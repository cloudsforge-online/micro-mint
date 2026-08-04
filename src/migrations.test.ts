/**
 * The schema, and the three constraints that make a defect unrepresentable rather than unlikely.
 *
 * These run the REAL `MIGRATIONS` through the real migrator, on the real database, exactly as a
 * deploy does. A fixture schema would let the constraints drift out of the tests that are supposed
 * to prove they fire.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'
import { enabled, migrateTestDb, openDb, resetMint, skip, testDatabaseUrl } from './testsupport.ts'
import { toChecksumAddress } from './evm.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetMint(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

const OWNER = toChecksumAddress('0x00000000000000000000000000000000000000a1')

async function insert(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    status: 'paid',
    broadcast_at: null,
    deploy_tx_hash: null,
    contract_address: null,
    failure_reason: null,
    paid_journal_entry_id: 'entry-1',
    supply: '1000',
    cap: null,
    decimals: 18,
    ...overrides,
  }
  const rows = await sql<{ id: string }[]>`
    insert into tokens (
      owner_subject, owner_wallet_id, owner_address, chain, network, name, symbol, decimals,
      supply, cap, status, price_usd_cents, charge_asset_code, charge_amount, rate_usd_scaled,
      paid_journal_entry_id, broadcast_at, deploy_tx_hash,
      contract_address, failure_reason
    ) values (
      'user:1', 'w1', ${OWNER}, 'ember', 'testnet', 'Ashfall', 'ASH', ${row.decimals as number},
      ${row.supply as string}::numeric, ${row.cap as string | null}::numeric,
      ${row.status as string}, 2500::numeric,
      -- The charge is present exactly when the entry that made it is, because
      -- tokens_paid_records_charge says so: a paid order that cannot say what was TAKEN has
      -- nothing for a refund to return.
      ${row.paid_journal_entry_id === null ? null : 'EMBER'},
      ${row.paid_journal_entry_id === null ? null : '100000000000000000000'}::numeric,
      ${row.paid_journal_entry_id === null ? null : '250000'}::numeric,
      ${row.paid_journal_entry_id as string | null},
      ${row.broadcast_at as string | null}::timestamptz, ${row.deploy_tx_hash as string | null},
      ${row.contract_address as string | null}, ${row.failure_reason as string | null}
    )
    returning id
  `
  return rows[0]!.id
}

test('the migrator brings an empty database to SCHEMA_VERSION', { skip }, async () => {
  const rows = await sql<{ version: number }[]>`
    select max(version)::int as version from schema_migrations
  `
  assert.equal(rows[0]?.version, SCHEMA_VERSION)
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length)
})

test('every table the harness truncates actually exists', { skip }, async () => {
  for (const table of TABLES) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_name = ${table}
    `
    assert.equal(rows[0]?.n, 1, table)
  }
})

/**
 * **The Solana defect, as a constraint.**
 *
 * The frozen `deploySplToken` is called with no `onBroadcast` at all, so a broadcast that loses its
 * 90-second confirmation race writes `status: 'failed'` with a NULL transaction hash. The lease
 * predicate then matches a `failed` row immediately and the second attempt calls
 * `Keypair.generate()` afresh: two SPL mints, rent and fees paid twice, and no record of the first.
 *
 * Here the write cannot commit.
 */
test('tokens_broadcast_has_hash: a broadcast with no transaction hash is REFUSED', { skip }, async () => {
  await assert.rejects(
    () => insert({ broadcast_at: '2026-01-01T00:00:00Z', deploy_tx_hash: null }),
    /tokens_broadcast_has_hash/,
  )
})

test('tokens_broadcast_has_hash: the same write WITH a hash is accepted', { skip }, async () => {
  const id = await insert({ broadcast_at: '2026-01-01T00:00:00Z', deploy_tx_hash: '0xdead' })
  assert.ok(id)
})

test('tokens_broadcast_has_hash also fires on an UPDATE, not only on the insert', { skip }, async () => {
  const id = await insert()
  await assert.rejects(
    () => sql`update tokens set broadcast_at = now() where id = ${id}`,
    /tokens_broadcast_has_hash/,
  )
})

test('tokens_paid_before_broadcast: nothing reaches a chain that was not paid for', { skip }, async () => {
  await assert.rejects(
    () =>
      insert({
        paid_journal_entry_id: null,
        status: 'deploying',
        broadcast_at: '2026-01-01T00:00:00Z',
        deploy_tx_hash: '0xdead',
      }),
    /tokens_paid_before_broadcast/,
  )
})

test('tokens_terminal_is_complete: a deployed row must carry an address and a hash', { skip }, async () => {
  await assert.rejects(
    () => insert({ status: 'deployed', contract_address: null, deploy_tx_hash: null }),
    /tokens_terminal_is_complete/,
  )
  const id = await insert({
    status: 'deployed',
    contract_address: OWNER,
    deploy_tx_hash: '0xdead',
    broadcast_at: '2026-01-01T00:00:00Z',
  })
  assert.ok(id)
})

test('tokens_terminal_is_complete: a failed row must say why', { skip }, async () => {
  // A terminal state that says nothing is a terminal state an operator cannot act on.
  await assert.rejects(() => insert({ status: 'failed', failure_reason: null }), /tokens_terminal_is_complete/)
  assert.ok(await insert({ status: 'failed', failure_reason: 'the chain reverted it' }))
})

test('tokens_deploy_tx_hash_uniq: one transaction belongs to at most one token', { skip }, async () => {
  await insert({ broadcast_at: '2026-01-01T00:00:00Z', deploy_tx_hash: '0xsame' })
  await assert.rejects(
    () => insert({ broadcast_at: '2026-01-01T00:00:00Z', deploy_tx_hash: '0xsame' }),
    /tokens_deploy_tx_hash_uniq/,
  )
})

test('tokens_deploy_tx_hash_uniq is partial, so many rows may have no hash yet', { skip }, async () => {
  await insert()
  await insert()
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from tokens`
  assert.equal(rows[0]?.n, 2)
})

test('an unknown status is refused: the state machine is in the database too', { skip }, async () => {
  await assert.rejects(() => insert({ status: 'nearly_deployed' }), /tokens_status_known/)
})

test('a cap below the supply is refused', { skip }, async () => {
  await assert.rejects(() => insert({ supply: '1000', cap: '999' }), /tokens_cap_covers_supply/)
})

test('supply is numeric(78,0), so a 78-digit quantity survives a round trip exactly', { skip }, async () => {
  // The frozen schema stores this as TEXT. numeric is what lets the database enforce the
  // arithmetic; 78 digits is 2^256, the largest quantity an EVM chain can express.
  const huge = '9'.repeat(78)
  const id = await insert({ supply: huge })
  const rows = await sql<{ supply: string }[]>`select supply from tokens where id = ${id}`
  assert.equal(rows[0]?.supply, huge)
})

test('an attempt records the same outcome once, and different outcomes freely', { skip }, async () => {
  const id = await insert()
  const write = (outcome: string) => sql`
    insert into token_deploy_attempts (token_id, attempt, family, outcome)
    values (${id}, 1, 'evm', ${outcome})
  `
  await write('signed')
  await write('broadcast')
  await assert.rejects(() => write('signed'), /token_deploy_attempts_uniq/)
})

/* ══════════════════════════════════ migration 6: SHARDS OUT ══════════════════════════════════ */

/**
 * The raw INSERT the guards below are aimed at.
 *
 * Deliberately NOT `insert()` above and NOT `seedToken` in `testsupport.ts`: both of those set the
 * columns this service now writes, and a test that could only produce a well-formed row could not
 * prove anything about a malformed one. This is the shape a psql session, a later migration, or a
 * build that had not been updated would produce.
 */
async function rawOrder(columns: Record<string, string | null>): Promise<void> {
  const names = ['owner_subject', 'owner_wallet_id', 'owner_address', 'chain', 'network', 'name',
    'symbol', 'decimals', 'supply', 'status', ...Object.keys(columns)]
  const values = [`'user:1'`, `'w1'`, `'${OWNER}'`, `'ember'`, `'testnet'`, `'Ashfall'`, `'ASH'`,
    '18', '1000000::numeric', `'awaiting_payment'`,
    ...Object.values(columns).map((v) => (v === null ? 'null' : v))]
  await sql.unsafe(`insert into tokens (${names.join(', ')}) values (${values.join(', ')})`)
}

test('THE GUARD: a NEW order may not be charged in a retired asset', { skip }, async () => {
  // The defect, expressed as a row. micro-mint debited real SHARD until this migration; the
  // customer's screen said "Pay 2,500 Shards" and was telling the truth about this column.
  //
  // micro-ledger refuses the POSTING as well (its migration 13). Both are needed and neither is
  // redundant: that one cannot see this table, and this one cannot bind the other eleven services.
  await assert.rejects(
    () =>
      rawOrder({
        price_usd_cents: '2500::numeric',
        charge_asset_code: `'SHARD'`,
        charge_amount: '2500::numeric',
        paid_journal_entry_id: `'entry-1'`,
      }),
    /tokens_no_new_shard_charge/,
  )
})

test('a HISTORICAL Shard charge is untouched, because it is what that order really cost', { skip }, async () => {
  // The other half, and the one that matters more. Retiring an asset must never make the record of
  // a past payment unwritable — a row that cannot be re-inserted is a row that cannot be restored
  // from a backup, and rewriting `charge_asset_code` to 'EMBER' would be a false statement about a
  // charge the ledger records as SHARD.
  await assert.doesNotReject(() =>
    rawOrder({
      created_at: `timestamptz '2026-08-04 12:00:00+00'`,
      price_usd_cents: '2500::numeric',
      price_shards: '2500::numeric',
      charge_asset_code: `'SHARD'`,
      charge_amount: '2500::numeric',
      paid_journal_entry_id: `'entry-1'`,
    }),
  )
})

test('an EMBER charge on a new order is exactly what the guard permits', { skip }, async () => {
  // The guard must be about the ASSET. A test that only proved the refusal would pass just as well
  // over a constraint that had broken every payment in the service.
  await assert.doesNotReject(() =>
    rawOrder({
      price_usd_cents: '2500::numeric',
      charge_asset_code: `'EMBER'`,
      charge_amount: '100000000000000000000::numeric',
      rate_usd_scaled: '250000::numeric',
      paid_journal_entry_id: `'entry-1'`,
    }),
  )
})

test('tokens_priced: an order with no price in either unit is refused', { skip }, async () => {
  // Not a NOT NULL on price_usd_cents, and the difference is a rollout. The migrator runs BEFORE
  // the new code starts, so for the length of a deploy the retired build is still inserting rows
  // that name price_shards and nothing else. A NOT NULL would turn that window into a 500 on every
  // launch. This accepts both eras and still refuses a row with no price at all — which is the row
  // that would otherwise reach `priceOf` and be read as a free deploy.
  await assert.rejects(() => rawOrder({ price_usd_cents: null }), /tokens_priced/)
  await assert.doesNotReject(() => rawOrder({ price_shards: '2500::numeric' }))
})

test('tokens_paid_records_charge: a paid order must say what was TAKEN', { skip }, async () => {
  // Without this the two-column design is decorative: a refund would have nothing to return, and
  // recomputing $25.00 at today's administered rate refunds the wrong amount to anybody whose
  // payment straddled a rate change.
  await assert.rejects(
    () => rawOrder({ price_usd_cents: '2500::numeric', paid_journal_entry_id: `'entry-1'` }),
    /tokens_paid_records_charge/,
  )
})

test('tokens_converted_charge_records_rate: a converted charge records its rate', { skip }, async () => {
  // Without the rate, price_usd_cents and charge_amount are two numbers with no stated
  // relationship, and nobody can tell a rate change from a bug.
  await assert.rejects(
    () =>
      rawOrder({
        price_usd_cents: '2500::numeric',
        charge_asset_code: `'EMBER'`,
        charge_amount: '100000000000000000000::numeric',
        paid_journal_entry_id: `'entry-1'`,
      }),
    /tokens_converted_charge_records_rate/,
  )
})

test('THE BACKFILL is the identity: one Shard was exactly one cent', { skip }, async () => {
  // The whole safety argument of migration 6. SHARD has decimals 0, USD is cents, the peg is 100
  // Shards to the dollar — so 2,500 Shards was $25.00 and 2,500 cents is $25.00, and nothing is
  // multiplied, divided or rounded.
  //
  // This replays the REAL upgrade: bring a database up to version 5, write the row a pre-migration
  // build would have written, then run the migration. Asserting on the SQL text instead would pass
  // over an UPDATE that never ran, and mutating THIS suite's database — dropping constraints and
  // deleting the applied-version row — was the first attempt and left every later case in the file
  // red when it failed halfway. A separate database is the only version of this that cannot.
  const admin = openDb(1)
  const name = `mint_backfill_test_${process.pid}`
  await admin.unsafe(`drop database if exists ${name} with (force)`)
  await admin.unsafe(`create database ${name}`)
  const legacy = postgres(testDatabaseUrl().replace(/\/[^/?]+(\?|$)/, `/${name}$1`), {
    max: 1,
    onnotice: () => {},
  })
  try {
    await migrate(legacy as unknown as DbSql, MIGRATIONS.filter((m) => m.version <= 5), {
      service: 'mint-backfill-test',
    })
    await legacy`
      insert into tokens (owner_subject, owner_wallet_id, owner_address, chain, network, name,
                          symbol, decimals, supply, status, price_shards, paid_journal_entry_id,
                          created_at)
      values ('user:1', 'w1', ${OWNER}, 'ember', 'testnet', 'Legacy', 'LEG', 18, 1000000::numeric,
              'paid', 2500::numeric, 'entry-legacy',
              -- A REAL legacy instant, matching the oldest live order (2026-08-04 06:31 UTC).
              -- Left to default, this row is stamped AFTER the guard cutoff, the backfill gives it
              -- a Shard charge, and MIGRATION 6 ITSELF FAILS. That is the correct behaviour and it
              -- is worth knowing: a deployment holding a Shard charge stamped after the cutoff must
              -- stop the deploy rather than admit the row.
              timestamptz '2026-08-04 06:31:26+00')
    `

    await migrate(legacy as unknown as DbSql, MIGRATIONS, { service: 'mint-backfill-test' })

    const rows = await legacy<{
      price_usd_cents: string
      price_shards: string
      charge_asset_code: string
      charge_amount: string
      rate_usd_scaled: string | null
    }[]>`
      select price_usd_cents, price_shards, charge_asset_code, charge_amount, rate_usd_scaled
        from tokens where symbol = 'LEG'
    `
    const row = rows[0]!
    assert.equal(row.price_usd_cents, row.price_shards, 'the integer moved, and it must not')
    assert.equal(row.price_usd_cents, '2500')
    // What that order ACTUALLY cost, recorded as what it was rather than converted into what it
    // would cost today. price_shards survives for the same reason: rewriting it would retroactively
    // restate what a customer paid.
    assert.equal(row.charge_asset_code, 'SHARD')
    assert.equal(row.charge_amount, '2500')
    // NULL rather than a 1:1 figure. A Shard price and a Shard debit meant no conversion happened,
    // and writing a rate would claim one was consulted when none was.
    assert.equal(row.rate_usd_scaled, null)
  } finally {
    await legacy.end({ timeout: 5 })
    await admin.unsafe(`drop database if exists ${name} with (force)`)
    await admin.end({ timeout: 5 })
  }
})
