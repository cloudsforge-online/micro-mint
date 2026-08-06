/**
 * Paying for a deploy.
 *
 * ---------------------------------------------------------------------------------------------
 * **THE DEFECT THIS FILE EXISTS TO FIX.** The frozen service does this
 * (`forge-mint/src/routes/tokens.ts`):
 *
 *     const result = await spendShards(bearer, offer.shardPrice, …, `forge-mint:order:${id}`, …)
 *     if (result.insufficient) return 402
 *     if (!result.ok) return 502
 *     const updated = await updateOrder(order.id, { status: 'paid' })
 *
 * A cross-service debit, then a separate, unguarded, non-transactional local UPDATE, with an
 * `await` boundary and two early returns between them. A process that dies in the gap has charged
 * the customer and left the order in `awaiting_payment` with no compensation and no record. The
 * customer's only recovery is to press Pay again and hope the downstream idempotency key has not
 * expired — a 30-day TTL in another service is the entire safety net.
 *
 * **The fix: the ledger call happens INSIDE the transaction that records its result.**
 *
 * That is billing's shape and it is the right one. Two idempotency keys, and they are not the same
 * thing: the caller's key makes the *request* happen once, and a key DERIVED from the token id —
 * `mint:order:<id>` — makes the *entry* post once. The second is derived rather than random
 * precisely so a transaction that rolls back after posting cannot post again on the retry: the
 * ledger recognises the key and replays its stored answer, and `markPaid` then commits against the
 * same entry id.
 *
 * **Why the HTTP call is inside the transaction.** It holds a database connection for the length of
 * a bounded remote call, which is a real cost and the reason `MINT_UPSTREAM_DEADLINE_MS` exists.
 * The alternative — commit `paid`, post the entry from a job — marks an order paid before the money
 * has moved, so an order with no balance behind it reaches the deploy queue and spends the
 * platform's gas. Between "hold a connection for five seconds" and "deploy a contract nobody paid
 * for", this is not a close decision.
 * ---------------------------------------------------------------------------------------------
 */

import { parseAccountSubject } from '@cloudsforge/contracts-money'
import type { IssuableAssetCode } from '@cloudsforge/contracts-chain'
import { withOutbox, type Db } from './outbox.ts'
import type { PricingClient } from './pricingclient.ts'
import {
  deployPostings,
  orderIdempotencyKey,
  LedgerRefusedError,
  type LedgerClient,
} from './ledgerclient.ts'
import { markPaid, type TokenRecord } from './tokens.ts'

/** The ledger refused for want of balance. A 402 to the customer, and not an error at all. */
export class InsufficientBalanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientBalanceError'
  }
}

/** The order is not in a state that can be paid. Includes "already paid", which is a 409. */
export class OrderStateError extends Error {
  readonly status: string
  constructor(message: string, status: string) {
    super(message)
    this.name = 'OrderStateError'
    this.status = status
  }
}

export interface PayDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  /**
   * Reads the USD→EMBER rate. **Fails the payment rather than guessing** — see `pricingclient.ts`.
   *
   * A real availability coupling, and the correct one: the order is quoted in dollars and the
   * ledger is posted in EMBER, and nothing can turn the first into the second without a rate.
   */
  readonly pricing: PricingClient
  /** What the customer is charged in. `IssuableAssetCode`, so it can never be a retired code. */
  readonly settlementAsset: IssuableAssetCode
  readonly producer: string
}

export interface PayRequest {
  readonly tokenId: string
  readonly ownerSubject: string
  readonly actor: string
  readonly correlationId: string
}

export interface PayResult {
  readonly token: TokenRecord
  /** True when the ledger answered from a stored response rather than by posting. */
  readonly replayed: boolean
  readonly journalEntryId: string
}

/**
 * Debit the customer and record the order as paid, atomically.
 *
 * The ordering inside the transaction is deliberate and it is the opposite of the frozen service's:
 *
 *   1. Re-read the row FOR UPDATE. The precondition is then held for the length of the
 *      transaction, so two concurrent payment attempts serialise here rather than both passing a
 *      check made against a snapshot read moments earlier.
 *   2. Post the entry. If the ledger refuses for balance the whole transaction rolls back and
 *      nothing was written; if it is unreachable, likewise, and the caller retries with the same
 *      derived key.
 *   3. `markPaid`, guarded on `awaiting_payment`, in the same transaction. It cannot fail to match
 *      here — the FOR UPDATE established the state — but the guard stays because a predicate that
 *      is only correct because of something two statements above it is a predicate that stops
 *      being correct when somebody moves a statement.
 */
export async function payForDeploy(deps: PayDeps, request: PayRequest): Promise<PayResult> {
  // Validated with the ledger's own parser so the two cannot disagree about what a subject is.
  parseAccountSubject(request.ownerSubject)

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE PRICE IS READ BEFORE THE TRANSACTION OPENS, AND THAT PLACEMENT IS DELIBERATE.
  //
  // The quote is a network call to micro-pricing that can fail. Failing it here leaves nothing to
  // unwind — no row is locked, no connection is held, and the customer gets a 503 having been
  // charged nothing. Inside `withOutbox` it would sit in the same transaction as the ledger post,
  // holding a database connection across a SECOND upstream and lengthening the window in which a
  // row is locked FOR UPDATE. This is the placement `billing/src/purchases.ts` argues for and the
  // reasoning transfers unchanged.
  //
  // The cost of reading it early is that the price is quoted a few milliseconds before the debit
  // rather than inside it. That is the right trade: the rate is administered and does not move
  // between two statements, and the figure that was used is written onto the row either way.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const priced = await priceOf(deps, request)

  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const rows = await tx<{ id: string; status: string; paid_journal_entry_id: string | null }[]>`
      select id, status, paid_journal_entry_id
        from tokens
       where id = ${request.tokenId} and owner_subject = ${request.ownerSubject}
         for update
    `
    const row = rows[0]
    if (!row) throw new OrderStateError('no such order', 'not_found')
    if (row.status !== 'awaiting_payment') {
      throw new OrderStateError(`an order in ${row.status} cannot be paid`, row.status)
    }

    let entry
    try {
      entry = await deps.ledger.postEntry({
        kind: 'purchase',
        actor: request.actor as Parameters<LedgerClient['postEntry']>[0]['actor'],
        correlationId: request.correlationId,
        // DERIVED, not random. See the file header — this is what makes a rolled-back transaction
        // safe to retry.
        idempotencyKey: orderIdempotencyKey(request.tokenId),
        description: `mint: token deploy ${request.tokenId}`,
        postings: deployPostings({
          subject: request.ownerSubject,
          assetCode: deps.settlementAsset,
          amount: priced.amount,
        }),
      })
    } catch (err) {
      // Insufficient balance is the customer's answer, not a fault. Translated here so the route
      // can answer 402 without knowing what a ledger error code looks like.
      if (err instanceof LedgerRefusedError && /insufficient/i.test(err.code)) {
        throw new InsufficientBalanceError(err.message)
      }
      throw err
    }

    const token = await markPaid(tx, emit, {
      id: request.tokenId,
      ownerSubject: request.ownerSubject,
      journalEntryId: entry.id,
      chargeAssetCode: deps.settlementAsset,
      chargeAmount: priced.amount,
      rateUsdScaled: priced.usdScaled,
      actor: request.actor,
      correlationId: request.correlationId,
    })
    // Unreachable given the FOR UPDATE above, and therefore exactly the sort of thing to throw on
    // rather than to paper over: reaching it means the guard and the lock have come apart, and
    // rolling back is the only answer that does not leave a debit with no order behind it.
    if (!token) throw new Error('paid an order that no longer matched its own precondition')

    return { token, replayed: entry.replayed, journalEntryId: entry.id }
  })
}

/**
 * What this order costs, in the unit it will be charged in.
 *
 * Reads the order's `price_usd_cents` — the durable figure — and converts it once, at the rate
 * micro-pricing publishes now. Both numbers come back, because both are written onto the row: the
 * charge is what a refund must return, and the rate is what makes the arithmetic checkable
 * afterwards. Without the rate, the cents and the wei are two numbers with no stated relationship
 * and nobody can tell a rate change from a bug.
 */
async function priceOf(
  deps: PayDeps,
  request: PayRequest,
): Promise<{ readonly amount: bigint; readonly usdScaled: bigint }> {
  const rows = await deps.sql<{ price_usd_cents: string | null; price_shards: string | null }[]>`
    select price_usd_cents, price_shards
      from tokens
     where id = ${request.tokenId} and owner_subject = ${request.ownerSubject}
  `
  const row = rows[0]
  if (!row) throw new OrderStateError('no such order', 'not_found')

  // An order quoted only in Shards is one this build cannot honour. It predates migration 6's
  // back-fill, which set `price_usd_cents` on every row that existed — so reaching this means the
  // row was written by the retired build during a rollout, and the only safe answer is to refuse.
  //
  // Explicit, and not `BigInt(row.price_usd_cents ?? '')`: **`BigInt('')` is `0n`**, so the tidy
  // spelling would turn a missing price into a FREE DEPLOY — a gas bill the platform pays for
  // anyone who can open an order.
  if (row.price_usd_cents === null) {
    throw new OrderStateError(
      'this order was quoted in a retired unit and cannot be paid; open a new one',
      'awaiting_payment',
    )
  }

  const cents = BigInt(row.price_usd_cents)
  if (cents <= 0n) throw new OrderStateError('this order has no price to charge', 'awaiting_payment')

  const quote = await deps.pricing.quote(deps.settlementAsset, cents)

  // Belt and braces over `coinAmountForUsdCents`, which already refuses this. A positive price that
  // settles to nothing is a free deploy, and the order reaches the deploy queue in the same
  // transaction as the posting — so a zero here would spend the platform's gas for a balanced entry
  // that moved no money.
  if (quote.amount <= 0n) {
    throw new OrderStateError(
      `a price of ${cents} cents settled to ${quote.amount} — refusing to charge nothing for something`,
      'awaiting_payment',
    )
  }

  return { amount: quote.amount, usdScaled: quote.usdScaled }
}
