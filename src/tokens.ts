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
  readonly priceShards: bigint
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
  readonly price_shards: string
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
  readonly created_at: Date
  readonly updated_at: Date
}

/** Every column, once. Repeating this list per query is how a projection quietly loses a field. */
const COLUMNS = `
  id, owner_subject, owner_wallet_id, owner_address, chain, network, standard, name, symbol,
  decimals, supply, cap, features, metadata_uri, brand_kit_id, status, price_shards,
  paid_journal_entry_id, paid_at, deployer_address, deploy_nonce, raw_tx, custody_audit_id,
  deploy_tx_hash, contract_address, broadcast_at, confirmed_at, failure_reason, lease_owner,
  lease_until, deploy_attempts, created_at, updated_at
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
    priceShards: BigInt(row.price_shards),
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
  readonly priceShards: bigint
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
 * fixture in `community/src/server.test.ts:632` that uses it as an example of a topic community does
 * NOT subscribe to. Nobody was listening. Meanwhile the registered name is read in four places:
 *
 *   - `notify/src/catalogue.ts:568` — priority HIGH, template `token.deployed`, and its own `why`
 *     says it "is the event that retires ForgeMint's four-second client poll".
 *   - `activity/src/classify.ts:838` — `token.deploy_confirmed`, user-visible.
 *   - `analytics/src/catalogue.ts:321` — `token_deployed`, personal, feeding metrics 8 and 9
 *     (`docs/ecosystem/13-operational-model.md:623`, token creation and its funnel).
 *   - `docs/ecosystem/07-dependency-map.md:176` and `02-target-architecture.md:704` both list
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

export async function createToken(
  sql: Db,
  producer: string,
  input: CreateToken,
): Promise<TokenRecord> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<TokenRow[]>`
      insert into tokens (
        owner_subject, owner_wallet_id, owner_address, chain, network, name, symbol, decimals,
        supply, cap, features, metadata_uri, brand_kit_id, status, price_shards
      ) values (
        ${input.ownerSubject}, ${input.ownerWalletId}, ${input.ownerAddress}, ${input.chain},
        ${input.network}, ${input.name}, ${input.symbol}, ${input.decimals},
        ${input.supply.toString()}::numeric, ${input.cap === null ? null : input.cap.toString()}::numeric,
        ${input.features as string[]}, ${input.metadataUri}, ${input.brandKitId},
        'awaiting_payment', ${input.priceShards.toString()}::numeric
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
        priceShards: token.priceShards.toString(),
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
    readonly actor: string
    readonly correlationId: string
  },
): Promise<TokenRecord | null> {
  const rows = await tx<TokenRow[]>`
    update tokens
       set status = 'paid',
           paid_journal_entry_id = ${input.journalEntryId},
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
      priceShards: token.priceShards.toString(),
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })
  return token
}

/**
 * Take the exclusive right to advance this order's deploy.
 *
 * CARRIED FORWARD from `forge-mint/src/store.ts:164`, which is the one correct distributed
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
     * `userIdOf` (`notify/src/catalogue.ts:120`) looks for a bare uuid under `user_id`/`userId`,
     * then falls back to the envelope key only when the registry keys the topic by `user_id` — this
     * one is keyed by `token_id` — and finally to an actor of `user:<id>`. This emit is reached from
     * a leased deploy job, so the actor is `service:mint` (`deploy.ts:309`). `activity`'s classifier
     * reads `userId` as a bare uuid too (`classify.ts:112`).
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
    // "<name> is live at <address>" (`classify.ts:844`) and notify's `tokenName` tries `token_name`,
    // `tokenName`, `name`, then `symbol` (`catalogue.ts:576`). The column exists and simply was not
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
