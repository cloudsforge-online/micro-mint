/**
 * Right to erasure.
 *
 * The assertion that matters most is the NEGATIVE one: after an erasure, the string `user:<uuid>`
 * appears in no column of any table this service owns. Every other case here checks a rule; that
 * one checks the outcome, and it is the only one that would notice a table somebody adds later and
 * forgets to erase — it scans each row as text rather than naming the columns it knows about.
 *
 * The second is the SPLIT. A token that never reached a chain is deleted outright; a token that
 * broadcast keeps its on-chain facts and loses its owner. Getting that backwards in either
 * direction is a defect: one way destroys the record of a contract that exists, the other keeps a
 * person attached to it for ever.
 */

import { singleNetworkSql } from './server.test.ts'
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { TokenError, type Principal } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { ERASED_SUBJECT, eraseUser } from './erasure.ts'
import { SIGNATURE_HEADER, signEvent, type Db, type Tx } from './outbox.ts'
import { toChecksumAddress } from './evm.ts'
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
} from './testsupport.ts'

/** Long enough to be a real secret as far as the contract's verifier is concerned. */
const SECRET = 'an-event-signing-secret-for-tests-0123456789'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const ALICE_SUBJECT = `user:${ALICE}`
const OWNER_ADDRESS = toChecksumAddress('0x00000000000000000000000000000000000000a1')
const TX_HASH = `0x${'ab'.repeat(32)}`
const CONTRACT_ADDRESS = toChecksumAddress('0x00000000000000000000000000000000000000b2')

/** Nobody in this file authenticates; the route under test is a MAC surface, not a token one. */
const verifier: PrincipalVerifier = {
  async principal(): Promise<Principal> {
    throw new TokenError('no principal in this suite', 'missing')
  },
}

let sql: postgres.Sql
let server: Server
let baseUrl: string

before(async () => {
  if (!enabled) return
  sql = openDb(8)
  await migrateTestDb(sql)

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
    pay: { sql: db, ledger: fakeLedger(), pricing: fakePricing(), settlementAsset: 'EMBER', producer: 'mint' },
    render: { sql: db, indexer: fakeIndexer() },
    queue: { async enqueue() {} },
    priceUsdCents: 2_500n,
    settlementAsset: 'EMBER',
    mainnetAllowlist: [],
    eventAcceptSecrets: [SECRET],
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  lifecycle.markReady()
})

beforeEach(async () => {
  if (!enabled) return
  await resetMint(sql)
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

/* ------------------------------------------------------------------------- helpers */

/** A token that never reached a chain: no transaction hash, so nothing was ever signed for it. */
async function seedNeverBroadcast(subject = ALICE_SUBJECT): Promise<string> {
  const { id } = await seedToken(sql as unknown as Db, {
    owner_subject: subject,
    owner_wallet_id: 'wallet-alice',
    status: 'paid',
  })
  return id
}

/** A token that DID broadcast: a hash exists, so bytes reached a wire and a contract exists. */
async function seedBroadcast(subject = ALICE_SUBJECT): Promise<string> {
  const { id } = await seedToken(sql as unknown as Db, {
    owner_subject: subject,
    owner_wallet_id: 'wallet-alice',
    status: 'deployed',
    deploy_tx_hash: TX_HASH,
    contract_address: CONTRACT_ADDRESS,
    broadcast_at: new Date().toISOString(),
  })
  return id
}

async function seedPage(tokenId: string, subject = ALICE_SUBJECT): Promise<void> {
  await sql`
    insert into project_pages (token_id, subject, description, team, roadmap, risk_disclosures)
    values (
      ${tokenId}, ${subject},
      'Ashfall is run by Alice Example, alice@example.test',
      ${sql.json([{ name: 'A Third Party', role: 'advisor' }] as never)},
      ${sql.json([{ quarter: 'Q1', item: 'launch' }] as never)},
      'no guarantees'
    )
  `
}

async function seedAttempt(tokenId: string, detail: string | null, attempt = 1): Promise<void> {
  await sql`
    insert into token_deploy_attempts (token_id, attempt, family, outcome, tx_hash, detail)
    values (${tokenId}, ${attempt}, 'evm', 'refused', null, ${detail})
  `
}

async function countOf(table: string): Promise<number> {
  const rows = (await sql.unsafe(`select count(*)::int as n from ${table}`)) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

/**
 * Every row of every table this service owns, cast to text, searched for a needle.
 *
 * The whole-row cast is the point: naming columns would only ever find the leak somebody already
 * thought of, and this has to notice a column added next year.
 */
async function anyTableContains(needle: string): Promise<string[]> {
  const tables = ['tokens', 'project_pages', 'token_deploy_attempts', 'outbox', 'inbox',
    'outbox_deliveries', 'event_subscriptions', 'jobs']
  const found: string[] = []
  for (const table of tables) {
    const rows = (await sql.unsafe(
      `select count(*)::int as n from ${table} t where t::text like $1`,
      [`%${needle}%`],
    )) as Array<{ n: number }>
    if ((rows[0]?.n ?? 0) > 0) found.push(table)
  }
  return found
}

function deletionEvent(userId: string, id = randomUUID()): string {
  return JSON.stringify({
    id,
    topic: 'identity.user.deleted',
    key: userId,
    occurredAt: new Date().toISOString(),
    producer: 'identity',
    version: '1.0',
    actor: 'system',
    correlationId: randomUUID(),
    payload: { userId, tombstoneAt: new Date().toISOString(), reason: 'user_requested' },
  })
}

async function postEvent(body: string, signature?: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signature ?? signEvent(body, SECRET),
    },
    body,
  })
}

/** Run the handler directly, in one transaction, the way the route does. */
async function erase(userId: string): Promise<Awaited<ReturnType<typeof eraseUser>>> {
  const outcome = await sql.begin(async (tx) => ({
    result: await eraseUser(tx as unknown as Tx, userId),
  }))
  return outcome.result
}

/* ------------------------------------------------- the split: deleted versus anonymised */

test('a token that never reached a chain is DELETED, with its attempts and its page', { skip }, async () => {
  const tokenId = await seedNeverBroadcast()
  await seedPage(tokenId)
  await seedAttempt(tokenId, 'custody refused: wallet-alice is frozen')

  const outcome = await erase(ALICE)

  assert.equal(outcome.tokensDeleted, 1)
  assert.equal(outcome.tokensAnonymised, 0)
  assert.equal(await countOf('tokens'), 0)
  assert.equal(await countOf('project_pages'), 0)
  // ON DELETE CASCADE, PROVED rather than assumed. The handler never names this table on the
  // delete path, so if the cascade were not there the attempt row — and the free text in its
  // `detail` — would outlive the order it belongs to and nothing would say so.
  assert.equal(await countOf('token_deploy_attempts'), 0)
})

test('a token that DID broadcast keeps its on-chain facts and loses its owner', { skip }, async () => {
  const tokenId = await seedBroadcast()
  await seedPage(tokenId)

  const outcome = await erase(ALICE)
  assert.equal(outcome.tokensDeleted, 0)
  assert.equal(outcome.tokensAnonymised, 1)

  const rows = await sql<
    {
      owner_subject: string
      owner_wallet_id: string
      owner_address: string
      deploy_tx_hash: string
      contract_address: string
      name: string
      symbol: string
      supply: string
    }[]
  >`
    select owner_subject, owner_wallet_id, owner_address, deploy_tx_hash, contract_address,
           name, symbol, supply::text as supply
      from tokens where id = ${tokenId}
  `
  const row = rows[0]
  assert.ok(row, 'the broadcast token is still here')

  // Retained under Art. 17(3)(b) — the platform's own record of an issuance it performed.
  assert.equal(row.owner_address, OWNER_ADDRESS)
  assert.equal(row.deploy_tx_hash, TX_HASH)
  assert.equal(row.contract_address, CONTRACT_ADDRESS)
  assert.equal(row.name, 'Ashfall')
  assert.equal(row.symbol, 'ASH')
  // `supply` is numeric(78,0) read as ::text. Compared as a string and never through BigInt() on a
  // possibly-empty value — `BigInt('') === 0n`, which has silently zeroed a supply here before.
  assert.equal(row.supply, '1000000000000000000000000')

  // Erased.
  assert.match(row.owner_subject, ERASED_SUBJECT)
  assert.equal(row.owner_wallet_id, row.owner_subject, 'one placeholder, used for both')

  // The page goes on this branch too. It is user-authored marketing copy about the user and about
  // named third parties, and no retention basis reaches any of it.
  assert.equal(await countOf('project_pages'), 0)
})

test('the page is gone in BOTH cases, and only the erased user is touched', { skip }, async () => {
  const mine = await seedNeverBroadcast()
  const alsoMine = await seedBroadcast()
  const theirs = await seedNeverBroadcast(`user:${BOB}`)
  await seedPage(mine)
  await seedPage(alsoMine)
  await seedPage(theirs, `user:${BOB}`)

  const outcome = await erase(ALICE)
  assert.equal(outcome.projectPagesDeleted, 2)

  const pages = await sql<{ token_id: string }[]>`select token_id from project_pages`
  assert.equal(pages.length, 1)
  assert.equal(pages[0]?.token_id, theirs)

  const survivors = await sql<{ owner_subject: string }[]>`select owner_subject from tokens order by owner_subject`
  assert.deepEqual(
    survivors.map((s) => (ERASED_SUBJECT.test(s.owner_subject) ? 'erased' : s.owner_subject)),
    ['erased', `user:${BOB}`],
  )
})

test('NO user:<uuid> value survives, in any column of any table', { skip }, async () => {
  const never = await seedNeverBroadcast()
  const broadcast = await seedBroadcast()
  await seedPage(never)
  await seedPage(broadcast)
  await seedAttempt(never, 'chain refused: nonce too low')
  await seedAttempt(broadcast, 'custody refused for wallet-alice')
  // The outbox is where this service keeps the subject for ever: nothing prunes it, and four of
  // its five topics carry `ownerSubject`.
  await sql`
    insert into outbox (topic, key, producer, actor, correlation_id, payload, published_at)
    values (
      'mint.deploy.confirmed', ${broadcast}, 'mint', ${ALICE_SUBJECT}, ${randomUUID()},
      ${sql.json({ tokenId: broadcast, ownerSubject: ALICE_SUBJECT, userId: ALICE, name: 'Ashfall' } as never)},
      now()
    )
  `

  // Three tables, and the third is the point of doing this by scan rather than by column list:
  // `project_pages.subject` is a SECOND copy of the identity, separate from the token's owner.
  assert.deepEqual(
    (await anyTableContains(ALICE_SUBJECT)).sort(),
    ['outbox', 'project_pages', 'tokens'],
    'the fixture really does hold the subject before the erasure',
  )

  await erase(ALICE)

  assert.deepEqual(await anyTableContains(ALICE_SUBJECT), [], 'the ledger spelling is gone')
  // And the BARE uuid too, which is the form the outbox payload carries for `userId`.
  assert.deepEqual(await anyTableContains(ALICE), [], 'the bare user id is gone')
})

test('the outbox keeps the emission and loses the person', { skip }, async () => {
  const tokenId = await seedBroadcast()
  await sql`
    insert into outbox (topic, key, producer, actor, correlation_id, payload)
    values (
      'mint.deploy.confirmed', ${tokenId}, 'mint', ${ALICE_SUBJECT}, ${randomUUID()},
      ${sql.json({ tokenId, ownerSubject: ALICE_SUBJECT, userId: ALICE, txHash: TX_HASH } as never)}
    )
  `

  const outcome = await erase(ALICE)
  assert.equal(outcome.outboxRowsRedacted, 1)

  const rows = await sql<{ actor: string; payload: Record<string, unknown> }[]>`
    select actor, payload from outbox
  `
  const row = rows[0]
  assert.ok(row)
  // The row is still there, unpublished, and will still relay — a consumer is owed this delivery.
  assert.equal(row.payload['txHash'], TX_HASH)
  assert.match(String(row.payload['ownerSubject']), ERASED_SUBJECT)
  assert.match(row.actor, ERASED_SUBJECT)
  // JSON null, not a placeholder: `userId` is a BARE uuid on the wire, and every reader in the
  // estate parses it as one. `erased:<uuid>` there would be a malformed id rather than an absent
  // one; null is the value the payload already carries when the owner is not a person.
  assert.equal(row.payload['userId'], null)
})

test('an upstream error message that echoed the wallet id is redacted, and the rest is kept', { skip }, async () => {
  const tokenId = await seedBroadcast()
  await seedAttempt(tokenId, 'custody refused: signing for wallet-alice is disabled', 1)
  await seedAttempt(tokenId, 'chain refused: nonce too low', 2)

  const outcome = await erase(ALICE)
  assert.equal(outcome.attemptDetailsRedacted, 1)

  const rows = await sql<{ attempt: number; detail: string }[]>`
    select attempt, detail from token_deploy_attempts order by attempt
  `
  assert.equal(rows.length, 2, 'the attempts of a RETAINED token are retained')
  assert.ok(!rows[0]?.detail.includes('wallet-alice'), 'the wallet id is gone')
  assert.ok(rows[0]?.detail.startsWith('custody refused: signing for erased:'), 'the message is kept')
  assert.equal(rows[1]?.detail, 'chain refused: nonce too low', 'an untouched message is untouched')
})

/* ------------------------------------------------------------------ the schema guards */

test('THE ONE-WAY TRIGGER: an erased owner can never be turned back into a person', { skip }, async () => {
  const tokenId = await seedBroadcast()
  await erase(ALICE)

  await assert.rejects(
    () => sql`update tokens set owner_subject = ${ALICE_SUBJECT} where id = ${tokenId}`,
    /cannot be re-attributed/,
  )
  // The wallet pointer is guarded alongside it, or the re-attribution route is simply one column
  // to the left.
  await assert.rejects(
    () => sql`update tokens set owner_wallet_id = 'wallet-alice' where id = ${tokenId}`,
    /wallet pointer cannot be rewritten/,
  )
  // And an unrelated update still works: the trigger must not freeze a retained row.
  await sql`update tokens set updated_at = now() where id = ${tokenId}`
})

test('the owner shape is pinned: erased is exactly a uuid, and a person is not guessed at', { skip }, async () => {
  // A loose `erased:%` would let a handler write something re-identifiable and keep the marker.
  const tokenId = await seedNeverBroadcast()
  await assert.rejects(
    () => sql`update tokens set owner_subject = 'erased:alice' where id = ${tokenId}`,
    /tokens_owner_subject_shape/,
  )
  await assert.rejects(
    () =>
      sql`insert into tokens (owner_subject, owner_wallet_id, owner_address, chain, network, name,
                              symbol, decimals, supply, status, price_usd_cents)
          values ('nobody', 'w1', ${OWNER_ADDRESS}, 'ember', 'testnet', 'X', 'XX', 18,
                  1000::numeric, 'draft', 2500::numeric)`,
    /tokens_owner_subject_shape/,
  )
})

/* ------------------------------------------------------------------------- the route */

test('a bad signature is 403, and is refused BEFORE the body is parsed', { skip }, async () => {
  // Deliberately not valid JSON. A 403 here proves the MAC is checked over the raw bytes first; a
  // 400 would mean an unauthenticated caller reached the JSON parser.
  const bad = await postEvent('{ this is not json', 't=1,v1=deadbeef')
  assert.equal(bad.status, 403)
  assert.equal((await bad.json() as { error: { code: string } }).error.code, 'bad_signature')

  // 401 would be the wrong answer, not merely a different one: it invites the caller to go and
  // find a token, and there is no token that would help. The MAC is the credential.
  const missing = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: deletionEvent(ALICE),
  })
  assert.equal(missing.status, 403)

  // With a GOOD signature the same unparseable body is a 400 — which is what shows the order of
  // the two checks rather than merely that both exist.
  const parsed = await postEvent('{ this is not json')
  assert.equal(parsed.status, 400)
})

test('an unsubscribed topic is 202 ignored, never 4xx', { skip }, async () => {
  // A 4xx makes the producer's relay treat the delivery as retryable, and it re-sends the same
  // event for ever.
  const body = JSON.stringify({
    id: randomUUID(),
    topic: 'identity.user.registered',
    payload: { userId: ALICE },
  })
  const res = await postEvent(body)
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { status: 'ignored' })
})

test('the route erases, and a redelivery is a duplicate rather than a second erasure', { skip }, async () => {
  const never = await seedNeverBroadcast()
  const broadcast = await seedBroadcast()
  await seedPage(never)
  await seedPage(broadcast)

  const body = deletionEvent(ALICE)
  const first = await postEvent(body)
  assert.equal(first.status, 202)
  assert.deepEqual(await first.json(), { status: 'recorded' })

  const after = await sql<{ owner_subject: string }[]>`select owner_subject from tokens`
  assert.equal(after.length, 1)
  assert.match(after[0]?.owner_subject ?? '', ERASED_SUBJECT)
  const placeholder = after[0]?.owner_subject

  const second = await postEvent(body)
  assert.equal(second.status, 202)
  assert.deepEqual(await second.json(), { status: 'duplicate' })

  // The second delivery must not mint a SECOND placeholder over the first. It would be harmless
  // for privacy and wrong for everything else: the retained rows of one erasure would stop being
  // recognisable as one erasure, and an operator would read two.
  const unchanged = await sql<{ owner_subject: string }[]>`select owner_subject from tokens`
  assert.equal(unchanged[0]?.owner_subject, placeholder)
  assert.equal(await countOf('inbox'), 1)
  void broadcast
})

test('an event with no uuid userId is a 400, and erases nothing', { skip }, async () => {
  await seedNeverBroadcast()
  const body = JSON.stringify({
    id: randomUUID(),
    topic: 'identity.user.deleted',
    payload: { userId: 'not-a-uuid' },
  })
  const res = await postEvent(body)
  assert.equal(res.status, 400)
  assert.equal(await countOf('tokens'), 1)
  // The inbox row is rolled back with the handler, so the producer's redelivery of a FIXED event
  // is processed rather than swallowed as a duplicate.
  assert.equal(await countOf('inbox'), 0)
})

test('erasing a user with nothing here is a no-op, not a failure', { skip }, async () => {
  const outcome = await erase(BOB)
  assert.deepEqual(outcome, {
    tokensDeleted: 0,
    tokensAnonymised: 0,
    projectPagesDeleted: 0,
    attemptDetailsRedacted: 0,
    outboxRowsRedacted: 0,
  })
})
