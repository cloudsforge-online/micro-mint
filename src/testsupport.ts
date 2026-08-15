/**
 * Local fakes for the three upstreams and for the chain itself, plus the database harness.
 *
 * ## No test in this repository deploys to a real network
 *
 * That is an absolute rule and this file is how it is kept. Every chain call in every test goes
 * through `fakeNode`, an in-memory EVM node. The local Hearth testnet on `127.0.0.1:8545` may be
 * READ — it is a useful sanity check that the adapter speaks the same dialect — and nothing here
 * ever sends to it.
 *
 * ## The seam is the JSON-RPC transport, not the family
 *
 * `fakeNode` implements `JsonRpc`, so the code under test is the REAL EVM family: its nonce
 * handling, its fee bound, its gas estimate gate, its transaction-id derivation, its CREATE
 * address derivation and its drop proof are all exercised, and only the wire is imaginary. Faking
 * `DeployFamily` instead would have made every test a test of the fake.
 *
 * ## `fakeCustody` returns REAL RLP
 *
 * It assembles an actual legacy transaction — `rlp([nonce, gasPrice, gasLimit, to, value, data, v,
 * r, s])` — out of the payload it is given. That matters because a production function reads those
 * bytes back: `evmTxHash` derives the id a chain will know them by, and the whole "record the
 * broadcast before confirming" property turns on that id matching the one the network uses. A fake
 * that returned `'0xdeadbeef'` would let the derivation be wrong in a way no test could see.
 *
 * It signs nothing, of course. The `v`, `r` and `s` items are structurally valid and
 * cryptographically meaningless, which is exactly right: this service never verifies a signature,
 * it only commits and broadcasts one.
 */

import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { chainSpec, coinAmountForUsdCents, type Network } from '@cloudsforge/contracts-chain'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import { evmTxHash, toChecksumAddress, type FeeBounds, type JsonRpc } from './evm.ts'
import type { ChainId } from './chains.ts'
import type { PricingClient } from './pricingclient.ts'
import type { CustodyClient, DeployerAddress, SignRequest, SignedResult } from './custodyclient.ts'
import type { IndexedToken, IndexedTransaction, IndexerClient } from './indexerclient.ts'
import type { LedgerClient, PostEntryRequest, PostedEntry } from './ledgerclient.ts'
import type { Db } from './outbox.ts'
import type { DeployDeps } from './deploy.ts'

/* ------------------------------------------------------------------ RLP, for the fake signer */

function toBytes(value: bigint): Buffer {
  if (value === 0n) return Buffer.alloc(0)
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex, 'hex')
}

function rlpItem(payload: Buffer): Buffer {
  if (payload.length === 1 && payload[0]! <= 0x7f) return payload
  if (payload.length <= 55) return Buffer.concat([Buffer.from([0x80 + payload.length]), payload])
  const length = toBytes(BigInt(payload.length))
  return Buffer.concat([Buffer.from([0xb7 + length.length]), length, payload])
}

function rlpList(items: readonly Buffer[]): Buffer {
  const body = Buffer.concat(items)
  if (body.length <= 55) return Buffer.concat([Buffer.from([0xc0 + body.length]), body])
  const length = toBytes(BigInt(body.length))
  return Buffer.concat([Buffer.from([0xf7 + length.length]), length, body])
}

/** A structurally valid legacy creation. See the file header for why this is not a stub string. */
export function fakeLegacyCreation(payload: Record<string, unknown>): string {
  const quantity = (value: unknown): bigint => BigInt(String(value ?? 0))
  const data = String(payload['data'] ?? '0x').replace(/^0x/, '')
  const fingerprint = JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
  const items = [
    rlpItem(toBytes(quantity(payload['nonce']))),
    rlpItem(toBytes(quantity(payload['gasPrice'] ?? payload['maxFeePerGas']))),
    rlpItem(toBytes(quantity(payload['gasLimit']))),
    // A creation: `to` is the empty string, which is exactly what a null `to` encodes as.
    rlpItem(Buffer.alloc(0)),
    rlpItem(toBytes(quantity(payload['value']))),
    rlpItem(Buffer.from(data, 'hex')),
    rlpItem(toBytes(BigInt(2 * Number(payload['chainId'] ?? 1) + 35))),
    rlpItem(createHash('sha256').update(fingerprint).digest()),
    rlpItem(createHash('sha256').update(`s:${fingerprint}`).digest()),
  ]
  return `0x${rlpList(items).toString('hex')}`
}

/* ------------------------------------------------------------------ the fake node */

export interface FakeNodeOptions {
  readonly chainId?: number
  readonly gasPriceWei?: bigint
  readonly balances?: Readonly<Record<string, bigint>>
  readonly startingNonce?: number
  readonly gasEstimate?: bigint
  readonly head?: bigint
}

export interface FakeNode {
  readonly rpc: JsonRpc
  /** Every method called, in order. Several tests assert on what was NOT asked. */
  readonly calls: ReadonlyArray<{ method: string; params: readonly unknown[] }>
  /** Every set of bytes that reached `eth_sendRawTransaction`. **The headline assertion.** */
  readonly broadcast: readonly string[]
  setBalance(address: string, value: bigint): void
  setNonce(address: string, value: number): void
  /** Put a broadcast transaction in a block, so a receipt appears. */
  mine(rawTxOrHash: string, options?: { readonly reverted?: boolean; readonly contractAddress?: string }): void
  advance(blocks: number): void
  /** Make the next call of a method throw, once. For the broadcast-failure tests. */
  failNext(method: string, message: string): void
  setUnreachable(value: boolean): void
}

const hexQuantity = (value: bigint): string => `0x${value.toString(16)}`

export function fakeNode(options: FakeNodeOptions = {}): FakeNode {
  const calls: Array<{ method: string; params: readonly unknown[] }> = []
  const broadcast: string[] = []
  const balances = new Map<string, bigint>()
  const nonces = new Map<string, number>()
  const receipts = new Map<string, { block: bigint; reverted: boolean; contractAddress: string | null }>()
  const failures = new Map<string, string>()
  const gasPrice = options.gasPriceWei ?? 20_000_000_000n
  let head = options.head ?? 1_000n
  let unreachable = false

  for (const [address, value] of Object.entries(options.balances ?? {})) {
    balances.set(address.toLowerCase(), value)
  }

  /**
   * The id a real node would know these bytes by, which IS keccak256 of exactly the bytes.
   *
   * It uses the production `evmTxHash` on purpose, and that is not the tests asserting a hash
   * against itself: it is the fake modelling the chain's actual rule. The whole recovery path turns
   * on the derived id matching the one the network uses, so a fake that hashed differently would
   * make every re-broadcast and every receipt lookup miss — and the tests would pass only for
   * adapters that never looked a transaction up twice.
   */
  const hashOf = (rawTx: string): string => {
    const derived = evmTxHash(rawTx)
    if (!derived) throw new Error('the fake node was sent something that is not a hex transaction')
    return derived
  }

  const node: FakeNode = {
    calls,
    broadcast,
    setBalance(address, value) {
      balances.set(address.toLowerCase(), value)
    },
    setNonce(address, value) {
      nonces.set(address.toLowerCase(), value)
    },
    mine(rawTxOrHash, mineOptions = {}) {
      const hash = rawTxOrHash.length > 70 ? hashOf(rawTxOrHash) : rawTxOrHash
      receipts.set(hash.toLowerCase(), {
        block: head,
        reverted: mineOptions.reverted === true,
        contractAddress: mineOptions.contractAddress ?? null,
      })
    },
    advance(blocks) {
      head += BigInt(blocks)
    },
    failNext(method, message) {
      failures.set(method, message)
    },
    setUnreachable(value) {
      unreachable = value
    },
    rpc: async (method, params) => {
      calls.push({ method, params })
      if (unreachable) throw new Error(`fake node is unreachable (${method})`)
      const failure = failures.get(method)
      if (failure !== undefined) {
        failures.delete(method)
        throw new Error(failure)
      }
      switch (method) {
        case 'eth_chainId':
          return hexQuantity(BigInt(options.chainId ?? 7412))
        case 'eth_gasPrice':
          return hexQuantity(gasPrice)
        case 'eth_blockNumber':
          return hexQuantity(head)
        case 'eth_estimateGas':
          return hexQuantity(options.gasEstimate ?? 1_200_000n)
        case 'eth_getBalance': {
          const address = String((params[0] as string) ?? '').toLowerCase()
          return hexQuantity(balances.get(address) ?? 0n)
        }
        case 'eth_getTransactionCount': {
          const address = String((params[0] as string) ?? '').toLowerCase()
          return hexQuantity(BigInt(nonces.get(address) ?? options.startingNonce ?? 0))
        }
        case 'eth_sendRawTransaction': {
          const rawTx = String(params[0])
          const hash = hashOf(rawTx)
          if (broadcast.includes(rawTx)) {
            // What a real node says for bytes it already holds. The recovery path depends on this
            // being an ERROR rather than a hash, which is exactly why it is modelled.
            throw new Error('already known')
          }
          broadcast.push(rawTx)
          return hash
        }
        case 'eth_getTransactionReceipt': {
          const hash = String(params[0]).toLowerCase()
          const receipt = receipts.get(hash)
          if (!receipt) return null
          return {
            blockNumber: hexQuantity(receipt.block),
            status: receipt.reverted ? '0x0' : '0x1',
            contractAddress: receipt.contractAddress,
          }
        }
        default:
          throw new Error(`the fake node was asked for ${method}, which it does not implement`)
      }
    },
  }
  return node
}

/** A factory that serves one fake node for every chain. */
export function fakeRpc(node: FakeNode): (chain: ChainId) => JsonRpc {
  return () => node.rpc
}

/* ------------------------------------------------------------------ custody */

export interface FakeCustody extends CustodyClient {
  readonly requests: readonly SignRequest[]
  /** How many signatures were actually produced. **The double-deploy test asserts this is 1.** */
  readonly signatures: readonly string[]
  refuseSigning(code: string, message: string): void
  failSigning(err: Error): void
  /** Called just before each signature is produced, so a test can interleave two workers. */
  onSign?: ((request: SignRequest) => Promise<void>) | undefined
}

export function fakeCustody(options: { readonly deployer?: string } = {}): FakeCustody {
  const requests: SignRequest[] = []
  const signatures: string[] = []
  let refusal: { code: string; message: string } | null = null
  let failure: Error | null = null
  let minted = 0

  const fake: FakeCustody = {
    requests,
    signatures,
    refuseSigning(code, message) {
      refusal = { code, message }
    },
    failSigning(err) {
      failure = err
    },
    async sign(request: SignRequest): Promise<SignedResult> {
      requests.push(request)
      await fake.onSign?.(request)
      if (failure) {
        const err = failure
        failure = null
        throw err
      }
      if (refusal) {
        const { code, message } = refusal
        refusal = null
        const { CustodySignRefusedError } = await import('./custodyclient.ts')
        throw new CustodySignRefusedError(403, code, message)
      }
      const signedTx = fakeLegacyCreation(request.payload)
      signatures.push(signedTx)
      return { signedTx, auditId: `audit-${signatures.length}` }
    },
    async provisionDeployer(input): Promise<DeployerAddress> {
      minted += 1
      return {
        // Deterministic and idempotent per order, exactly as custody is: everything it writes is
        // derived from the path, so two calls for one order return one address.
        address: options.deployer ?? deployerFor(input.orderId),
        chain: input.chain,
        network: input.network,
        family: input.chain === 'solana' ? 'solana' : input.chain === 'ember' ? 'ember' : 'evm',
      }
    },
  }
  return fake
}

/** A deterministic deployer address per order, so a failure names the same account every run. */
export function deployerFor(orderId: string): string {
  const digest = createHash('sha256').update(`deployer:${orderId}`).digest('hex')
  return toChecksumAddress(`0x${digest.slice(0, 40)}`)
}

/* ------------------------------------------------------------------ indexer */

export interface FakeIndexer extends IndexerClient {
  setTransaction(hash: string, transaction: IndexedTransaction | null): void
  setToken(address: string, token: IndexedToken | null): void
  setUnavailable(value: boolean): void
  readonly asked: readonly string[]
}

/**
 * Empty by default, which is the state that matters most: a transaction the indexer has never seen.
 * That is what a fresh broadcast looks like, and reading it as "not on chain" is the mistake the
 * whole outcome path exists to avoid.
 */
export function fakeIndexer(): FakeIndexer {
  const transactions = new Map<string, IndexedTransaction>()
  const tokens = new Map<string, IndexedToken>()
  const asked: string[] = []
  let unavailable = false
  return {
    asked,
    setTransaction(hash, transaction) {
      if (transaction) transactions.set(hash.toLowerCase(), transaction)
      else transactions.delete(hash.toLowerCase())
    },
    setToken(address, token) {
      if (token) tokens.set(address.toLowerCase(), token)
      else tokens.delete(address.toLowerCase())
    },
    setUnavailable(value) {
      unavailable = value
    },
    async transaction(_chain, _network, hash) {
      asked.push(hash)
      if (unavailable) {
        const { IndexerUnavailableError } = await import('./indexerclient.ts')
        throw new IndexerUnavailableError('the fake indexer is unavailable')
      }
      return transactions.get(hash.toLowerCase()) ?? null
    },
    async token(_chain, _network, address) {
      asked.push(address)
      if (unavailable) {
        const { IndexerUnavailableError } = await import('./indexerclient.ts')
        throw new IndexerUnavailableError('the fake indexer is unavailable')
      }
      return tokens.get(address.toLowerCase()) ?? null
    },
  }
}

/* ------------------------------------------------------------------ pricing */

/**
 * The rate at which the fixtures below convert: **$0.25 to one EMBER**, at `RATE_SCALE`.
 *
 * `RATE_SCALE` is 1,000,000 (`contracts/packages/chain/src/index.ts`), so $0.25 is 250,000 and
 * NOT 250,000,000. That distinction is written down because this file had the second number for one
 * draft, and the only symptom was a charge a thousand times too small — no type error, no
 * exception, a perfectly balanced entry for the wrong amount of money. Reading the scale rather
 * than assuming it is the whole reason `pricingclient.ts` checks the published `rateScale` instead
 * of trusting it.
 *
 * The value is the administered figure `micro-pricing` is actually seeded with
 * (`pricing/src/migrations.ts`), so these tests convert at the number the live rate board
 * carries rather than a round one chosen to make the arithmetic easy. At this rate $25.00 — 2,500
 * cents, the default deploy price — settles to exactly 100 EMBER.
 */
export const FAKE_RATE_USD_SCALED = 250_000n

export interface FakePricing extends PricingClient {
  /** Every asset it was asked about, in order. */
  readonly asked: readonly string[]
  /** Make the next quote fail, the way an unreachable or unusable rate board does. */
  failNext(err: Error): void
}

/**
 * A rate board that always answers, until told not to.
 *
 * It computes with `coinAmountForUsdCents` rather than returning a canned number: the conversion
 * is the thing under test at every call site, and a fake that returned a constant would let a
 * decimals mistake through — which is the one mistake in this area that costs eighteen orders of
 * magnitude.
 */
export function fakePricing(): FakePricing {
  const asked: string[] = []
  let failure: Error | null = null
  return {
    asked,
    failNext(err) {
      failure = err
    },
    async quote(asset, cents) {
      asked.push(asset)
      if (failure) {
        const err = failure
        failure = null
        throw err
      }
      return {
        usdScaled: FAKE_RATE_USD_SCALED,
        amount: coinAmountForUsdCents(cents, chainSpec(asset).decimals, FAKE_RATE_USD_SCALED),
      }
    },
  }
}

/* ------------------------------------------------------------------ ledger */

export interface FakeLedger extends LedgerClient {
  readonly entries: readonly PostEntryRequest[]
  /** Every idempotency key it has seen, in order. The double-post test reads this. */
  readonly keys: readonly string[]
  failNext(err: Error): void
  refuseNext(err: Error): void
  /**
   * Forget everything, between cases.
   *
   * The fake outlives the suite's `beforeEach` — one instance is built in `before` and shared —
   * so without this a case asserting "one debit" is really asserting "one debit in every case that
   * ran before it too". It held only while exactly one case in the file ever paid, and the second
   * one that did made the first fail.
   */
  reset(): void
}

export function fakeLedger(): FakeLedger {
  const entries: PostEntryRequest[] = []
  const keys: string[] = []
  const byKey = new Map<string, PostedEntry>()
  let failure: Error | null = null
  let counter = 0
  return {
    entries,
    keys,
    reset() {
      entries.length = 0
      keys.length = 0
      byKey.clear()
      failure = null
      counter = 0
    },
    failNext(err) {
      failure = err
    },
    refuseNext(err) {
      failure = err
    },
    async postEntry(request) {
      keys.push(request.idempotencyKey)
      if (failure) {
        const err = failure
        failure = null
        throw err
      }
      // The replay is what makes a rolled-back local transaction safe to retry: the same derived
      // key gets the same entry id back and the customer is debited once.
      const replay = byKey.get(request.idempotencyKey)
      if (replay) return { ...replay, replayed: true }
      counter += 1
      entries.push(request)
      const entry: PostedEntry = {
        id: `entry-${counter}`,
        kind: request.kind,
        recordedAt: new Date(counter).toISOString(),
        replayed: false,
      }
      byKey.set(request.idempotencyKey, entry)
      return entry
    },
  }
}

/* ------------------------------------------------------------------ the database harness */

/**
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience: `resetMint` truncates every table this service owns, and requiring "test" in
 * the name is the difference between a red build and an emptied environment. This service holds
 * the only record of which signed bytes exist for which order; the wrong connection string here
 * destroys the evidence every stuck deploy would ever be triaged on.
 *
 * Only a `mint_test` database is ever created or written by this suite.
 */
const url = process.env['MINT_TEST_DATABASE_URL']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set MINT_TEST_DATABASE_URL (name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * The configured URL, for the one case that needs a DIFFERENT database on the same server.
 *
 * `migrations.test.ts` replays the real upgrade path — bring a schema to version 5, write the row a
 * pre-migration build wrote, then migrate — and it cannot do that on the suite's own database
 * without deleting an applied-version row and dropping constraints, which leaves every later case
 * in the file red if it fails halfway. It derives a sibling name from this.
 *
 * The `test` requirement above still binds: a sibling of `mint_test` is named `mint_backfill_test`
 * and nothing outside this suite is reachable.
 */
export function testDatabaseUrl(): string {
  if (!enabled) throw new Error('database tests are disabled')
  return url!
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints drift out of the tests that are supposed to prove they fire — and one
 * of them, `tokens_broadcast_has_hash`, is the single most important line in this repository.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'mint-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetMint(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'mint-test', sink: () => {} })
}

export const TEST_BOUNDS: FeeBounds = Object.freeze({
  minGasPriceWei: 1_000_000_000n,
  maxGasPriceWei: 500_000_000_000n,
  maxFeeWei: 10n ** 18n,
})

export interface Harness {
  readonly sql: Db
  readonly node: FakeNode
  readonly custody: FakeCustody
  readonly indexer: FakeIndexer
  readonly ledger: FakeLedger
  readonly metrics: Metrics
  readonly deploy: DeployDeps
}

export interface HarnessOptions {
  readonly network?: Network
  readonly node?: FakeNode
  readonly custody?: FakeCustody
  readonly owner?: string
  readonly stuckMs?: number
  readonly leaseMs?: number
  readonly enabled?: boolean
  readonly fundingMaxRequests?: number
  readonly fundingCooldownMs?: number
  readonly now?: () => number
}

/** The deps bundle every test needs, wired to fakes and one pool. */
export function harness(sql: postgres.Sql, options: HarnessOptions = {}): Harness {
  const db = sql as unknown as Db
  const node = options.node ?? fakeNode()
  const custody = options.custody ?? fakeCustody()
  const indexer = fakeIndexer()
  const ledger = fakeLedger()
  const metrics = registerServiceMetrics(new Metrics())
  const logger = quietLogger()

  return {
    sql: db,
    node,
    custody,
    indexer,
    ledger,
    metrics,
    deploy: {
      sql: db,
      producer: 'mint',
      owner: options.owner ?? 'replica-a',
      network: options.network ?? 'testnet',
      custody,
      indexer,
      rpc: fakeRpc(node),
      bounds: TEST_BOUNDS,
      leaseMs: options.leaseMs ?? 120_000,
      stuckMs: options.stuckMs ?? 30 * 60_000,
      fundingMaxRequests: options.fundingMaxRequests ?? 3,
      // No cooldown by default: a test that drives two passes back to back is asserting the LIMIT,
      // and a five-minute wall between them would make every such test pass for the wrong reason.
      fundingCooldownMs: options.fundingCooldownMs ?? 0,
      enabled: options.enabled ?? true,
      logger,
      metrics,
      ...(options.now ? { now: options.now } : {}),
    },
  }
}

/** A well-formed order, with the awkward fields already right. */
export async function seedToken(
  sql: Db,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const row = {
    owner_subject: 'user:11111111-1111-4111-8111-111111111111',
    owner_wallet_id: 'wallet-1',
    owner_address: toChecksumAddress('0x00000000000000000000000000000000000000a1'),
    chain: 'ember',
    network: 'testnet',
    name: 'Ashfall',
    symbol: 'ASH',
    decimals: 18,
    supply: '1000000000000000000000000',
    cap: null as string | null,
    features: [] as string[],
    status: 'paid',
    // USD cents, and the charge that settled it. 2,500 cents is $25.00, which is what 2,500 Shards
    // was — one Shard is exactly one cent, so migration 6 moved no number. `price_shards` is
    // absent from this seed on purpose: nothing writes it any more, and a fixture that kept
    // setting it would keep the retired era alive in every test that touches a token.
    price_usd_cents: '2500',
    charge_asset_code: 'EMBER',
    charge_amount: '100000000000000000000',
    rate_usd_scaled: '250000',
    paid_journal_entry_id: 'entry-1',
    // The terminal columns. Present here because `tokens_terminal_is_complete` refuses a
    // `deployed` row with no address and a `failed` row with no reason — a seed helper that could
    // not set them could not seed a terminal row at all, which the constraint caught the first
    // time this suite ran.
    deploy_tx_hash: null as string | null,
    contract_address: null as string | null,
    broadcast_at: null as string | null,
    failure_reason: null as string | null,
    ...overrides,
  }
  const rows = await sql<{ id: string }[]>`
    insert into tokens (
      owner_subject, owner_wallet_id, owner_address, chain, network, name, symbol, decimals,
      supply, cap, features, status, price_usd_cents, charge_asset_code, charge_amount,
      rate_usd_scaled, paid_journal_entry_id, paid_at,
      deploy_tx_hash, contract_address, broadcast_at, failure_reason
    ) values (
      ${row.owner_subject}, ${row.owner_wallet_id}, ${row.owner_address}, ${row.chain},
      ${row.network}, ${row.name}, ${row.symbol}, ${row.decimals}, ${row.supply}::numeric,
      ${row.cap}::numeric, ${row.features}, ${row.status}, ${row.price_usd_cents}::numeric,
      ${row.charge_asset_code as string | null}, ${row.charge_amount as string | null}::numeric,
      ${row.rate_usd_scaled as string | null}::numeric,
      ${row.paid_journal_entry_id}, now(),
      ${row.deploy_tx_hash as string | null}, ${row.contract_address as string | null},
      ${row.broadcast_at as string | null}::timestamptz, ${row.failure_reason as string | null}
    )
    returning id
  `
  const inserted = rows[0]
  if (!inserted) throw new Error('seed insert returned no row')
  return inserted
}
