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
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { Network } from '@cloudsforge/contracts-chain'
import type { ChainId } from './chains.ts'

export const INDEXER_SCOPES: readonly string[] = Object.freeze(['indexer:read'])

export class IndexerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndexerUnavailableError'
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
      try {
        return await client.get<IndexedTransaction>(
          `/v1/chains/${chain}/${network}/transactions/${hash}`,
        )
      } catch (err) {
        // A 404 is an ANSWER, not a fault: the indexer has not seen this hash. Collapsing it into
        // an unavailability would make a fresh broadcast look like an outage and would be retried
        // at error level for the whole of a normal confirmation window.
        if (err instanceof HttpError && err.status === 404) return null
        throw translate(err)
      }
    },

    async token(chain, network, address) {
      try {
        return await client.get<IndexedToken>(`/v1/chains/${chain}/${network}/tokens/${address}`)
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null
        throw translate(err)
      }
    },
  }
}

function translate(err: unknown): Error {
  if (err instanceof IndexerUnavailableError) return err
  return new IndexerUnavailableError(err instanceof Error ? err.message : String(err))
}
