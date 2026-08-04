/**
 * The ledger, as this service uses it.
 *
 * **This service holds no balance.** 04-domain-model §11 — "no 'user balance' column anywhere
 * outside the ledger's projection" — and the price of a deploy is debited by posting a balanced
 * entry, never by decrementing a column here. The frozen service is on the right side of this
 * already, in that it calls out to forge-pay rather than keeping its own wallet; what it does not
 * have is the atomicity, which is `orders.ts`.
 *
 * ## One entry, one order, for ever
 *
 * The idempotency key is `mint:order:<tokenId>` — DERIVED from the order rather than random, and
 * that is the whole recovery story. A transaction that posts the entry and then rolls back locally
 * cannot post again on the retry: the ledger recognises the key and replays its stored answer, so
 * the customer is debited exactly once however many times the order is retried, and the entry id
 * that comes back is the same one both times. The frozen service gets this right too — the key is
 * `forge-mint:order:<id>` — but the primitive that makes it safe lives in forge-pay, so its
 * correctness on this route is entirely borrowed from a downstream service. Here the key and the
 * transaction that records its result are in the same function.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { Actor, EntryKind, LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { IssuableAssetCode } from '@cloudsforge/contracts-chain'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call this peer.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `custodyclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the estate's grant list, and
 * identity
 * refuses to boot on a name the registry does not have — or has deprecated, which `Scope` alone
 * would not have caught.
 */
export const LEDGER_SCOPES: readonly LiveScope[] = Object.freeze(['ledger:post'])

/**
 * The ledger refused on the state of the world — most often an insufficient balance, which is a
 * 402 to the customer and not an error at all. Never retried with the same request.
 */
export class LedgerRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRefusedError'
    this.code = code
    this.status = status
  }
}

/** The ledger could not be reached, or answered 5xx. Retry with the same idempotency key. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

export interface AccountRef {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: 'available' | 'reserved' | 'escrow' | 'treasury' | 'fees' | 'payout_due' | 'suspense'
  readonly type: 'liability' | 'asset' | 'revenue' | 'expense' | 'equity' | 'clearing'
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
  readonly account: AccountRef
}

export interface PostEntryRequest {
  readonly kind: EntryKind
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly postings: readonly PostingRequest[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  /** True when the ledger answered from a stored response rather than by posting. */
  readonly replayed: boolean
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>
}

/**
 * The two postings that pay for a deploy: the customer's EMBER out, the platform's revenue in.
 *
 * Balanced by construction because it is the same number on both sides, which is what lets the
 * ledger refuse an unbalanced entry without this service having to prove anything.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`assetCode` IS A PARAMETER, AND IT IS TYPED `IssuableAssetCode`.**
 *
 * It used to be the literal `'SHARD'`, four times over, and that is the whole defect this release
 * fixes: SHARD was retired on 2026-08-04 and this function went on debiting it, so a customer of
 * Forge Create was charged in a wound-down unit for a day. The screen that said "Pay 2,500 Shards"
 * was reporting this function accurately.
 *
 * `IssuableAssetCode` is `Exclude<AssetCode, 'SHARD'>` (contracts/packages/chain). Passing a
 * retired code here is now a COMPILE ERROR rather than a comment somebody has to read, which is
 * the only kind of rule that survives the next edit. micro-ledger refuses it a second time at the
 * database — its migration 13 — because a compile error binds this repository and nothing else.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function deployPostings(input: {
  readonly subject: string
  readonly assetCode: IssuableAssetCode
  readonly amount: bigint
}): readonly PostingRequest[] {
  return [
    {
      account: { subject: input.subject, assetCode: input.assetCode, purpose: 'available', type: 'liability' },
      direction: 'debit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 0,
    },
    {
      account: { subject: 'platform', assetCode: input.assetCode, purpose: 'fees', type: 'revenue' },
      direction: 'credit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 1,
    },
  ]
}

/** The key one order's entry is posted under, for ever. See the file header. */
export function orderIdempotencyKey(tokenId: string): string {
  return `mint:order:${tokenId}`
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly originatingService: string
  readonly fetch?: typeof globalThis.fetch
}

interface RawEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async postEntry(request) {
      try {
        // The key is in the body AND on the request, and both matter. In the body it is what the
        // ledger stores and dedupes on; on the request it is what makes the POST retriable at all,
        // because `HttpClient` attempts a non-idempotent method exactly once without one.
        const body = await client.request<{ entry: RawEntry; replayed: boolean }>('/entries', {
          method: 'POST',
          body: {
            kind: request.kind,
            originatingService: options.originatingService,
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            postings: request.postings.map((posting) => ({
              direction: posting.direction,
              // Smallest units as a decimal STRING, in both directions. A JSON number is an IEEE
              // 754 double, and a large amount does not survive one — it does not fail either, it
              // comes back subtly wrong.
              amount: posting.amount.toString(),
              assetCode: posting.assetCode,
              sequence: posting.sequence,
              account: posting.account,
            })),
          },
          idempotencyKey: request.idempotencyKey,
        })
        return {
          id: body.entry.id,
          kind: body.entry.kind,
          recordedAt: body.entry.recordedAt,
          replayed: body.replayed,
        }
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

/**
 * `HttpError.peerDecided` is the discriminator: a 4xx means the ledger looked at the request and
 * said no, which is a permanent fact about it. Anything else means we do not know whether the
 * entry posted, and the only safe response is to retry with the same key.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new LedgerRefusedError(err.status, parsed.code, parsed.message)
  }
  if (err instanceof LedgerRefusedError || err instanceof LedgerUnavailableError) return err
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) }
  }
}
