/**
 * What can be minted, and which committed bytecode each tier deploys.
 *
 * The variant is derived from the FEATURES the customer asked for rather than from an offer id, so
 * the catalogue is a projection of the contracts rather than a second source of truth about them.
 * The frozen service maps offer id → variant with a fall-through default (`erc20.ts`), which
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
 * An order naming something no committed contract can build, and the FIELD that made it so.
 *
 * A subclass of `ChainError`, so nothing that already catches or classifies a `ChainError` changes
 * behaviour. What it adds is `field`, and that is the whole point: `POST /v1/tokens` answers it as
 * `unbuildable_order` rather than a generic `bad_request`, so a caller can put the message next to
 * the input that caused it instead of next to the form. "Your order is invalid" and "`cap` is the
 * word that made this impossible" are not the same answer.
 */
export class UnbuildableOrderError extends ChainError {
  /** The request field a caller must change. Never a column name, never a contract name. */
  readonly field: 'features' | 'cap'

  constructor(field: 'features' | 'cap', message: string) {
    super(message)
    this.name = 'UnbuildableOrderError'
    this.field = field
  }
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
  throw new UnbuildableOrderError(
    'features',
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
    if (input.cap === null) {
      throw new UnbuildableOrderError('cap', `${spec.contract} requires a cap`)
    }
    if (input.cap < input.supply) {
      throw new UnbuildableOrderError('cap', 'cap must be at least the initial supply')
    }
    head.push({ type: 'uint256', value: input.cap })
  } else if (input.cap !== null) {
    throw new UnbuildableOrderError('cap', `${spec.contract} takes no cap`)
  }
  head.push({ type: 'address', value: input.ownerAddress })
  return Object.freeze(head)
}

/**
 * Can this order be built at all? Asked at the ORDER, answered before anything is charged.
 *
 * ## Why it exists
 *
 * `POST /v1/tokens` used to call `variantFor` alone, and `variantFor` never reads the cap. The cap
 * rule lived one call further on, inside `constructorArgs`, which runs in the deploy job
 * (`families.ts`) — long after `POST /v1/tokens/:id/pay` has debited the customer. So an
 * order for the foundry variant with no cap was accepted, charged, and then could not be built:
 * `dataFor` threw a `ChainError`, `driveDeploy` matched none of its four classified failures
 * (`deploy.ts`), released the lease and rethrew, and `outstandingDeploys` — which selects
 * on `CLAIMABLE`, and `deploying` is in it (`tokens.ts`) — swept the row back onto the queue
 * on the next tick. Not a terminal failure with a reason on the row: a permanent loop, with the
 * customer's money spent and the order never reaching any state a human is shown.
 *
 * ## Why it is not a second copy of the rule
 *
 * It IS the rule. `variantFor` and `constructorArgs` are the two functions the deploy job itself
 * calls, invoked here against the order exactly as submitted. Nothing is restated, so nothing can
 * drift: a cap condition added to a variant tomorrow is enforced at the order route on the same
 * commit, without anybody remembering that a second list exists. This estate has already shipped a
 * client and a server that disagreed because a rule was written down twice.
 *
 * The deploy-time call is NOT removed by this and must not be: the order route sees one request,
 * and the job is the last thing standing between a stored row and a signed contract creation.
 */
export function assertBuildable(
  features: readonly Feature[],
  input: ConstructorInput,
): VariantSpec {
  const spec = variantFor(features)
  // The encoded arguments are discarded; the THROW is the product.
  void constructorArgs(spec, input)
  return spec
}
