/**
 * The HTTP surface.
 *
 * The test that matters most is the 202: `POST /v1/tokens/:id/deploy` must answer immediately with
 * a status URL and reach no chain. The frozen handler awaits a broadcast and up to 180 seconds of
 * receipt wait inside the request, which is what a rolling deploy cuts in half.
 */

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { toChecksumAddress } from './evm.ts'
import { DEPLOY_KIND } from './jobs.ts'
import type { Db } from './outbox.ts'
import {
  enabled,
  fakeIndexer,
  fakeLedger,
  fakePricing,
  migrateTestDb,
  openDb,
  resetMint,
  seedToken,
  skip,
  type FakeIndexer,
  type FakeLedger,
} from './testsupport.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const OWNER = toChecksumAddress('0x00000000000000000000000000000000000000a1')

/**
 * A verifier keyed on the token text, so a test names the authority it wants.
 *
 * An interface rather than a real `Verifier`, so these tests need no JWKS endpoint and no signing
 * key — the mapping from auth fault to status is what is under test, not jose.
 */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    switch (token) {
      case 'alice':
        return { kind: 'user', userId: ALICE, handle: 'alice', roles: ['player'] }
      case 'bob':
        return { kind: 'user', userId: BOB, handle: 'bob', roles: ['player'] }
      case 'admin':
        return { kind: 'user', userId: 'admin-1', handle: 'ops-jane', roles: ['admin'] }
      case 'svc-write':
        return { kind: 'service', service: 'hub', scopes: ['mint:write', 'mint:read'] }
      case 'svc-none':
        return { kind: 'service', service: 'nosy', scopes: ['other:read'] }
      case 'down':
        throw new VerifierUnavailableError('jwks unreachable')
      default:
        throw new TokenError('bad signature', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')
    }
  },
}

let sql: postgres.Sql
let server: Server
let baseUrl: string
let ledger: FakeLedger
let indexer: FakeIndexer
let enqueued: Array<{ kind: string; key: string; payload?: Record<string, unknown> }>

before(async () => {
  if (!enabled) return
  sql = openDb(8)
  await migrateTestDb(sql)
  ledger = fakeLedger()
  indexer = fakeIndexer()
  enqueued = []

  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
  const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
  const db = sql as unknown as Db
  server = createServer({
    lifecycle,
    logger: new Logger({ service: 'mint-test', level: 'fatal', sink: () => {} }),
    metrics,
    verifier,
    sql: singleNetworkSql(db),
    singleNetwork: 'mainnet' as const,
    producer: 'mint',
    network: 'testnet',
    pay: { sql: db, ledger, pricing: fakePricing(), settlementAsset: 'EMBER', producer: 'mint' },
    render: { sql: db, indexer },
    queue: {
      async enqueue(options) {
        enqueued.push({
          kind: options.kind,
          key: options.key,
          ...(options.payload ? { payload: options.payload } : {}),
        })
      },
    },
    priceUsdCents: 2_500n,
    settlementAsset: 'EMBER',
    // One allowlisted subject, so both halves of the gate are exercised.
    mainnetAllowlist: [`user:${ALICE}`],
    // `POST /v1/events` is exercised in `erasure.test.ts`, which owns the signing key. Present
    // here because the field is required, and required because a service that will accept a signed
    // event must be told what to accept BEFORE it starts, not on the first delivery.
    eventAcceptSecrets: ['a-secret-this-file-never-signs-with-0123456789'],
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  lifecycle.markReady()
})

beforeEach(async () => {
  if (!enabled) return
  await resetMint(sql)
  enqueued.length = 0
  // The ledger fake outlives the suite, so without this a case asserting "one debit" is really
  // asserting "one debit in every case that ran before it too" — it passed only while exactly one
  // case ever paid. `ledger.entries.length` is the money assertion in this file; it has to mean
  // what it says.
  ledger.reset()
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

async function call(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  }
}

const ORDER = {
  chain: 'ember',
  network: 'testnet',
  name: 'Ashfall',
  symbol: 'ASH',
  decimals: 18,
  supply: '1000000000000000000000000',
  features: [],
  ownerAddress: OWNER,
  ownerWalletId: 'wallet-1',
}

/* ------------------------------------------------------------------ the probes */

test('livez, readyz and metrics are served — rule 4', { skip }, async () => {
  assert.equal((await call('/livez')).status, 200)
  assert.equal((await call('/readyz')).status, 200)
  const metrics = await fetch(`${baseUrl}/metrics`)
  assert.equal(metrics.status, 200)
  assert.match(await metrics.text(), /mint_deploys_total/)
})

/* ------------------------------------------------------------------ auth */

test('a missing or bad token is 401, and the reason is never returned', { skip }, async () => {
  assert.equal((await call('/v1/tokens')).status, 401)
  const bad = await call('/v1/tokens', { token: 'forged' })
  assert.equal(bad.status, 401)
  assert.doesNotMatch(JSON.stringify(bad.body), /signature/i)
})

test('an unreachable verifier is 503, NEVER 401', { skip }, async () => {
  // Answering 401 there signs every user in the estate out because identity is having a bad
  // minute.
  assert.equal((await call('/v1/tokens', { token: 'down' })).status, 503)
})

test('a service token without the scope is 403', { skip }, async () => {
  const res = await call('/v1/tokens', { method: 'POST', token: 'svc-none', body: ORDER })
  assert.equal(res.status, 403)
})

/* ------------------------------------------------------------------ orders */

test('an order is created without charging or deploying anything', { skip }, async () => {
  const res = await call('/v1/tokens', { method: 'POST', token: 'alice', body: ORDER })
  assert.equal(res.status, 201)
  const token = res.body['token'] as Record<string, unknown>
  assert.equal(token['status'], 'awaiting_payment')
  // US cents on the wire, and `priceShards` gone rather than renamed — a removed field is an
  // `undefined` a stale client can notice, a re-based one is not.
  assert.equal(token['priceUsdCents'], '2500')
  assert.equal(token['priceShards'], undefined)
  // Nothing has been charged, so there is no charge to report yet.
  assert.equal(token['chargeAssetCode'], null)
  assert.equal(token['chargeAmount'], null)
  // Strings on the wire. A supply of 10^24 does not survive a JSON number.
  assert.equal(token['supply'], ORDER.supply)
  assert.equal(ledger.entries.length, 0)
})

test('a mistyped owner address is refused at the order form, not at the deploy', { skip }, async () => {
  const res = await call('/v1/tokens', {
    method: 'POST',
    token: 'alice',
    body: { ...ORDER, ownerAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD' },
  })
  assert.equal(res.status, 400)
  assert.match(JSON.stringify(res.body), /checksum/)
})

test('a feature set no committed contract provides is refused BEFORE payment', { skip }, async () => {
  // Discovering after payment that a request can never succeed is the worst possible moment.
  const res = await call('/v1/tokens', {
    method: 'POST',
    token: 'alice',
    body: { ...ORDER, features: ['pausable'] },
  })
  assert.equal(res.status, 400)
  assert.match(JSON.stringify(res.body), /no committed contract/)
  const error = res.body['error'] as Record<string, unknown>
  assert.equal(error['code'], 'unbuildable_order')
  assert.equal(error['field'], 'features')
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AN ORDER THAT CANNOT BE BUILT NEVER REACHES A PAYABLE STATE.
 *
 * The defect: `POST /v1/tokens` called `variantFor` alone, and `variantFor` never reads the cap.
 * The cap rule ran for the first time in `constructorArgs`, inside the deploy job — so a foundry
 * order with no cap was accepted, then charged by `POST /v1/tokens/:id/pay`, and only then found
 * to be unbuildable. It did not even fail cleanly: the `ChainError` from `dataFor` matches none of
 * `driveDeploy`'s four classified failures (`deploy.ts`), so the lease was released, the
 * row stayed `deploying`, `deploying` is in `CLAIMABLE` (`tokens.ts`), and the sweep put it
 * straight back on the queue. A permanent loop with the customer's Shards already spent.
 *
 * This asserts the money consequence directly: after the refusal there is no order to pay for, and
 * the ledger has not been touched.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a capped variant ordered with no cap cannot reach a payable state', { skip }, async () => {
  const foundry = { ...ORDER, features: ['mintable', 'burnable', 'pausable'], cap: null }
  const res = await call('/v1/tokens', { method: 'POST', token: 'alice', body: foundry })

  assert.equal(res.status, 400)
  const error = res.body['error'] as Record<string, unknown>
  assert.equal(error['code'], 'unbuildable_order', 'distinguishable from a generic 400')
  assert.equal(error['field'], 'cap', 'the caller is told WHICH field to change')
  assert.match(String(error['message']), /requires a cap/)

  // No row, so no id, so nothing for `POST /v1/tokens/:id/pay` to charge against. This is the
  // whole claim: the money path is unreachable because the order does not exist.
  assert.equal(res.body['token'], undefined)
  assert.deepEqual((await call('/v1/tokens', { token: 'alice' })).body['tokens'], [])
  assert.equal(ledger.entries.length, 0)
})

test('a cap below the initial supply is refused at the order, not at the deploy', { skip }, async () => {
  // The other half of the same rule, and the one a caller is likeliest to hit: a cap that exists
  // but is smaller than the supply the contract mints in its constructor.
  const res = await call('/v1/tokens', {
    method: 'POST',
    token: 'alice',
    body: { ...ORDER, features: ['mintable', 'burnable', 'pausable'], cap: '1000' },
  })
  assert.equal(res.status, 400)
  assert.equal((res.body['error'] as Record<string, unknown>)['field'], 'cap')
  assert.equal(ledger.entries.length, 0)
})

test('a cap on a variant whose contract takes none is refused too', { skip }, async () => {
  // Uncapped BY DESIGN is a fact the project page reports. Accepting a nominal ceiling here and
  // discarding it at the deploy would make that page lie about the token it describes.
  const res = await call('/v1/tokens', {
    method: 'POST',
    token: 'alice',
    body: { ...ORDER, features: ['mintable', 'burnable'], cap: '2000000000000000000000000' },
  })
  assert.equal(res.status, 400)
  assert.equal((res.body['error'] as Record<string, unknown>)['field'], 'cap')
  assert.match(String((res.body['error'] as Record<string, unknown>)['message']), /takes no cap/)
  assert.equal(ledger.entries.length, 0)
})

test('a foundry order with a cap at or above its supply is accepted, and is payable', { skip }, async () => {
  // The gate refuses what cannot be built and nothing else. Without this the three tests above
  // would pass against a route that refused every capped order.
  const created = await call('/v1/tokens', {
    method: 'POST',
    token: 'alice',
    body: {
      ...ORDER,
      features: ['mintable', 'burnable', 'pausable'],
      cap: '2000000000000000000000000',
    },
  })
  assert.equal(created.status, 201)
  const id = (created.body['token'] as Record<string, unknown>)['id'] as string
  const paid = await call(`/v1/tokens/${id}/pay`, { method: 'POST', token: 'alice' })
  assert.equal(paid.status, 201)
  assert.equal(ledger.entries.length, 1)
})

test('a supply sent as a JSON number is refused rather than rounded', { skip }, async () => {
  const res = await call('/v1/tokens', {
    method: 'POST',
    token: 'alice',
    body: { ...ORDER, supply: 1e24 },
  })
  assert.equal(res.status, 400)
})

test('paying an order debits once and moves it to paid', { skip }, async () => {
  const created = await call('/v1/tokens', { method: 'POST', token: 'alice', body: ORDER })
  const id = (created.body['token'] as Record<string, unknown>)['id'] as string
  const paid = await call(`/v1/tokens/${id}/pay`, { method: 'POST', token: 'alice' })
  assert.equal(paid.status, 201)
  assert.equal((paid.body['token'] as Record<string, unknown>)['status'], 'paid')
  assert.equal(ledger.entries.length, 1)

  // A retry replays rather than debiting again, and says so.
  const again = await call(`/v1/tokens/${id}/pay`, { method: 'POST', token: 'alice' })
  assert.equal(again.status, 409, 'an already-paid order is a state conflict, not a second debit')
  assert.equal(ledger.entries.length, 1)
})

test('another user\'s order is a 404, never a 403', { skip }, async () => {
  const created = await call('/v1/tokens', { method: 'POST', token: 'alice', body: ORDER })
  const id = (created.body['token'] as Record<string, unknown>)['id'] as string
  assert.equal((await call(`/v1/tokens/${id}`, { token: 'bob' })).status, 404)
})

/* ------------------------------------------------------------------ THE 202 */

test('POST deploy answers 202 with a status URL and reaches no chain', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as Db)
  const res = await call(`/v1/tokens/${id}/deploy`, { method: 'POST', token: 'alice' })

  assert.equal(res.status, 202)
  assert.equal(res.headers.get('location'), `/v1/tokens/${id}`)
  assert.equal(res.body['statusUrl'], `/v1/tokens/${id}`)
  assert.equal(res.body['accepted'], true)

  // The work was enqueued, keyed on the CHAIN rather than on the row.
  assert.deepEqual(enqueued, [
    { kind: DEPLOY_KIND, key: 'ember:testnet', payload: { tokenId: id } },
  ])

  // Nothing moved. The job does that.
  const status = await call(`/v1/tokens/${id}`, { token: 'alice' })
  assert.equal((status.body['token'] as Record<string, unknown>)['status'], 'paid')
})

test('the status URL from a 202 is pollable and carries the attempt history', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as Db)
  const res = await call(`/v1/tokens/${id}/deploy`, { method: 'POST', token: 'alice' })
  const status = await call(res.body['statusUrl'] as string, { token: 'alice' })
  assert.equal(status.status, 200)
  assert.ok(Array.isArray(status.body['attempts']))
})

test('three clicks before the job runs produce one queued run', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as Db)
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call(`/v1/tokens/${id}/deploy`, { method: 'POST', token: 'alice' })).status, 202)
  }
  // `onConflict: 'keep'` collapses them on the queue's side; the route enqueues each time and the
  // queue is what de-duplicates. Asserted here as three enqueues of one (kind, key), which is the
  // shape the unique constraint collapses.
  assert.equal(new Set(enqueued.map((job) => `${job.kind} ${job.key}`)).size, 1)
})

test('an unpaid order cannot be deployed', { skip }, async () => {
  const created = await call('/v1/tokens', { method: 'POST', token: 'alice', body: ORDER })
  const id = (created.body['token'] as Record<string, unknown>)['id'] as string
  const res = await call(`/v1/tokens/${id}/deploy`, { method: 'POST', token: 'alice' })
  assert.equal(res.status, 409)
  assert.equal(enqueued.length, 0)
})

test('a failed deploy is not retried by pressing the button again', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as Db, {
    status: 'failed',
    failure_reason: 'the chain reverted it',
  })
  assert.equal((await call(`/v1/tokens/${id}/deploy`, { method: 'POST', token: 'alice' })).status, 409)
  assert.equal(enqueued.length, 0)
})

/* ------------------------------------------------------------------ the mainnet allowlist */

test('a mainnet deploy by a subject not on the allowlist is 403 and enqueues nothing', { skip }, async () => {
  // The frozen service gates mainnet on nothing at all, so any authenticated caller with a paid
  // order can put a contract on Ethereum mainnet at the platform's expense.
  const { id } = await seedToken(sql as unknown as Db, {
    network: 'mainnet',
    owner_subject: `user:${BOB}`,
  })
  const res = await call(`/v1/tokens/${id}/deploy`, { method: 'POST', token: 'bob' })
  assert.equal(res.status, 403)
  assert.equal(enqueued.length, 0)
})

test('an allowlisted subject may deploy to a mainnet', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as Db, { network: 'mainnet' })
  assert.equal((await call(`/v1/tokens/${id}/deploy`, { method: 'POST', token: 'alice' })).status, 202)
})

test('the allowlist does not touch testnet', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as Db, { owner_subject: `user:${BOB}` })
  assert.equal((await call(`/v1/tokens/${id}/deploy`, { method: 'POST', token: 'bob' })).status, 202)
})

/* ------------------------------------------------------------------ project pages */

test('a project page renders supply and authorities from the INDEXER, not the order', { skip }, async () => {
  // 04-domain-model §5.3. The order says what was asked for; the chain says what is true. This
  // token was ordered with a supply of 1e24 and the chain now reports 5e24 — a mintable token
  // doing its job. The page must show the chain's number.
  const contract = toChecksumAddress('0x00000000000000000000000000000000000000b2')
  const { id } = await seedToken(sql as unknown as Db, {
    status: 'deployed',
    contract_address: contract,
    deploy_tx_hash: '0xdead',
    broadcast_at: '2026-01-01T00:00:00Z',
  })
  indexer.setToken(contract, {
    contractAddress: contract,
    name: 'Ashfall',
    symbol: 'ASH',
    decimals: 18,
    totalSupply: '5000000000000000000000000',
    cap: null,
    owner: OWNER,
    mintAuthority: true,
    paused: false,
    observedAtBlock: 900,
  })

  const res = await call(`/v1/tokens/${id}/page`)
  assert.equal(res.status, 200)
  const onchain = res.body['onchain'] as Record<string, unknown>
  assert.equal(onchain['totalSupply'], '5000000000000000000000000')
  const risk = res.body['risk'] as Record<string, unknown>
  assert.equal(risk['hasMintAuthority'], true)
  assert.equal(risk['ownershipRenounced'], false)
  // The live supply exceeds the order's — a fact a buyer is entitled to, and the order record
  // could never have told them.
  assert.equal(risk['supplyExceedsOrder'], true)
})

test('an unindexed contract renders null, NEVER the order record standing in for it', { skip }, async () => {
  const contract = toChecksumAddress('0x00000000000000000000000000000000000000b3')
  const { id } = await seedToken(sql as unknown as Db, {
    status: 'deployed',
    contract_address: contract,
    deploy_tx_hash: '0xbeef',
    broadcast_at: '2026-01-01T00:00:00Z',
  })
  const res = await call(`/v1/tokens/${id}/page`)
  assert.equal(res.body['onchain'], null)
  assert.match(String(res.body['onchainUnavailable']), /not yet indexed/)
  // Null everywhere, not a cheerful default: "we have not observed this" and "this is false" are
  // different statements and a buyer is entitled to the difference.
  assert.deepEqual(res.body['risk'], {
    hasMintAuthority: null,
    ownershipRenounced: null,
    paused: null,
    supplyExceedsOrder: null,
  })
})

test('an indexer outage renders the page without the on-chain facts and says so', { skip }, async () => {
  const contract = toChecksumAddress('0x00000000000000000000000000000000000000b4')
  const { id } = await seedToken(sql as unknown as Db, {
    status: 'deployed',
    contract_address: contract,
    deploy_tx_hash: '0xcafe',
    broadcast_at: '2026-01-01T00:00:00Z',
  })
  indexer.setUnavailable(true)
  const res = await call(`/v1/tokens/${id}/page`)
  assert.equal(res.status, 200)
  assert.equal(res.body['onchain'], null)
  assert.match(String(res.body['onchainUnavailable']), /unavailable/)
  indexer.setUnavailable(false)
})

test('a project page is public: a shop nobody can read cannot do its job', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as Db)
  assert.equal((await call(`/v1/tokens/${id}/page`)).status, 200)
})

/* ------------------------------------------------------------------ shape */

test('every error carries the request id, in the body as well as the header', { skip }, async () => {
  const res = await call('/v1/tokens/does-not-exist', { token: 'alice' })
  assert.equal(res.status, 404)
  const error = res.body['error'] as Record<string, unknown>
  assert.equal(error['requestId'], res.headers.get('x-request-id'))
})

test('an unmatched path collapses to one metric label', { skip }, async () => {
  await call('/v1/nope/12345')
  const metrics = await (await fetch(`${baseUrl}/metrics`)).text()
  assert.match(metrics, /route="unmatched"/)
  assert.doesNotMatch(metrics, /route="\/v1\/nope\/12345"/)
})

/* ═════════════════════════════ the wire, after migration 6 ═════════════════════════════ */

test('the catalogue quotes US cents and names what it settles in', { skip }, async () => {
  const res = await call('/v1/catalogue', {})
  assert.equal(res.status, 200)
  assert.equal(res.body['priceUsdCents'], '2500')
  // Published rather than assumed by the client. A surface that had to guess would guess wrong the
  // day it changes, and guessing wrong about a unit is how a screen ends up printing a price in a
  // currency the ledger does not record.
  assert.equal(res.body['settlementAsset'], 'EMBER')
  // Removed, not renamed. A stale client reading `priceShards` gets `undefined` — something it can
  // notice — rather than a number silently re-based into a different unit.
  assert.equal(res.body['priceShards'], undefined)
})

test('a paid order reports what was quoted AND what was taken', { skip }, async () => {
  const created = await call('/v1/tokens', { method: 'POST', token: 'alice', body: ORDER })
  const id = (created.body['token'] as Record<string, unknown>)['id'] as string

  const paid = await call(`/v1/tokens/${id}/pay`, { method: 'POST', token: 'alice' })
  // 201 on a fresh debit, 200 on a replay — see the route.
  assert.equal(paid.status, 201)
  const token = paid.body['token'] as Record<string, unknown>

  assert.equal(token['priceUsdCents'], '2500')
  assert.equal(token['chargeAssetCode'], 'EMBER')
  // $25.00 at the fixture rate of $0.25/EMBER is 100 EMBER, in wei. A decimal STRING: 1e20 does not
  // survive a JSON number.
  assert.equal(token['chargeAmount'], '100000000000000000000')
  // A Spark is 10^-6 EMBER — a DISPLAY denomination of one asset, never a second asset code — so
  // WEI_PER_SPARK is 10^12 and 100 EMBER is 10^8 Sparks. Written out rather than computed from the
  // line above, because a test that divides by the same constant the code divides by would agree
  // with a wrong constant.
  assert.equal(token['chargeAmountSparks'], '100000000')
  // The rate, so the two amounts above can be checked against each other afterwards.
  assert.equal(token['rateUsdScaled'], '250000')
  assert.equal(token['priceShards'], undefined)
})

/**
 * One handle, presented as the per-network selector the server now takes. The fixture runs against
 * a single test database, so mainnet is the only configured network — which exercises the REFUSAL
 * path for free: anything reaching for testnet throws rather than reusing this handle.
 */
export function singleNetworkSql(db: unknown) {
  return networkSql({ mainnet: db as RuntimeSql })
}
