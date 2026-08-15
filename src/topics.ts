/**
 * The producer half of the bus contract: what this service puts on the wire, and whether the estate
 * can read it.
 *
 * ## The defect this file exists to close
 *
 * Every consumer in the estate is pinned to `@cloudsforge/contracts-events`. `activity` declares its
 * classifier table `satisfies Readonly<Record<TopicName, _>>`; `notify` asserts it has a rule for
 * every registry topic. **The producer was pinned to nothing at all** — not to the topic names,
 * not to the shape of the envelope it wrote them into, and not to whether the event named the person
 * it was about.
 *
 * Three instances of that one class were live here at once, and together they mean nothing this
 * service emitted has ever reached anyone:
 *
 *   - **A topic renamed on the wire.** The registry owns `mint.deploy.confirmed`, one of the eight
 *     FIRST topics of 02-target-architecture §5; this service emitted `mint.token.deployed`.
 *     `notify/src/catalogue.ts` (priority HIGH), `activity/src/classify.ts` and
 *     `analytics/src/catalogue.ts` all read the registered name, so all three were dead code and
 *     the ForgeMint client kept polling every four seconds — the exact cost `notify`'s own rule
 *     records as the reason the topic exists. Nothing anywhere read the name this service used.
 *   - **An envelope the contract refuses.** `version` went out as the integer `1` where the contract
 *     types it "major.minor", and the relay passed the nullable `actor` and `correlation_id` columns
 *     through untouched. `validateEnvelope` refuses all three, so even a correctly-signed delivery
 *     was thrown away before anything read a payload.
 *   - **A signature scheme drifted from the contract.** A local `sha256=<hmac>` under a local
 *     `x-cloudsforge-signature`, where the contract signs `t=…,v1=…` under `cf-signature`.
 *
 * And one that is none of those three and matters as much: **the event named nobody.** The payload
 * carried `ownerSubject` (`user:<uuid>`), and every reader in the estate wants a bare uuid under
 * `userId`. A renamed topic whose envelope is valid and whose recipient is null is a HIGH-priority
 * notification answering `no_recipient` for ever. That half is fixed at the emit site, in
 * `tokens.ts`, with the reasoning beside it.
 *
 * So this file pins the producer, in both directions and two ways:
 *
 *   1. **At compile time.** `EnvelopeCandidate` in `outbox.ts` types `version` as the contract's
 *      `EventVersion` and actor/correlationId as non-nullable, so all three envelope defects are
 *      type errors — which is `pnpm typecheck`, which is the build.
 *   2. **At test time, against the source rather than against this list.** `topics.test.ts` reads
 *      every topic literal out of `src/` and reconciles that set with the registry IN BOTH
 *      DIRECTIONS, and it builds a real envelope through the relay's own `buildEnvelope` and hands
 *      it to the contract's own `classifyEnvelope`. A test that compared this list with the registry
 *      would agree with itself for ever while the emit sites drifted underneath it — which is
 *      exactly what happened.
 */

import {
  classifyEnvelope,
  isRegisteredTopic,
  isValidTopicName,
  topicSpec,
  topicsProducedBy,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import {
  BROADCAST_TOPIC,
  CREATED_TOPIC,
  DEPLOYED_TOPIC,
  FAILED_TOPIC,
  FUNDING_REQUESTED_TOPIC,
  PAID_TOPIC,
} from './tokens.ts'

/** This service's own name, and the namespace it is the only permitted producer under. */
export const SERVICE = 'mint'

/**
 * Every topic this service emits.
 *
 * The constants are imported from the module that declares them rather than redeclared, so this list
 * cannot name a topic whose spelling has since changed under it. `topics.test.ts` additionally reads
 * the literals back out of `src/`, so it cannot name one that no emit site produces either.
 */
export const EMITTED_TOPICS = Object.freeze([
  CREATED_TOPIC,
  PAID_TOPIC,
  BROADCAST_TOPIC,
  DEPLOYED_TOPIC,
  FAILED_TOPIC,
  FUNDING_REQUESTED_TOPIC,
] as const)

export interface ProposedTopic {
  /** Why the fact belongs on the bus at all. Read by a human reviewing the contracts change. */
  readonly reason: string
  /** The entry to add to `TOPICS` in `@cloudsforge/contracts-events`, verbatim. */
  readonly spec: TopicSpec
}

/**
 * Topics this service emits that the shared registry does not yet name.
 *
 * A quarantine, not an exemption, with three properties that keep it honest:
 *
 *   - An entry carries the exact `TopicSpec` it is asking for, so adopting it into
 *     `contracts/packages/events/src/index.ts` is a copy rather than a fresh design.
 *   - `topics.test.ts` asserts every entry is **genuinely absent** from the registry. The moment
 *     contracts registers one, this file fails until the entry is deleted — so the quarantine
 *     empties itself rather than rotting into a permanent allow-list.
 *   - An emit site whose topic is in neither the registry nor here fails the test.
 *
 * `keyedBy` on each is read off the emit site, never chosen here: all six are keyed by the token id
 * (`tokens.ts`), which is what the registry already says for `mint.deploy.confirmed` and
 * `mint.deploy.funding_requested` and is therefore the whole family's partition.
 *
 * ## Why these four are PROPOSED rather than deleted
 *
 * A deploy has a lifecycle and this is it: created, paid, broadcast, then confirmed or failed. The
 * registered topic is the terminal SUCCESS, and `notify` deliberately notifies only on that one. The
 * other four are the states a project page and an operator need, and `mint.token.failed` is the one
 * a person most needs and nothing currently tells them — a deploy that failed after broadcast has
 * spent the customer's gas. That is a `notify` rule that cannot be written until the topic is
 * registered, so the proposals are the first step rather than a formality.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({
  [CREATED_TOPIC]: {
    reason:
      'A token order exists and is awaiting payment. The project page renders from this rather than polling, and analytics needs the top of the token-creation funnel (metric 8) — without it the funnel has a denominator nobody can measure.',
    spec: Object.freeze({
      producer: SERVICE,
      payloadType: 'TokenCreated',
      version: '1.0',
      keyedBy: 'token_id',
      description: 'A token order was created and is awaiting payment.',
    }),
  },
  [PAID_TOPIC]: {
    reason:
      'The ledger entry paying for the deploy exists, written in the same transaction as the status change. It is the handover between billing and deployment and the point after which a refund is a reversal rather than a cancellation.',
    spec: Object.freeze({
      producer: SERVICE,
      payloadType: 'TokenPaid',
      version: '1.0',
      keyedBy: 'token_id',
      description: 'A token order was paid for, naming the journal entry that paid.',
    }),
  },
  [BROADCAST_TOPIC]: {
    reason:
      'The signed transaction is on the network and the contract address is already DERIVED, so a client can start watching the chain for it instead of waiting for a receipt. This is half of what retires the four-second poll; mint.deploy.confirmed is the other half.',
    spec: Object.freeze({
      producer: SERVICE,
      payloadType: 'TokenBroadcast',
      version: '1.0',
      keyedBy: 'token_id',
      description: 'A deploy transaction was broadcast, carrying its hash and derived address.',
    }),
  },
  [FAILED_TOPIC]: {
    reason:
      'A deploy failed terminally, carrying whether it was broadcast first — which is whether the customer paid gas for nothing. It is the one event here a person most needs and nothing tells them: mint.deploy.confirmed has a HIGH-priority notify rule and there is no failure twin, which is the settlement.outbound.failed gap in a second service. The payload names the owner, so a rule is writable the day this is registered.',
    spec: Object.freeze({
      producer: SERVICE,
      payloadType: 'TokenDeployFailed',
      version: '1.0',
      keyedBy: 'token_id',
      description: 'A deploy failed terminally, flagging whether it had been broadcast first.',
    }),
  },
})

/**
 * The ordering partition each emitted topic uses.
 *
 * **`key` IS THE ORDERING PARTITION, SO IT IS CONTRACT AND NOT A PRODUCER'S PREFERENCE.** Events
 * sharing a `(topic, key)` are delivered in the order they were written and no other pair has any
 * ordering relationship whatsoever. The token id is right for the whole family: one token's
 * lifecycle stays in order, and two tokens do not serialise against each other.
 */
export const KEYED_BY: Readonly<Record<string, string>> = Object.freeze({
  [CREATED_TOPIC]: 'token_id',
  [PAID_TOPIC]: 'token_id',
  [BROADCAST_TOPIC]: 'token_id',
  [DEPLOYED_TOPIC]: 'token_id',
  [FAILED_TOPIC]: 'token_id',
  // The token, not the deployer address, even though the address is what gets funded. The address
  // is minted per order and belongs to exactly one token, so keying by it would partition the same
  // way while giving settlement a key it cannot join back to an order.
  [FUNDING_REQUESTED_TOPIC]: 'token_id',
})

/* ------------------------------------------------------------------ reconciliation */

/** Topics this service emits that no registry names and no proposal explains — always a defect. */
export function undeclaredTopics(emitted: readonly string[]): readonly string[] {
  return emitted
    .filter((topic) => !isRegisteredTopic(topic) && !Object.hasOwn(AWAITING_REGISTRATION, topic))
    .sort()
}

/**
 * Registry topics this service owns and never emits — a feature that can never fire.
 *
 * **THE DIRECTION THIS REPOSITORY WAS WRONG IN.** The registry has said `mint` produces
 * `mint.deploy.confirmed` since before this service existed, and this service emitted
 * `mint.token.deployed`, so notify's HIGH-priority rule, activity's classifier and analytics'
 * metrics 8 and 9 were all dead code. Nothing breaks and nothing logs when a topic is missing — the
 * consumer simply never hears from it, and the client keeps polling.
 */
export function unemittedOwnedTopics(emitted: readonly string[]): readonly TopicName[] {
  const seen = new Set(emitted)
  return topicsProducedBy(SERVICE).filter((topic) => !seen.has(topic))
}

/** Proposals the registry has since adopted. Non-empty means delete the entry from the quarantine. */
export function adoptedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION).filter(isRegisteredTopic).sort()
}

/** A proposal that could not be pasted into the registry as it stands. */
export function malformedProposals(): readonly string[] {
  return Object.entries(AWAITING_REGISTRATION)
    .filter(([topic, proposal]) => {
      if (!isValidTopicName(topic) || !topic.startsWith(`${SERVICE}.`)) return true
      if (proposal.spec.producer !== SERVICE) return true
      if (proposal.spec.keyedBy.trim() === '') return true
      if (proposal.reason.trim().length < 20) return true
      return false
    })
    .map(([topic]) => topic)
    .sort()
}

/* ------------------------------------------------------------------ the envelope */

/**
 * Every reason a contract-following consumer would refuse this envelope.
 *
 * The check itself is `classifyEnvelope`, and it is the contract's — the exact check `activity`'s
 * ingest and `notify` run on a delivered body. Running it here, on an envelope this service's relay
 * actually built, is the only way a producer finds out it is unreadable without waiting for two
 * services to be composed. Composing two services is how the integer-version defect was found, and
 * it was found months late.
 *
 * `classifyEnvelope` rather than the contract's own `envelopeDefects(value, awaiting)` wrapper, for
 * the reason `settlement/src/topics.ts` records: `unregisteredTopic` is a FIELD on the verdict, not
 * a sentence in a list, so there is nothing here for a future flattening to drop. Five repositories
 * previously matched the contract's error SENTENCE byte for byte and would all have stopped excusing
 * anything the day it was reworded.
 *
 * What this file decides and the contract cannot: **which** unregistered topics are excused — the
 * four `AWAITING_REGISTRATION` proposes, and nothing else.
 */
export function envelopeDefects(envelope: unknown): readonly string[] {
  const verdict = classifyEnvelope(envelope)
  // Reported FIRST, where `validateEnvelope` has always put it, so a reader of a failure sees the
  // registry question before the envelope's own faults.
  const unexplained =
    verdict.unregisteredTopic !== null &&
    !Object.hasOwn(AWAITING_REGISTRATION, verdict.unregisteredTopic)
      ? [
          `topic: "${verdict.unregisteredTopic}" is not in the registry, and AWAITING_REGISTRATION does not propose it`,
        ]
      : []
  return [...unexplained, ...verdict.defects]
}

/* ------------------------------------------------------------------ the person */

/**
 * The user a delivered event names, answered the way the ESTATE answers it.
 *
 * **A test that asserts `payload.userId === '…'` is weaker than this and would pass the day before
 * the fix if the field were spelled `owner` or `ownerId`** — or if the real readers wanted a shape
 * this service does not send. So the readers themselves are restated here, from their source, and
 * `topics.test.ts` runs them over the bytes the relay produces.
 *
 * Both consumers are modelled because they disagree in a way that matters:
 *
 *   - `activity/src/classify.ts` takes ONLY a bare uuid under `userId`. A `user:<uuid>` subject
 *     is not a user id to it.
 *   - `notify/src/catalogue.ts` takes `user_id` or `userId`, then falls back to the envelope key
 *     when the REGISTRY keys the topic by `user_id` — `mint.deploy.confirmed` is keyed by `token_id`,
 *     so that arm never fires here and a token id can never be mistaken for a person — and finally
 *     to an actor of `user:<id>`.
 *
 * The actor arm is why the fix had to be a payload field rather than an actor: this emit is reached
 * from a leased deploy job, so the actor is `service:mint` and notify's last resort finds nothing.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `activity`'s reader: a bare uuid under `userId`, or nobody. */
export function activityRecipient(payload: Record<string, unknown>): string | null {
  const value = payload['userId']
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

/** `notify`'s reader, including both fallbacks, so neither can silently rescue a bad payload. */
export function notifyRecipient(event: {
  readonly topic: string
  readonly key: string
  readonly actor: string
  readonly payload: Record<string, unknown>
}): string | null {
  for (const name of ['user_id', 'userId']) {
    const value = event.payload[name]
    if (typeof value === 'string' && value !== '') return value
  }
  if (isRegisteredTopic(event.topic) && keyedByUserId(event.topic) && event.key) return event.key
  if (event.actor.startsWith('user:')) return event.actor.slice('user:'.length) || null
  return null
}

/**
 * Answered from the REGISTRY rather than from a list here, because that is where notify reads it —
 * a topic this service later keyed by a user would gain the fallback automatically, and none of
 * today's does.
 */
function keyedByUserId(topic: TopicName): boolean {
  return topicSpec(topic).keyedBy === 'user_id'
}
