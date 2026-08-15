/**
 * The deploy, as background work.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE DEPLOY HAS LEFT THE REQUEST.** `POST /tokens/:id/deploy` enqueues and answers 202 with a
 * status URL; everything below runs under a lease, in a job, on whichever replica claims it.
 *
 * The frozen service does this inside the HTTP request. It awaits, in one handler: a settlement
 * pass (up to three RPC round trips), a balance read, the lease claim, a nonce read, a fee read, a
 * gas estimate, a 15-second signing call, the broadcast, and then `sent.wait(1, 180_000)` — a wait
 * of up to **three minutes** for a receipt. Three things then go wrong at once:
 *
 *   * **A rolling deploy kills it.** `obs.ts` calls `process.exit(0)` ten seconds after
 *     SIGTERM whatever is in flight, so a deploy in its receipt wait has about a 95% chance of
 *     being cut. Where it lands decides the damage, and the bad landing is between the broadcast
 *     and the write that records the hash: a real signed creation is on the wire and the row has
 *     no record of it, the lease expires, `tx_hash IS NULL` passes, and a second contract is
 *     deployed at the platform's expense with the first orphaned.
 *   * **The edge kills it first.** Cloudflare's origin timeout is 100 seconds and the wait is 180,
 *     so the browser sees a 524 on deploys that then succeed server-side.
 *   * **Nothing recovers it.** There is no reconciler at all: settlement runs only when a request
 *     arrives for that specific order, so a customer who closes the tab leaves a broadcast deploy
 *     in `deploying` for ever.
 *
 * Here the HTTP request does one conditional UPDATE and one enqueue. The lease is renewed between
 * steps rather than sized against a guess, a drain stops the runner claiming before it stops
 * serving, and a `chain.sweep` job walks every outstanding deploy on a timer so a closed tab is
 * not the difference between a settled order and a stuck one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The sequence, and why each step must precede the next
 *
 *     claim → provision deployer → check funding → PREPARE (sign) → COMMIT bytes → broadcast →
 *     record broadcast → poll outcome
 *
 * A crash before the commit has broadcast nothing: the signature is discarded unbroadcast, no gas
 * was spent, and the next tick rebuilds from a fresh nonce read. A crash after the commit and
 * before the send leaves bytes with no `broadcast_at`, and the next tick RESUMES AT BROADCAST with
 * the identical bytes — a re-send of one transaction, never a second one. A crash after the send
 * is covered because the hash was written with the bytes, so the row can be polled to a terminal
 * state without anything being sent again.
 */

import type { Network } from '@cloudsforge/contracts-chain'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { familyFor, ChainRefusedError, ChainUnavailableError, NotImplementedError, type DeployContext } from './families.ts'
import { CustodySignRefusedError, type CustodyClient } from './custodyclient.ts'
import type { IndexerClient } from './indexerclient.ts'
import type { FeeBounds, JsonRpc } from './evm.ts'
import type { ChainId } from './chains.ts'
import type { Db } from './outbox.ts'
import {
  ageMs,
  claimDeploy,
  findToken,
  markBroadcast,
  markDeployed,
  markFailed,
  markProvisioned,
  markSigned,
  recordAttempt,
  releaseLease,
  renewLease,
  requestDeployerFunding,
  type TokenRecord,
} from './tokens.ts'

export interface DeployDeps {
  readonly sql: Db
  readonly producer: string
  readonly owner: string
  readonly network: Network
  readonly custody: CustodyClient
  readonly indexer: IndexerClient
  readonly rpc: (chain: ChainId) => JsonRpc
  readonly bounds: FeeBounds
  readonly leaseMs: number
  readonly stuckMs: number
  /**
   * How many times one order may ask settlement to fund its deployer before it stops asking.
   *
   * A bound rather than a retry budget. If three top-ups have gone out and the address is still
   * short, the next one will not be the one that works — something is wrong with the estimate, the
   * treasury or the chain — and continuing to ask spends real money on a wrong answer. The order
   * stays in `awaiting_funds`, which is exactly where an operator can see it and fund it by hand.
   */
  readonly fundingMaxRequests: number
  /** How long to wait between asks, so a top-up has blocks in which to confirm. */
  readonly fundingCooldownMs: number
  readonly enabled: boolean
  readonly logger: Logger
  readonly metrics: Metrics
  readonly now?: () => number
}

export type DriveResult =
  | 'skipped'
  | 'not_claimed'
  | 'awaiting_funds'
  | 'broadcast'
  | 'pending'
  | 'deployed'
  | 'failed'

/**
 * Advance one token's deploy by as much as it can be advanced in one lease.
 *
 * Returns rather than throws for every outcome the domain has a name for. A throw here is a fault:
 * the runner burns an attempt, backs off and retries, which is what should happen to a bug and
 * emphatically not to "the customer has not funded the deployer yet".
 */
export async function driveDeploy(deps: DeployDeps, tokenId: string): Promise<DriveResult> {
  if (!deps.enabled) return 'skipped'
  const now = deps.now ?? Date.now

  const claimed = await claimDeploy(deps.sql, {
    id: tokenId,
    owner: deps.owner,
    leaseMs: deps.leaseMs,
  })
  if (!claimed) {
    // Somebody else holds it, or the row is terminal, or bytes are already committed and this
    // path is not the one that resumes them. All ordinary; none an error.
    return resumeIfSigned(deps, tokenId)
  }

  const family = familyFor(claimed.chain)
  try {
    return await advance(deps, claimed)
  } catch (err) {
    if (err instanceof NotImplementedError) {
      // Recorded as evidence and then failed, terminally, with the reason on the row. The frozen
      // service reaches the same place by throwing out of a route, which leaves the customer a 500
      // and the order in `deploying`.
      await recordAttempt(deps.sql, {
        tokenId,
        attempt: claimed.deployAttempts,
        family: family.family,
        outcome: 'not_implemented',
        detail: err.message,
      })
      await fail(deps, claimed, err.message)
      return 'failed'
    }
    if (err instanceof CustodySignRefusedError || err instanceof ChainRefusedError) {
      // A peer looked at this request and said no. Permanent for these inputs, so retrying is a
      // guaranteed second refusal and a second burnt attempt.
      await recordAttempt(deps.sql, {
        tokenId,
        attempt: claimed.deployAttempts,
        family: family.family,
        outcome: 'refused',
        detail: err.message,
      })
      await fail(deps, claimed, err.message)
      return 'failed'
    }
    if (err instanceof ChainUnavailableError) {
      // We do not know what happened. The row keeps everything it has, the lease is released so
      // another replica may take it immediately, and nothing is failed — a node that is having a
      // bad minute must not cost a customer their order.
      await recordAttempt(deps.sql, {
        tokenId,
        attempt: claimed.deployAttempts,
        family: family.family,
        outcome: 'unavailable',
        detail: err.message,
      })
      deps.logger.warn('deploy paused: an upstream was unavailable', { tokenId, err: err.message })
      await releaseLease(deps.sql, tokenId, deps.owner)
      return 'pending'
    }
    await releaseLease(deps.sql, tokenId, deps.owner)
    throw err
  }
}

async function advance(deps: DeployDeps, claimed: TokenRecord): Promise<DriveResult> {
  const now = deps.now ?? Date.now
  const family = familyFor(claimed.chain)
  const rpc = deps.rpc(claimed.chain)

  // 1. The deployer address. Idempotent on custody's side, so a re-claim after a lost response
  //    finds the address that already exists rather than minting a second nonce sequence.
  let token = claimed
  if (!token.deployerAddress) {
    const deployer = await deps.custody.provisionDeployer({
      chain: (await import('./chains.ts')).custodyChainOf(token.chain),
      network: token.network,
      userId: userIdOf(token.ownerSubject),
      orderId: token.id,
      correlationId: token.id,
    })
    const provisioned = await markProvisioned(deps.sql, {
      id: token.id,
      owner: deps.owner,
      deployerAddress: deployer.address,
    })
    if (!provisioned) return 'not_claimed'
    token = provisioned
  }
  await heartbeat(deps, token.id)

  const ctx = contextFor(token)

  // 2. Funding. A real number rather than `balance > 0`: the frozen gate lets one wei of dust
  //    through and the deploy then dies at `estimateGas` with the lease already claimed.
  const funding = await family.funding(ctx, rpc, deps.bounds)
  if (!funding.funded) {
    await askForFunds(deps, token, funding)
    return 'awaiting_funds'
  }
  await heartbeat(deps, token.id)

  // 3. Sign. Nothing is sent by this call — see the note in families.ts. The lease is renewed
  //    first because signing is the slowest single step and a lease that expires mid-signature is
  //    a second replica reading the same nonce.
  const plan = await family.prepare(ctx, rpc, deps.bounds, deps.custody)

  // 4. **COMMIT THE BYTES AND THE HASH, BEFORE ANYTHING IS BROADCAST.** If this does not match —
  //    the lease was taken over while the signature was in the air — the signature is DISCARDED
  //    UNBROADCAST. Nothing was sent, so no gas was spent and no contract exists.
  const signed = await markSigned(deps.sql, {
    id: token.id,
    owner: deps.owner,
    rawTx: plan.rawTx,
    txHash: plan.txHash,
    nonce: plan.nonce,
    contractAddress: plan.contractAddress,
    custodyAuditId: plan.custodyAuditId,
  })
  if (!signed) {
    deps.logger.warn('a signature was discarded unbroadcast: the row was signed elsewhere', {
      tokenId: token.id,
    })
    return 'not_claimed'
  }
  await recordAttempt(deps.sql, {
    tokenId: token.id,
    attempt: signed.deployAttempts,
    family: family.family,
    outcome: 'signed',
    txHash: plan.txHash,
  })

  return send(deps, signed)
}

/**
 * Send committed bytes and poll them.
 *
 * Reachable twice: straight after `markSigned`, and on a later tick for a row whose bytes were
 * committed and whose process died before the send. Both re-send the IDENTICAL bytes, which a node
 * answers with "already known" once it holds them — a success, not a failure.
 */
async function send(deps: DeployDeps, token: TokenRecord): Promise<DriveResult> {
  const family = familyFor(token.chain)
  const rpc = deps.rpc(token.chain)
  const ctx = contextFor(token)
  // Captured before anything reassigns `token`, so the narrowing survives. Both are known
  // non-null from here down: a row reaches `send` only after `markSigned` committed them.
  const rawTx = token.rawTx
  const txHash = token.deployTxHash
  if (!rawTx || !txHash) {
    throw new Error('send called for a row with no committed bytes')
  }

  if (!token.broadcastAt) {
    await family.broadcast(rawTx, rpc)
    // The hash is ALREADY on the row — it was written with the bytes — so this write only stamps
    // the time and emits the event. There is no window here in which a broadcast exists and its
    // id does not, which is the whole difference from the frozen service.
    const broadcast = await markBroadcast(deps.sql, deps.producer, {
      id: token.id,
      owner: deps.owner,
      // The SERVICE's clock, not the database's. `broadcast_at` is the only timestamp on the row
      // that is later compared against a clock, and mixing the two domains makes a fresh broadcast
      // read as negatively old. See the note on `markBroadcast`.
      at: new Date((deps.now ?? Date.now)()),
      actor: `service:${deps.producer}`,
      correlationId: token.id,
    })
    await recordAttempt(deps.sql, {
      tokenId: token.id,
      attempt: token.deployAttempts,
      family: family.family,
      outcome: 'broadcast',
      txHash,
    })
    deps.metrics.increment('mint_deploys_broadcast_total', { chain: token.chain })
    deps.logger.info('deploy broadcast', {
      tokenId: token.id,
      chain: token.chain,
      txHash,
      contractAddress: token.contractAddress,
    })
    if (broadcast) token = broadcast
  }

  const outcome = await family.outcome(
    ctx,
    {
      txHash,
      nonce: token.deployNonce ?? 0n,
      contractAddress: token.contractAddress ?? '',
    },
    rpc,
    deps.indexer,
    ageMs(token, (deps.now ?? Date.now)()),
    deps.stuckMs,
  )

  if (outcome.kind === 'confirmed') {
    const deployed = await markDeployed(deps.sql, deps.producer, {
      id: token.id,
      txHash,
      contractAddress: outcome.contractAddress,
      actor: `service:${deps.producer}`,
      correlationId: token.id,
    })
    await recordAttempt(deps.sql, {
      tokenId: token.id,
      attempt: token.deployAttempts,
      family: family.family,
      outcome: 'confirmed',
      txHash,
    })
    deps.metrics.increment('mint_deploys_total', { chain: token.chain, outcome: 'deployed' })
    deps.logger.info('deploy confirmed', {
      tokenId: token.id,
      contractAddress: deployed?.contractAddress ?? outcome.contractAddress,
    })
    return 'deployed'
  }

  if (outcome.kind === 'reverted' || outcome.kind === 'dropped') {
    await recordAttempt(deps.sql, {
      tokenId: token.id,
      attempt: token.deployAttempts,
      family: family.family,
      outcome: 'reverted',
      txHash,
      detail: outcome.reason,
    })
    await fail(deps, token, outcome.reason)
    return 'failed'
  }

  // Still in flight. The lease is released so any replica may poll it next tick; the row keeps its
  // bytes and its hash, so nothing will ever re-sign it.
  await releaseLease(deps.sql, token.id, deps.owner)
  return 'broadcast'
}

/**
 * Resume a row whose bytes were committed by a previous, dead attempt.
 *
 * `claimDeploy` deliberately refuses a row with `raw_tx`, because re-SIGNING one is the mistake.
 * Re-SENDING one is the recovery. So this path takes the row without claiming it fresh, and it is
 * safe to run concurrently: two replicas re-sending identical bytes produce one transaction, and
 * `markBroadcast` and `markDeployed` are both conditional so only one of them records it.
 */
async function resumeIfSigned(deps: DeployDeps, tokenId: string): Promise<DriveResult> {
  const token = await findToken(deps.sql, tokenId)
  if (!token || token.status !== 'deploying' || !token.rawTx) return 'not_claimed'
  try {
    return await send(deps, token)
  } catch (err) {
    if (err instanceof ChainUnavailableError) {
      deps.logger.warn('resume paused: an upstream was unavailable', { tokenId, err: err.message })
      return 'pending'
    }
    throw err
  }
}

/**
 * Move back to `awaiting_funds`, release the lease, and ASK FOR THE MONEY.
 *
 * The ask is the half that did not exist. A deployer address is minted per order and starts empty,
 * so this branch is on the happy path of every single deploy — and until `requestDeployerFunding`
 * it did nothing but write the row back and log a line, which is why a paid order sat here for
 * ever. This service cannot fund the address itself: it holds `custody:sign:deployer` and no other
 * signing scope, so the transfer belongs to settlement, which holds `custody:sign:treasury`.
 *
 * Everything here is a LOG, never a throw. "The deployer has no gas yet" is an ordinary state of a
 * deploy, and throwing would burn a runner attempt and back the whole sweep off.
 */
async function askForFunds(
  deps: DeployDeps,
  token: TokenRecord,
  funding: { readonly required: bigint; readonly balance: bigint },
): Promise<void> {
  const outcome = await requestDeployerFunding(deps.sql, deps.producer, {
    id: token.id,
    owner: deps.owner,
    required: funding.required,
    balance: funding.balance,
    maxRequests: deps.fundingMaxRequests,
    cooldownMs: deps.fundingCooldownMs,
    at: new Date((deps.now ?? Date.now)()),
    actor: `service:${deps.producer}`,
    correlationId: token.id,
  })

  if (outcome.kind === 'requested') {
    deps.metrics.increment('mint_deploy_funding_requests_total', { chain: token.chain })
    deps.logger.info('deploy is awaiting funds; asked settlement to top the deployer up', {
      tokenId: token.id,
      chain: token.chain,
      deployerAddress: token.deployerAddress,
      required: funding.required.toString(),
      balance: funding.balance.toString(),
      requested: outcome.amount.toString(),
      attempt: outcome.attempt,
    })
    return
  }

  if (outcome.kind === 'held') {
    deps.metrics.increment('mint_deploy_funding_held_total', {
      chain: token.chain,
      reason: outcome.reason,
    })
    // `limit_reached` is the one an operator has to act on: three top-ups have been sent and the
    // address is still short, so the order will not move without a person. Warn, with the numbers.
    const log = outcome.reason === 'cooling_down' ? deps.logger.info : deps.logger.warn
    log.call(deps.logger, 'deploy is awaiting funds; no request was sent', {
      tokenId: token.id,
      chain: token.chain,
      deployerAddress: token.deployerAddress,
      reason: outcome.reason,
      attempts: outcome.attempts,
      required: funding.required.toString(),
      balance: funding.balance.toString(),
    })
    return
  }

  // The lease moved while we were measuring. Another replica owns this row now and has its own
  // measurement; ours is stale and must not be acted on.
  deps.logger.info('deploy funding skipped: the lease is no longer ours', { tokenId: token.id })
}

async function fail(deps: DeployDeps, token: TokenRecord, reason: string): Promise<void> {
  await markFailed(deps.sql, deps.producer, {
    id: token.id,
    reason,
    actor: `service:${deps.producer}`,
    correlationId: token.id,
  })
  deps.metrics.increment('mint_deploys_total', { chain: token.chain, outcome: 'failed' })
  deps.logger.error('deploy failed', {
    tokenId: token.id,
    reason,
    // A truthful `broadcast`. The frozen service reports `broadcast: false` for transactions it
    // did in fact broadcast, which sends triage in exactly the wrong direction.
    broadcast: token.broadcastAt !== null,
    txHash: token.deployTxHash,
  })
}

/**
 * Renew the lease between steps.
 *
 * A lease sized against a guess is the frozen service's mistake: its 300-second budget was
 * computed against the 180-second receipt wait alone and does not cover the three RPC round trips
 * and the 15-second signing call that precede it, so one slow node expires a lease before any
 * bytes exist and a second caller claims. Renewing turns the budget into a bound on ONE STEP
 * rather than on the whole job.
 */
async function heartbeat(deps: DeployDeps, tokenId: string): Promise<void> {
  const held = await renewLease(deps.sql, { id: tokenId, owner: deps.owner, leaseMs: deps.leaseMs })
  if (!held) {
    throw new ChainUnavailableError('this replica no longer holds the deploy lease')
  }
}

function contextFor(token: TokenRecord): DeployContext {
  if (!token.deployerAddress) throw new Error('deploy context requires a deployer address')
  return {
    tokenId: token.id,
    ownerSubject: token.ownerSubject,
    userId: userIdOf(token.ownerSubject),
    ownerAddress: token.ownerAddress,
    deployerAddress: token.deployerAddress,
    chain: token.chain,
    network: token.network,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    supply: token.supply,
    cap: token.cap,
    features: token.features,
    correlationId: token.id,
  }
}

/**
 * The bare user id inside a ledger subject.
 *
 * Custody's binding carries the raw id, the ledger's subject carries `user:<id>`, and this service
 * stores the ledger's spelling. Restating custody's binding with the `user:` prefix left on is a
 * `binding_mismatch` — a 403 that does not say which of the seven fields was wrong.
 */
export function userIdOf(subject: string): string {
  return subject.startsWith('user:') ? subject.slice('user:'.length) : subject
}
