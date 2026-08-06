/**
 * The chain families, and the interface that makes "record the broadcast before confirming" a
 * property of the TYPE rather than of the discipline of whoever writes the next one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A FAMILY CANNOT BROADCAST BEFORE ITS TRANSACTION ID HAS BEEN RECORDED, BECAUSE IT DOES NOT
 * HOLD THE BYTES LONG ENOUGH TO.**
 *
 * `prepare` builds and signs and returns — it does not send. Its return value carries `txHash`,
 * the id the chain will know the bytes by, derived from the bytes themselves. The caller commits
 * that to the database and only then calls `broadcast`. There is no path through this interface
 * that puts bytes on a wire before the id is durable.
 *
 * That is deliberately structural, because the frozen service's version was a convention and the
 * convention was not kept. `deployErc20Evm` takes an OPTIONAL `onBroadcast?` callback and the EVM
 * call site supplies one; `deploySplToken` has no such parameter AT ALL, so a Solana broadcast
 * that loses its 90-second confirmation race writes `status: 'failed'` with a null hash, the
 * claim predicate matches a `failed` row immediately, and the second attempt calls
 * `Keypair.generate()` afresh — two independent SPL mints, both holding the full supply, rent and
 * fees paid twice, and nothing anywhere that could ever reconcile them. An optional callback on
 * the money path is an optional callback that will one day be omitted.
 *
 * So there is no callback here. There is an ordering, and the ordering is the signature.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Network } from '@cloudsforge/contracts-chain'
import { constructorArgs, variantFor, type Feature } from './catalogue.ts'
import { custodyChainOf, evmChainId, familyOf, legacyOnly, type ChainId } from './chains.ts'
import {
  createAddress,
  creationData,
  evmTxHash,
  gasPriceBid,
  hexQuantity,
  quantity,
  type FeeBounds,
  type JsonRpc,
} from './evm.ts'
import type { CustodyClient } from './custodyclient.ts'
import { IndexerUnavailableError, type IndexerClient } from './indexerclient.ts'

/** Raised by a family that exists as an object but has no working implementation. */
export class NotImplementedError extends Error {
  readonly family: string
  constructor(family: string, message: string) {
    super(message)
    this.name = 'NotImplementedError'
    this.family = family
  }
}

/** A chain refused the work on its own terms. Permanent for these bytes. */
export class ChainRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainRefusedError'
  }
}

/** A node could not be reached. We do not know what happened; retry the same bytes. */
export class ChainUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainUnavailableError'
  }
}

export interface DeployContext {
  readonly tokenId: string
  readonly ownerSubject: string
  /** The bare user id, which is what custody's binding carries. Never the `user:` subject. */
  readonly userId: string
  readonly ownerAddress: string
  readonly deployerAddress: string
  readonly chain: ChainId
  readonly network: Network
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly supply: bigint
  readonly cap: bigint | null
  readonly features: readonly Feature[]
  readonly correlationId: string
}

/** What `prepare` returns: bytes, and everything derivable from them, before anything is sent. */
export interface SignedDeploy {
  readonly rawTx: string
  /** `keccak256(rawTx)`. Knowable before the send, which is the whole point. */
  readonly txHash: string
  readonly nonce: bigint
  /** `keccak256(rlp([deployer, nonce]))[12:]`. Also knowable before the send. */
  readonly contractAddress: string
  readonly custodyAuditId: string
}

export interface FundingReport {
  readonly required: bigint
  readonly balance: bigint
  readonly funded: boolean
}

export type DeployOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'confirmed'; readonly contractAddress: string }
  | { readonly kind: 'reverted'; readonly reason: string }
  | { readonly kind: 'dropped'; readonly reason: string }

export interface DeployFamily {
  readonly family: string
  /**
   * Whether the deployer holds enough native coin to pay for this creation.
   *
   * A REAL number, not `balance > 0`. The frozen service's gate is `wei > 0n`
   * (`routes/tokens.ts`), so one wei of dust passes it and the deploy then fails at
   * `estimateGas` — after the lease has been claimed and an attempt burned.
   */
  funding(ctx: DeployContext, rpc: JsonRpc, bounds: FeeBounds): Promise<FundingReport>
  /** Build and sign. **Does not send.** See the file header. */
  prepare(ctx: DeployContext, rpc: JsonRpc, bounds: FeeBounds, custody: CustodyClient): Promise<SignedDeploy>
  /** Send bytes that are already committed. Idempotent: "already known" is a success. */
  broadcast(rawTx: string, rpc: JsonRpc): Promise<void>
  /** What became of it, preferring the indexer where it has an answer. */
  outcome(
    ctx: DeployContext,
    plan: Pick<SignedDeploy, 'txHash' | 'nonce' | 'contractAddress'>,
    rpc: JsonRpc,
    indexer: IndexerClient,
    ageMs: number,
    stuckMs: number,
  ): Promise<DeployOutcome>
}

/* ------------------------------------------------------------------ EVM */

/**
 * Errors a node returns for a transaction it has ALREADY accepted or already mined.
 *
 * Both are the SUCCESSFUL outcome of a re-broadcast, which the recovery path does by design: the
 * bytes are committed before they are sent, and anything that dies in between re-sends them. geth's
 * strings are matched because every EVM client copies them verbatim and Hearth's own RPC passes
 * the chain's words through untouched.
 *
 * `nonce too low` is included deliberately and is the subtle one: it is what a node says once our
 * transaction has been MINED, which is the same recovery path arriving slightly later. Treating it
 * as a failure would re-deploy a contract that already exists.
 */
const ALREADY_SENT = ['already known', 'known transaction', 'nonce too low', 'already imported']

const EVM_FAMILY: DeployFamily = {
  family: 'evm',

  async funding(ctx, rpc, bounds) {
    const [balanceHex, priceHex] = await Promise.all([
      call(rpc, 'eth_getBalance', [ctx.deployerAddress, 'latest']),
      call(rpc, 'eth_gasPrice', []),
    ])
    const balance = quantity(balanceHex, 'eth_getBalance')
    const gasPrice = gasPriceBid(quantity(priceHex, 'eth_gasPrice'), bounds)
    const gasLimit = await estimateGas(ctx, rpc)
    const required = gasPrice * gasLimit
    return { required, balance, funded: balance >= required }
  },

  async prepare(ctx, rpc, bounds, custody) {
    const chainId = evmChainId(ctx.chain, ctx.network)
    if (chainId === null) {
      // A creation with no bound chain id is replayable on every EVM network the deployer holds
      // gas on. Custody refuses such an address outright (SD-09 gate 3); refusing to BUILD it is
      // the earlier and more legible of the two failures.
      throw new ChainRefusedError(`${ctx.chain} has no chain id on ${ctx.network} to bind a creation to`)
    }

    // `pending`, so two creations queued back to back do not collide. It is also why the nonce is
    // read inside the lease and never outside it: the value is only meaningful while nothing else
    // is signing for this address.
    const nonce = quantity(
      await call(rpc, 'eth_getTransactionCount', [ctx.deployerAddress, 'pending']),
      'eth_getTransactionCount',
    )
    const gasPrice = gasPriceBid(
      quantity(await call(rpc, 'eth_gasPrice', []), 'eth_gasPrice'),
      bounds,
    )
    // A hard gate, not a fallback to a constant. If the chain will not estimate this creation, it
    // will not mine it either, and broadcasting anyway spends gas on a certain revert. Carried
    // forward from the frozen service, which gets this right.
    const gasLimit = await estimateGas(ctx, rpc)
    if (gasPrice * gasLimit > bounds.maxFeeWei) {
      throw new ChainRefusedError(
        `this deploy would cost up to ${gasPrice * gasLimit} wei, above the ${bounds.maxFeeWei} ceiling`,
      )
    }

    const payload: Record<string, unknown> = {
      // Null, zero and creation bytecode: the only EVM shape custody will sign for a `deployer`
      // address. Anything else is a 403 rather than a wider signature.
      to: null,
      data: dataFor(ctx),
      value: '0x0',
      nonce: Number(nonce),
      gasLimit: gasLimit.toString(),
      chainId,
    }
    if (legacyOnly(ctx.chain)) {
      payload.type = 0
      payload.gasPrice = gasPrice.toString()
    } else {
      payload.type = 2
      payload.maxFeePerGas = gasPrice.toString()
      // The tip is the whole bid on a chain with no base fee to speak of, and never more than the
      // max — custody refuses a tip above `maxFeePerGas` outright.
      payload.maxPriorityFeePerGas = (gasPrice / 2n).toString()
    }

    const signed = await custody.sign({
      address: ctx.deployerAddress,
      // Custody's NAME, not our slug. `eth` versus `ethereum` is the one field that differs, and
      // getting it wrong is a 403 that does not say which field was wrong. See chains.ts.
      chain: custodyChainOf(ctx.chain),
      network: ctx.network,
      family: familyOf(ctx.chain),
      purpose: 'deployer',
      userId: ctx.userId,
      orderId: ctx.tokenId,
      payload,
      correlationId: ctx.correlationId,
    })

    const txHash = evmTxHash(signed.signedTx)
    if (!txHash) throw new ChainRefusedError('custody returned bytes that are not a hex transaction')

    return {
      rawTx: signed.signedTx,
      txHash,
      nonce,
      contractAddress: createAddress(ctx.deployerAddress, nonce),
      custodyAuditId: signed.auditId,
    }
  },

  async broadcast(rawTx, rpc) {
    try {
      await call(rpc, 'eth_sendRawTransaction', [rawTx])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Already on the chain, or already in this node's pool. Both are the recovery path working.
      if (ALREADY_SENT.some((needle) => message.toLowerCase().includes(needle))) return
      throw new ChainUnavailableError(message)
    }
  },

  async outcome(ctx, plan, rpc, indexer, ageMs, stuckMs) {
    // The indexer first, where it has an answer: it applies the estate's own confirmation depths,
    // so two services cannot disagree about whether a deploy is deep enough to be final.
    //
    // The catch is narrowed to the indexer's OWN error type on purpose. Degrading to the node when
    // the indexer cannot be reached is the design (see `indexerclient.ts`, and the node branch
    // below); swallowing every throwable was not — it also swallowed a bug in the client, which is
    // half of why `transaction()` spent its whole life asking for a path that does not exist and
    // nothing anywhere noticed. `IndexerRouteError` extends `IndexerUnavailableError`, so a wrong
    // route still degrades here rather than failing a customer's deploy; what makes it visible is
    // `checkindexerroutes.mjs`, in CI, before it can ship.
    const indexed = await indexer
      .transaction(ctx.chain, ctx.network, plan.txHash)
      .catch((err: unknown) => {
        if (err instanceof IndexerUnavailableError) return null
        throw err
      })
    if (indexed && indexed.status === 'failed') {
      return { kind: 'reverted', reason: 'the indexer reports this creation reverted' }
    }
    if (indexed && indexed.status === 'success') {
      const observed = indexed.contractAddress
      if (observed && observed.toLowerCase() !== plan.contractAddress.toLowerCase()) {
        // The derived address and the mined one disagree, which means the nonce moved under us.
        // Failing rather than confirming is the only safe answer: recording the derived address
        // would point the project page, the market and the customer at an address with no code.
        return {
          kind: 'reverted',
          reason: `the chain created ${observed} but this order derived ${plan.contractAddress}`,
        }
      }
      return { kind: 'confirmed', contractAddress: observed ?? plan.contractAddress }
    }

    // The node, when the indexer has not caught up. "The indexer has never heard of this hash" is
    // emphatically not "the chain does not have it" — its worker walks blocks, so a creation
    // broadcast four seconds ago is not in it yet.
    const receipt = (await call(rpc, 'eth_getTransactionReceipt', [plan.txHash])) as {
      blockNumber?: unknown
      status?: unknown
      contractAddress?: unknown
    } | null

    if (receipt && receipt.blockNumber != null) {
      if (receipt.status !== '0x1') {
        return { kind: 'reverted', reason: `creation reverted at ${plan.txHash}` }
      }
      const observed = typeof receipt.contractAddress === 'string' ? receipt.contractAddress : null
      if (observed && observed.toLowerCase() !== plan.contractAddress.toLowerCase()) {
        return {
          kind: 'reverted',
          reason: `the chain created ${observed} but this order derived ${plan.contractAddress}`,
        }
      }
      return { kind: 'confirmed', contractAddress: observed ?? plan.contractAddress }
    }

    // No receipt. Three conditions, ALL of which must hold before this is called dropped, and the
    // third is the one that makes it a proof rather than a guess: the deployer's `latest` nonce
    // has passed the slot these bytes occupy, so whatever filled that slot, it was not this
    // transaction and this transaction can never be mined. Carried forward from the frozen
    // `settleEvmDeploy`, which is the best-designed function in the old service.
    if (ageMs < stuckMs) return { kind: 'pending' }
    const latest = quantity(
      await call(rpc, 'eth_getTransactionCount', [ctx.deployerAddress, 'latest']),
      'eth_getTransactionCount',
    )
    if (latest > plan.nonce) {
      return {
        kind: 'dropped',
        reason: `nonce ${plan.nonce} has been passed (latest ${latest}) with no receipt for ${plan.txHash}`,
      }
    }
    // Old, unseen, and the slot is still open. That is a transaction nobody can prove anything
    // about, and it stays PENDING rather than being failed: the row keeps its hash, the metric
    // climbs, and an operator decides. Declaring it failed here would refund a deploy whose
    // contract may appear in the next block.
    return { kind: 'pending' }
  },
}

function dataFor(ctx: DeployContext): string {
  const spec = variantFor(ctx.features)
  return creationData(
    spec.bytecode,
    constructorArgs(spec, {
      name: ctx.name,
      symbol: ctx.symbol,
      decimals: ctx.decimals,
      supply: ctx.supply,
      cap: ctx.cap,
      // THE CUSTOMER'S WALLET. Read from the claimed row, never from the request that started the
      // deploy — see `deploy.ts`.
      ownerAddress: ctx.ownerAddress,
    }),
  )
}

async function estimateGas(ctx: DeployContext, rpc: JsonRpc): Promise<bigint> {
  const estimate = await call(rpc, 'eth_estimateGas', [
    { from: ctx.deployerAddress, data: dataFor(ctx) },
  ])
  // Twenty per cent of headroom, because an estimate is taken against the current state and the
  // creation is mined against a later one.
  return (quantity(estimate, 'eth_estimateGas') * 120n) / 100n
}

async function call(rpc: JsonRpc, method: string, params: readonly unknown[]): Promise<unknown> {
  try {
    return await rpc(method, params)
  } catch (err) {
    // `eth_estimateGas` and `eth_sendRawTransaction` failures are the chain's own verdict and are
    // re-thrown by the callers that can tell the difference. Everything else is an outage.
    if (method === 'eth_sendRawTransaction') throw err
    throw new ChainUnavailableError(err instanceof Error ? err.message : String(err))
  }
}

/* ------------------------------------------------------------------ Solana */

/**
 * Solana, as a REAL OBJECT that refuses.
 *
 * Not a `null` in the registry and not a `switch` that falls through, because both of those are
 * absences and an absence cannot be tested. This is present, typed, registered, and every method
 * throws `NotImplementedError` — so `families.test.ts` can assert that the SPL path refuses rather
 * than asserting that a branch does not exist, and so a future implementer fills in method bodies
 * against an interface that already enforces the ordering.
 *
 * ## Why it is not implemented, and it is two reasons rather than one
 *
 *   1. **Custody refuses `SetAuthority`.** Its SPL allowlist is `InitializeMint2` (20) and `MintTo`
 *      (7) and nothing else — tag 6 is excluded by name, alongside Transfer, Approve, Burn and
 *      CloseAccount. So a mint this platform creates can have its authority initialised to the
 *      platform's own deployer and can never be handed to the customer. That is not a token the
 *      customer owns; it is a token the platform owns and has promised to be nice about. The whole
 *      EVM design rests on the customer's wallet being the owner FROM THE CONSTRUCTOR, and there is
 *      no SPL equivalent while tag 6 is refused. Widening custody's allowlist to admit it is not a
 *      small change: `SetAuthority` is also how an attacker who reaches the signer takes every mint
 *      the vault has ever created.
 *
 *   2. **`Keypair.generate()` sits inside the retryable region.** The frozen `deploySplToken`
 *      generates a fresh mint keypair on every call, so two attempts produce two unrelated mints
 *      with no nonce, no derivation and nothing making them mutually exclusive. Recording the
 *      broadcast — which this interface makes mandatory — is necessary and NOT sufficient for
 *      Solana: the address must also be deterministic, a PDA or a per-order derived keypair, so a
 *      re-broadcast is the same mint rather than a second one. An implementer who fills in the
 *      methods below without doing that has fixed the recording and kept the double-mint.
 */
const SOLANA_FAMILY: DeployFamily = {
  family: 'solana',

  async funding() {
    throw refuse()
  },
  async prepare() {
    throw refuse()
  },
  async broadcast() {
    throw refuse()
  },
  async outcome() {
    throw refuse()
  },
}

function refuse(): NotImplementedError {
  return new NotImplementedError(
    'solana',
    'SPL deploys are not delivered: custody refuses SetAuthority, so the mint authority cannot be ' +
      'handed to the customer, and a deterministic mint address is required before a re-broadcast ' +
      'is safe. See the note in families.ts.',
  )
}

/* ------------------------------------------------------------------ the registry */

const FAMILIES: Readonly<Record<string, DeployFamily>> = Object.freeze({
  evm: EVM_FAMILY,
  // Ember is an EVM chain in every respect this service cares about; the family name differs only
  // so custody can apply its legacy-only rule.
  ember: EVM_FAMILY,
  solana: SOLANA_FAMILY,
})

/**
 * The family for a chain. Never null: an unknown chain throws rather than returning an absence a
 * caller might treat as "skip this one".
 */
export function familyFor(chain: ChainId): DeployFamily {
  const family = FAMILIES[familyOf(chain)]
  if (!family) throw new ChainRefusedError(`no deploy family for ${chain}`)
  return family
}

/** Chains whose family will actually deploy. `implementedChains` is what the boot log reports. */
export function isImplemented(chain: ChainId): boolean {
  return familyFor(chain) !== SOLANA_FAMILY
}
