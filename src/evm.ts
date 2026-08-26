/**
 * The EVM half of a deploy: addresses, quantities, ABI encoding, and the two derivations that make
 * the recovery path possible.
 *
 * ## There is no chain library here, and that is a decision rather than an omission
 *
 * This service builds ONE transaction shape — a legacy zero-value contract creation — and hands it
 * to custody as a JSON object. Custody is the only place a private key exists and therefore the
 * only place a serialiser is needed. What is left is keccak256 and RLP, and both exist here rather
 * than as a dependency because they sit on the one path where a wrong answer deploys a customer's
 * contract to an address nobody can find.
 *
 * ## The two derivations, and why both are DERIVED rather than remembered
 *
 *   1. **`evmTxHash`** — `keccak256(rawTx)` is the id a chain will know the bytes by. A node
 *      answers a re-broadcast of a transaction it already holds with an ERROR, not with the hash.
 *      So a crash between broadcasting and recording would otherwise leave a deploy that landed on
 *      chain with no id to poll — re-sending for ever, and eventually declared failed while the
 *      contract sat there fully deployed. This is the function that makes "record the broadcast
 *      before awaiting confirmation" implementable at all: the hash is knowable BEFORE the send.
 *
 *   2. **`createAddress`** — a contract created by an EOA lands at
 *      `keccak256(rlp([sender, nonce]))[12:]`, and that is a total function of two values this
 *      service already holds. So the contract address is known before the transaction is sent,
 *      not read out of a receipt afterwards. It is still CHECKED against the receipt when one
 *      arrives — a derived address that disagrees with the mined one means the nonce moved under
 *      us, which is the one condition under which a deploy must be failed rather than confirmed.
 */

import { keccak256, toChecksumAddress } from '@cloudsforge/evm'
import { ChainError } from './chains.ts'

const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/* ------------------------------------------------------------------ addresses */

/**
 * Validate and produce the display form, or throw.
 *
 * A mixed-case address is CLAIMING a checksum and is held to it. An all-lowercase or all-uppercase
 * address is not claiming one and is accepted — refusing it would reject the form every block
 * explorer's copy button used to produce and the form the indexer stores.
 *
 * This is what stands between a customer typing their wallet address into an order form and a
 * contract whose owner is an account nobody holds the key to. The frozen service checks the shape
 * and not the checksum.
 */
export function canonicaliseEvm(raw: string): string {
  const trimmed = raw.trim()
  if (!EVM_SHAPE.test(trimmed)) {
    throw new ChainError('address must be 0x followed by 40 hex characters')
  }
  const lower = trimmed.toLowerCase()
  const isAllOneCase = trimmed === lower || trimmed === `0x${trimmed.slice(2).toUpperCase()}`
  if (!isAllOneCase && toChecksumAddress(lower) !== trimmed) {
    throw new ChainError('address fails its EIP-55 checksum; check for a mistyped character')
  }
  if (lower === ZERO_ADDRESS) {
    // Not a judgement about an address's worth, but 0x0 is the one account from which nothing can
    // ever be recovered — a token whose owner is the zero address is a token with no owner at all.
    throw new ChainError('the zero address cannot own a contract')
  }
  return toChecksumAddress(lower)
}

/* ------------------------------------------------------------------ quantities */

/** Hex quantity → BigInt, refusing anything that is not one rather than reading it as zero. */
export function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) {
    throw new ChainError(`${what}: expected a hex quantity, got ${JSON.stringify(value)}`)
  }
  return BigInt(value)
}

export const hexQuantity = (value: bigint): string => `0x${value.toString(16)}`

/* ------------------------------------------------------------------ RLP, encoding side */

function toBytes(value: bigint): Buffer {
  if (value === 0n) return Buffer.alloc(0)
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex, 'hex')
}

function rlpItem(payload: Buffer): Buffer {
  if (payload.length === 1 && payload[0]! <= 0x7f) return payload
  if (payload.length <= 55) return Buffer.concat([Buffer.from([0x80 + payload.length]), payload])
  const length = toBytes(BigInt(payload.length))
  return Buffer.concat([Buffer.from([0xb7 + length.length]), length, payload])
}

function rlpList(items: readonly Buffer[]): Buffer {
  const body = Buffer.concat(items)
  if (body.length <= 55) return Buffer.concat([Buffer.from([0xc0 + body.length]), body])
  const length = toBytes(BigInt(body.length))
  return Buffer.concat([Buffer.from([0xf7 + length.length]), length, body])
}

/**
 * The address a contract created by `sender` at `nonce` will occupy.
 *
 * `keccak256(rlp([sender, nonce]))` and take the low 20 bytes. Known BEFORE the transaction is
 * sent, which is what lets a project page and an event carry the address from the moment of
 * broadcast rather than from the moment of confirmation.
 */
export function createAddress(sender: string, nonce: bigint): string {
  if (!EVM_SHAPE.test(sender)) throw new ChainError('sender must be an EVM address')
  if (nonce < 0n) throw new ChainError('nonce must not be negative')
  const encoded = rlpList([
    rlpItem(Buffer.from(sender.slice(2).toLowerCase(), 'hex')),
    rlpItem(toBytes(nonce)),
  ])
  const digest = Buffer.from(keccak256(encoded))
  return toChecksumAddress(`0x${digest.subarray(12).toString('hex')}`)
}

/* ------------------------------------------------------------------ the transaction id */

/** Raw bytes of a `0x`-prefixed or bare hex string, or null if it is not one. */
export function hexBytes(rawTx: string): Buffer | null {
  const body = rawTx.startsWith('0x') || rawTx.startsWith('0X') ? rawTx.slice(2) : rawTx
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return null
  return Buffer.from(body, 'hex')
}

/**
 * The id a signed EVM transaction will be known by: keccak256 of exactly its bytes.
 *
 * See the file header. This is the function the whole "record the broadcast before confirming"
 * rule rests on, because it means the hash exists before anything is sent.
 */
export function evmTxHash(rawTx: string): string | null {
  const bytes = hexBytes(rawTx)
  if (!bytes) return null
  return `0x${Buffer.from(keccak256(bytes)).toString('hex')}`
}

/* ------------------------------------------------------------------ ABI encoding */

const WORD = 32

function padLeft(bytes: Buffer): Buffer {
  if (bytes.length > WORD) throw new ChainError('abi word overflow')
  return Buffer.concat([Buffer.alloc(WORD - bytes.length), bytes])
}

function padRight(bytes: Buffer): Buffer {
  const remainder = bytes.length % WORD
  return remainder === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(WORD - remainder)])
}

/**
 * The constructor argument types this service encodes. Deliberately four, and deliberately not a
 * general ABI encoder: the only constructor it ever calls is the one in `contracts/ForgeTokens.sol`
 * whose bytecode is committed beside it. A general encoder here would be a large amount of
 * untested surface serving exactly one call site.
 */
export type AbiType = 'string' | 'address' | 'uint8' | 'uint256' | 'bool'

export interface AbiValue {
  readonly type: AbiType
  readonly value: string | bigint | boolean
}

/**
 * Encode constructor arguments, head-and-tail.
 *
 * Static types go in the head; `string` is dynamic, so its head slot carries the offset from the
 * start of the argument block to its tail, and the tail is a length word followed by the UTF-8
 * bytes padded up to a word boundary. That is the whole of the ABI this service needs.
 */
export function encodeConstructorArgs(args: readonly AbiValue[]): Buffer {
  const heads: Buffer[] = []
  const tails: Buffer[] = []
  // The offsets are measured from the start of the argument block, so the head length has to be
  // known before any of them can be written. Every head is exactly one word, dynamic or not.
  let tailOffset = args.length * WORD

  for (const arg of args) {
    if (arg.type === 'string') {
      if (typeof arg.value !== 'string') throw new ChainError('string argument must be a string')
      const bytes = Buffer.from(arg.value, 'utf8')
      const tail = Buffer.concat([padLeft(toBytes(BigInt(bytes.length))), padRight(bytes)])
      heads.push(padLeft(toBytes(BigInt(tailOffset))))
      tails.push(tail)
      tailOffset += tail.length
      continue
    }
    if (arg.type === 'address') {
      if (typeof arg.value !== 'string' || !EVM_SHAPE.test(arg.value)) {
        throw new ChainError('address argument must be an EVM address')
      }
      heads.push(padLeft(Buffer.from(arg.value.slice(2).toLowerCase(), 'hex')))
      continue
    }
    if (arg.type === 'bool') {
      if (typeof arg.value !== 'boolean') throw new ChainError('bool argument must be a boolean')
      heads.push(padLeft(toBytes(arg.value ? 1n : 0n)))
      continue
    }
    // uint8 and uint256. The bound is checked rather than truncated: a supply silently reduced
    // mod 2^256 is a token whose total is not the one the customer paid to create.
    if (typeof arg.value !== 'bigint') throw new ChainError(`${arg.type} argument must be a bigint`)
    if (arg.value < 0n) throw new ChainError(`${arg.type} argument must not be negative`)
    const ceiling = arg.type === 'uint8' ? 1n << 8n : 1n << 256n
    if (arg.value >= ceiling) throw new ChainError(`${arg.type} argument is out of range`)
    heads.push(padLeft(toBytes(arg.value)))
  }

  return Buffer.concat([...heads, ...tails])
}

/** Creation bytecode plus encoded constructor arguments, as the `data` field of a creation. */
export function creationData(bytecode: string, args: readonly AbiValue[]): string {
  const code = hexBytes(bytecode)
  if (!code || code.length === 0) throw new ChainError('creation bytecode is not hex')
  return `0x${Buffer.concat([code, encodeConstructorArgs(args)]).toString('hex')}`
}

/* ------------------------------------------------------------------ fee bounds */

export interface FeeBounds {
  readonly minGasPriceWei: bigint
  readonly maxGasPriceWei: bigint
  readonly maxFeeWei: bigint
}

export class FeeOutOfBandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeeOutOfBandError'
  }
}

/**
 * The gas price one deploy will bid, in wei per gas.
 *
 * Read from the node rather than configured: a constant mirrored in an environment file misprices
 * every deploy the day the chain's own price moves.
 *
 * Doubled, because the price is read when the job claims and the transaction is signed and sent a
 * few seconds later. A creation that underbids its own chain does not fail — it sits in a mempool
 * being neither mined nor refunded until an operator looks at it, which is the worst of the three
 * available outcomes.
 *
 * **The ceiling is checked BEFORE the doubling**, deliberately. Checking after would make every
 * deploy fail as soon as the real price passed half the ceiling, so the bound would bite at a
 * number nobody configured.
 */
export function gasPriceBid(quoted: bigint, bounds: FeeBounds): bigint {
  const base = quoted > bounds.minGasPriceWei ? quoted : bounds.minGasPriceWei
  if (base > bounds.maxGasPriceWei) {
    throw new FeeOutOfBandError(
      `the chain quotes ${base} wei/gas, above the ${bounds.maxGasPriceWei} ceiling this service will bid`,
    )
  }
  const bid = base * 2n
  return bid > bounds.maxGasPriceWei ? bounds.maxGasPriceWei : bid
}

/** The JSON-RPC transport. The seam every test substitutes; the adapter above it is the real one. */
export type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>

/**
 * EIP-55 checksum encoding, from `@cloudsforge/evm`.
 *
 * Re-exported so callers keep importing it from here. The implementation moved out
 * because five services held a byte-identical copy, and a checksum computed two ways
 * is a withdrawal refused for an address copied out of our own UI.
 */
export { toChecksumAddress }
