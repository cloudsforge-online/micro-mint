/**
 * The schema, and the three constraints that make a defect unrepresentable rather than unlikely.
 *
 * These run the REAL `MIGRATIONS` through the real migrator, on the real database, exactly as a
 * deploy does. A fixture schema would let the constraints drift out of the tests that are supposed
 * to prove they fire.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'
import { enabled, migrateTestDb, openDb, resetMint, skip } from './testsupport.ts'
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
      supply, cap, status, price_shards, paid_journal_entry_id, broadcast_at, deploy_tx_hash,
      contract_address, failure_reason
    ) values (
      'user:1', 'w1', ${OWNER}, 'ember', 'testnet', 'Ashfall', 'ASH', ${row.decimals as number},
      ${row.supply as string}::numeric, ${row.cap as string | null}::numeric,
      ${row.status as string}, 2500::numeric, ${row.paid_journal_entry_id as string | null},
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
