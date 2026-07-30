/**
 * Chains, families, and the two names for each of them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`chain` ON A CUSTODY REQUEST IS CUSTODY'S NAME, NOT THIS SERVICE'S SLUG.**
 *
 * Custody's `CHAIN_ASSET` is keyed by chain NAME — `ethereum`, `bitcoin`, `solana`, `xrp`,
 * `ember` — because those are the values the rows it adopted from forge-keyvault already carry.
 * This service's slug is the asset code lowercased, which is what appears in a URL, in an order
 * row and on an event. The two agree on four of five and disagree on exactly one:
 *
 *     this service says `eth`.  Custody says `ethereum`.
 *
 * `POST /v1/sign` compares SEVEN restated identity fields against the row it holds, character for
 * character, and answers a mismatch with a 403 whose message deliberately does not say which field
 * disagreed — naming it would be an oracle a caller could walk one field at a time. So a caller
 * cannot debug this from the response; it has to be right by construction. Settlement lost time to
 * exactly this, which is why the translation below is a named table rather than a `toLowerCase()`
 * that happens to work for the other four.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every chain id comes from `@cloudsforge/contracts-chain` and nothing here redefines one. That
 * package is exact-pinned precisely so mint, custody, settlement and the indexer cannot disagree —
 * a chain id held in two places is a contract creation bound to the wrong network the first time
 * one of the copies is edited.
 */

import {
  chainSpec,
  type AssetCode,
  type ChainFamily,
  type Network,
} from '@cloudsforge/contracts-chain'

/** The chains this service will deploy a token on. A slug, lowercase, and it is our name. */
export type ChainId = 'ember' | 'eth' | 'sol'

export const CHAIN_IDS: readonly ChainId[] = Object.freeze(['ember', 'eth', 'sol'])

export function isChainId(value: string): value is ChainId {
  return (CHAIN_IDS as readonly string[]).includes(value)
}

export function isNetwork(value: string): value is Network {
  return value === 'mainnet' || value === 'testnet'
}

const ASSET_OF: Readonly<Record<ChainId, AssetCode>> = Object.freeze({
  ember: 'EMBER',
  eth: 'ETH',
  sol: 'SOL',
})

export function assetOf(chain: ChainId): AssetCode {
  return ASSET_OF[chain]
}

export function familyOf(chain: ChainId): ChainFamily {
  return chainSpec(assetOf(chain)).family
}

/**
 * Custody's chain NAME for one of our slugs. See the header — this is the one field on a sign
 * request that is not our own spelling, and getting it wrong is a `binding_mismatch`.
 */
const CUSTODY_CHAIN: Readonly<Record<ChainId, string>> = Object.freeze({
  ember: 'ember',
  eth: 'ethereum',
  sol: 'solana',
})

export function custodyChainOf(chain: ChainId): string {
  return CUSTODY_CHAIN[chain]
}

/**
 * The numeric EIP-155 chain id a creation must declare, or null when the chain has none.
 *
 * **A null is not permission to skip the binding.** A transaction with no bound chain id is valid
 * on every EVM network, so a creation signed without one could be replayed onto any chain the
 * deployer holds gas on. Custody refuses such an address outright (SD-09 gate 3); this service
 * refuses to build the transaction in the first place, which is the earlier and more legible of
 * the two failures.
 */
export function evmChainId(chain: ChainId, network: Network): number | null {
  return chainSpec(assetOf(chain)).chainId?.[network] ?? null
}

/**
 * Ember v1 accepts legacy (type 0) transactions only: its node has no type-2 decoder, so a
 * 1559 transaction signed for it is not a transaction the network rejects, it is bytes nothing on
 * that chain can even parse. Custody carries the same rule as `legacyOnly`, and the two must
 * agree — a transaction this service builds as 1559 for a legacy-only chain is a 403, which is a
 * worse way to discover the same fact.
 */
export function legacyOnly(chain: ChainId): boolean {
  return chain === 'ember'
}

/** The lease key for chain work: `chain:network`. The contended resource is the deployer's nonce. */
export function chainKey(chain: ChainId, network: Network): string {
  return `${chain}:${network}`
}

/** The confirmation depth this service waits for before a deploy is `deployed`. */
export function confirmationsRequired(chain: ChainId): number {
  return chainSpec(assetOf(chain)).confirmations
}

export class ChainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainError'
  }
}
