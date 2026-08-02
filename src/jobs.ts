/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work and CI greps for one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE, NOT THE ROW.** Ask: what would break if two of
 * these ran at once? Whatever the answer names, that is the key.
 *
 *   | Work           | Key             | Why                                                      |
 *   |----------------|-----------------|----------------------------------------------------------|
 *   | token.deploy   | `chain:network` | **The deployer's nonce sequence.** NOT the token id, and  |
 *   |                |                 | this is the decision most likely to be got wrong here.    |
 *   |                |                 | Every deploy on one chain reads `eth_getTransactionCount` |
 *   |                |                 | on ITS OWN per-order deployer address, so two tokens are  |
 *   |                |                 | genuinely independent — but they share one node, one fee  |
 *   |                |                 | quote and one custody rate limit, and serialising them is |
 *   |                |                 | what keeps a hundred queued orders from opening a hundred |
 *   |                |                 | concurrent signing calls. The row-level lease inside      |
 *   |                |                 | `claimDeploy` is what makes two deploys of the SAME token |
 *   |                |                 | impossible; this key bounds the load.                     |
 *   | token.sweep    | `chain:network` | The set of outstanding deploys on that chain. It shares a |
 *   |                |                 | key with `token.deploy` and that is SAFE FOR ONE REASON:  |
 *   |                |                 | it never signs and never sends. It enqueues. See below.   |
 *   | outbox.relay   | `stream`        | The outbox stream. Keying on the event id would let two   |
 *   |                |                 | relays deliver one batch to one subscriber twice.         |
 *
 * **A KEY IS NOT A LOCK ACROSS KINDS.** The jobs table is unique on `(kind, key)`, so
 * `token.sweep / eth:testnet` and `token.deploy / eth:testnet` are two rows and two workers may
 * hold them at the same instant. That is only tolerable because `token.sweep` does nothing but
 * enqueue — it claims nothing, signs nothing and broadcasts nothing. **The moment anything in
 * `token.sweep` reaches a chain it must be merged into `token.deploy` rather than given its own
 * key**, because sharing a key with a different kind buys nothing at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `token.sweep` is the thing the frozen service has no equivalent of. There, settlement runs only
 * when a request arrives for that specific order, so a customer who closes the tab leaves a
 * broadcast deploy in `deploying` with a live hash and nothing ever looks at it again. The sweep
 * walks `outstandingDeploys` on a schedule, so an order settles whether or not anybody is watching.
 */

import { JobRunner, type Job, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Network } from '@cloudsforge/contracts-chain'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { CHAIN_IDS, chainKey, isChainId, isNetwork, type ChainId } from './chains.ts'
import { createRelay, type Db, type RelayDeps } from './outbox.ts'
import { driveDeploy, type DeployDeps } from './deploy.ts'
import { outstandingDeploys } from './tokens.ts'

export const RELAY_KIND = 'outbox.relay'
/** The only job that ever asks custody for a signature or puts bytes on a wire. */
export const DEPLOY_KIND = 'token.deploy'
/** Finds outstanding deploys and enqueues them. Never signs, never sends — see the header. */
export const SWEEP_KIND = 'token.sweep'

export interface Recurring {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
  readonly payload?: Record<string, unknown>
}

/**
 * Jobs that must exist whether or not anything enqueued them.
 *
 * The sweep is seeded for every chain rather than for every chain with work, deliberately: a job
 * that only exists once there is something to do is a job whose absence looks exactly like a job
 * that is stuck, and `jobs_overdue` stops being a signal.
 */
export function recurring(network: Network): readonly Recurring[] {
  return Object.freeze(
    CHAIN_IDS.map((chain) => ({
      kind: SWEEP_KIND,
      key: chainKey(chain, network),
      everyMs: 15_000,
      payload: { chain, network } as Record<string, unknown>,
    })).concat([{ kind: RELAY_KIND, key: 'stream', everyMs: 1_000, payload: {} }]),
  )
}

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue, network: Network): Promise<void> {
  for (const job of recurring(network)) {
    await queue.enqueue({
      kind: job.kind,
      key: job.key,
      onConflict: 'keep',
      ...(job.payload ? { payload: job.payload } : {}),
    })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. Silently rescheduling
 * a job that has failed its whole attempt budget hides a permanent fault behind a busy loop.
 */
export function rescheduleRecurring(
  queue: JobQueue,
  network: Network,
  logger: Logger,
): (event: RunnerEvent) => void {
  const byKey = new Map(recurring(network).map((job) => [`${job.kind}\u0000${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed' || !event.kind || !event.key) return
    const job = byKey.get(`${event.kind}\u0000${event.key}`)
    if (!job) return
    void queue
      .enqueue({
        kind: job.kind,
        key: job.key,
        runAt: new Date(Date.now() + job.everyMs),
        onConflict: 'earliest',
        ...(job.payload ? { payload: job.payload } : {}),
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: job.kind, err }))
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly signingSecret: string
  readonly deploy: DeployDeps
  /**
   * The queue the sweep enqueues onto.
   *
   * Passed in rather than closed over at module scope. A module-local queue would be exactly the
   * shape of the module-local boolean rule 8 exists to keep out: invisible to a second process,
   * and impossible to substitute in a test.
   */
  readonly queue: Pick<JobQueue, 'enqueue'>
  /** How many outstanding deploys one sweep will enqueue. Bounds the queue, not the work. */
  readonly sweepLimit: number
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  /**
   * Advance one token's deploy.
   *
   * The payload names the token; the KEY names the chain. A payload that cannot be acted on is a
   * permanent fault and throwing dead-letters it, which is correct — retrying will not make a
   * missing token id valid.
   */
  runner.register<{ tokenId?: string }>(DEPLOY_KIND, async (job: Job<{ tokenId?: string }>, ctx) => {
    const tokenId = job.payload.tokenId
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
      throw new Error(`${DEPLOY_KIND} requires a string tokenId`)
    }
    const result = await driveDeploy(deps.deploy, tokenId)
    if (ctx.signal.aborted) return
    deps.logger.info('deploy tick', { tokenId, result })
  })

  /**
   * Find outstanding deploys and enqueue one job each.
   *
   * Enqueues only. It claims nothing and reaches no chain, which is the single fact that makes it
   * safe to share a lease key with `token.deploy` — see the header.
   */
  runner.register<{ chain?: string; network?: string }>(SWEEP_KIND, async (job, ctx) => {
    const chain = job.payload.chain
    const network = job.payload.network
    if (typeof chain !== 'string' || !isChainId(chain)) {
      throw new Error(`${SWEEP_KIND} requires a known chain (got ${String(chain)})`)
    }
    if (typeof network !== 'string' || !isNetwork(network)) {
      throw new Error(`${SWEEP_KIND} requires a known network (got ${String(network)})`)
    }
    const outstanding = await outstandingDeploys(deps.sql, deps.sweepLimit)
    let enqueued = 0
    for (const token of outstanding) {
      if (ctx.signal.aborted) return
      if (token.chain !== (chain as ChainId) || token.network !== network) continue
      // `keep`, so a token already queued is not re-queued: three sweeps before the first deploy
      // job runs must produce one run, not three.
      await deps.queue.enqueue({
        kind: DEPLOY_KIND,
        key: chainKey(token.chain, token.network),
        payload: { tokenId: token.id },
        onConflict: 'keep',
      })
      enqueued += 1
    }
    deps.metrics.set('mint_deploys_outstanding', outstanding.length)
    if (enqueued > 0) deps.logger.info('deploy sweep', { chain, network, enqueued })
  })

  return runner
}
