/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this
 * file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process — AD-17 and rule 7. In this service that is more than hygiene: below
 * `SCHEMA_VERSION` the three constraints described in `migrations.ts` may not exist, and one of
 * them is what makes a broadcast with no transaction hash unrepresentable. A service that could
 * create them at boot is a service that could start without them.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it
 * must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { HttpClient } from '@cloudsforge/http'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { httpCustodyClient } from './custodyclient.ts'
import { httpIndexerClient } from './indexerclient.ts'
import { httpLedgerClient } from './ledgerclient.ts'
import { CHAIN_IDS, type ChainId } from './chains.ts'
import { isImplemented } from './families.ts'
import type { JsonRpc } from './evm.ts'
import type { Db } from './outbox.ts'
import type { DeployDeps } from './deploy.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  // Said at boot rather than discovered from a refused deploy an hour later. A chain with a family
  // but no endpoint is the failure most likely to be a deploy mistake.
  chains: CHAIN_IDS.map((chain) => ({
    chain,
    implemented: isImplemented(chain),
    endpoint: Boolean(env.rpcUrls[chain]),
  })),
  // Empty is the default and empty means no mainnet deploy is possible. Logged so an operator can
  // see which it is without reading the environment.
  mainnetAllowlist: env.mainnetAllowlist.length,
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does NOT migrate. Failing here rather than serving is the point: a
//    replica of the new code answering against the old schema is a replica whose broadcast
//    constraint may not exist, and that is the constraint standing between a lost confirmation
//    race and a second deploy.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The upstreams. Constructed before the Lifecycle so its probes can close over their URLs, and
//    all three take the same scoped service token — never a shared one (SD-05).
const token = () => env.serviceToken
const custody = httpCustodyClient({
  baseUrl: env.custodyUrl,
  token,
  deadlineMs: env.upstreamDeadlineMs,
})
const indexer = httpIndexerClient({
  baseUrl: env.indexerUrl,
  token,
  deadlineMs: env.upstreamDeadlineMs,
})
const ledger = httpLedgerClient({
  baseUrl: env.ledgerUrl,
  token,
  deadlineMs: env.upstreamDeadlineMs,
  originatingService: SERVICE,
})

/**
 * One JSON-RPC client per chain, built once so a circuit breaker accumulates state across ticks.
 * A fresh client per call has a permanently closed circuit and hammers a dead node.
 */
const rpcClients = new Map<string, HttpClient>()
const rpc = (chain: ChainId): JsonRpc => {
  const url = env.rpcUrls[chain]
  if (!url) throw new Error(`no JSON-RPC endpoint configured for ${chain}`)
  let client = rpcClients.get(chain)
  if (!client) {
    client = new HttpClient({
      baseUrl: new URL(url).origin,
      name: `rpc:${chain}`,
      defaultDeadlineMs: env.rpcDeadlineMs,
    })
    rpcClients.set(chain, client)
  }
  const path = `${new URL(url).pathname}${new URL(url).search}`
  let id = 0
  return async (method, params) => {
    id += 1
    const body = await client.request<{ result?: unknown; error?: { message?: string } }>(path, {
      method: 'POST',
      body: { jsonrpc: '2.0', id, method, params },
      // A JSON-RPC POST is retriable only because every method this service calls is either a read
      // or `eth_sendRawTransaction`, which a node answers idempotently for bytes it already holds.
      idempotencyKey: `${chain}:${method}:${id}`,
    })
    if (body.error) throw new Error(body.error.message ?? 'json-rpc error')
    return body.result
  }
}

// 6. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval or the balancer is still sending traffic when the
  // process stops accepting it.
  drainDelayMs: 5_000,
  // Generous, because a drain must not cut a worker between a signature and its commit. The runner
  // is given 20 seconds below and this is the ceiling around it. The frozen service's equivalent
  // is `setTimeout(() => process.exit(0), 10_000)` racing an in-flight 180-second deploy.
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  // SOFT, all three. Custody being down means no new signature can be made — but this service must
  // stay in its balancer to keep ADVANCING deploys that are already signed, which is the state
  // where a customer's gas is actually at risk. Marking any of them hard would remove mint from
  // rotation for the duration of somebody else's incident, which is a cascade, not a safety
  // measure.
  .addProbe(httpProbe('custody', `${env.custodyUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('indexer', `${env.indexerUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }))

// 7. The dependency bundles, built once and shared so the routes and the worker cannot disagree
//    about which network they are on or which bounds they are enforcing.
const db = sql as unknown as Db
const queue = new JobQueue(sql as unknown as JobsSql, {
  owner: env.instanceId,
  // Longer than the default 60 seconds because a deploy job holds its lease across a node round
  // trip, a custody round trip and a broadcast. The handler renews between steps, so this is the
  // ceiling on a STEP rather than on the job — which is the frozen service's mistake: its lease
  // was sized against the receipt wait alone and one slow RPC expires it before bytes exist.
  leaseMs: 120_000,
})

const deploy: DeployDeps = {
  sql: db,
  producer: SERVICE,
  owner: env.instanceId,
  network: env.network,
  custody,
  indexer,
  rpc,
  bounds: {
    minGasPriceWei: env.minGasPriceWei,
    maxGasPriceWei: env.maxGasPriceWei,
    maxFeeWei: env.maxFeeWei,
  },
  leaseMs: 120_000,
  stuckMs: env.stuckMinutes * 60_000,
  enabled: env.deploysEnabled,
  logger: logger.child({ component: 'deploy' }),
  metrics,
}

// 8. Routes. After the Lifecycle so the health handlers report real state, and after the pool so
//    the stores are real rather than a lazily-connected surprise on the first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: db,
  producer: SERVICE,
  network: env.network,
  pay: { sql: db, ledger, producer: SERVICE },
  render: { sql: db, indexer },
  queue,
  priceShards: env.deployPriceShards,
  mainnetAllowlist: env.mainnetAllowlist,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in
  // this repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that.
const reschedule = rescheduleRecurring(queue, env.network, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql: db,
  logger,
  metrics,
  signingSecret: env.outboxSigningSecret,
  deploy,
  queue,
  sweepLimit: 100,
})
await seedRecurring(queue, env.network)
runner.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its dependencies
//     exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now does `/readyz` start answering 200 and the balancer send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and DRAINS — which is the step that matters: a SIGTERM
//     between a signature and its commit discards bytes that were made and never sent, which is
//     safe but wastes a custody signature and a nonce read. Then the pool closes with nothing left
//     to use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
