/**
 * The producer half of the bus contract, checked against the source rather than against a list.
 *
 * Four families of check, for the four shapes one defect class took here — all live at once, which
 * is why nothing this service emitted has ever reached anyone:
 *
 *   1. **The name.** The registry owns `mint.deploy.confirmed` and this service emitted
 *      `mint.token.deployed`. `notify` (priority HIGH), `activity` and `analytics` all read the
 *      registered name, so all three were dead code and the client kept polling every four seconds.
 *      Reconciling the emitted set with the registry in BOTH directions is what catches that, and
 *      reading the literals back out of `src/` is what stops the check agreeing with itself while
 *      the emit sites drift.
 *   2. **The envelope.** `version` went out as the integer `1` where the contract types it
 *      "major.minor", and the nullable `actor` and `correlation_id` columns went out untouched. This
 *      suite was green throughout, because both sides tested against imagined counterparts. The only
 *      check that could have caught it is the one below: build an envelope with the relay's own
 *      `buildEnvelope` and hand it to the contract's own `classifyEnvelope`.
 *   3. **The signature.** A local `sha256=` under a local header, where the contract signs
 *      `t=…,v1=…` under `cf-signature`.
 *   4. **The person**, which is a different question from the name. A correctly-named, perfectly
 *      valid envelope that names nobody is a HIGH-priority notification answering `no_recipient` for
 *      ever. The readers are restated in `topics.ts` from their own source and run here over the
 *      bytes the relay produces.
 *
 * No database. Pure text, set arithmetic and a few function calls, so it runs in CI even when the
 * database-backed suite skips.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TOPIC_NAMES,
  isRegisteredTopic,
  parseVersion,
  topicSpec,
  topicsProducedBy,
  verifyDelivery,
} from '@cloudsforge/contracts-events'
import { buildEnvelope, signEvent, verifyEventSignature } from './outbox.ts'
import { DEPLOYED_TOPIC, deployConfirmedPayload, type TokenRecord } from './tokens.ts'
import {
  AWAITING_REGISTRATION,
  EMITTED_TOPICS,
  KEYED_BY,
  SERVICE,
  activityRecipient,
  adoptedProposals,
  envelopeDefects,
  malformedProposals,
  notifyRecipient,
  undeclaredTopics,
  unemittedOwnedTopics,
} from './topics.ts'

const SRC = dirname(fileURLToPath(import.meta.url))

function sourceFiles(): readonly string[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'testsupport.ts')
    .map((file) => join(SRC, file))
}

/**
 * The files a topic literal may legitimately appear in.
 *
 * `topics.ts` is excluded, and that exclusion is the whole check rather than a convenience: it is
 * the file holding `EMITTED_TOPICS` and the quarantine, and it is the thing being checked. Scanning
 * it would let a quarantine entry justify its own existence — a topic could be declared, quarantined
 * and never emitted, and every assertion below would still agree.
 */
function emitSourceFiles(): readonly string[] {
  return sourceFiles().filter((file) => !file.endsWith('/topics.ts'))
}

/**
 * Every topic literal in this service's namespace that appears anywhere in `src/`.
 *
 * Not `topic: '<name>'`: this service names its topics through exported constants, so a scan for the
 * emit-site shape would find nothing and pass vacuously. Matching every well-formed `mint.*.*`
 * string literal finds both spellings — which is what makes it able to see the RENAME — and it also
 * catches a constant that no emit site uses.
 *
 * Comment lines are skipped, and that is load-bearing rather than tidy: `tokens.ts` and `topics.ts`
 * both discuss `mint.token.deployed` and `mint.deploy.confirmed` in prose while explaining the
 * rename, and counting a sentence about a topic as an emission is precisely the failure this estate
 * found when a guard passed because its own prose naming a function counted as a reference.
 */
function topicsInSource(): readonly string[] {
  const found = new Set<string>()
  const literal = new RegExp(`'(${SERVICE}\\.[a-z0-9_]+\\.[a-z0-9_]+)'`, 'g')
  for (const file of emitSourceFiles()) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      if (/\b(?:action|scope|resource|permission)\s*:/.test(line)) continue
      for (const match of line.matchAll(literal)) if (match[1]) found.add(match[1])
    }
  }
  return [...found].sort()
}

/* ------------------------------------------------------------------ the names */

test('the source emits exactly the topics this service declares', () => {
  // Both halves of the drift: a literal in `src/` that EMITTED_TOPICS does not list, and an entry in
  // EMITTED_TOPICS that no literal backs. The second half is what stops the list being repaired by
  // editing the list.
  assert.deepEqual(
    topicsInSource(),
    [...EMITTED_TOPICS].sort(),
    'src/ and EMITTED_TOPICS disagree about what this service puts on the bus',
  )
})

test('the literal scanner does not count a topic named in prose', () => {
  // The scanner is exercised before it is trusted, because it is the input to every assertion above
  // and below. A scanner that silently matched nothing would make all of them pass.
  assert.ok(topicsInSource().length >= 5, 'the scanner found nothing — it is broken, not the source')
  assert.ok(topicsInSource().includes('mint.deploy.confirmed'))
  // **The old name is gone from the wire.** `tokens.ts` still discusses it at length in the comment
  // explaining the rename, so a scanner that counted prose would report it as still emitted — which
  // is exactly the failure mode this assertion guards, and the reason it is worth stating.
  assert.ok(
    !topicsInSource().includes('mint.token.deployed'),
    'the pre-rename name is still emitted somewhere',
  )
  assert.match(readFileSync(join(SRC, 'tokens.ts'), 'utf8'), /mint\.token\.deployed/, 'the rename is still explained in prose, so the scanner is genuinely ignoring comments')
})

test('every topic this service emits is one the estate has a name for', () => {
  assert.deepEqual(
    undeclaredTopics(topicsInSource()),
    [],
    'emitted, but in neither the registry nor AWAITING_REGISTRATION — decide which, then say so',
  )
})

test('THE DEFECT: every registry topic this service owns is actually emitted', () => {
  // **The direction this repository was wrong in, for the life of the service.** The registry has
  // said `mint` produces `mint.deploy.confirmed` since before this service existed; nothing here
  // emitted it, so notify's HIGH-priority rule, activity's classifier and analytics' metrics 8 and 9
  // were all dead code. Nothing broke and nothing logged — the client just kept polling.
  assert.deepEqual(
    unemittedOwnedTopics(topicsInSource()),
    [],
    'the registry says mint produces these and no emit site does — every consumer of each is dead code',
  )
  // And the registry is being read rather than the check passing vacuously. Two topics now, not one:
  // `mint.deploy.funding_requested` is emitted by `requestDeployerFunding` when a per-order deployer
  // address cannot pay its own gas. It is owned by mint and consumed by settlement, which answers it
  // with a `gas_topup` outbound — so if it ever stops being emitted, every paid deploy stalls at
  // `awaiting_funds` in silence, which is exactly the failure this test exists to name.
  assert.deepEqual(topicsProducedBy(SERVICE), [
    'mint.deploy.confirmed',
    'mint.deploy.funding_requested',
  ])
  assert.ok(TOPIC_NAMES.length >= 40)
})

test('the ordering key is the registry’s, character for character', () => {
  // `key` is the ordering partition: events sharing a `(topic, key)` are delivered in the order they
  // were written and no other pair has any ordering relationship at all, so a producer that picks its
  // own key silently reorders every consumer's view of the topic.
  for (const topic of EMITTED_TOPICS) {
    const keyedBy = KEYED_BY[topic]
    assert.ok(keyedBy, `${topic} has no declared ordering key`)
    if (isRegisteredTopic(topic)) {
      assert.equal(topicSpec(topic).keyedBy, keyedBy, `${topic} disagrees with the registry`)
    } else {
      assert.equal(AWAITING_REGISTRATION[topic]?.spec.keyedBy, keyedBy)
    }
  }
  assert.equal(topicSpec(DEPLOYED_TOPIC).keyedBy, 'token_id')
})

test('a pending proposal disappears once contracts adopts it', () => {
  // Without this the quarantine becomes a permanent allow-list: the topic gets registered, the entry
  // stays, and the next reader believes the topic is still unregistered.
  assert.deepEqual(
    adoptedProposals(),
    [],
    'the registry now names these — delete them from AWAITING_REGISTRATION',
  )
  assert.equal(Object.keys(AWAITING_REGISTRATION).length, 4)
  for (const topic of Object.keys(AWAITING_REGISTRATION)) {
    assert.equal(isRegisteredTopic(topic), false, `${topic} is registered now`)
  }
  // The registered one is NOT quarantined — an entry for it would excuse the very defect this
  // commit fixes.
  assert.equal(isRegisteredTopic(DEPLOYED_TOPIC), true)
  assert.equal(Object.hasOwn(AWAITING_REGISTRATION, DEPLOYED_TOPIC), false)
})

test('every pending proposal carries a spec that could be pasted into the registry', () => {
  assert.deepEqual(
    malformedProposals(),
    [],
    'a proposal needs a well-formed mint topic, a real ordering key, and a reason worth reading',
  )
})

/* ------------------------------------------------------------------ the envelope */

const OWNER = '018f0000-0000-7000-8000-0000000000d1'

/**
 * A stored outbox row exactly as the deploy path writes one.
 *
 * `actor` and `correlation_id` are set here because `markDeployed` does set them — but the relay
 * must survive them being null too, which the row below the tests covers. A fixture that only ever
 * exercised the easy case would prove nothing about a leased job.
 */
const ROW = {
  id: '018f0000-0000-7000-8000-0000000000a1',
  topic: DEPLOYED_TOPIC,
  key: '018f0000-0000-7000-8000-0000000000b1',
  occurred_at: new Date('2026-08-03T10:00:00.000Z'),
  producer: SERVICE,
  version: 1,
  actor: 'service:mint',
  correlation_id: '018f0000-0000-7000-8000-0000000000b1',
  payload: {
    tokenId: '018f0000-0000-7000-8000-0000000000b1',
    ownerSubject: `user:${OWNER}`,
    userId: OWNER,
    contractAddress: '0xabc',
    symbol: 'FOO',
    name: 'Foo Token',
  },
}

/**
 * **THE TRAP, STATED FIRST: prove the reader can fail before trusting that it passed.**
 *
 * A test in this estate stayed green with the logic deliberately broken because the payload lacked
 * the field being read and an absent field is null to every reader — null being the expected answer.
 * The same vacuity is available here. So YESTERDAY'S ENVELOPE is built by hand first, with the
 * integer version and the nulls passed straight through, and every defect is named.
 */
test('the pre-migration envelope is refused, and all three reasons are named', () => {
  const yesterday = {
    id: ROW.id,
    topic: ROW.topic,
    key: ROW.key,
    occurredAt: ROW.occurred_at.toISOString(),
    producer: ROW.producer,
    version: ROW.version as unknown as string,
    actor: null,
    correlationId: null,
    payload: ROW.payload,
  }
  const defects = envelopeDefects(yesterday)
  assert.ok(defects.some((e) => e.startsWith('version:')), `version must be named: ${defects.join('; ')}`)
  assert.ok(defects.some((e) => e.startsWith('actor:')), `actor must be named: ${defects.join('; ')}`)
  assert.ok(
    defects.some((e) => e.startsWith('correlationId:')),
    `correlationId must be named: ${defects.join('; ')}`,
  )
})

test('THE RULE: the envelope this relay builds is one the contract accepts', () => {
  // The check whose absence let this service relay nothing but refusals. `classifyEnvelope` is the
  // contract's own function and is literally what activity's ingest and notify run on a delivered
  // body — not a restatement of it here.
  for (const topic of topicsInSource()) {
    const built = buildEnvelope({ ...ROW, topic })
    assert.ok(built.ok, `${topic}: the relay would refuse its own envelope`)
    assert.deepEqual(
      envelopeDefects(JSON.parse(JSON.stringify(built.value))),
      [],
      `an event on ${topic} would be refused by every consumer in the estate`,
    )
  }
})

test('the version on the wire is "major.minor", never the stored integer', () => {
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  assert.equal(typeof built.value.version, 'string')
  assert.equal(built.value.version, '1.0')
  assert.equal(parseVersion(built.value.version).ok, true)
  assert.equal(parseVersion(String(ROW.version)).ok, false, 'the stored integer is NOT a wire version')
})

test('a row with no actor and no correlation id still makes a readable envelope', () => {
  // Both columns are nullable and both are refused by the contract if they arrive null.
  const built = buildEnvelope({ ...ROW, actor: null, correlation_id: null })
  assert.ok(built.ok)
  assert.equal(built.value.actor, 'system')
  assert.equal(built.value.correlationId, ROW.id)
})

test('the relay refuses a malformed row and permits a merely unregistered one', () => {
  // The distinction the `classifyEnvelope`-rather-than-`validateEnvelope` choice rests on: four of
  // this service's five topics are unregistered, so refusing on that basis would stop relaying four
  // topics that work.
  const proposed = buildEnvelope({ ...ROW, topic: 'mint.token.created' })
  assert.ok(proposed.ok, 'a proposed-but-unregistered topic must still be delivered')
  assert.equal(proposed.unregisteredTopic, 'mint.token.created')

  assert.equal(buildEnvelope({ ...ROW, key: '' }).ok, false, 'an empty key leaves ordering undefined')
  assert.equal(
    buildEnvelope({ ...ROW, producer: 'wallet' }).ok,
    false,
    'the topic namespace is the ownership boundary',
  )

  // A topic that is neither registered nor proposed is not excused by `envelopeDefects`.
  const unexplained = buildEnvelope({ ...ROW, topic: 'mint.nothing.happened' })
  assert.ok(unexplained.ok)
  assert.ok(envelopeDefects(JSON.parse(JSON.stringify(unexplained.value))).length > 0)
})

/* ------------------------------------------------------------------ who the event reaches */

/**
 * One emitted event, put through the relay exactly as it goes on the wire.
 *
 * The JSON round trip is not decoration: a field assigned `undefined` is INDISTINGUISHABLE from an
 * absent one after it, which is precisely how "the payload has a userId" can be true in a test and
 * false on the wire.
 */
function asDelivered(payload: Record<string, unknown>, actor = 'service:mint') {
  const built = buildEnvelope({ ...ROW, actor, payload })
  assert.ok(built.ok)
  return JSON.parse(JSON.stringify(built.value)) as {
    topic: string
    key: string
    actor: string
    payload: Record<string, unknown>
  }
}

test("the recipient readers can actually fail — yesterday's deploy payload reaches nobody", () => {
  // **THE TRAP AGAIN, on the half that the rename alone would NOT have fixed.** The payload carried
  // `ownerSubject`, which is `user:<uuid>` — a SUBJECT, not a user id. `activity` wants a bare uuid
  // under `userId` and `notify` wants `user_id`/`userId`, so both found nobody. A HIGH-priority
  // notification would have answered `no_recipient` for every deploy for ever, and nothing would
  // have logged an error: notify records "no recipient" as an ordinary outcome.
  const yesterday = asDelivered({
    tokenId: ROW.key,
    ownerSubject: `user:${OWNER}`,
    contractAddress: '0xabc',
    symbol: 'FOO',
  })
  assert.equal(activityRecipient(yesterday.payload), null, 'activity found nobody')
  assert.equal(notifyRecipient(yesterday), null, 'notify found nobody')

  // Nor is the KEY a way out, on the topic where it is most tempting: it is a uuid, and it is the
  // TOKEN. A reader that fell back to it would address a notification to a token id.
  assert.equal(topicSpec(DEPLOYED_TOPIC).keyedBy, 'token_id')
  assert.notEqual(ROW.key, OWNER)

  // Nor is the ACTOR: this emit is reached from a leased deploy job, so the actor is the service.
  assert.equal(yesterday.actor, 'service:mint')

  // And a subject in the userId field is refused rather than half-accepted — activity would drop it
  // while notify would keep it, which is one surface reaching a person and one not, off one payload.
  const subjectInTheWrongField = asDelivered({ tokenId: ROW.key, userId: `user:${OWNER}` })
  assert.equal(activityRecipient(subjectInTheWrongField.payload), null)
})

/**
 * A token row, complete enough for the real payload builder.
 *
 * The builder is called rather than a payload being written out here, because a hand-written payload
 * is a test agreeing with itself: it would keep passing on the day somebody deleted the `userId`
 * line from the emit. Verified by deleting it — this test goes red.
 */
const TOKEN = {
  id: ROW.key,
  ownerSubject: `user:${OWNER}`,
  ownerWalletId: '018f0000-0000-7000-8000-0000000000c9',
  ownerAddress: '0x00000000000000000000000000000000000000a1',
  chain: 'ember',
  network: 'testnet',
  standard: 'erc20',
  name: 'Foo Token',
  symbol: 'FOO',
  decimals: 18,
  supply: 1_000n,
  cap: null,
  features: [],
  metadataUri: null,
  brandKitId: null,
  status: 'deployed',
  priceShards: 10n,
  paidJournalEntryId: null,
  paidAt: null,
  deployerAddress: null,
  deployNonce: null,
  rawTx: null,
  custodyAuditId: null,
  deployTxHash: '0xhash',
  contractAddress: '0xabc',
  broadcastAt: null,
  confirmedAt: new Date('2026-08-03T10:00:00.000Z'),
  failureReason: null,
  leaseOwner: null,
  leaseUntil: null,
  deployAttempts: 1,
  createdAt: new Date('2026-08-03T09:00:00.000Z'),
  updatedAt: new Date('2026-08-03T09:00:00.000Z'),
} as unknown as TokenRecord

test('THE RULE: a confirmed deploy reaches the person whose contract it is', () => {
  // The REAL payload builder, not a payload restated here.
  const delivered = asDelivered(deployConfirmedPayload(TOKEN))
  assert.equal(activityRecipient(delivered.payload), OWNER, 'this deploy is in nobody’s feed')
  assert.equal(notifyRecipient(delivered), OWNER, 'this deploy notifies nobody')

  // Present on the WIRE, after the round trip, and a bare uuid — never a subject and never
  // `undefined`, which JSON drops and every reader then reads as "nobody".
  assert.ok(Object.hasOwn(delivered.payload, 'userId'))
  assert.equal(typeof delivered.payload['userId'], 'string')

  // The subject is kept alongside it rather than replaced: it is what the ledger and the ownership
  // check use, and an organisation-owned token has one of those and no user.
  assert.equal(delivered.payload['ownerSubject'], `user:${OWNER}`)

  // Both consumers render a name before falling back to the symbol. The column existed and simply
  // was not on the event, so every notification would have read "Your token".
  assert.equal(delivered.payload['name'], 'Foo Token')
  assert.equal(delivered.payload['contractAddress'], '0xabc')
})

/* ------------------------------------------------------------------ the delivery */

// GENERATED, never a committed literal. This used to be the estate's shared test fixture — 32
// characters but only 24 bytes — and `env.ts` now refuses it, so a fixture spelling it out would
// be signing with a value no deploy of this service can hold (micro-org #142).
const SECRET = randomBytes(48).toString('base64')

test('the delivery this relay signs is one a contract-following consumer verifies', () => {
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  const body = JSON.stringify(built.value)

  assert.equal(SIGNATURE_HEADER, 'cf-signature')
  assert.equal(EVENT_ID_HEADER, 'cf-event-id')
  assert.equal(verifyDelivery(body, signEvent(body, SECRET), [SECRET]).ok, true)
  assert.equal(verifyEventSignature(body, SECRET, signEvent(body, SECRET)), true)

  // The old scheme is not what this service produces any more, and a receiver of the new scheme does
  // not accept the old one — the two are genuinely different, not one renamed.
  const legacy = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
  assert.ok(!signEvent(body, SECRET).startsWith('sha256='))
  assert.match(signEvent(body, SECRET), /^t=\d+,v1=[0-9a-f]{64}$/)
  assert.equal(verifyDelivery(body, legacy, [SECRET]).ok, false)

  // Tampering, a wrong secret and an absent header are all refused.
  assert.equal(verifyEventSignature(`${body} `, SECRET, signEvent(body, SECRET)), false)
  assert.equal(
    verifyEventSignature(body, 'a-different-secret-that-is-long-enough', signEvent(body, SECRET)),
    false,
  )
  assert.equal(verifyEventSignature(body, SECRET, ''), false)
})

test('the signature carries a timestamp, so a captured delivery is not a permanent credential', () => {
  // What the old scheme could not do at all: its MAC covered the body alone, so a delivery captured
  // once was replayable for ever.
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  const body = JSON.stringify(built.value)
  const signature = signEvent(body, SECRET)
  const now = Date.now()

  assert.equal(verifyDelivery(body, signature, [SECRET], { now }).ok, true)
  const stale = verifyDelivery(body, signature, [SECRET], { now: now + 600_000 })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok === false && stale.reason, 'stale')

  // And the timestamp cannot be moved without invalidating the MAC.
  const moved = signature.replace(/^t=\d+/, `t=${Math.floor((now + 600_000) / 1000)}`)
  assert.equal(verifyDelivery(body, moved, [SECRET], { now: now + 600_000 }).ok, false)
})

/* ------------------------------------------------------------------ reachability */

/**
 * A guard that proves a topic name is correct proves nothing about whether the emit is reached.
 *
 * `identity/src/sessions.ts` exports `emitSessionRevoked` and NOTHING CALLS IT — so
 * `identity.session.revoked` is produced by dead code while identity's own guard passes, because it
 * scans literals rather than reachability.
 */
function unreachedEmitters(files: readonly { name: string; text: string }[]): readonly string[] {
  const declared: { symbol: string; where: string }[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      const match = /^export (?:async )?function (emit[A-Za-z0-9_]*)/.exec(line)
      if (match?.[1]) declared.push({ symbol: match[1], where: `${file.name}:${index + 1}` })
    })
  }
  return declared
    .filter(({ symbol }) => {
      const reference = new RegExp(`\\b${symbol}\\b`)
      for (const file of files) {
        for (const line of file.text.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
          if (/^export (?:async )?function /.test(trimmed)) continue
          if (reference.test(line)) return false
        }
      }
      return true
    })
    .map(({ symbol, where }) => `${symbol} (${where})`)
    .sort()
}

test('the unreachable-emitter detector can actually fail', () => {
  const dead = [{ name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' }]
  assert.deepEqual(unreachedEmitters(dead), ['emitSessionRevoked (sessions.ts:1)'])

  const alive = [
    { name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' },
    { name: 'server.ts', text: 'emitSessionRevoked()\n' },
  ]
  assert.deepEqual(unreachedEmitters(alive), [])
})

test('every exported emitter is reached from somewhere', () => {
  assert.deepEqual(
    unreachedEmitters(sourceFiles().map((name) => ({ name, text: readFileSync(name, 'utf8') }))),
    [],
    'exported, emits an event, and no code path reaches it — the topic is produced by dead code',
  )
})

/**
 * A topic CONSTANT that is declared and never used to emit anything.
 *
 * The gap between the two checks above, and it is a real one: the literal scanner reads names out of
 * `src/`, so `export const DEPLOYED_TOPIC = 'mint.deploy.confirmed'` satisfies it whether or not any
 * emit site references the constant. Delete the `emit(...)` call and the name check stays green.
 * Written after breaking micro-ledger's fix exposed exactly that hole.
 */
function unusedTopicConstants(files: readonly { name: string; text: string }[]): readonly string[] {
  const topicLiteral = new RegExp(`^export const ([A-Z][A-Z0-9_]*) = '${SERVICE}\\.[a-z0-9_]+\\.[a-z0-9_]+'`)
  const declared: { symbol: string; where: string }[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      const match = topicLiteral.exec(line)
      if (match?.[1]) declared.push({ symbol: match[1], where: `${file.name}:${index + 1}` })
    })
  }
  return declared
    .filter(({ symbol }) => {
      const reference = new RegExp(`\\b${symbol}\\b`)
      for (const file of files) {
        for (const line of file.text.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
          if (topicLiteral.test(line)) continue
          if (reference.test(line)) return false
        }
      }
      return true
    })
    .map(({ symbol, where }) => `${symbol} (${where})`)
    .sort()
}

test('the unused-topic-constant detector can actually fail', () => {
  const dead = [{ name: 'a.ts', text: `export const T = '${SERVICE}.thing.happened'\n` }]
  assert.deepEqual(unusedTopicConstants(dead), ['T (a.ts:1)'])

  // A reference from a COMMENT does not count — that is how a guard passes because its own prose
  // names the thing it is checking.
  const prose = [
    { name: 'a.ts', text: `export const T = '${SERVICE}.thing.happened'\n` },
    { name: 'b.ts', text: '// T is emitted somewhere, honest\n' },
  ]
  assert.deepEqual(unusedTopicConstants(prose), ['T (a.ts:1)'])

  const alive = [
    { name: 'a.ts', text: `export const T = '${SERVICE}.thing.happened'\n` },
    { name: 'b.ts', text: 'emit({ topic: T, key: row.id, payload: {} })\n' },
  ]
  assert.deepEqual(unusedTopicConstants(alive), [])
})

test('every topic constant is referenced by something that emits', () => {
  assert.deepEqual(
    unusedTopicConstants(emitSourceFiles().map((name) => ({ name, text: readFileSync(name, 'utf8') }))),
    [],
    'declared, registered, and no emit site references it — the topic is a name and nothing more',
  )
})

test('an organisation-owned token names nobody, rather than guessing a member', () => {
  // The safe direction, and it has to be deliberate rather than accidental. A token whose owner is
  // an organisation has no single user; inventing one would put somebody else's deploy in a member's
  // feed. `activity` resolves a null to "no user" and files the record internal, which is honest.
  const org = deployConfirmedPayload({
    ...TOKEN,
    ownerSubject: 'organisation:018f0000-0000-7000-8000-0000000000e1',
  } as unknown as TokenRecord)
  assert.equal(org['userId'], null)
  assert.equal(activityRecipient(asDelivered(org).payload), null)

  // And a subject this service cannot parse is "no person" rather than a thrown error: the deploy
  // has already confirmed on chain, the money is spent and the contract exists, so refusing to
  // record it would be the worst possible response.
  const nonsense = deployConfirmedPayload({ ...TOKEN, ownerSubject: 'not-a-subject' } as unknown as TokenRecord)
  assert.equal(nonsense['userId'], null)
})
