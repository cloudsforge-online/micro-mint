/**
 * The token registry and its state machine.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY WRITE IN THIS FILE IS A CONDITIONAL `UPDATE … RETURNING`**, and the row it returns is
 * the proof it was this caller's write that landed. That is not a style: `claimDeploy` in the
 * frozen service is the one correct distributed primitive in the old estate, and the reason it is
 * the only one is that every OTHER write there matches on `id` alone. Two of those are dangerous —
 * the broadcast recording stamps a hash onto a row that may since have been re-claimed, and the
 * success write can overwrite a settlement that already concluded the same hash was dropped.
 *
 * So here the conditional update is the DEFAULT and the unconditional one does not exist. Each
 * function names the states it will move FROM, and a call that matches nothing returns null rather
 * than throwing: "somebody else already moved this row" is an ordinary outcome of concurrent work,
 * not an error.
 *
 * The owner is folded into the WHERE of every customer-initiated write, too. The frozen service
 * reads the row with an ownership check and then updates by id, which is a time-of-check /
 * time-of-use gap that is unexploitable today only because nothing ever changes `user_id`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The states, and which of them the customer waits in
 *
 *     draft → awaiting_payment → paid → provisioning → awaiting_funds → deploying → deployed
 *                                                                                 ↘ failed
 *
 * 04-domain-model §5.2. Everything from `paid` onwards is reached by a leased JOB, never inside an
 * HTTP request — see `deploy.ts`. `draft` exists in the published type and is written here for a
 * token whose order form has not been completed; the frozen service never writes it at all, which
 * made it a phantom state the SPA still handled.
 */

import type { Network } from '@cloudsforge/contracts-chain'
import { parseAccountSubject } from '@cloudsforge/contracts-money'
import { withOutbox, type Db, type Emit, type Tx } from './outbox.ts'
import type { ChainId } from './chains.ts'
import type { Feature } from './catalogue.ts'

export const TOKEN_STATUSES = Object.freeze([
  'draft',
  'awaiting_payment',
  'paid',
  'provisioning',
  'awaiting_funds',
  'deploying',
  'deployed',
  'failed',
] as const)

export type TokenStatus = (typeof TOKEN_STATUSES)[number]

/** Terminal. Nothing moves a row out of one of these, and the deploy job will not claim one. */
export const TERMINAL: readonly TokenStatus[] = Object.freeze(['deployed', 'failed'])

export function isTerminal(status: TokenStatus): boolean {
  return TERMINAL.includes(status)
}

/**
 * The states a deploy may legitimately start from.
 *
 * `failed` is deliberately **absent**, and this is the largest single divergence from the frozen
 * `DEPLOYABLE = ['awaiting_funds', 'failed', 'deploying']`. Including `failed` is what makes the
 * Solana double-mint reachable in one step: a broadcast that lost its confirmation race writes
 * `failed`, the lease predicate matches it immediately with no wait at all, and the second attempt
 * mints again. A failure here is TERMINAL and a retry is an explicit operator or customer action
 * that creates a new attempt, not something a background poll does by itself.
 */
export const CLAIMABLE: readonly TokenStatus[] = Object.freeze([
  'paid',
  'provisioning',
  'awaiting_funds',
  'deploying',
])

export interface TokenRecord {
  readonly id: string
  readonly ownerSubject: string
  readonly ownerWalletId: string
  readonly ownerAddress: string
  readonly chain: ChainId
  readonly network: Network
  readonly standard: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly supply: bigint
  readonly cap: bigint | null
  readonly features: readonly Feature[]
  readonly metadataUri: string | null
  readonly brandKitId: string | null
  readonly status: TokenStatus
  /**
   * What the customer was QUOTED, in US cents. The durable figure — see migration 6.
   *
   * Null only on an order created before migration 6 by a build that predates it. Every row the
   * migration touched was back-filled, one Shard to one cent.
   */
  readonly priceUsdCents: bigint | null
  /**
   * What a pre-migration order was priced at, in Shards. **Historical only; nothing writes it.**
   *
   * Kept rather than dropped because it is what a past order ACTUALLY cost, and rewriting it would
   * retroactively restate history. Null on everything created since.
   */
  readonly priceShards: bigint | null
  /** What was actually charged — `EMBER` — and `SHARD` on a legacy paid order. Null until paid. */
  readonly chargeAssetCode: string | null
  /**
   * The charge, in the settlement asset's smallest units. Wei, for EMBER.
   *
   * Stored beside `priceUsdCents` rather than derived from it, because a refund must return what
   * was TAKEN. Recomputing $25.00 at today's administered rate would refund the wrong amount to
   * anyone whose payment straddled a rate change.
   */
  readonly chargeAmount: bigint | null
  /** The rate the conversion used, at `RATE_SCALE`. Null on a legacy 1:1 Shard charge. */
  readonly rateUsdScaled: bigint | null
  readonly paidJournalEntryId: string | null
  readonly paidAt: Date | null
  readonly deployerAddress: string | null
  readonly deployNonce: bigint | null
  readonly rawTx: string | null
  readonly custodyAuditId: string | null
  readonly deployTxHash: string | null
  readonly contractAddress: string | null
  readonly broadcastAt: Date | null
  readonly confirmedAt: Date | null
  readonly failureReason: string | null
  readonly leaseOwner: string | null
  readonly leaseUntil: Date | null
  readonly deployAttempts: number
  /**
   * How many times this order has asked settlement to fund its deployer. See migration 8.
   *
   * This is the `attempt` on `mint.deploy.funding_requested`, and settlement's idempotency key is
   * built from it — which is what makes a genuine second ask a second transfer while a redelivery
   * of the first stays one.
   */
  readonly fundingRequests: number
  /** When it last asked, on THIS service's clock — the cooldown is measured against it. */
  readonly fundingRequestedAt: Date | null
  /** What it last asked for, in wei. Null until it has asked. */
  readonly fundingRequestedWei: bigint | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface TokenRow {
  readonly id: string
  readonly owner_subject: string
  readonly owner_wallet_id: string
  readonly owner_address: string
  readonly chain: string
  readonly network: string
  readonly standard: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly supply: string
  readonly cap: string | null
  readonly features: string[]
  readonly metadata_uri: string | null
  readonly brand_kit_id: string | null
  readonly status: string
  readonly price_usd_cents: string | null
  readonly price_shards: string | null
  readonly charge_asset_code: string | null
  readonly charge_amount: string | null
  readonly rate_usd_scaled: string | null
  readonly paid_journal_entry_id: string | null
  readonly paid_at: Date | null
  readonly deployer_address: string | null
  readonly deploy_nonce: string | number | null
  readonly raw_tx: string | null
  readonly custody_audit_id: string | null
  readonly deploy_tx_hash: string | null
  readonly contract_address: string | null
  readonly broadcast_at: Date | null
  readonly confirmed_at: Date | null
  readonly failure_reason: string | null
  readonly lease_owner: string | null
  readonly lease_until: Date | null
  readonly deploy_attempts: number
  readonly funding_requests: number
  readonly funding_requested_at: Date | null
  readonly funding_requested_wei: string | null
  readonly created_at: Date
  readonly updated_at: Date
}

/** Every column, once. Repeating this list per query is how a projection quietly loses a field. */
const COLUMNS = `
  id, owner_subject, owner_wallet_id, owner_address, chain, network, standard, name, symbol,
  decimals, supply, cap, features, metadata_uri, brand_kit_id, status,
  price_usd_cents, price_shards, charge_asset_code, charge_amount, rate_usd_scaled,
  paid_journal_entry_id, paid_at, deployer_address, deploy_nonce, raw_tx, custody_audit_id,
  deploy_tx_hash, contract_address, broadcast_at, confirmed_at, failure_reason, lease_owner,
  lease_until, deploy_attempts, funding_requests, funding_requested_at, funding_requested_wei,
  created_at, updated_at
`

export function toToken(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    ownerWalletId: row.owner_wallet_id,
    ownerAddress: row.owner_address,
    chain: row.chain as ChainId,
    network: row.network as Network,
    standard: row.standard,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    // numeric(78,0) arrives as a string from postgres.js, which is correct and deliberate: a
    // 78-digit quantity read through Number() would be silently rounded, and a rounded supply is a
    // token whose total is not the one the customer paid to create.
    supply: BigInt(row.supply),
    cap: row.cap === null ? null : BigInt(row.cap),
    features: row.features as Feature[],
    metadataUri: row.metadata_uri,
    brandKitId: row.brand_kit_id,
    status: row.status as TokenStatus,
    // `BigInt('')` is `0n` and `BigInt(null as never)` is `0n` as well, so the null check is
    // explicit rather than a `?? '0'` default. A price of zero is a free deploy — a gas bill the
    // platform pays for anyone who can open an order — and it must never be something a missing
    // column produces by accident.
    priceUsdCents: row.price_usd_cents === null ? null : BigInt(row.price_usd_cents),
    priceShards: row.price_shards === null ? null : BigInt(row.price_shards),
    chargeAssetCode: row.charge_asset_code,
    chargeAmount: row.charge_amount === null ? null : BigInt(row.charge_amount),
    rateUsdScaled: row.rate_usd_scaled === null ? null : BigInt(row.rate_usd_scaled),
    paidJournalEntryId: row.paid_journal_entry_id,
    paidAt: row.paid_at,
    deployerAddress: row.deployer_address,
    deployNonce: row.deploy_nonce === null ? null : BigInt(row.deploy_nonce),
    rawTx: row.raw_tx,
    custodyAuditId: row.custody_audit_id,
    deployTxHash: row.deploy_tx_hash,
    contractAddress: row.contract_address,
    broadcastAt: row.broadcast_at,
    confirmedAt: row.confirmed_at,
    failureReason: row.failure_reason,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    deployAttempts: row.deploy_attempts,
    fundingRequests: row.funding_requests,
    fundingRequestedAt: row.funding_requested_at,
    // numeric(78,0), so a string, for the same reason `supply` is one: a wei amount read through
    // Number() is rounded, and this one is a figure an operator compares against what settlement
    // actually sent.
    fundingRequestedWei:
      row.funding_requested_wei === null ? null : BigInt(row.funding_requested_wei),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/* ------------------------------------------------------------------ reading */

export async function findToken(sql: Db, id: string): Promise<TokenRecord | null> {
  const rows = await sql<TokenRow[]>`select ${sql.unsafe(COLUMNS)} from tokens where id = ${id}`
  const row = rows[0]
  return row ? toToken(row) : null
}

/** Ownership is a predicate, not a check followed by an update. */
export async function findOwnedToken(
  sql: Db,
  id: string,
  ownerSubject: string,
): Promise<TokenRecord | null> {
  const rows = await sql<TokenRow[]>`
    select ${sql.unsafe(COLUMNS)} from tokens where id = ${id} and owner_subject = ${ownerSubject}
  `
  const row = rows[0]
  return row ? toToken(row) : null
}

export async function listTokens(
  sql: Db,
  ownerSubject: string,
  limit: number,
): Promise<TokenRecord[]> {
  const rows = await sql<TokenRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from tokens
     where owner_subject = ${ownerSubject}
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toToken)
}

/* ------------------------------------------------------------------ creating */

export interface CreateToken {
  readonly ownerSubject: string
  readonly ownerWalletId: string
  readonly ownerAddress: string
  readonly chain: ChainId
  readonly network: Network
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly supply: bigint
  readonly cap: bigint | null
  readonly features: readonly Feature[]
  readonly metadataUri: string | null
  readonly brandKitId: string | null
  /** What the order is quoted at, in US cents. `env.deployPriceUsdCents`. */
  readonly priceUsdCents: bigint
  readonly actor: string
  readonly correlationId: string
}

/**
 * The bare user id inside an account subject, or null when the owner is not a person.
 *
 * `ownerSubject` is `@cloudsforge/contracts-money`'s `AccountSubject` — `user:<uuid>`,
 * `organisation:<uuid>`, `community:<uuid>` or a singleton such as the treasury. Every consumer that
 * needs to reach a PERSON wants the bare uuid, so the unwrapping happens once, here, rather than
 * four times in four repositories that each guess at the prefix.
 *
 * `parseAccountSubject` throws on a malformed subject, which would abort a deploy that has already
 * confirmed on chain — the money is spent and the contract exists, so refusing to record it is the
 * worst possible response. A subject this service cannot parse means "no person", which is the same
 * safe answer as an organisation.
 */
function userIdOfSubject(subject: string): string | null {
  try {
    const parsed = parseAccountSubject(subject)
    return parsed.kind === 'user' ? parsed.id : null
  } catch {
    return null
  }
}

export const CREATED_TOPIC = 'mint.token.created'
export const PAID_TOPIC = 'mint.token.paid'
export const BROADCAST_TOPIC = 'mint.token.broadcast'
/**
 * Registered as `mint.deploy.confirmed` — one of the eight FIRST topics of 02-target-architecture §5.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS SERVICE EMITTED THE ESTATE'S MOST-CONSUMED MINT EVENT UNDER A NAME NOBODY KNEW.** The
 * registry has owned `mint.deploy.confirmed` since before this service existed, and this line said
 * `mint.token.deployed`. That is the `custody.key.exported` shape exactly: custody looked like
 * "nobody emits this" while it was in fact emitting `custody.export.completed` — a name in no
 * registry with no subscriber — and the repair was a RENAME IN THE ONE REPOSITORY rather than five
 * consumers learning a second name.
 *
 * The evidence that it is a rename and not a missing emit is that the two are the same fact, and
 * that nothing anywhere reads the name this service used. `grep -rn 'mint.token.deployed'` across
 * all 58 repositories returns this declaration, this repository's own tests, and one unrelated
 * fixture in `community/src/server.test.ts` that uses it as an example of a topic community does
 * NOT subscribe to. Nobody was listening. Meanwhile the registered name is read in four places:
 *
 *   - `notify/src/catalogue.ts` — priority HIGH, template `token.deployed`, and its own `why`
 *     says it "is the event that retires ForgeMint's four-second client poll".
 *   - `activity/src/classify.ts` — `token.deploy_confirmed`, user-visible.
 *   - `analytics/src/catalogue.ts` — `token_deployed`, personal, feeding metrics 8 and 9
 *     (`docs/ecosystem/13-operational-model.md`, token creation and its funnel).
 *   - `docs/ecosystem/07-dependency-map.md` and `02-target-architecture.md` both list
 *     activity, market, notify and analytics as consumers.
 *
 * All four were dead code, and the client kept polling every four seconds.
 *
 * The constant keeps its name because "deployed" is what this service does and what the row's status
 * is called; the WIRE name is the registry's, because the registry is the only place a topic name is
 * spelled. The registry's `keyedBy` is `token_id`, which is what this emit already passed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const DEPLOYED_TOPIC = 'mint.deploy.confirmed'
export const FAILED_TOPIC = 'mint.token.failed'
/**
 * Registered as `mint.deploy.funding_requested` — the sentence that was missing between the two
 * services that each hold half of a deploy.
 *
 * A paid order's deployer address is minted per order and holds nothing. This service measures the
 * shortfall exactly (`families.ts` `funding`) and can do nothing about it: it holds
 * `custody:sign:deployer` and no other signing scope, so it cannot spend the treasury the gas has
 * to come from. Settlement holds `custody:sign:treasury` and already knows how to send platform
 * gas to a platform address — that is the `gas_topup` purpose its own sweep uses. Until this topic
 * existed there was no way to say so, and `awaitFunds` put the row back in `awaiting_funds` to be
 * measured again on the next tick, for ever.
 *
 * An outbox row rather than an HTTP call because 03 §2 rule 5 says a state change others care
 * about is written in the same transaction as the change, and because settlement's only write
 * surface is `POST /v1/events`.
 */
export const FUNDING_REQUESTED_TOPIC = 'mint.deploy.funding_requested'

export async function createToken(
  sql: Db,
  producer: string,
  input: CreateToken,
): Promise<TokenRecord> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<TokenRow[]>`
      insert into tokens (
        owner_subject, owner_wallet_id, owner_address, chain, network, name, symbol, decimals,
        supply, cap, features, metadata_uri, brand_kit_id, status, price_usd_cents
      ) values (
        ${input.ownerSubject}, ${input.ownerWalletId}, ${input.ownerAddress}, ${input.chain},
        ${input.network}, ${input.name}, ${input.symbol}, ${input.decimals},
        ${input.supply.toString()}::numeric, ${input.cap === null ? null : input.cap.toString()}::numeric,
        ${input.features as string[]}, ${input.metadataUri}, ${input.brandKitId},
        'awaiting_payment', ${input.priceUsdCents.toString()}::numeric
      )
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new Error('insert returned no row')
    const token = toToken(row)
    emit({
      topic: CREATED_TOPIC,
      key: token.id,
      payload: {
        tokenId: token.id,
        ownerSubject: token.ownerSubject,
        chain: token.chain,
        network: token.network,
        symbol: token.symbol,
        priceUsdCents: token.priceUsdCents?.toString() ?? null,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return token
  })
}

/* ------------------------------------------------------------------ the transitions */

/**
 * Record that the ledger entry paying for this order exists.
 *
 * Called from INSIDE the transaction that posted it — see `orders.ts`. It takes a `Tx` rather than
 * a `Db` for exactly that reason: there is no way to call it outside one, so the two writes cannot
 * become two transactions the way `spendShards(...)` then `updateOrder(..., 'paid')` did.
 *
 * Guarded on `awaiting_payment`, so a second concurrent payment attempt matches nothing and gets
 * null back rather than a second debit. The idempotency key on the ledger side means the second
 * attempt's entry is a replay of the first, so nulling here loses nothing.
 */
export async function markPaid(
  tx: Tx,
  emit: Emit,
  input: {
    readonly id: string
    readonly ownerSubject: string
    readonly journalEntryId: string
    /** The settlement asset, and what actually left the balance. Both, because a refund needs both. */
    readonly chargeAssetCode: string
    readonly chargeAmount: bigint
    /** The rate that produced `chargeAmount`, at `RATE_SCALE`. Recorded so the sum is auditable. */
    readonly rateUsdScaled: bigint
    readonly actor: string
    readonly correlationId: string
  },
): Promise<TokenRecord | null> {
  const rows = await tx<TokenRow[]>`
    update tokens
       set status = 'paid',
           paid_journal_entry_id = ${input.journalEntryId},
           charge_asset_code = ${input.chargeAssetCode},
           charge_amount = ${input.chargeAmount.toString()}::numeric,
           rate_usd_scaled = ${input.rateUsdScaled.toString()}::numeric,
           paid_at = now(),
           updated_at = now()
     where id = ${input.id}
       and owner_subject = ${input.ownerSubject}
       and status = 'awaiting_payment'
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) return null
  const token = toToken(row)
  emit({
    topic: PAID_TOPIC,
    key: token.id,
    payload: {
      tokenId: token.id,
      ownerSubject: token.ownerSubject,
      journalEntryId: input.journalEntryId,
      priceUsdCents: token.priceUsdCents?.toString() ?? null,
      chargeAssetCode: input.chargeAssetCode,
      chargeAmount: input.chargeAmount.toString(),
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })
  return token
}

/**
 * Take the exclusive right to advance this order's deploy.
 *
 * CARRIED FORWARD from `forge-mint/src/store.ts`, which is the one correct distributed
 * primitive in the old estate, with three changes:
 *
 *   1. **`failed` is not claimable.** See the note on `CLAIMABLE`. In the frozen predicate a
 *      `failed` row is re-claimable with no lease wait at all, which is the second half of the
 *      Solana double-mint: broadcast, lose the race, write `failed`, re-claim instantly, mint
 *      again.
 *   2. **`raw_tx IS NULL` replaces `tx_hash IS NULL` as the in-flight guard.** The frozen guard
 *      admits a row whose bytes were signed and committed but whose broadcast had not yet been
 *      recorded — the catastrophic window. Guarding on the BYTES means a row that has been signed
 *      is never re-signed by anybody: the next claim resumes at broadcast with the identical
 *      bytes, which is a re-send of one transaction rather than a second one.
 *   3. **The lease is written explicitly** (`lease_owner`, `lease_until`) rather than inferred
 *      from a `deploy_started_at` timestamp, so an operator can see who holds it and until when,
 *      and so it can be RENEWED. The frozen lease cannot be: its 300-second budget was computed
 *      against the 180-second receipt wait alone and does not cover the three RPC round trips and
 *      the signing call that precede it, so a slow node can expire a lease before any bytes exist.
 *
 * A single conditional UPDATE: whichever transaction commits first stops the row matching, so the
 * second caller gets no row back and never reaches the chain.
 */
export async function claimDeploy(
  sql: Db,
  input: { readonly id: string; readonly owner: string; readonly leaseMs: number },
): Promise<TokenRecord | null> {
  const rows = await sql<TokenRow[]>`
    update tokens
       set status = 'deploying',
           lease_owner = ${input.owner},
           lease_until = now() + make_interval(secs => ${input.leaseMs / 1000}),
           deploy_attempts = deploy_attempts + 1,
           updated_at = now()
     where id = ${input.id}
       and status in ${sql(CLAIMABLE as string[])}
       -- Nothing is claimed while bytes exist that have not been sent. The next tick RESUMES at
       -- broadcast rather than re-signing, which is what makes a crash mid-deploy a re-send of one
       -- transaction rather than a second one.
       and raw_tx is null
       and (lease_until is null or lease_until < now())
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toToken(row) : null
}

/**
 * Extend a lease this replica already holds.
 *
 * Guarded on `lease_owner`, so a worker whose lease has already been taken over cannot push the
 * new holder's deadline out. Returns false in that case, and the caller must stop — it is no
 * longer the owner of this deploy and anything it does from here races the replica that is.
 */
export async function renewLease(
  sql: Db,
  input: { readonly id: string; readonly owner: string; readonly leaseMs: number },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update tokens
       set lease_until = now() + make_interval(secs => ${input.leaseMs / 1000}), updated_at = now()
     where id = ${input.id} and lease_owner = ${input.owner} and status = 'deploying'
    returning id
  `
  return rows.length > 0
}

/** Record the deployer address custody minted for this order. */
export async function markProvisioned(
  sql: Db,
  input: { readonly id: string; readonly owner: string; readonly deployerAddress: string },
): Promise<TokenRecord | null> {
  const rows = await sql<TokenRow[]>`
    update tokens
       set deployer_address = ${input.deployerAddress}, updated_at = now()
     where id = ${input.id} and lease_owner = ${input.owner} and status = 'deploying'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toToken(row) : null
}

/* ------------------------------------------------------------------ asking for gas */

/** What one pass over an under-funded deploy did. Every branch releases the lease. */
export type FundingRequest =
  | {
      readonly kind: 'requested'
      /** 1 for the first ask. Also the `attempt` on the wire and in settlement's idempotency key. */
      readonly attempt: number
      /** What was asked for, in wei — the shortfall plus headroom. */
      readonly amount: bigint
      readonly token: TokenRecord
    }
  | {
      readonly kind: 'held'
      readonly reason: 'limit_reached' | 'cooling_down' | 'no_deployer'
      readonly attempts: number
    }
  | { readonly kind: 'not_claimed' }

/**
 * How much headroom to ask for beyond the measured requirement, as a percentage of it.
 *
 * Asking for the exact shortfall is the mistake that looks correct. `funding` measures against
 * `eth_gasPrice` at that instant; the top-up then has to be planned, signed, broadcast and mined
 * before the next pass re-measures, and any upward tick in that window leaves the deployer short
 * AGAIN by a few thousand wei — a second full request cycle, and on the third one the order hits
 * the request limit and stops for a rounding error. Fifty per cent of a ~0.0014 EMBER deploy is a
 * fraction of a cent, so this is bought very cheaply.
 */
const FUNDING_HEADROOM_PCT = 50n

/** What to ask for: enough to cover the requirement with headroom, less what is already there. */
export function fundingAmount(required: bigint, balance: bigint): bigint {
  const target = required + (required * FUNDING_HEADROOM_PCT) / 100n
  return target > balance ? target - balance : 0n
}

/**
 * The payload of `mint.deploy.funding_requested`, as a pure function of the row and the
 * measurement. Pulled out of the emit for the same reason as `deployConfirmedPayload`: a guard
 * that needs a database to fail is skipped exactly when somebody is in a hurry.
 *
 * Every amount is a DECIMAL STRING. A wei quantity in a JSON number is silently rounded above
 * 2^53, and settlement's parser refuses anything that is not `/^\d+$/` rather than coercing.
 *
 * There is deliberately **no `userId`**. A customer paid for a token; the platform topping up its
 * own deployer address out of its own treasury is not a fact about that customer, and putting a
 * user on it would file platform plumbing in a person's activity feed.
 */
export function fundingRequestedPayload(
  token: TokenRecord,
  measured: { readonly required: bigint; readonly balance: bigint },
): Record<string, unknown> {
  return {
    tokenId: token.id,
    chain: token.chain,
    network: token.network,
    deployerAddress: token.deployerAddress,
    requiredWei: measured.required.toString(),
    balanceWei: measured.balance.toString(),
    // What is being ASKED for, which is the requirement plus headroom less the balance — NOT
    // `required - balance`, and named `amountWei` for exactly that reason. It was `shortfallWei`
    // for one afternoon and that name was a trap: settlement sends this figure verbatim and cannot
    // recompute it — it has no gas estimate for a creation it is not building — so a field whose
    // name says "shortfall" and whose value is 1.5× one is a wrong number waiting to be reasoned
    // about by its label.
    amountWei: (token.fundingRequestedWei ?? 0n).toString(),
    attempt: token.fundingRequests,
  }
}

/**
 * **THE ASK.** Release the lease into `awaiting_funds` and, if this order is still allowed to,
 * tell settlement its deployer cannot pay for itself.
 *
 * This replaces a bare `update … set status = 'awaiting_funds'` that had no event and no counter,
 * and which is why every paid order on both networks sat waiting for money nobody was sending.
 *
 * Both branches END IN THE SAME PLACE — `awaiting_funds`, lease released — because the next tick
 * must re-measure either way: a top-up may have landed since, and a held request must still be
 * picked up once the cooldown expires.
 *
 * The bounds are the whole reason this is one conditional UPDATE rather than a read and a write.
 * The sweep runs every tick, so a plain emit would send one event per tick per stuck order at the
 * one service that spends the treasury; and two ticks in the same minute would plan two transfers
 * for a shortfall the first already covers. `funding_requests < maxRequests` and the cooldown are
 * checked by the DATABASE in the same statement that increments the counter, so two replicas
 * racing produce one request and not two.
 */
export async function requestDeployerFunding(
  sql: Db,
  producer: string,
  input: {
    readonly id: string
    readonly owner: string
    readonly required: bigint
    readonly balance: bigint
    readonly maxRequests: number
    readonly cooldownMs: number
    /** The SERVICE's clock, stamped and compared in one domain — see `markBroadcast`. */
    readonly at: Date
    readonly actor: string
    readonly correlationId: string
  },
): Promise<FundingRequest> {
  const amount = fundingAmount(input.required, input.balance)
  return withOutbox(sql, producer, async (tx, emit) => {
    const asked = await tx<TokenRow[]>`
      update tokens
         set status = 'awaiting_funds',
             lease_owner = null,
             lease_until = null,
             funding_requests = funding_requests + 1,
             funding_requested_at = ${input.at.toISOString()}::timestamptz,
             funding_requested_wei = ${amount.toString()}::numeric,
             updated_at = now()
       where id = ${input.id}
         and lease_owner = ${input.owner}
         and status = 'deploying'
         and raw_tx is null
         -- Nothing to fund without an address to fund. The deploy job provisions one before it
         -- measures, so this is null only if custody answered and the write did not land.
         and deployer_address is not null
         and funding_requests < ${input.maxRequests}
         and (
           funding_requested_at is null
           or funding_requested_at
              < ${input.at.toISOString()}::timestamptz - make_interval(secs => ${input.cooldownMs / 1000})
         )
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = asked[0]
    if (row) {
      const token = toToken(row)
      emit({
        topic: FUNDING_REQUESTED_TOPIC,
        key: token.id,
        payload: fundingRequestedPayload(token, input),
        actor: input.actor,
        correlationId: input.correlationId,
      })
      return { kind: 'requested', attempt: token.fundingRequests, amount, token }
    }

    // Not allowed to ask — over the limit, inside the cooldown, or with no address. The row still
    // has to leave `deploying`, or the lease holds a deploy nobody is advancing until it expires.
    const released = await tx<TokenRow[]>`
      update tokens
         set status = 'awaiting_funds', lease_owner = null, lease_until = null, updated_at = now()
       where id = ${input.id}
         and lease_owner = ${input.owner}
         and status = 'deploying'
         and raw_tx is null
      returning ${tx.unsafe(COLUMNS)}
    `
    const held = released[0]
    if (!held) return { kind: 'not_claimed' }
    const token = toToken(held)
    const reason = !token.deployerAddress
      ? 'no_deployer'
      : token.fundingRequests >= input.maxRequests
        ? 'limit_reached'
        : 'cooling_down'
    return { kind: 'held', reason, attempts: token.fundingRequests }
  })
}

/**
 * **THE COMMIT.** Write the signed bytes, the nonce and the address they will produce, BEFORE
 * anything is broadcast.
 *
 * A crash between custody answering and this committing has broadcast nothing: the signature is
 * discarded unbroadcast, no gas was spent, no contract exists, and the next tick builds again from
 * a fresh nonce read. A crash after this and before the send leaves a row with `raw_tx` populated
 * and no `broadcast_at`, and the next tick RESUMES AT BROADCAST rather than re-signing — which is
 * why `claimDeploy` guards on `raw_tx is null` rather than on the hash.
 *
 * The derived transaction hash is written here too, and that is the piece the frozen service does
 * not have. `keccak256(rawTx)` is knowable the instant the bytes exist, so the id a chain will know
 * the transaction by is in the database BEFORE the send rather than after it. That closes the
 * window between `broadcastTransaction` and `onBroadcast` entirely: there is nothing left to lose.
 */
export async function markSigned(
  sql: Db,
  input: {
    readonly id: string
    readonly owner: string
    readonly rawTx: string
    readonly txHash: string
    readonly nonce: bigint
    readonly contractAddress: string
    readonly custodyAuditId: string
  },
): Promise<TokenRecord | null> {
  const rows = await sql<TokenRow[]>`
    update tokens
       set raw_tx = ${input.rawTx},
           deploy_tx_hash = ${input.txHash},
           deploy_nonce = ${input.nonce.toString()}::bigint,
           contract_address = ${input.contractAddress},
           custody_audit_id = ${input.custodyAuditId},
           updated_at = now()
     where id = ${input.id}
       and lease_owner = ${input.owner}
       and status = 'deploying'
       -- Committed once. A second write here would replace bytes that may already be on a wire.
       and raw_tx is null
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toToken(row) : null
}

/**
 * Record that the bytes reached a node.
 *
 * `broadcast_at` is set once and only once (`coalesce`), so a re-send does not push the stuck
 * clock out by one poll interval for ever — which would make a genuinely stuck deploy immortal.
 *
 * The schema will not let this commit without a hash (`tokens_broadcast_has_hash`), and the hash
 * is already on the row from `markSigned`, so the Solana failure mode — a broadcast recorded with
 * a null hash — is unrepresentable rather than merely avoided.
 *
 * **`at` is supplied by the application and is never left to `now()`.** `broadcast_at` is the only
 * timestamp on this row that is later COMPARED against a clock — `ageMs` measures from it to
 * decide whether a deploy is stuck. Stamping it with the database's clock and comparing it against
 * the service's mixed two clock domains, and a Postgres host a few tens of milliseconds ahead made
 * `ageMs` NEGATIVE: a just-broadcast deploy read as younger than zero, which is younger than any
 * stuck deadline and therefore never adjudicated. Billing hit the identical defect on
 * `granted_at`. This was caught by `deploy.test.ts`, intermittently, on a host whose Postgres
 * container runs ahead of the test process.
 */
export async function markBroadcast(
  sql: Db,
  producer: string,
  input: {
    readonly id: string
    readonly owner: string
    readonly at: Date
    readonly actor: string
    readonly correlationId: string
  },
): Promise<TokenRecord | null> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<TokenRow[]>`
      update tokens
         set broadcast_at = coalesce(broadcast_at, ${input.at.toISOString()}::timestamptz),
             updated_at = now()
       where id = ${input.id}
         and lease_owner = ${input.owner}
         and status = 'deploying'
         and raw_tx is not null
         and deploy_tx_hash is not null
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) return null
    const token = toToken(row)
    emit({
      topic: BROADCAST_TOPIC,
      key: token.id,
      payload: {
        tokenId: token.id,
        chain: token.chain,
        network: token.network,
        txHash: token.deployTxHash,
        // The address is DERIVED, so it is on the event from the moment of broadcast rather than
        // from the moment of confirmation. A project page can start polling the indexer for it
        // straight away instead of waiting for a receipt.
        contractAddress: token.contractAddress,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return token
  })
}

/**
 * The payload of `mint.deploy.confirmed`, as a pure function of the row.
 *
 * **Pulled out of the emit so that a test with no database can call it.** The estate's two recipient
 * readers are run over this in `topics.test.ts`; leaving it inline meant the only check that could
 * see it needed a real Postgres and a real deploy, and a guard that needs a database to fail is a
 * guard that is skipped exactly when somebody is in a hurry. `deploy.test.ts` still runs the readers
 * over the row the REAL path wrote — the two are complementary, not duplicates: this one proves the
 * shape, that one proves the shape survives the database and the wire.
 */
export function deployConfirmedPayload(token: TokenRecord): Record<string, unknown> {
  return {
    tokenId: token.id,
    ownerSubject: token.ownerSubject,
    /**
     * **THE PERSON, WHICH IS A DIFFERENT QUESTION FROM THE NAME.**
     *
     * Renaming the topic is only half the repair. `notify`'s rule for it is `forUser`, and
     * `userIdOf` (`notify/src/catalogue.ts`) looks for a bare uuid under `user_id`/`userId`,
     * then falls back to the envelope key only when the registry keys the topic by `user_id` — this
     * one is keyed by `token_id` — and finally to an actor of `user:<id>`. This emit is reached from
     * a leased deploy job, so the actor is `service:mint` (`deploy.ts`). `activity`'s classifier
     * reads `userId` as a bare uuid too (`classify.ts`).
     *
     * The payload carried `ownerSubject`, which is `user:<uuid>` — a SUBJECT, not a user id — so
     * every reader in the estate would have found nobody and a HIGH-priority notification would have
     * answered `no_recipient` for every deploy for ever. That is precisely the defect `micro-org`
     * records for `settlement.outbound.failed` and `market.offer.made`
     * (`org/tools/estate-topic-gaps.json`), where the topic is correct and the envelope names nobody
     * notify could address. One field closes it, so it is closed here rather than filed.
     *
     * Null when the owner is not a person. A token owned by an organisation has no single user, and
     * guessing one would put somebody else's deploy in a member's feed — `activity` resolves a null
     * to "no user" and files the record internal, which is the honest answer.
     */
    userId: userIdOfSubject(token.ownerSubject),
    ownerAddress: token.ownerAddress,
    chain: token.chain,
    network: token.network,
    contractAddress: token.contractAddress,
    txHash: token.deployTxHash,
    symbol: token.symbol,
    // Both consumers render a name before falling back to the symbol — `activity`'s summary is
    // "<name> is live at <address>" (`classify.ts`) and notify's `tokenName` tries `token_name`,
    // `tokenName`, `name`, then `symbol` (`catalogue.ts`). The column exists and simply was not
    // on the event, so every notification would have read "Your token".
    name: token.name,
  }
}

/**
 * Terminal success, with its event in the same transaction.
 *
 * Guarded on the HASH as well as the lease. That is `applyDeploySettlement`'s shape from the
 * frozen store, and it is the guard the frozen SUCCESS path does not use: a settlement that
 * already concluded this hash was dropped has cleared it, so this write matches nothing rather
 * than resurrecting a contract that is not there.
 */
export async function markDeployed(
  sql: Db,
  producer: string,
  input: {
    readonly id: string
    readonly txHash: string
    readonly contractAddress: string
    readonly actor: string
    readonly correlationId: string
  },
): Promise<TokenRecord | null> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<TokenRow[]>`
      update tokens
         set status = 'deployed',
             contract_address = ${input.contractAddress},
             confirmed_at = now(),
             failure_reason = null,
             lease_owner = null,
             lease_until = null,
             updated_at = now()
       where id = ${input.id}
         and deploy_tx_hash = ${input.txHash}
         and status = 'deploying'
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) return null
    const token = toToken(row)
    emit({
      topic: DEPLOYED_TOPIC,
      key: token.id,
      payload: deployConfirmedPayload(token),
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return token
  })
}

/**
 * Terminal failure.
 *
 * **`deploy_tx_hash` is never cleared.** The frozen service clears it on a `reverted` or `dropped`
 * settlement so the order becomes retryable, and that is the wrong trade: it destroys the only
 * record of where a customer's gas went, and it is precisely what makes the row claimable again.
 * Here a failed deploy keeps its hash, keeps its evidence, and is retried only by an explicit act
 * that creates a NEW attempt row — never by a background poll finding the row claimable.
 */
export async function markFailed(
  sql: Db,
  producer: string,
  input: {
    readonly id: string
    readonly reason: string
    readonly actor: string
    readonly correlationId: string
  },
): Promise<TokenRecord | null> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<TokenRow[]>`
      update tokens
         set status = 'failed',
             failure_reason = ${input.reason.slice(0, 2_000)},
             lease_owner = null,
             lease_until = null,
             updated_at = now()
       where id = ${input.id} and status not in ${tx(TERMINAL as string[])}
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) return null
    const token = toToken(row)
    emit({
      topic: FAILED_TOPIC,
      key: token.id,
      payload: {
        tokenId: token.id,
        ownerSubject: token.ownerSubject,
        reason: token.failureReason,
        // On the event because it is the question an operator asks first, and because a `false`
        // here is a promise that no gas was spent. The frozen service logs `broadcast: false` for
        // a transaction it did in fact broadcast, which sends a triage in the wrong direction.
        broadcast: token.broadcastAt !== null,
        txHash: token.deployTxHash,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return token
  })
}

/** Release a lease without moving the state, so another replica may take the row immediately. */
export async function releaseLease(sql: Db, id: string, owner: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update tokens
       set lease_owner = null, lease_until = null, updated_at = now()
     where id = ${id} and lease_owner = ${owner}
    returning id
  `
  return rows.length > 0
}

/* ------------------------------------------------------------------ attempts */

export type AttemptOutcome =
  | 'signed'
  | 'broadcast'
  | 'confirmed'
  | 'reverted'
  | 'refused'
  | 'unavailable'
  | 'not_implemented'

/**
 * Append-only evidence, one row per (attempt, outcome).
 *
 * The unique constraint is on `(token_id, attempt, outcome)` rather than on `(token_id, attempt)`,
 * because one attempt legitimately produces several: `signed` then `broadcast` then `confirmed`.
 * What it stops is the same outcome being recorded twice for one attempt, which is what a retry
 * loop that has lost track of itself does.
 *
 * `on conflict do nothing`: recording evidence must never be the thing that fails a deploy.
 */
export async function recordAttempt(
  sql: Db,
  input: {
    readonly tokenId: string
    readonly attempt: number
    readonly family: string
    readonly outcome: AttemptOutcome
    readonly txHash?: string | null
    readonly detail?: string | null
  },
): Promise<void> {
  await sql`
    insert into token_deploy_attempts (token_id, attempt, family, outcome, tx_hash, detail)
    values (
      ${input.tokenId}, ${input.attempt}, ${input.family}, ${input.outcome},
      ${input.txHash ?? null}, ${input.detail?.slice(0, 2_000) ?? null}
    )
    on conflict (token_id, attempt, outcome) do nothing
  `
}

export interface AttemptRecord {
  readonly attempt: number
  readonly family: string
  readonly outcome: AttemptOutcome
  readonly txHash: string | null
  readonly detail: string | null
  readonly createdAt: Date
}

export async function listAttempts(sql: Db, tokenId: string): Promise<AttemptRecord[]> {
  const rows = await sql<
    {
      attempt: number
      family: string
      outcome: string
      tx_hash: string | null
      detail: string | null
      created_at: Date
    }[]
  >`
    select attempt, family, outcome, tx_hash, detail, created_at
      from token_deploy_attempts
     where token_id = ${tokenId}
     order by created_at
  `
  return rows.map((row) => ({
    attempt: row.attempt,
    family: row.family,
    outcome: row.outcome as AttemptOutcome,
    txHash: row.tx_hash,
    detail: row.detail,
    createdAt: row.created_at,
  }))
}

/* ------------------------------------------------------------------ the work queue */

/**
 * Tokens whose deploy is outstanding, oldest first.
 *
 * The frozen service has NO reconciler at all: settlement runs only when a request arrives for
 * that specific order, so a customer who closes the tab leaves a broadcast deploy in `deploying`
 * with a live hash indefinitely and nothing ever looks at it again. This query is what the leased
 * sweeper walks, and it is the reason a deploy no longer depends on anybody watching it.
 */
export async function outstandingDeploys(sql: Db, limit: number): Promise<TokenRecord[]> {
  const rows = await sql<TokenRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from tokens
     where status in ${sql(CLAIMABLE as string[])}
     order by created_at
     limit ${limit}
  `
  return rows.map(toToken)
}

/**
 * How long a deploy has been outstanding, dated from the broadcast where there was one.
 *
 * `broadcastAt` comes from the application clock (see `markBroadcast`), so this subtraction is
 * within one clock domain. `createdAt` is the database's, and that is deliberate and safe: it is
 * only reached for a row that has never broadcast, where a few tens of milliseconds of skew
 * against a stuck deadline measured in minutes cannot change an answer. Clamped at zero anyway,
 * because a negative age is not a young deploy — it is a clock disagreement, and reading it as
 * "younger than any deadline" is how a stuck row becomes immortal.
 */
export function ageMs(token: Pick<TokenRecord, 'broadcastAt' | 'createdAt'>, now: number): number {
  return Math.max(0, now - (token.broadcastAt ?? token.createdAt).getTime())
}
