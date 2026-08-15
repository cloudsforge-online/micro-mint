/**
 * The deploy, and the four failures it is built to make impossible.
 *
 * **No test here reaches a real network.** Every chain call goes through `fakeNode`, and the code
 * under test is the REAL EVM family — its nonce handling, its fee bound, its gas gate, its
 * transaction-id derivation, its CREATE address derivation and its drop proof. Only the wire is
 * imaginary.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { driveDeploy } from './deploy.ts'
import { NotImplementedError, familyFor, isImplemented } from './families.ts'
import {
  BROADCAST_TOPIC,
  DEPLOYED_TOPIC,
  FUNDING_REQUESTED_TOPIC,
  claimDeploy,
  findToken,
  listAttempts,
} from './tokens.ts'
import { buildEnvelope, type OutboxRow } from './outbox.ts'
import { activityRecipient, envelopeDefects, notifyRecipient } from './topics.ts'
import { createAddress, evmTxHash } from './evm.ts'
import {
  deployerFor,
  enabled,
  fakeCustody,
  fakeNode,
  harness,
  migrateTestDb,
  openDb,
  resetMint,
  seedToken,
  skip,
  type Harness,
} from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetMint(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

/** A funded deployer for one order, so the funding gate passes. */
function funded(orderId: string): ReturnType<typeof fakeNode> {
  return fakeNode({ balances: { [deployerFor(orderId).toLowerCase()]: 10n ** 18n } })
}

/* ------------------------------------------------------------------ the happy path */

test('a paid order deploys: sign, commit, broadcast, confirm', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const h: Harness = harness(sql, { node })

  // First pass: signs, commits, broadcasts. Not yet mined, so it stays in flight.
  assert.equal(await driveDeploy(h.deploy, id), 'broadcast')
  assert.equal(node.broadcast.length, 1)

  const afterBroadcast = await findToken(h.sql, id)
  assert.equal(afterBroadcast?.status, 'deploying')
  assert.ok(afterBroadcast?.deployTxHash, 'the hash is on the row')
  assert.ok(afterBroadcast?.broadcastAt, 'the broadcast is recorded')
  assert.equal(afterBroadcast?.contractAddress, createAddress(deployerFor(id), 0n))

  // Mine it, then poll to terminal.
  node.mine(node.broadcast[0]!)
  assert.equal(await driveDeploy(h.deploy, id), 'deployed')

  const deployed = await findToken(h.sql, id)
  assert.equal(deployed?.status, 'deployed')
  assert.equal(deployed?.contractAddress, createAddress(deployerFor(id), 0n))
  assert.ok(deployed?.confirmedAt)
  // Exactly one signature and one broadcast for the whole deploy.
  assert.equal(h.custody.signatures.length, 1)
  assert.equal(node.broadcast.length, 1)
})

test('the deployed event names the CUSTOMER as owner, never the deployer', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const h = harness(sql, { node })
  await driveDeploy(h.deploy, id)
  node.mine(node.broadcast[0]!)
  await driveDeploy(h.deploy, id)

  const events = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
    select topic, payload from outbox where key = ${id} order by occurred_at
  `
  // The REGISTERED name. This read `'mint.token.deployed'` — the name this service invented and
  // nothing in the estate subscribed to — so it passed while notify, activity and analytics all sat
  // on a topic that never arrived.
  const deployed = events.find((e) => e.topic === DEPLOYED_TOPIC)
  assert.ok(deployed)
  assert.equal(deployed.topic, 'mint.deploy.confirmed')
  // The gas payer and the owner are different accounts, and this is the assertion that says so.
  assert.notEqual(deployed.payload['ownerAddress'], deployerFor(id))
  assert.equal(
    (deployed.payload['ownerAddress'] as string).toLowerCase(),
    '0x00000000000000000000000000000000000000a1',
  )

  /* -------------------------------------------------------------------------------------------
   * **THE PERSON, off a REAL row rather than a fixture.** `topics.test.ts` runs the estate's two
   * recipient readers over a constructed payload; this runs them over the payload the real deploy
   * path wrote, through the relay's own builder and the JSON round trip that is the wire. A field
   * assigned `undefined` is indistinguishable from an absent one after that round trip, which is
   * exactly how "the payload has a userId" can be true in a test and false in production.
   * ----------------------------------------------------------------------------------------- */
  const stored = await sql<OutboxRow[]>`
    select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
      from outbox where key = ${id} and topic = ${DEPLOYED_TOPIC}
  `
  const row = stored[0]
  assert.ok(row)
  assert.equal(row.key, id, 'keyed by token_id, which is what the registry declares')

  const built = buildEnvelope(row)
  assert.ok(built.ok, 'the relay would refuse the envelope it built from a real deploy')
  const delivered = JSON.parse(JSON.stringify(built.value)) as {
    topic: string
    key: string
    actor: string
    payload: Record<string, unknown>
  }
  assert.deepEqual(
    envelopeDefects(delivered),
    [],
    'a real confirmed deploy would be refused at the envelope by every consumer in the estate',
  )
  // The actor is the SERVICE, because this runs in a leased deploy job — so notify's actor fallback
  // finds nobody and the payload field is the only thing that can name a person.
  assert.equal(delivered.actor, 'service:mint')
  const owner = String(delivered.payload['ownerSubject']).slice('user:'.length)
  assert.equal(activityRecipient(delivered.payload), owner, 'this deploy is in nobody’s feed')
  assert.equal(notifyRecipient(delivered), owner, 'this deploy notifies nobody')
})

test('the broadcast event carries the contract address, DERIVED before the send', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const h = harness(sql, { node: funded(id) })
  await driveDeploy(h.deploy, id)
  const events = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
    select topic, payload from outbox where key = ${id} and topic = ${BROADCAST_TOPIC}
  `
  assert.equal(events[0]?.payload['contractAddress'], createAddress(deployerFor(id), 0n))
  assert.ok(events[0]?.payload['txHash'])
})

/* ------------------------------------------------------------------ the recording ordering */

/**
 * **THE HEADLINE.** The transaction hash is durable BEFORE anything is sent.
 *
 * The frozen service broadcasts and then writes the hash, so a process killed in between leaves a
 * real signed creation on the wire that the row has no record of — and the next claim, seeing
 * `tx_hash IS NULL`, deploys a second one. Here the hash is written with the bytes, so there is no
 * window: this test asserts the row already carries the id at the moment the node is asked to
 * accept it.
 */
test('the hash is on the row BEFORE the node is asked to accept the bytes', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  let hashAtBroadcast: string | null | undefined
  const originalRpc = node.rpc
  const observing = {
    ...node,
    rpc: async (method: string, params: readonly unknown[]) => {
      if (method === 'eth_sendRawTransaction') {
        // Read the row at the exact moment the send is happening.
        hashAtBroadcast = (await findToken(sql as unknown as never, id))?.deployTxHash
      }
      return originalRpc(method, params)
    },
  } as typeof node
  const h = harness(sql, { node: observing })

  await driveDeploy(h.deploy, id)

  assert.ok(hashAtBroadcast, 'the row already carried the transaction hash when the send began')
  assert.equal(hashAtBroadcast, evmTxHash(node.broadcast[0] ?? observing.broadcast[0]!))
})

/**
 * A process killed after the commit and before the send re-sends the IDENTICAL bytes.
 *
 * Modelled by letting the send fail once. The bytes are already committed, so the next pass
 * resumes at broadcast rather than re-signing: one signature, one transaction.
 */
test('a crash between the commit and the send re-sends one transaction, not two', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  node.failNext('eth_sendRawTransaction', 'connection reset')
  const h = harness(sql, { node })

  // The send fails. Nothing reached the node.
  assert.equal(await driveDeploy(h.deploy, id), 'pending')
  assert.equal(node.broadcast.length, 0)
  const stalled = await findToken(h.sql, id)
  assert.ok(stalled?.rawTx, 'the bytes are committed')
  assert.equal(stalled?.broadcastAt, null, 'nothing is recorded as broadcast')

  // The next pass RESUMES at broadcast. `claimDeploy` refuses a row with committed bytes, so this
  // is the resume path and not a fresh claim.
  assert.equal(await driveDeploy(h.deploy, id), 'broadcast')
  assert.equal(h.custody.signatures.length, 1, 'exactly one signature was ever made')
  assert.equal(node.broadcast.length, 1, 'exactly one transaction ever reached the node')
  assert.equal(stalled?.rawTx, (await findToken(h.sql, id))?.rawTx, 'the same bytes')
})

test('a node that already holds the bytes answers "already known", which is a success', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const h = harness(sql, { node })
  await driveDeploy(h.deploy, id)
  // Force a re-send by clearing the broadcast marker, as a lost response would.
  await sql`update tokens set broadcast_at = null where id = ${id}`
  assert.equal(await driveDeploy(h.deploy, id), 'broadcast')
  assert.equal(node.broadcast.length, 1, 'the re-send was recognised, not duplicated')
})

/* ------------------------------------------------------------------ the lease */

test('claimDeploy is a lease: two claims, one winner', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const [a, b] = await Promise.all([
    claimDeploy(sql as unknown as never, { id, owner: 'replica-a', leaseMs: 60_000 }),
    claimDeploy(sql as unknown as never, { id, owner: 'replica-b', leaseMs: 60_000 }),
  ])
  assert.equal([a, b].filter(Boolean).length, 1)
})

test('claimDeploy refuses a row whose bytes are already committed', { skip }, async () => {
  // The in-flight guard, and it is on the BYTES rather than on the hash. The frozen guard is
  // `tx_hash IS NULL`, which admits a row that was signed and committed but not yet recorded as
  // broadcast — the catastrophic window.
  const { id } = await seedToken(sql as unknown as never, {
    status: 'deploying',
    deploy_tx_hash: '0xdead',
  })
  await sql`update tokens set raw_tx = '0xf86c', lease_until = null where id = ${id}`
  assert.equal(await claimDeploy(sql as unknown as never, { id, owner: 'x', leaseMs: 1_000 }), null)
})

test('a FAILED deploy is not re-claimable: that is the second half of the double-mint', { skip }, async () => {
  // The frozen `DEPLOYABLE` includes `'failed'`, so a broadcast that loses its confirmation race
  // writes `failed`, matches the claim predicate immediately with no lease wait at all, and mints
  // again. A failure here is terminal.
  const { id } = await seedToken(sql as unknown as never, {
    status: 'failed',
    failure_reason: 'the chain reverted it',
  })
  assert.equal(await claimDeploy(sql as unknown as never, { id, owner: 'x', leaseMs: 1_000 }), null)
})

test('a deployed order is not re-claimable', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never, {
    status: 'deployed',
    deploy_tx_hash: '0xdead',
    contract_address: '0x00000000000000000000000000000000000000b2',
    broadcast_at: '2026-01-01T00:00:00Z',
  })
  assert.equal(await claimDeploy(sql as unknown as never, { id, owner: 'x', leaseMs: 1_000 }), null)
})

test('two replicas racing one order produce ONE signature and ONE transaction', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const custody = fakeCustody()
  // Hold the first signature open so the second replica is genuinely inside the same window,
  // rather than the proof being an accident of scheduling.
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  custody.onSign = async () => {
    if (first) {
      first = false
      await held
    }
  }
  const a = harness(sql, { node, custody, owner: 'replica-a' })
  const b = harness(sql, { node, custody, owner: 'replica-b' })

  const runA = driveDeploy(a.deploy, id)
  // Give the second replica a turn while the first is blocked in custody.
  await new Promise((resolve) => setImmediate(resolve))
  const runB = driveDeploy(b.deploy, id)
  release?.()
  await Promise.all([runA, runB])

  assert.equal(custody.signatures.length, 1, 'only one replica ever reached custody')
  assert.equal(node.broadcast.length, 1, 'only one transaction ever reached the node')
})

/* ------------------------------------------------------------------ funding */

test('an unfunded deployer moves to awaiting_funds and signs nothing', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  // Deliberately ONE WEI, which is what the frozen `wei > 0n` gate lets through. The deploy would
  // then die at estimateGas with the lease already claimed and an attempt burned.
  const node = fakeNode({ balances: { [deployerFor(id).toLowerCase()]: 1n } })
  const h = harness(sql, { node })

  assert.equal(await driveDeploy(h.deploy, id), 'awaiting_funds')
  assert.equal(h.custody.signatures.length, 0, 'nothing was signed')
  assert.equal(node.broadcast.length, 0)
  const row = await findToken(h.sql, id)
  assert.equal(row?.status, 'awaiting_funds')
  assert.equal(row?.leaseOwner, null, 'the lease is released so a funded retry is immediate')
})

test('a funded deployer picked up on a later pass deploys normally', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = fakeNode({ balances: { [deployerFor(id).toLowerCase()]: 1n } })
  const h = harness(sql, { node })
  await driveDeploy(h.deploy, id)
  node.setBalance(deployerFor(id), 10n ** 18n)
  assert.equal(await driveDeploy(h.deploy, id), 'broadcast')
})

/**
 * **THE HALF THAT DID NOT EXIST.** Everything above proves the deploy does not proceed unfunded.
 * Nothing proved anyone was ever TOLD, and nothing was: a deployer address is minted per order and
 * starts empty, so this branch is on the happy path of every deploy, and it used to write the row
 * back to `awaiting_funds` and log a line. Every paid order on both networks sat there.
 */
test('an unfunded deployer ASKS for gas, on the registered topic', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = fakeNode({ balances: { [deployerFor(id).toLowerCase()]: 1n } })
  const h = harness(sql, { node })

  assert.equal(await driveDeploy(h.deploy, id), 'awaiting_funds')

  const stored = await sql<OutboxRow[]>`
    select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
      from outbox where key = ${id} and topic = ${FUNDING_REQUESTED_TOPIC}
  `
  const row = stored[0]
  assert.ok(row, 'nothing asked settlement for the gas this deploy cannot pay for')
  assert.equal(row.key, id, 'keyed by token_id, which is what the registry declares')

  // Through the relay's own builder and the JSON round trip that is the wire, because an envelope
  // the contract refuses is delivered to nobody however correct the payload is.
  const built = buildEnvelope(row)
  assert.ok(built.ok, 'the relay would refuse the envelope it built from a real funding request')
  const delivered = JSON.parse(JSON.stringify(built.value)) as {
    topic: string
    key: string
    actor: string
    payload: Record<string, unknown>
  }
  assert.deepEqual(envelopeDefects(delivered), [])
  assert.equal(delivered.actor, 'service:mint')

  const payload = delivered.payload
  assert.equal(payload['tokenId'], id)
  assert.equal(payload['chain'], 'ember')
  assert.equal(payload['network'], 'testnet')
  assert.equal(String(payload['deployerAddress']).toLowerCase(), deployerFor(id).toLowerCase())
  assert.equal(payload['attempt'], 1, 'the first ask is attempt 1; settlement keys its transfer on it')
  // Decimal strings, never JSON numbers: a wei quantity above 2^53 is silently rounded, and
  // settlement's parser refuses anything that is not /^\d+$/ rather than coercing it.
  for (const field of ['requiredWei', 'balanceWei', 'amountWei']) {
    assert.equal(typeof payload[field], 'string', `${field} must be a decimal string`)
    assert.match(String(payload[field]), /^\d+$/)
  }
  assert.equal(payload['balanceWei'], '1')
  // The ask covers the requirement with headroom, so a gas-price tick between the measurement and
  // the top-up landing does not leave the deployer short a second time.
  const required = BigInt(String(payload['requiredWei']))
  const amount = BigInt(String(payload['amountWei']))
  assert.equal(amount, required + required / 2n - 1n)

  // No person. The platform topping up its own deployer out of its own treasury is not a fact
  // about the customer who bought the token.
  assert.equal(payload['userId'], undefined)
  assert.equal(activityRecipient(payload), null, 'platform plumbing landed in a person’s feed')
  assert.equal(notifyRecipient(delivered), null, 'platform plumbing would notify a customer')
})

test('a second pass inside the cooldown does not ask twice', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = fakeNode({ balances: { [deployerFor(id).toLowerCase()]: 1n } })
  // A real cooldown, and a clock the test controls. The sweep runs every tick, so without this a
  // stuck order would spend its whole request allowance inside a minute — before the FIRST top-up
  // had any chance to be mined — and then stop asking for ever.
  let clock = 1_760_000_000_000
  const h = harness(sql, { node, fundingCooldownMs: 5 * 60_000, now: () => clock })

  await driveDeploy(h.deploy, id)
  clock += 60_000
  await driveDeploy(h.deploy, id)

  const asks = await sql<{ count: string }[]>`
    select count(*)::text as count from outbox where key = ${id} and topic = ${FUNDING_REQUESTED_TOPIC}
  `
  assert.equal(asks[0]?.count, '1', 'a second request went out before the first could confirm')
  const held = await findToken(h.sql, id)
  assert.equal(held?.status, 'awaiting_funds')
  assert.equal(held?.leaseOwner, null, 'a held request still has to release the lease')
  assert.equal(held?.fundingRequests, 1)

  // Past the cooldown, it asks again — a genuine re-ask, with an attempt settlement can tell apart
  // from a redelivery of the first.
  clock += 5 * 60_000 + 1
  await driveDeploy(h.deploy, id)
  const second = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from outbox where key = ${id} and topic = ${FUNDING_REQUESTED_TOPIC}
     order by occurred_at
  `
  assert.equal(second.length, 2)
  assert.equal(second[1]?.payload['attempt'], 2)
})

test('an order that has asked its limit of times stops asking', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = fakeNode({ balances: { [deployerFor(id).toLowerCase()]: 1n } })
  const h = harness(sql, { node, fundingMaxRequests: 2, fundingCooldownMs: 0 })

  for (let pass = 0; pass < 5; pass += 1) {
    assert.equal(await driveDeploy(h.deploy, id), 'awaiting_funds')
  }

  const asks = await sql<{ count: string }[]>`
    select count(*)::text as count from outbox where key = ${id} and topic = ${FUNDING_REQUESTED_TOPIC}
  `
  // A bound, not a retry budget. If two top-ups have gone out and the address is still short, the
  // third will not be the one that works and each one spends real treasury.
  assert.equal(asks[0]?.count, '2', 'the request limit is not a limit')
  const row = await findToken(h.sql, id)
  assert.equal(row?.fundingRequests, 2)
  assert.equal(row?.status, 'awaiting_funds', 'a capped order still waits where an operator can see it')
  assert.equal(row?.leaseOwner, null)
})

test('the money arriving ends it: a funded retry deploys and asks for nothing more', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = fakeNode({ balances: { [deployerFor(id).toLowerCase()]: 1n } })
  const h = harness(sql, { node })

  await driveDeploy(h.deploy, id)
  const asked = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from outbox where key = ${id} and topic = ${FUNDING_REQUESTED_TOPIC}
  `
  // Pay exactly what was asked for — which is what settlement's gas_topup transfers — rather than
  // a round number, so the headroom is proven sufficient rather than assumed.
  const amount = BigInt(String(asked[0]?.payload['amountWei']))
  node.setBalance(deployerFor(id), 1n + amount)

  assert.equal(await driveDeploy(h.deploy, id), 'broadcast')
  const after = await sql<{ count: string }[]>`
    select count(*)::text as count from outbox where key = ${id} and topic = ${FUNDING_REQUESTED_TOPIC}
  `
  assert.equal(after[0]?.count, '1', 'a funded deploy asked for money it did not need')
})

/* ------------------------------------------------------------------ outcomes */

test('a reverted creation fails terminally and KEEPS its hash', { skip }, async () => {
  // The frozen service clears `tx_hash` on a revert so the order becomes retryable, which destroys
  // the only record of where the customer's gas went — and is precisely what makes the row
  // claimable again.
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const h = harness(sql, { node })
  await driveDeploy(h.deploy, id)
  node.mine(node.broadcast[0]!, { reverted: true })

  assert.equal(await driveDeploy(h.deploy, id), 'failed')
  const row = await findToken(h.sql, id)
  assert.equal(row?.status, 'failed')
  assert.ok(row?.failureReason)
  assert.ok(row?.deployTxHash, 'the evidence is kept')
  assert.ok(row?.broadcastAt)
})

test('a creation at an address the chain disagrees with is FAILED, never confirmed', { skip }, async () => {
  // A derived address that disagrees with the mined one means the nonce moved under us. Recording
  // the derived address would point the project page and the customer at an address with no code.
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const h = harness(sql, { node })
  await driveDeploy(h.deploy, id)
  node.mine(node.broadcast[0]!, { contractAddress: '0x00000000000000000000000000000000000000ff' })

  assert.equal(await driveDeploy(h.deploy, id), 'failed')
  const row = await findToken(h.sql, id)
  assert.match(row?.failureReason ?? '', /derived/)
})

test('the indexer is preferred where it has an answer', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const h = harness(sql, { node })
  await driveDeploy(h.deploy, id)
  const hash = (await findToken(h.sql, id))!.deployTxHash!
  h.indexer.setTransaction(hash, {
    hash,
    status: 'success',
    blockHeight: 100,
    confirmations: 64,
    from: deployerFor(id),
    to: null,
    contractAddress: createAddress(deployerFor(id), 0n),
  })
  // The node has no receipt at all, so a confirmation here can only have come from the indexer.
  assert.equal(await driveDeploy(h.deploy, id), 'deployed')
})

test('an unseen fresh broadcast stays PENDING rather than being called dropped', { skip }, async () => {
  // "The indexer has never heard of this hash" is not "the chain does not have it". Reading that
  // absence as a failure would re-deploy every fresh broadcast and pay gas twice.
  const { id } = await seedToken(sql as unknown as never)
  const h = harness(sql, { node: funded(id) })
  await driveDeploy(h.deploy, id)
  assert.equal(await driveDeploy(h.deploy, id), 'broadcast')
  assert.equal((await findToken(h.sql, id))?.status, 'deploying')
})

test('a dropped creation needs a nonce PROOF, not merely age', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  // Old enough to be stuck, but the slot is still open: nobody can prove anything, so it stays
  // pending and an operator decides. Declaring it failed here would refund a deploy whose contract
  // may appear in the next block.
  const h = harness(sql, { node, stuckMs: 0 })
  await driveDeploy(h.deploy, id)
  assert.equal(await driveDeploy(h.deploy, id), 'broadcast')

  // Now the deployer's `latest` nonce has passed the slot these bytes occupy. Whatever filled it,
  // it was not this transaction, and this transaction can never be mined.
  node.setNonce(deployerFor(id), 1)
  assert.equal(await driveDeploy(h.deploy, id), 'failed')
  assert.match((await findToken(h.sql, id))?.failureReason ?? '', /nonce 0 has been passed/)
})

test('an unreachable node never fails an order', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const h = harness(sql, { node })
  await driveDeploy(h.deploy, id)
  node.setUnreachable(true)
  assert.equal(await driveDeploy(h.deploy, id), 'pending')
  assert.equal((await findToken(h.sql, id))?.status, 'deploying')
})

/* ------------------------------------------------------------------ refusals */

test('a custody refusal fails the order terminally and signs nothing further', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const custody = fakeCustody()
  custody.refuseSigning('binding_mismatch', 'the restated binding does not match')
  const h = harness(sql, { node: funded(id), custody })

  assert.equal(await driveDeploy(h.deploy, id), 'failed')
  const row = await findToken(h.sql, id)
  assert.match(row?.failureReason ?? '', /binding/)
  assert.equal(row?.broadcastAt, null)
  const attempts = await listAttempts(h.sql, id)
  assert.ok(attempts.some((a) => a.outcome === 'refused'))
})

test('deploys can be turned off without turning payment off', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const h = harness(sql, { node: funded(id), enabled: false })
  assert.equal(await driveDeploy(h.deploy, id), 'skipped')
  assert.equal((await findToken(h.sql, id))?.status, 'paid')
})

/* ------------------------------------------------------------------ Solana */

test('the Solana family exists as a real object and refuses', { skip: false }, () => {
  // Present, typed and registered, so this is an assertion about behaviour rather than about the
  // absence of a branch. Every method throws.
  const family = familyFor('sol')
  assert.equal(family.family, 'solana')
  assert.equal(isImplemented('sol'), false)
  assert.equal(isImplemented('ember'), true)
})

test('every Solana method throws NotImplementedError, naming both reasons', { skip: false }, async () => {
  const family = familyFor('sol')
  const calls = [
    () => family.funding({} as never, (() => {}) as never, {} as never),
    () => family.prepare({} as never, (() => {}) as never, {} as never, {} as never),
    () => family.broadcast('0x00', (() => {}) as never),
    () => family.outcome({} as never, {} as never, (() => {}) as never, {} as never, 0, 0),
  ]
  for (const call of calls) {
    await assert.rejects(call, (err: unknown) => {
      assert.ok(err instanceof NotImplementedError)
      assert.equal(err.family, 'solana')
      // Custody's refusal, and the deterministic-address requirement. Recording the broadcast is
      // necessary and NOT sufficient for Solana: `Keypair.generate()` inside the retryable region
      // is unfixable by any amount of hash recording.
      assert.match(err.message, /SetAuthority/)
      assert.match(err.message, /deterministic mint address/)
      return true
    })
  }
})

test('a Solana order fails terminally with the reason on the row, not with a 500', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never, { chain: 'sol' })
  const h = harness(sql, { node: funded(id) })
  assert.equal(await driveDeploy(h.deploy, id), 'failed')
  const row = await findToken(h.sql, id)
  assert.equal(row?.status, 'failed')
  assert.match(row?.failureReason ?? '', /SetAuthority/)
  const attempts = await listAttempts(h.sql, id)
  assert.equal(attempts[0]?.outcome, 'not_implemented')
})

/* ------------------------------------------------------------------ evidence */

test('every attempt is recorded, in order, with its hash', { skip }, async () => {
  const { id } = await seedToken(sql as unknown as never)
  const node = funded(id)
  const h = harness(sql, { node })
  await driveDeploy(h.deploy, id)
  node.mine(node.broadcast[0]!)
  await driveDeploy(h.deploy, id)

  const attempts = await listAttempts(h.sql, id)
  assert.deepEqual(
    attempts.map((a) => a.outcome),
    ['signed', 'broadcast', 'confirmed'],
  )
  // An operator asking "did this ever reach a chain" gets an answer from the row rather than from
  // a log search — and the answer carries the id to look up.
  for (const attempt of attempts) assert.ok(attempt.txHash)
})
