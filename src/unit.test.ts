/**
 * The pure half: chain names, address derivations, ABI encoding, and the committed bytecode.
 *
 * No database and no network. Everything here is a total function of its arguments, and every one
 * of them sits on a path where a wrong answer is a customer's contract at an address nobody can
 * find or a token whose supply is not the one they paid for.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { keccak256 } from './keccak.ts'
import {
  canonicaliseEvm,
  createAddress,
  creationData,
  encodeConstructorArgs,
  evmTxHash,
  gasPriceBid,
  toChecksumAddress,
} from './evm.ts'
import { CHAIN_IDS, custodyChainOf, evmChainId, familyOf, legacyOnly } from './chains.ts'
import { constructorArgs, variantFor, variantSpec } from './catalogue.ts'
import {
  FIXEDSUPPLYTOKEN_ABI,
  FOUNDRYTOKEN_ABI,
  MINTABLETOKEN_ABI,
  SOURCE_SHA256,
} from './contracts/generated.ts'
import { TEST_BOUNDS } from './testsupport.ts'

/* ------------------------------------------------------------------ keccak */

test('keccak256 matches the published empty-string vector', () => {
  assert.equal(
    Buffer.from(keccak256(Buffer.alloc(0))).toString('hex'),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  )
})

/* ------------------------------------------------------------------ custody's chain names */

test('custody is asked for `ethereum`, not for this service\'s `eth` slug', () => {
  // The one field on a sign request that is not our own spelling. Custody compares seven restated
  // identity fields character for character and answers a mismatch with a 403 that deliberately
  // does not say which field was wrong — so this cannot be debugged from a response, only asserted
  // here. Settlement lost time to exactly this.
  assert.equal(custodyChainOf('eth'), 'ethereum')
})

test('the other chains agree between the two spellings, which is why the odd one is easy to miss', () => {
  assert.equal(custodyChainOf('ember'), 'ember')
  assert.equal(custodyChainOf('sol'), 'solana')
})

test('every chain has a custody name and a family', () => {
  for (const chain of CHAIN_IDS) {
    assert.ok(custodyChainOf(chain).length > 0, chain)
    assert.ok(familyOf(chain).length > 0, chain)
  }
})

test('Ember pins its chain ids from contracts-chain and accepts legacy transactions only', () => {
  // A chain id held in two places is a creation bound to the wrong network the first time one of
  // the copies is edited, so these come from the exact-pinned package and nothing here restates
  // them. The assertion is that the pin is being read at all.
  assert.equal(evmChainId('ember', 'mainnet'), 7411)
  assert.equal(evmChainId('ember', 'testnet'), 7412)
  assert.equal(legacyOnly('ember'), true)
  assert.equal(legacyOnly('eth'), false)
})

test('Solana has no EVM chain id, and null is not permission to skip the binding', () => {
  assert.equal(evmChainId('sol', 'testnet'), null)
})

/* ------------------------------------------------------------------ addresses */

test('EIP-55: a mixed-case address is claiming a checksum and is held to it', () => {
  const valid = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  assert.equal(canonicaliseEvm(valid), valid)
  const mistyped = `${valid.slice(0, -1)}D`
  assert.throws(() => canonicaliseEvm(mistyped), /checksum/)
})

test('EIP-55: an all-lowercase address is not claiming one and is accepted', () => {
  // Refusing it would reject the form every block explorer's copy button used to produce and the
  // form the indexer stores.
  assert.equal(
    canonicaliseEvm('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  )
})

test('the zero address cannot own a contract', () => {
  // A token whose owner is 0x0 is a token with no owner at all, and nothing can ever recover it.
  assert.throws(() => canonicaliseEvm('0x0000000000000000000000000000000000000000'), /zero address/)
})

test('the contract address is derived from the deployer and the nonce, BEFORE the send', () => {
  // keccak256(rlp([sender, nonce]))[12:]. This is what lets the address be committed with the
  // bytes rather than read out of a receipt afterwards, which is what makes the whole
  // record-before-confirm ordering possible. The vector is the well-known one for nonce 0 of
  // 0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0.
  assert.equal(
    createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0n),
    toChecksumAddress('0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d'),
  )
  assert.equal(
    createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 1n),
    toChecksumAddress('0x343c43a37d37dff08ae8c4a11544c718abb4fcf8'),
  )
})

test('two nonces on one deployer produce two different addresses', () => {
  const a = createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 5n)
  const b = createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 6n)
  assert.notEqual(a, b)
})

test('the transaction id is keccak256 of exactly the bytes', () => {
  const raw = '0xf86c808504a817c800825208940000000000000000000000000000000000000001880de0b6b3a76400008025a0'
  assert.equal(
    evmTxHash(raw),
    `0x${Buffer.from(keccak256(Buffer.from(raw.slice(2), 'hex'))).toString('hex')}`,
  )
})

test('bytes that are not hex have no transaction id, rather than a plausible wrong one', () => {
  assert.equal(evmTxHash('not-hex'), null)
  assert.equal(evmTxHash('0xabc'), null)
})

/* ------------------------------------------------------------------ fee bounds */

test('the gas ceiling is checked BEFORE the doubling', () => {
  // Checking after would make every deploy fail as soon as the real price passed half the ceiling,
  // so the bound would bite at a number nobody configured.
  const justUnder = TEST_BOUNDS.maxGasPriceWei - 1n
  assert.equal(gasPriceBid(justUnder, TEST_BOUNDS), TEST_BOUNDS.maxGasPriceWei)
  assert.throws(() => gasPriceBid(TEST_BOUNDS.maxGasPriceWei + 1n, TEST_BOUNDS), /ceiling/)
})

test('a node quoting nothing is floored, not believed', () => {
  // A creation that underbids its own chain does not fail — it sits in a mempool being neither
  // mined nor refunded, which is the worst of the three available outcomes.
  assert.equal(gasPriceBid(0n, TEST_BOUNDS), TEST_BOUNDS.minGasPriceWei * 2n)
})

/* ------------------------------------------------------------------ ABI encoding */

test('a string argument is encoded head-and-tail with an offset the tail can be found at', () => {
  const encoded = encodeConstructorArgs([
    { type: 'string', value: 'Ashfall' },
    { type: 'uint8', value: 18n },
  ])
  // Two heads, so the tail starts at 0x40.
  assert.equal(encoded.subarray(0, 32).toString('hex'), '40'.padStart(64, '0'))
  assert.equal(encoded.subarray(32, 64).toString('hex'), '12'.padStart(64, '0'))
  assert.equal(encoded.subarray(64, 96).toString('hex'), '7'.padStart(64, '0'))
  assert.equal(encoded.subarray(96, 103).toString('utf8'), 'Ashfall')
})

test('a supply past 2^256 is refused, never truncated', () => {
  // A supply silently reduced mod 2^256 is a token whose total is not the one the customer paid to
  // create, and nothing downstream would ever notice.
  assert.throws(() => encodeConstructorArgs([{ type: 'uint256', value: 1n << 256n }]), /out of range/)
  assert.throws(() => encodeConstructorArgs([{ type: 'uint8', value: 256n }]), /out of range/)
})

test('an address argument must be an address, not a hopeful string', () => {
  assert.throws(() => encodeConstructorArgs([{ type: 'address', value: 'not-an-address' }]), /address/)
})

/* ------------------------------------------------------------------ the catalogue */

test('a variant provides EXACTLY the requested features, never a superset', () => {
  // A superset would be worse than a refusal: `pausable` on a token nobody asked to be pausable is
  // an owner key that can freeze every holder's balance.
  assert.equal(variantFor([]).contract, 'FixedSupplyToken')
  assert.equal(variantFor(['mintable', 'burnable']).contract, 'MintableToken')
  assert.equal(variantFor(['mintable', 'burnable', 'pausable']).contract, 'FoundryToken')
})

test('a feature set no committed contract provides is refused, and the refusal names what is', () => {
  assert.throws(() => variantFor(['pausable']), /no committed contract provides/)
  assert.throws(() => variantFor(['mintable']), /available/)
})

test('the fixed-supply contract takes no cap and the foundry contract requires one', () => {
  const base = {
    name: 'Ashfall',
    symbol: 'ASH',
    decimals: 18,
    supply: 1_000n,
    ownerAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  }
  assert.throws(() => constructorArgs(variantSpec('fixed'), { ...base, cap: 10n }), /takes no cap/)
  assert.throws(() => constructorArgs(variantSpec('foundry'), { ...base, cap: null }), /requires a cap/)
  assert.throws(
    () => constructorArgs(variantSpec('foundry'), { ...base, cap: 999n }),
    /at least the initial supply/,
  )
})

/* ------------------------------------------------------------------ the committed bytecode */

test('the committed artefact was generated from the .sol in this repository', () => {
  // The CI job recompiles and diffs, which is the real guarantee. This is the cheap half of it:
  // a source edited without a recompile fails here in a second rather than in a container.
  const source = readFileSync(new URL('./contracts/ForgeTokens.sol', import.meta.url), 'utf8')
  assert.equal(createHash('sha256').update(source).digest('hex'), SOURCE_SHA256)
})

/**
 * The constructor argument ORDER is load-bearing and unchecked by the compiler: the ABI encoder
 * takes a positional list, so swapping `decimals_` and `initialSupply_` produces a token with 10^18
 * decimals and a supply of 18 — and every other test in this file would still pass. This is the
 * only thing that catches it.
 */
const ABIS = {
  fixed: FIXEDSUPPLYTOKEN_ABI,
  mintable: MINTABLETOKEN_ABI,
  foundry: FOUNDRYTOKEN_ABI,
} as const

for (const [variant, abi] of Object.entries(ABIS) as [keyof typeof ABIS, readonly unknown[]][]) {
  test(`${variant}: the constructor arguments match the committed ABI, in order`, () => {
    const spec = variantSpec(variant)
    const declared = (abi as { type: string; inputs?: { type: string }[] }[]).find(
      (item) => item.type === 'constructor',
    )
    assert.ok(declared, 'the committed ABI declares a constructor')
    const built = constructorArgs(spec, {
      name: 'Ashfall',
      symbol: 'ASH',
      decimals: 18,
      supply: 1_000n,
      cap: spec.cap === 'required' ? 2_000n : null,
      ownerAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    })
    assert.deepEqual(
      built.map((arg) => arg.type),
      declared.inputs?.map((input) => input.type),
    )
  })

  test(`${variant}: creation data is the committed bytecode followed by the arguments`, () => {
    const spec = variantSpec(variant)
    const data = creationData(
      spec.bytecode,
      constructorArgs(spec, {
        name: 'Ashfall',
        symbol: 'ASH',
        decimals: 18,
        supply: 1_000n,
        cap: spec.cap === 'required' ? 2_000n : null,
        ownerAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      }),
    )
    assert.ok(data.startsWith(spec.bytecode), 'the bytecode is a prefix of the creation data')
    // EIP-3860's initcode ceiling, which custody also enforces and would otherwise refuse at the
    // moment of signing — a worse way to discover the same limit.
    assert.ok((data.length - 2) / 2 <= 49_152, 'initcode is within the EIP-3860 ceiling')
  })
}

test('the owner address is the LAST constructor argument on every variant', () => {
  // Positional, so this is the argument that decides who owns the contract for ever. Asserted
  // separately from the type list because a type list can match while the meaning has moved: two
  // `uint256`s either side of it would swap silently.
  for (const variant of ['fixed', 'mintable', 'foundry'] as const) {
    const spec = variantSpec(variant)
    const built = constructorArgs(spec, {
      name: 'Ashfall',
      symbol: 'ASH',
      decimals: 18,
      supply: 1_000n,
      cap: spec.cap === 'required' ? 2_000n : null,
      ownerAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    })
    const last = built[built.length - 1]
    assert.equal(last?.type, 'address', variant)
    assert.equal(last?.value, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', variant)
  }
})
