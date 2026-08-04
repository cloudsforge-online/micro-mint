/**
 * Payment, and the defect it fixes.
 *
 * The frozen service debits Shards and THEN writes `status: 'paid'` as a separate, unguarded,
 * non-transactional statement. A process that dies in the gap has charged the customer and left
 * the order in `awaiting_payment` with no compensation. These tests are the proof that the two
 * writes are now one.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { InsufficientBalanceError, OrderStateError, payForDeploy } from './orders.ts'
import { LedgerRefusedError, LedgerUnavailableError, orderIdempotencyKey } from './ledgerclient.ts'
import { createToken } from './tokens.ts'
import { toChecksumAddress } from './evm.ts'
import type { Db } from './outbox.ts'
import {
  FAKE_RATE_USD_SCALED,
  enabled,
  fakeLedger,
  fakePricing,
  migrateTestDb,
  openDb,
  resetMint,
  skip,
  type FakeLedger,
  type FakePricing,
} from './testsupport.ts'

let sql: postgres.Sql
let db: Db
let ledger: FakeLedger
let pricing: FakePricing

const SUBJECT = 'user:11111111-1111-4111-8111-111111111111'
const OWNER = toChecksumAddress('0x00000000000000000000000000000000000000a1')

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetMint(sql)
  ledger = fakeLedger()
  pricing = fakePricing()
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

async function order(): Promise<string> {
  const token = await createToken(db, 'mint', {
    ownerSubject: SUBJECT,
    ownerWalletId: 'w1',
    ownerAddress: OWNER,
    chain: 'ember',
    network: 'testnet',
    name: 'Ashfall',
    symbol: 'ASH',
    decimals: 18,
    supply: 1_000_000n,
    cap: null,
    features: [],
    metadataUri: null,
    brandKitId: null,
    priceUsdCents: 2_500n,
    actor: `user:${SUBJECT}`,
    correlationId: 'req-1',
  })
  return token.id
}

function deps() {
  return { sql: db, ledger, pricing, settlementAsset: 'EMBER' as const, producer: 'mint' }
}

/**
 * What 2,500 cents settles to at the fixture rate: $25.00 at $0.25/EMBER is 100 EMBER, in wei.
 *
 * Written out rather than recomputed with the same call the code under test uses. A test that
 * derived the expected value from `coinAmountForUsdCents` would agree with a wrong implementation
 * of it, which is exactly the eighteen-orders-of-magnitude mistake this area is prone to.
 */
const EXPECTED_CHARGE_WEI = 100_000_000_000_000_000_000n

test('a paid order carries the entry that paid for it', { skip }, async () => {
  const id = await order()
  const result = await payForDeploy(deps(), {
    tokenId: id,
    ownerSubject: SUBJECT,
    actor: `user:${SUBJECT}`,
    correlationId: 'req-2',
  })
  assert.equal(result.token.status, 'paid')
  assert.equal(result.token.paidJournalEntryId, result.journalEntryId)
  assert.equal(result.replayed, false)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.entries[0]?.kind, 'purchase')
})

test('the entry is balanced: the customer out, the platform in, same number', { skip }, async () => {
  const id = await order()
  await payForDeploy(deps(), {
    tokenId: id,
    ownerSubject: SUBJECT,
    actor: `user:${SUBJECT}`,
    correlationId: 'req-2',
  })
  const postings = ledger.entries[0]?.postings ?? []
  assert.equal(postings.length, 2)
  assert.equal(postings[0]?.direction, 'debit')
  assert.equal(postings[0]?.account.subject, SUBJECT)
  assert.equal(postings[1]?.direction, 'credit')
  assert.equal(postings[1]?.account.subject, 'platform')
  assert.equal(postings[0]?.amount, postings[1]?.amount)
  assert.equal(postings[0]?.amount, EXPECTED_CHARGE_WEI)
  // And in EMBER, not the retired unit this service charged until migration 6.
  assert.equal(postings[0]?.assetCode, 'EMBER')
  assert.equal(postings[0]?.account.assetCode, 'EMBER')
  assert.equal(postings[1]?.assetCode, 'EMBER')
})

test('the idempotency key is DERIVED from the order, not random', { skip }, async () => {
  // This is the whole recovery story: a transaction that posts and then rolls back cannot post
  // again on the retry, because the ledger recognises the key and replays its stored answer.
  const id = await order()
  await payForDeploy(deps(), {
    tokenId: id,
    ownerSubject: SUBJECT,
    actor: `user:${SUBJECT}`,
    correlationId: 'req-2',
  })
  assert.deepEqual(ledger.keys, [orderIdempotencyKey(id)])
})

/**
 * **THE HEADLINE.** The ledger call and the state change are one transaction.
 *
 * The ledger is made to post successfully and the local write is then made to fail, which is
 * exactly the shape of the frozen defect — money moved, order not updated. Here the whole
 * transaction rolls back, so the order is still `awaiting_payment`, AND the retry does not debit
 * twice: the derived key replays the entry the first attempt posted.
 */
test('a local failure after a successful post rolls back, and the retry does NOT double-debit', { skip }, async () => {
  const id = await order()

  // The ledger posts and the process then dies before the local commit. That is precisely the
  // frozen service's gap, reproduced: the debit has happened and nothing local has.
  //
  // The failure is raised from inside `postEntry` AFTER the entry is recorded, rather than by
  // mutating the row from another connection. The latter is what this test did first, and it
  // deadlocked — the outer UPDATE waited on the `select … for update` the transaction was holding,
  // and the transaction waited on the outer UPDATE. That deadlock is itself the row lock working,
  // but it makes a poor test.
  const poisoned = {
    ...deps(),
    ledger: {
      async postEntry(request: Parameters<FakeLedger['postEntry']>[0]) {
        await ledger.postEntry(request)
        throw new Error('the process died between the ledger COMMIT and ours')
      },
    },
  }

  await assert.rejects(
    () =>
      payForDeploy(poisoned, {
        tokenId: id,
        ownerSubject: SUBJECT,
        actor: `user:${SUBJECT}`,
        correlationId: 'req-2',
      }),
    /died between/,
  )

  // The order did not move. In the frozen service the customer would be charged and stranded here.
  const rows = await sql<{ status: string; paid_journal_entry_id: string | null }[]>`
    select status, paid_journal_entry_id from tokens where id = ${id}
  `
  assert.equal(rows[0]?.status, 'awaiting_payment')
  assert.equal(rows[0]?.paid_journal_entry_id, null)

  // And the retry replays rather than debiting again. One entry, ever.
  const retried = await payForDeploy(deps(), {
    tokenId: id,
    ownerSubject: SUBJECT,
    actor: `user:${SUBJECT}`,
    correlationId: 'req-3',
  })
  assert.equal(retried.replayed, true, 'the second attempt replayed rather than posting')
  assert.equal(ledger.entries.length, 1, 'exactly one entry was ever posted')
  assert.equal(retried.token.status, 'paid')
})

test('two concurrent payments produce one debit and one paid order', { skip }, async () => {
  const id = await order()
  const request = {
    tokenId: id,
    ownerSubject: SUBJECT,
    actor: `user:${SUBJECT}`,
    correlationId: 'req-2',
  }
  const results = await Promise.allSettled([
    payForDeploy(deps(), request),
    payForDeploy(deps(), request),
  ])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  // The `select … for update` serialises them, so the second finds the row already `paid` and is
  // refused on state — it never reaches the ledger a second time.
  assert.equal(fulfilled.length, 1)
  assert.equal(ledger.entries.length, 1)
})

test('an insufficient balance is a 402-shaped answer, not an error', { skip }, async () => {
  const id = await order()
  ledger.failNext(new LedgerRefusedError(402, 'insufficient_balance', 'not enough shards'))
  await assert.rejects(
    () =>
      payForDeploy(deps(), {
        tokenId: id,
        ownerSubject: SUBJECT,
        actor: `user:${SUBJECT}`,
        correlationId: 'req-2',
      }),
    InsufficientBalanceError,
  )
  const rows = await sql<{ status: string }[]>`select status from tokens where id = ${id}`
  assert.equal(rows[0]?.status, 'awaiting_payment', 'a refused payment leaves the order payable')
})

test('an unreachable ledger leaves the order payable and posts nothing', { skip }, async () => {
  const id = await order()
  ledger.failNext(new LedgerUnavailableError('connect ECONNREFUSED'))
  await assert.rejects(() =>
    payForDeploy(deps(), {
      tokenId: id,
      ownerSubject: SUBJECT,
      actor: `user:${SUBJECT}`,
      correlationId: 'req-2',
    }),
  )
  const rows = await sql<{ status: string }[]>`select status from tokens where id = ${id}`
  assert.equal(rows[0]?.status, 'awaiting_payment')
  assert.equal(ledger.entries.length, 0)
})

test('paying somebody else\'s order is a not-found, never a 403', { skip }, async () => {
  // "Does not exist" and "is not yours" are the same answer on purpose: a distinct refusal for the
  // second is an oracle that lets a caller enumerate which order ids exist.
  const id = await order()
  await assert.rejects(
    () =>
      payForDeploy(deps(), {
        tokenId: id,
        ownerSubject: 'user:22222222-2222-4222-8222-222222222222',
        actor: 'user:other',
        correlationId: 'req-2',
      }),
    (err: unknown) => err instanceof OrderStateError && err.status === 'not_found',
  )
  assert.equal(ledger.entries.length, 0)
})

test('the paid event is written in the same transaction as the state change', { skip }, async () => {
  const id = await order()
  await payForDeploy(deps(), {
    tokenId: id,
    ownerSubject: SUBJECT,
    actor: `user:${SUBJECT}`,
    correlationId: 'req-2',
  })
  const events = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
    select topic, payload from outbox where key = ${id} order by occurred_at
  `
  assert.deepEqual(
    events.map((e) => e.topic),
    ['mint.token.created', 'mint.token.paid'],
  )
  assert.equal(events[1]?.payload['priceUsdCents'], '2500')
})

/* ═══════════════════════════ priced in USD, settled in EMBER ═══════════════════════════ */

test('the order is priced in dollars and settled in EMBER at the published rate', { skip }, async () => {
  const id = await order()
  const result = await payForDeploy(deps(), {
    tokenId: id,
    ownerSubject: SUBJECT,
    actor: `user:${SUBJECT}`,
    correlationId: 'req-2',
  })

  // The quote was read once, for the settlement asset, and for nothing else.
  assert.deepEqual(pricing.asked, ['EMBER'])

  // BOTH amounts are on the row, and the rate that relates them. This is the whole point of the
  // three columns: a refund must return the EMBER that was TAKEN, not whatever today's
  // administered rate says $25.00 is worth — or a customer refunded across a rate change is
  // refunded the wrong amount. Without the rate the two numbers have no stated relationship and
  // nobody can tell a rate change from a bug.
  assert.equal(result.token.priceUsdCents, 2_500n)
  assert.equal(result.token.chargeAssetCode, 'EMBER')
  assert.equal(result.token.chargeAmount, EXPECTED_CHARGE_WEI)
  assert.equal(result.token.rateUsdScaled, FAKE_RATE_USD_SCALED)

  // The row must say what the POSTING said, and this pair is checked rather than assumed: a row
  // recording EMBER beside an entry denominated in something else is a receipt that does not match
  // the ledger, which is the exact failure the screens were refused a relabelling to avoid. It was
  // not caught by the assertions above when it was deliberately broken, so it is asserted here.
  const posting = ledger.entries[0]!.postings[0]!
  assert.equal(posting.assetCode, result.token.chargeAssetCode)
  assert.equal(posting.amount, result.token.chargeAmount)

  // And nothing Shard-shaped survives on the row.
  assert.equal(result.token.priceShards, null)
})

test('an unreadable rate refuses the payment and charges nothing', { skip }, async () => {
  // Fail closed. You cannot charge somebody in a currency you cannot price, and the only
  // alternative to refusing is guessing how much of their money to take. The coupling to
  // micro-pricing is real and it is the correct one — see `pricingclient.ts`.
  const id = await order()
  const { RateUnavailableError } = await import('./pricingclient.ts')
  pricing.failNext(new RateUnavailableError('the EMBER rate is not usable: stale'))

  await assert.rejects(
    () =>
      payForDeploy(deps(), {
        tokenId: id,
        ownerSubject: SUBJECT,
        actor: `user:${SUBJECT}`,
        correlationId: 'req-2',
      }),
    RateUnavailableError,
  )

  // Nothing posted, and the order is still payable. The rate is read BEFORE the transaction opens
  // precisely so that a failure here has nothing to unwind.
  assert.equal(ledger.entries.length, 0)
  const rows = await sql<{ status: string }[]>`select status from tokens where id = ${id}`
  assert.equal(rows[0]?.status, 'awaiting_payment')
})

test('an order quoted only in the retired unit is refused, never charged nothing', { skip }, async () => {
  // The row a pre-migration build writes during a rollout: a Shard price and no USD price. It must
  // not be payable, and the reason it is spelled with an explicit null check rather than
  // `BigInt(price ?? '')` is that **`BigInt('') === 0n`** — the tidy version turns a missing price
  // into a FREE DEPLOY, which is a gas bill the platform pays for anyone who can open an order.
  const id = await order()
  await sql`update tokens set price_usd_cents = null, price_shards = 2500::numeric where id = ${id}`

  await assert.rejects(
    () =>
      payForDeploy(deps(), {
        tokenId: id,
        ownerSubject: SUBJECT,
        actor: `user:${SUBJECT}`,
        correlationId: 'req-2',
      }),
    (err: unknown) => err instanceof OrderStateError && /retired unit/.test(err.message),
  )
  assert.equal(ledger.entries.length, 0)
  assert.equal(pricing.asked.length, 0, 'a priceless order must not even reach the rate board')
})
