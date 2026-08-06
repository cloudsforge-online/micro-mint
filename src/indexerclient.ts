/**
 * The indexer, as this service uses it. Two calls, and the second is the one that matters.
 *
 * ## `transaction` — what became of a deploy
 *
 * The indexer is the estate's declared reader of chain state and applies the same
 * `contracts-chain` confirmation depths this service does, so where it has an answer, its answer is
 * the one to use. But it is a FOLLOWER: its worker walks blocks, so a creation broadcast four
 * seconds ago is not in it yet, and "the indexer has never heard of this hash" is emphatically NOT
 * "the chain does not have it". Reading that absence as a failure would mark every fresh broadcast
 * lost and re-deploy it — paying gas twice for one order, which is the exact defect this service
 * exists to end. So the rule in `deploy.ts` is: the indexer when it has the transaction, the node
 * when it does not, and neither is allowed to be silently absent.
 *
 * ## `token` — supply and authorities, which is 04-domain-model §5.3's invariant
 *
 * "A project page always renders supply, authorities, network and contract address from the
 * INDEXER, not from the order record — the on-chain reality, not the intent."
 *
 * That distinction is not pedantry, it is the difference between a fact and a claim. The order row
 * says what the customer asked for at the moment they paid. The chain says what is true now: an
 * owner who has since renounced ownership, a supply that has been minted past what was ordered, a
 * pause that is currently in force. A page rendered from the order would keep telling a prospective
 * buyer that a token has a 1,000,000 cap after the owner minted 10,000,000, and market's risk
 * indicators (§6.3) are explicitly "computed, not editorial" — they are computed from THIS.
 *
 * `null` from `token` is therefore never filled in from the order record. It renders as "not yet
 * indexed", which is honest, rather than as the intent dressed up as an observation.
 *
 * ## The defect this file used to be, and the rule that replaced it
 *
 * Both methods asked for paths `micro-indexer` has never served:
 *
 *   `transaction`  asked `/v1/chains/:chain/:network/transactions/:hash`. The route exists, spelled
 *                  the other way round — `/v1/transactions/:chain/:network/:hash`
 *                  (`indexer/src/server.ts`).
 *   `token`        asked `/v1/chains/:chain/:network/tokens/:address`, and the indexer had no token
 *                  route in any spelling. It has one now: `/v1/tokens/:chain/:network/:address`
 *                  (`indexer/src/server.ts`), which reads the contract's own state at the
 *                  canonical head this service's follower has walked.
 *
 * Neither failure had a symptom, because **a 404 was read as an answer**. `token()` returned null on
 * every call, so every ForgeMint project page rendered its supply and its authorities as "not yet
 * indexed" — permanently, silently, and on a page whose whole purpose (04-domain-model §5.3) is to
 * show the chain rather than the order.
 *
 * So a 404 now splits, exactly as `micro-market`'s client splits it:
 *
 *   `transaction_not_found` / `token_not_found`   the indexer's answer ABOUT A CHAIN. Null, which
 *                                                 is a fact, and the caller's rule is unchanged.
 *   any other 404                                 a path this service asked for and the indexer
 *                                                 does not serve. That is a defect in THIS file,
 *                                                 not a statement about anybody's chain, and it
 *                                                 throws `IndexerRouteError`.
 *
 * A 404 whose body cannot be read is treated as the second: an unreadable failure must never be
 * promoted into a confident "there is nothing there".
 *
 * The runtime split is the second line of defence. The first is `scripts/checkindexerroutes.mjs`,
 * which reads the route table out of `micro-indexer`'s own source in CI and fails if a path
 * requested below is not one the indexer serves — because a defect that only shows up in
 * production is one that has already shipped.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { Network } from '@cloudsforge/contracts-chain'
import type { ChainId } from './chains.ts'
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
export const INDEXER_SCOPES: readonly LiveScope[] = Object.freeze(['indexer:read'])

export class IndexerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndexerUnavailableError'
  }
}

/**
 * The indexer does not serve the path this service asked for.
 *
 * A **subclass**, deliberately: every existing caller treats an `IndexerUnavailableError` as "we
 * could not ask" and degrades correctly, and none of them has to learn a new type to keep being
 * right. What the subclass adds is that the two causes are distinguishable at the point where the
 * difference matters — an outage is somebody else's incident, and this is our own bug, in this
 * file, and it will not fix itself by being retried.
 */
export class IndexerRouteError extends IndexerUnavailableError {
  readonly path: string
  constructor(path: string, code: string | null) {
    super(
      `the indexer does not serve ${path} (404 ${code ?? 'with no readable code'}); this client is asking for a route that does not exist`,
    )
    this.name = 'IndexerRouteError'
    this.path = path
  }
}

/**
 * The `error.code` inside an indexer failure, or null when there is not one to read.
 *
 * **This is what separates an answer from a misconfiguration, and the status alone will not do
 * it.** `token_not_found` is the indexer saying it asked the chain and there is nothing observable
 * at that address. `not_found` is the indexer saying it does not serve the path we asked for, which
 * tells us nothing about any chain. Same 404, opposite meanings.
 */
function codeOf(err: HttpError): string | null {
  try {
    const parsed: unknown = JSON.parse(err.body)
    if (typeof parsed !== 'object' || parsed === null) return null
    const error: unknown = (parsed as Record<string, unknown>)['error']
    if (typeof error !== 'object' || error === null) return null
    const code: unknown = (error as Record<string, unknown>)['code']
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

/**
 * One transaction as the indexer holds it.
 *
 * `status` is the indexer's normalised vocabulary from 04-domain-model §4.1 — `pending · success ·
 * failed · dropped · orphaned`. The mapping onto this service's states lives in `deploy.ts` rather
 * than here, because it is a decision about a customer's money and belongs with the rest of them.
 *
 * `confirmations` is nullable and null is **not zero**: it means the indexer knows the transaction
 * but cannot currently say how deep it is, which happens while a chain's tip is being re-read after
 * a reorg. A caller that read null as zero would treat a confirmed deploy as fresh.
 */
export interface IndexedTransaction {
  readonly hash: string
  readonly status: string
  readonly blockHeight: number | null
  readonly confirmations: number | null
  readonly from: string | null
  /** Null on a contract creation, which is what makes it recognisable as one. */
  readonly to: string | null
  /** Present on a creation the indexer has decoded. Checked against our derived address. */
  readonly contractAddress: string | null
}

/**
 * A deployed token as the chain currently reports it.
 *
 * Every field here is an OBSERVATION. `owner` is whoever `owner()` returns now, which is the zero
 * address once ownership is renounced; `mintAuthority` is a boolean fact about whether anything
 * can still increase the supply, and it is the single most important thing on a project page.
 */
export interface IndexedToken {
  readonly contractAddress: string
  readonly name: string | null
  readonly symbol: string | null
  readonly decimals: number | null
  /** Smallest units, as a decimal STRING. A JSON number does not survive 18 decimals. */
  readonly totalSupply: string | null
  readonly cap: string | null
  readonly owner: string | null
  readonly mintAuthority: boolean | null
  readonly paused: boolean | null
  /** The block the observation was taken at, so a stale page can say how stale. */
  readonly observedAtBlock: number | null
}

export interface IndexerClient {
  /** Null when the indexer has never seen this hash. Never an exception for a 404. */
  transaction(chain: ChainId, network: Network, hash: string): Promise<IndexedTransaction | null>
  /** Null when the indexer has not indexed this contract. Never filled in from the order. */
  token(chain: ChainId, network: Network, address: string): Promise<IndexedToken | null>
}

export interface IndexerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpIndexerClient(options: IndexerClientOptions): IndexerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'indexer',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async transaction(chain, network, hash) {
      // The indexer's own convention: the RESOURCE first, then `:chain/:network`, then the key.
      // `/chains/...` is the status route's shape and only the status route's — asking for it here
      // is what made this call a permanent 404 (`indexer/src/server.ts`).
      //
      // ONE template literal, not two concatenated. `checkindexerroutes.mjs` scans this file for the
      // paths it requests, and a path split across a `+` reaches that scan as a fragment it cannot
      // recognise — a route the checker fails to see, rather than a route that is fine.
      const path = `/v1/transactions/${encodeURIComponent(chain)}/${encodeURIComponent(network)}/${encodeURIComponent(hash)}`
      try {
        return await client.get<IndexedTransaction>(path)
      } catch (err) {
        // A 404 carrying the indexer's own "never seen this hash" code is an ANSWER, not a fault.
        // Collapsing it into an unavailability would make a fresh broadcast look like an outage and
        // would be retried at error level for the whole of a normal confirmation window.
        if (err instanceof HttpError && err.status === 404) {
          if (codeOf(err) === 'transaction_not_found') return null
          throw new IndexerRouteError(path, codeOf(err))
        }
        throw translate(err)
      }
    },

    async token(chain, network, address) {
      const path = `/v1/tokens/${encodeURIComponent(chain)}/${encodeURIComponent(network)}/${encodeURIComponent(address)}`
      try {
        return await client.get<IndexedToken>(path)
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          // `token_not_found` means the indexer asked the chain and found no contract answering
          // `totalSupply()` at the block it has walked — which is what a deployment above the
          // indexer's head looks like, and is honestly "not yet indexed".
          if (codeOf(err) === 'token_not_found') return null
          // Anything else is this client asking for a route that does not exist. Returning null
          // here is the defect: it renders as "not yet indexed" on every project page, for ever.
          throw new IndexerRouteError(path, codeOf(err))
        }
        throw translate(err)
      }
    },
  }
}

function translate(err: unknown): Error {
  if (err instanceof IndexerUnavailableError) return err
  return new IndexerUnavailableError(err instanceof Error ? err.message : String(err))
}
