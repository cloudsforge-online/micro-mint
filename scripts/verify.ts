/**
 * Boot the REAL service against a fake chain and drive one order end to end.
 *
 * This is the manual verification, and it is a real process on a real socket: `createServer` is
 * the production one, `driveDeploy` is the production one, and the EVM family below it is the
 * production one. Only three things are substituted, at the narrowest seam each has:
 *
 *   * the JSON-RPC transport — `fakeNode`, because **no verification may deploy to a real chain**;
 *   * custody — `fakeCustody`, which returns real RLP so the transaction id derivation is genuine;
 *   * the ledger — `fakeLedger`, which dedupes on the idempotency key exactly as the real one does.
 *
 * The job runner is NOT substituted and NOT started: the deploy job is driven by an operator
 * endpoint below, one tick at a time, so the transcript shows each state transition rather than a
 * race between a poll and a printer.
 *
 *     MINT_TEST_DATABASE_URL=... node --import tsx scripts/verify.ts
 */

import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import postgres from 'postgres'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import type { Principal } from '@cloudsforge/auth'
import { createServer, registerServiceMetrics } from '../src/server.ts'
import { driveDeploy } from '../src/deploy.ts'
import { migrateTestDb, openDb, resetMint, deployerFor, fakeNode, fakeCustody, fakeIndexer, fakeLedger, fakeRpc, TEST_BOUNDS } from '../src/testsupport.ts'
import type { Db } from '../src/outbox.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'

const sql = openDb(8)
await migrateTestDb(sql)
await resetMint(sql)
const db = sql as unknown as Db

// The fake chain. Every deployer address this run mints is funded, so the funding gate passes.
const node = fakeNode()
const custody = fakeCustody()
const indexer = fakeIndexer()
const ledger = fakeLedger()

const logger = new Logger({ service: 'mint-verify', level: 'error' })
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })

/** A verifier keyed on the token text. The real `Verifier` would need a JWKS this run has not got. */
const verifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: ['player'] }
    throw new Error('unknown token')
  },
}

const queued: Array<{ tokenId: string }> = []

const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: db,
  producer: 'mint',
  network: 'testnet',
  pay: { sql: db, ledger, producer: 'mint' },
  render: { sql: db, indexer },
  queue: {
    async enqueue(options) {
      queued.push({ tokenId: String((options.payload ?? {})['tokenId']) })
    },
  },
  priceShards: 2_500n,
  mainnetAllowlist: [],
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as AddressInfo).port
lifecycle.markReady()

const deploy = {
  sql: db,
  producer: 'mint',
  owner: 'verify-replica',
  network: 'testnet' as const,
  custody,
  indexer,
  rpc: fakeRpc(node),
  bounds: TEST_BOUNDS,
  leaseMs: 60_000,
  stuckMs: 30 * 60_000,
  enabled: true,
  logger,
  metrics,
}

/**
 * The operator side-car.
 *
 * A SECOND socket, deliberately: these are not routes on the service. `POST /tick` runs one
 * deploy job — which in production is a leased job the runner claims — and `POST /fund` and
 * `POST /mine` are the fake chain's controls. Putting them on the service would be putting a
 * chain simulator in a production binary.
 */
const control = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const send = (body: unknown): void => {
    const payload = `${JSON.stringify(body)}\n`
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
  if (url.pathname === '/fund') {
    const tokenId = url.searchParams.get('tokenId') ?? ''
    node.setBalance(deployerFor(tokenId), 10n ** 18n)
    return send({ funded: deployerFor(tokenId) })
  }
  if (url.pathname === '/mine') {
    for (const raw of node.broadcast) node.mine(raw)
    return send({ mined: node.broadcast.length })
  }
  if (url.pathname === '/tick') {
    const tokenId = url.searchParams.get('tokenId') ?? queued[queued.length - 1]?.tokenId ?? ''
    void driveDeploy(deploy, tokenId).then((result) =>
      send({ tokenId, result, broadcasts: node.broadcast.length, signatures: custody.signatures.length }),
    )
    return undefined
  }
  return send({ queued })
})
await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', () => resolve()))
const controlPort = (control.address() as AddressInfo).port

process.stdout.write(`${JSON.stringify({ service: port, control: controlPort })}\n`)
