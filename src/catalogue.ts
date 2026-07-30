/**
 * What can be minted, and which committed bytecode each tier deploys.
 *
 * The variant is derived from the FEATURES the customer asked for rather than from an offer id, so
 * the catalogue is a projection of the contracts rather than a second source of truth about them.
 * The frozen service maps offer id → variant with a fall-through default (`erc20.ts:16-20`), which
 * means an unknown offer silently deploys the fixed-supply contract — a customer who paid for a
 * mintable token and received one that can never mint again.
 */

import { ChainError } from './chains.ts'
import {
  FIXEDSUPPLYTOKEN_BYTECODE,
  FOUNDRYTOKEN_BYTECODE,
  MINTABLETOKEN_BYTECODE,
} from './contracts/generated.ts'
import type { AbiValue } from './evm.ts'

/** 04-domain-model §5.2 `features[]`. */
export type Feature = 'mintable' | 'burnable' | 'pausable'

export const FEATURES: readonly Feature[] = Object.freeze(['mintable', 'burnable', 'pausable'])

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value)
}

export type Variant = 'fixed' | 'mintable' | 'foundry'

export interface VariantSpec {
  readonly variant: Variant
  readonly contract: string
  readonly bytecode: string
  readonly features: readonly Feature[]
  /** Whether a cap is required, forbidden, or neither. */
  readonly cap: 'required' | 'forbidden'
}

const VARIANTS: Readonly<Record<Variant, VariantSpec>> = Object.freeze({
  fixed: Object.freeze({
    variant: 'fixed',
    contract: 'FixedSupplyToken',
    bytecode: FIXEDSUPPLYTOKEN_BYTECODE,
    features: Object.freeze([]),
    // No owner at all, so a cap would be a promise nothing can enforce or change.
    cap: 'forbidden',
  }),
  mintable: Object.freeze({
    variant: 'mintable',
    contract: 'MintableToken',
    bytecode: MINTABLETOKEN_BYTECODE,
    features: Object.freeze(['mintable', 'burnable'] as Feature[]),
    // Uncapped BY DESIGN, and the project page says so from the indexer: a mintable token with no
    // cap is a fact a buyer is entitled to see, not a defect to paper over with a nominal ceiling.
    cap: 'forbidden',
  }),
  foundry: Object.freeze({
    variant: 'foundry',
    contract: 'FoundryToken',
    bytecode: FOUNDRYTOKEN_BYTECODE,
    features: Object.freeze(['mintable', 'burnable', 'pausable'] as Feature[]),
    cap: 'required',
  }),
})

export function variantSpec(variant: Variant): VariantSpec {
  return VARIANTS[variant]
}

/**
 * The variant whose contract provides EXACTLY the requested features — never a superset.
 *
 * A superset would be worse than a refusal. `pausable` on a token nobody asked to be pausable is
 * an owner key that can freeze every holder's balance, and a buyer reading the project page would
 * see an authority the issuer never intended to hold. So a request that no committed contract
 * matches exactly is refused, and the refusal names what is available.
 */
export function variantFor(features: readonly Feature[]): VariantSpec {
  const wanted = new Set(features)
  for (const spec of Object.values(VARIANTS)) {
    if (spec.features.length !== wanted.size) continue
    if (spec.features.every((feature) => wanted.has(feature))) return spec
  }
  const offered = Object.values(VARIANTS)
    .map((spec) => `[${spec.features.join(', ') || 'none'}]`)
    .join(' ')
  throw new ChainError(
    `no committed contract provides exactly [${[...wanted].sort().join(', ')}] — available: ${offered}`,
  )
}

export interface ConstructorInput {
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly supply: bigint
  readonly cap: bigint | null
  /** The CUSTOMER's wallet. Never the deployer — see the note in ForgeTokens.sol. */
  readonly ownerAddress: string
}

/**
 * The constructor arguments for a variant, in the order its constructor declares them.
 *
 * The order is load-bearing and unchecked by the compiler: the ABI encoder takes a positional
 * list, so swapping `decimals_` and `initialSupply_` would produce a token with 10^18 decimals and
 * a supply of 18. `contracts.test.ts` asserts each list against the committed ABI, which is the
 * only thing that can catch it.
 */
export function constructorArgs(spec: VariantSpec, input: ConstructorInput): readonly AbiValue[] {
  const head: AbiValue[] = [
    { type: 'string', value: input.name },
    { type: 'string', value: input.symbol },
    { type: 'uint8', value: BigInt(input.decimals) },
    { type: 'uint256', value: input.supply },
  ]
  if (spec.cap === 'required') {
    if (input.cap === null) throw new ChainError(`${spec.contract} requires a cap`)
    if (input.cap < input.supply) throw new ChainError('cap must be at least the initial supply')
    head.push({ type: 'uint256', value: input.cap })
  } else if (input.cap !== null) {
    throw new ChainError(`${spec.contract} takes no cap`)
  }
  head.push({ type: 'address', value: input.ownerAddress })
  return Object.freeze(head)
}
