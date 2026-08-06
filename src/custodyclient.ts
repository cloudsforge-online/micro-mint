/**
 * Custody, as this service uses it.
 *
 * **This service holds no keys and asks for none.** It sends an unsigned contract creation and
 * receives bytes. There is no method here that could return key material even if custody offered
 * one, and custody has exactly one route that returns any — the export ceremony's redemption —
 * which needs a user token and cannot be reached with the credential below.
 *
 * ## One purpose, one shape, and that is the whole of the blast radius
 *
 * Every signature this service asks for is `purpose: 'deployer'`, which custody's policy binds to
 * the `creation` shape: `to` must be null, `value` must be zero, `data` must be non-empty creation
 * bytecode under EIP-3860's 49,152-byte ceiling, and the gas limit must lie in [21,000, 8,000,000].
 * A deployer address therefore CANNOT transfer, cannot call a contract and cannot mint, whoever
 * holds the credential. That is why the customer's own wallet being the contract owner is safe: the
 * platform's key is not merely policy-restricted from touching the token, it is incapable of it.
 *
 * ## The binding is restated, and that is the awkward part of this interface
 *
 * `POST /v1/sign` takes SEVEN identity fields — `address`, `chain`, `network`, `family`, `purpose`,
 * `userId`, `orderId` — and compares all seven, character for character, against the row it holds.
 * Getting any one of them wrong is a 403 `binding_mismatch` whose message deliberately does NOT say
 * which field disagreed, because naming it would be an oracle a caller could walk one field at a
 * time. So a caller cannot debug a mismatch from the response; it has to be right by construction
 * instead.
 *
 * **The one field that is not this service's slug is `chain`.** Custody's names are
 * `ethereum`/`bitcoin`/`solana`/`xrp`/`ember`; ours are the asset code lowercased. They agree on
 * four of five and `eth` versus `ethereum` is the fifth. `custodyChainOf` in `chains.ts` is the
 * translation, and it is a named table rather than a `toLowerCase()` that happens to work for the
 * other four. Settlement lost time to exactly this.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { ChainFamily, Network } from '@cloudsforge/contracts-chain'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scope this service's token must carry, and it is ONE.
 *
 * Not `custody:sign:treasury` and not `custody:sign:deposit`: mint never moves money, so a
 * credential that could is a credential whose compromise is a loss rather than an outage. SD-05.
 *
 * ── THE ANNOTATION: AN OUTBOUND DEMAND, TYPED AGAINST THE REGISTRY ───────────────────────────
 *
 * `readonly LiveScope[]`, not `readonly string[]`. `service-ci.yml` proves that every scope a
 * repository's route GATES demand is registered — the INBOUND direction. This constant is the
 * other one: what this service PRESENTS to a peer. Nothing had ever checked it, which is how
 * `micro-market` declared `policy:evaluate` and `micro-wallet` `custody:address` — neither ever
 * a registry key — for the life of both services. `derive-grants.mjs` reads this into
 * `IDENTITY_SERVICE_TOKEN_GRANTS`, and identity validates that list at import and REFUSES TO
 * START on an unknown name (`identity/src/env.ts`): a dead identity container, so no tokens
 * for anybody.
 *
 * `LiveScope` rather than `Scope` because `Scope` is `keyof typeof SCOPES` — every registered
 * key, DEPRECATED ones included — and identity will not mint a deprecated scope either.
 * `LiveScope = Exclude<Scope, DeprecatedScope>`, with `DeprecatedScope` computed FROM `SCOPES` by
 * a conditional type over the `deprecated` field rather than hand-listed
 * (`contracts/packages/auth/src/index.ts`), so it cannot drift from the registry. `Scope`
 * keeps its wide meaning and this does not narrow it: a token arriving from anywhere may carry a
 * scope that has since died, so reading is wide and demanding is narrow. This is demanding.
 */
export const CUSTODY_SCOPES: readonly LiveScope[] = Object.freeze([
  'custody:sign:deployer',
  'custody:address:create',
])

/** Custody looked at the request and refused it. Never retriable with the same request. */
export class CustodySignRefusedError extends Error {
  /** `purpose_forbidden · binding_mismatch · shape_refused · not_found`. */
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CustodySignRefusedError'
    this.code = code
    this.status = status
  }
}

/** Custody could not be reached, or answered 5xx. We do not know whether it signed. */
export class CustodyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyUnavailableError'
  }
}

/** The seven identity fields plus the payload, exactly as `POST /v1/sign` wants them. */
export interface SignRequest {
  readonly address: string
  /** Custody's chain NAME, not this service's slug. `custodyChainOf` translates. */
  readonly chain: string
  readonly network: Network
  readonly family: ChainFamily
  /** Always `deployer` here. Typed as a literal so a widening is a compile error, not a review. */
  readonly purpose: 'deployer'
  readonly userId: string
  readonly orderId: string
  /** The exact object custody's signer receives. Extra fields are refused, not ignored. */
  readonly payload: Record<string, unknown>
  readonly correlationId: string
}

export interface SignedResult {
  /** The serialised signed transaction. This is what gets committed, then broadcast. */
  readonly signedTx: string
  /** The id of the audit row custody committed with the signature. Stored beside the bytes. */
  readonly auditId: string
}

export interface DeployerAddress {
  readonly address: string
  readonly chain: string
  readonly network: Network
  readonly family: ChainFamily
}

export interface CustodyClient {
  sign(request: SignRequest): Promise<SignedResult>
  /**
   * Mint the per-order deployer address that will pay this token's gas.
   *
   * Idempotent on `(chain, network, userId, orderId)`: custody derives everything it writes from
   * those, so a retry after a lost response returns the address that already exists rather than
   * minting a second one. That matters more here than it looks — a second deployer address is a
   * second nonce sequence, and a deploy that signs against the wrong one is a contract at an
   * address the order does not know.
   */
  provisionDeployer(input: {
    readonly chain: string
    readonly network: Network
    readonly userId: string
    readonly orderId: string
    readonly correlationId: string
  }): Promise<DeployerAddress>
}

export interface CustodyClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

interface KeyBody {
  readonly key: { readonly address: string; readonly chain: string; readonly network: string; readonly family: string }
}

export function httpCustodyClient(options: CustodyClientOptions): CustodyClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'custody',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async sign(request) {
      try {
        // NO IDEMPOTENCY KEY, and its absence is deliberate. `HttpClient` attempts a POST exactly
        // once unless a key is present, which is precisely what is wanted here: this service must
        // never be in a position where two sets of creation bytes exist for one order. A signature
        // that was made and whose response was lost is discarded UNBROADCAST — nothing was sent,
        // so no gas was spent and no contract exists — and the next tick builds again from a fresh
        // nonce read.
        const body = await client.request<SignedResult>('/v1/sign', {
          method: 'POST',
          body: {
            address: request.address,
            chain: request.chain,
            network: request.network,
            family: request.family,
            purpose: request.purpose,
            userId: request.userId,
            orderId: request.orderId,
            payload: request.payload,
          },
          requestId: request.correlationId,
        })
        if (typeof body.signedTx !== 'string' || body.signedTx.length === 0) {
          throw new CustodyUnavailableError('custody answered 200 with no signature')
        }
        return body
      } catch (err) {
        throw translateSign(err)
      }
    },

    async provisionDeployer(input) {
      try {
        const body = await client.request<KeyBody>('/v1/addresses', {
          method: 'POST',
          body: {
            chain: input.chain,
            network: input.network,
            purpose: 'deployer',
            userId: input.userId,
            orderId: input.orderId,
            scheme: 'hd_bip44',
          },
          // The order id IS the idempotency of this call on custody's side, but the key is sent
          // anyway so `HttpClient` will retry the POST at all: without one it attempts exactly
          // once, and a lost response would strand an order that has already paid.
          idempotencyKey: `mint:deployer:${input.orderId}`,
          requestId: input.correlationId,
        })
        const key = body.key
        if (!key || typeof key.address !== 'string') {
          throw new CustodyUnavailableError('custody answered 201 with no address')
        }
        return {
          address: key.address,
          chain: key.chain,
          network: key.network as Network,
          family: key.family as ChainFamily,
        }
      } catch (err) {
        throw translateSign(err)
      }
    },
  }
}

/**
 * Turn an HTTP failure into one of the two things a caller can act on.
 *
 * `HttpError.peerDecided` is the discriminator: a 4xx means custody looked at the request and said
 * no, which is a permanent fact about this request and must not be retried. Anything else — 5xx, a
 * timeout, an open circuit — means we do not know whether it signed, and the only safe response is
 * to leave the row where it is and try again on the next tick.
 *
 * The distinction matters here for the same reason it does in settlement: a "refusal" that was
 * really a timeout would fail an order whose signature may exist, and a signature that exists is a
 * transaction that may yet reach a chain.
 */
function translateSign(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new CustodySignRefusedError(err.status, parsed.code, parsed.message)
  }
  if (err instanceof CustodyUnavailableError || err instanceof CustodySignRefusedError) return err
  return new CustodyUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'custody_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'custody_error', message: body.slice(0, 500) }
  }
}
