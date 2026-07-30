/**
 * Project pages.
 *
 * ---------------------------------------------------------------------------------------------
 * **04-domain-model §5.3's invariant is the whole of this file:** "A project page always renders
 * supply, authorities, network and contract address from the **indexer**, not from the order
 * record — the on-chain reality, not the intent."
 *
 * The order row says what the customer asked for at the moment they paid. The chain says what is
 * true now. They agree at the instant of deployment and they diverge immediately afterwards: an
 * owner renounces ownership, a mintable token's supply is minted past what was ordered, a pausable
 * token is paused. A page rendered from the order would keep telling a prospective buyer that a
 * token has a 1,000,000 supply after the owner minted 10,000,000 — which is not a stale cache, it
 * is a false statement about a thing being sold.
 *
 * So `render` reads the indexer, and where the indexer has no answer it says so. `onchain: null`
 * renders as "not yet indexed". It is never filled in from the order record: an intent presented
 * as an observation is worse than an absence, because a buyer cannot tell which they are reading.
 *
 * Market's risk indicators (§6.3) are "computed, not editorial" — has a mint authority, ownership
 * renounced or not, supply concentration. Every one of them is computed from `onchain` below.
 * ---------------------------------------------------------------------------------------------
 */

import type { Db } from './outbox.ts'
import type { IndexedToken, IndexerClient } from './indexerclient.ts'
import { findToken, type TokenRecord } from './tokens.ts'

export type VerificationStatus = 'unverified' | 'claimed' | 'verified' | 'flagged'

export interface ProjectPageRecord {
  readonly id: string
  readonly tokenId: string
  readonly subject: string
  readonly description: string
  readonly links: readonly unknown[]
  readonly team: readonly unknown[]
  readonly roadmap: readonly unknown[]
  readonly riskDisclosures: string
  readonly verificationStatus: VerificationStatus
  readonly communityId: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface PageRow {
  readonly id: string
  readonly token_id: string
  readonly subject: string
  readonly description: string
  readonly links: unknown[]
  readonly team: unknown[]
  readonly roadmap: unknown[]
  readonly risk_disclosures: string
  readonly verification_status: string
  readonly community_id: string | null
  readonly created_at: Date
  readonly updated_at: Date
}

const COLUMNS = `
  id, token_id, subject, description, links, team, roadmap, risk_disclosures,
  verification_status, community_id, created_at, updated_at
`

function toPage(row: PageRow): ProjectPageRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    subject: row.subject,
    description: row.description,
    links: row.links,
    team: row.team,
    roadmap: row.roadmap,
    riskDisclosures: row.risk_disclosures,
    verificationStatus: row.verification_status as VerificationStatus,
    communityId: row.community_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface UpsertPage {
  readonly tokenId: string
  readonly subject: string
  readonly description: string
  readonly links: readonly unknown[]
  readonly team: readonly unknown[]
  readonly roadmap: readonly unknown[]
  readonly riskDisclosures: string
  readonly communityId: string | null
}

/**
 * Create or replace the editorial half of a page.
 *
 * Note what this function CANNOT write: supply, cap, owner, authorities, contract address,
 * network. There is no column for any of them, so "render the intent instead" is not a mistake
 * somebody can make in a hurry — it is a schema change they would have to argue for.
 */
export async function upsertProjectPage(sql: Db, input: UpsertPage): Promise<ProjectPageRecord> {
  const rows = await sql<PageRow[]>`
    insert into project_pages (
      token_id, subject, description, links, team, roadmap, risk_disclosures, community_id
    ) values (
      ${input.tokenId}, ${input.subject}, ${input.description},
      ${sql.json(input.links as never)}, ${sql.json(input.team as never)},
      ${sql.json(input.roadmap as never)}, ${input.riskDisclosures}, ${input.communityId}
    )
    on conflict (token_id) do update set
      subject = excluded.subject,
      description = excluded.description,
      links = excluded.links,
      team = excluded.team,
      roadmap = excluded.roadmap,
      risk_disclosures = excluded.risk_disclosures,
      community_id = excluded.community_id,
      updated_at = now()
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('upsert returned no row')
  return toPage(row)
}

export async function findProjectPage(sql: Db, tokenId: string): Promise<ProjectPageRecord | null> {
  const rows = await sql<PageRow[]>`
    select ${sql.unsafe(COLUMNS)} from project_pages where token_id = ${tokenId}
  `
  const row = rows[0]
  return row ? toPage(row) : null
}

/**
 * Risk indicators, computed from what the chain says and from nothing else.
 *
 * Facts, not a score. §6.3 is explicit that this must be shown as facts, and a score is an opinion
 * with the provenance stripped off — a buyer cannot tell a 3/10 for "has a mint authority" from a
 * 3/10 for "the deployer wallet is exported".
 */
export interface RiskIndicators {
  readonly hasMintAuthority: boolean | null
  readonly ownershipRenounced: boolean | null
  readonly paused: boolean | null
  /** True when the live supply exceeds what the order said. A mintable token doing its job. */
  readonly supplyExceedsOrder: boolean | null
}

const ZERO = '0x0000000000000000000000000000000000000000'

export function riskIndicators(token: TokenRecord, onchain: IndexedToken | null): RiskIndicators {
  if (!onchain) {
    // Null everywhere rather than a cheerful default. "We have not observed this" and "this is
    // false" are different statements and a buyer is entitled to the difference.
    return {
      hasMintAuthority: null,
      ownershipRenounced: null,
      paused: null,
      supplyExceedsOrder: null,
    }
  }
  return {
    hasMintAuthority: onchain.mintAuthority,
    ownershipRenounced: onchain.owner === null ? null : onchain.owner.toLowerCase() === ZERO,
    paused: onchain.paused,
    supplyExceedsOrder:
      onchain.totalSupply === null ? null : BigInt(onchain.totalSupply) > token.supply,
  }
}

export interface RenderedPage {
  readonly token: {
    readonly id: string
    readonly chain: string
    readonly network: string
    readonly symbol: string
    readonly name: string
    readonly status: string
  }
  readonly page: ProjectPageRecord | null
  /**
   * The chain's own answer, or null. **Never the order record standing in for it.** A consumer
   * that wants the intent can read the order; it must not be able to mistake one for the other.
   */
  readonly onchain: IndexedToken | null
  readonly risk: RiskIndicators
  /** Why `onchain` is null, when it is. An absence with no explanation reads as a bug. */
  readonly onchainUnavailable: string | null
}

export interface RenderDeps {
  readonly sql: Db
  readonly indexer: IndexerClient
}

export async function renderProjectPage(
  deps: RenderDeps,
  tokenId: string,
): Promise<RenderedPage | null> {
  const token = await findToken(deps.sql, tokenId)
  if (!token) return null
  const page = await findProjectPage(deps.sql, tokenId)

  let onchain: IndexedToken | null = null
  let unavailable: string | null = null
  if (token.contractAddress && token.status === 'deployed') {
    try {
      onchain = await deps.indexer.token(token.chain, token.network, token.contractAddress)
      if (!onchain) unavailable = 'the indexer has not yet indexed this contract'
    } catch (err) {
      // An indexer outage renders a page WITHOUT the on-chain facts and says so. Falling back to
      // the order record here would be the invariant breaking silently at exactly the moment
      // nobody is watching.
      unavailable = err instanceof Error ? err.message : String(err)
    }
  } else {
    unavailable = 'this token is not deployed'
  }

  return {
    token: {
      id: token.id,
      chain: token.chain,
      network: token.network,
      symbol: token.symbol,
      name: token.name,
      status: token.status,
    },
    page,
    onchain,
    risk: riskIndicators(token, onchain),
    onchainUnavailable: unavailable,
  }
}
