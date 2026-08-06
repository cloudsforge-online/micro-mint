/**
 * Right to erasure — GDPR Art. 17, and rule 6 of docs/ecosystem/03 §2.
 *
 * Every service that stores a `user_id` subscribes to `identity.user.deleted` and erases. This
 * service did not, so a deletion request answered success and left every order, every project page
 * and every event payload exactly where it was.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A DEPLOYED TOKEN IS ON A PUBLIC BLOCKCHAIN AND CANNOT BE UN-DEPLOYED.** That single fact is
 * what splits this decision, and the split is the design. A token that never reached a chain has
 * no artefact and no issuance to account for, so it goes. A token that did is a thing this
 * platform performed, paid gas for, and must be able to account for.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ┌────────────────────────────┬───────────────┬──────────────────────────────────────────────────
 * │ table                      │ action        │ reasoning, and the lawful basis if retained
 * ├────────────────────────────┼───────────────┼──────────────────────────────────────────────────
 * │ tokens                     │ DELETE the    │ No transaction hash means custody never signed
 * │   deploy_tx_hash IS NULL   │ row           │ bytes for it, so nothing was broadcast, nothing
 * │                            │               │ was created and no gas was spent. There is no
 * │                            │               │ on-chain artefact to reconcile against and no
 * │                            │               │ issuance for this platform to have records of.
 * │                            │               │ Nothing is retained, so no basis is needed and
 * │                            │               │ none is claimed. An order that was PAID FOR and
 * │                            │               │ never deployed goes too: the money record lives
 * │                            │               │ in micro-ledger under its own retention rule,
 * │                            │               │ and paid_journal_entry_id here is a pointer at
 * │                            │               │ that record, not the record.
 * ├────────────────────────────┼───────────────┼──────────────────────────────────────────────────
 * │ tokens                     │ ANONYMISE     │ Retained under Art. 17(3)(b), a legal obligation:
 * │   deploy_tx_hash NOT NULL  │ owner_subject │ these are this platform's own records of a token
 * │                            │ owner_wallet  │ issuance it carried out and paid gas for, and it
 * │                            │ _id.          │ is required to keep them for financial-crime and
 * │                            │               │ tax purposes. That is the basis, and it is the
 * │                            │ RETAIN        │ only one claimed here.
 * │                            │ owner_address │
 * │                            │ deploy_tx_    │ A SUPPORTING argument, and explicitly not the
 * │                            │ hash          │ basis: owner_address and deploy_tx_hash are
 * │                            │ contract_     │ published immutably on a public chain, so erasing
 * │                            │ address       │ our copy would erase nothing. True, but "it is
 * │                            │ name, symbol, │ already public" is not a lawful basis for us to
 * │                            │ supply, cap   │ keep processing it, and stating it as one would
 * │                            │               │ be the overstatement this block exists to avoid.
 * │                            │               │
 * │                            │               │ owner_subject and owner_wallet_id are NOT covered
 * │                            │               │ by that basis. They are the link from an on-chain
 * │                            │               │ artefact back to an account holder, and the
 * │                            │               │ issuance record is complete without them.
 * ├────────────────────────────┼───────────────┼──────────────────────────────────────────────────
 * │ project_pages              │ DELETE,       │ User-authored marketing copy: description, team,
 * │                            │ uncondition-  │ roadmap, links, risk_disclosures. Free text that
 * │                            │ ally, on BOTH │ can carry personal data about the erased user AND
 * │                            │ branches      │ about named third parties who never asked this
 * │                            │               │ platform for anything. No retention basis reaches
 * │                            │               │ any of it — it is not part of the issuance
 * │                            │               │ record, and the contract on chain is unaffected
 * │                            │               │ by its removal. Deleting a retained token's page
 * │                            │               │ takes a live public page off the internet, which
 * │                            │               │ is inconvenient and is not a reason.
 * ├────────────────────────────┼───────────────┼──────────────────────────────────────────────────
 * │ token_deploy_attempts      │ RETAIN, bound │ Carries no user identifier: token_id, attempt,
 * │                            │ to whichever  │ family, outcome, tx_hash, detail. The rows for
 * │                            │ token rows    │ deleted tokens go by ON DELETE CASCADE, so what
 * │                            │ survive.      │ survives is attached to a retained issuance and
 * │                            │               │ shares its basis — it is the evidence of what was
 * │                            │ REDACT the    │ signed and broadcast.
 * │                            │ wallet id out │
 * │                            │ of `detail`   │ `detail` is the exception and it is not
 * │                            │               │ theoretical: it is err.message from custody or a
 * │                            │               │ chain node (deploy.ts,141,155,336), free text
 * │                            │               │ this service does not author. A custody refusal
 * │                            │               │ can echo the wallet id back. Leaving it there
 * │                            │               │ would undo the anonymisation of owner_wallet_id
 * │                            │               │ one table across, so the wallet id is replaced
 * │                            │               │ with the placeholder in place. The rest of the
 * │                            │               │ message is kept: it is what triage reads. An
 * │                            │               │ address surviving in `detail` is covered by the
 * │                            │               │ retained row's own basis, which keeps
 * │                            │               │ owner_address anyway.
 * ├────────────────────────────┼───────────────┼──────────────────────────────────────────────────
 * │ outbox                     │ REDACT        │ THE TABLE THAT IS EASY TO MISS, AND IT STORES THE
 * │                            │ payload       │ USER ID. The payloads of mint.token.created,
 * │                            │ .ownerSubject │ mint.token.paid, mint.deploy.confirmed and
 * │                            │ payload       │ mint.token.failed each carry ownerSubject
 * │                            │ .userId       │ ('user:<uuid>'); the confirmed payload also
 * │                            │ actor         │ carries a bare userId (tokens.ts) and the
 * │                            │               │ `actor` column is 'user:<uuid>'
 * │                            │               │ (server.ts). Nothing prunes this table, so
 * │                            │               │ every one of those is kept for ever. An erasure
 * │                            │               │ that emptied `tokens` and left the outbox would
 * │                            │               │ be an erasure in name.
 * │                            │               │
 * │                            │               │ Redacted rather than deleted, because an outbox
 * │                            │               │ row is the durable record that an event was
 * │                            │               │ emitted, and an unpublished row for a RETAINED
 * │                            │               │ token is a delivery other services are still
 * │                            │               │ owed. Redaction removes the personal data and
 * │                            │               │ keeps the emission; a redacted unpublished event
 * │                            │               │ relays naming nobody, which is what a consumer's
 * │                            │               │ own null-user path already handles (topics.ts).
 * ├────────────────────────────┼───────────────┼──────────────────────────────────────────────────
 * │ inbox, outbox_deliveries,  │ UNTOUCHED     │ (topic, event_id) pairs, delivery counters and
 * │ event_subscriptions, jobs  │               │ subscription URLs. Checked, not assumed: the only
 * │                            │               │ job this service enqueues carries { tokenId }
 * │                            │               │ (server.ts) — a token id, not a user id — and
 * │                            │               │ a claim for a token that has just been deleted
 * │                            │               │ finds no row and completes. The whole-row scan in
 * │                            │               │ erasure.test.ts covers all four, so a column
 * │                            │               │ added to any of them later is caught.
 * └────────────────────────────┴───────────────┴──────────────────────────────────────────────────
 *
 * ## The placeholder
 *
 * ONE random `erased:<uuid>` per erasure, from `randomUUID()`. Random, never derived: a hash of a
 * user id — keyed or not — is brute-forceable over a candidate list, because the candidates are
 * exactly the uuids of the users this platform has, and a keyed hash only moves the problem to
 * whoever holds the key. Nothing stores the mapping, here or anywhere, so there is nothing to
 * compel and nothing to leak.
 *
 * Using ONE placeholder across that user's retained rows leaves those rows linked to each other.
 * That is unavoidable if they are retained at all — they are already linked through their shared
 * gas payer and their block times — and it is linkage to no person, which is the property that
 * matters. The alternative, a fresh uuid per row, buys nothing and would make an operator unable
 * to see that four retained issuances were one erasure.
 */

import { randomUUID } from 'node:crypto'
import { userSubject } from '@cloudsforge/contracts-money'
import type { Tx } from './outbox.ts'

/** What an erasure did, for the log line and for the tests. Counts only — never a value. */
export interface ErasureOutcome {
  readonly tokensDeleted: number
  readonly tokensAnonymised: number
  readonly projectPagesDeleted: number
  readonly attemptDetailsRedacted: number
  readonly outboxRowsRedacted: number
}

/**
 * The erased owner's shape, as the schema pins it — see migration 7.
 *
 * Exported so a test asserts against the same regular expression the database does, rather than
 * against a second copy that can drift away from it.
 */
export const ERASED_SUBJECT =
  /^erased:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Erase one user, inside the caller's transaction.
 *
 * Takes a `Tx` and not a `Db` on purpose: this runs under `withInbox`, so the inbox row that makes
 * the event effectively-once and every write below commit together. Splitting them would let a
 * crash halfway leave a user half-erased and the event marked handled — the one outcome that
 * cannot be recovered from, because the redelivery never comes.
 */
export async function eraseUser(tx: Tx, userId: string): Promise<ErasureOutcome> {
  // The event carries a BARE UUID; this service stores the LEDGER SPELLING, 'user:<uuid>'
  // (migrations.ts). Converted with the contract's own helper rather than by concatenating a
  // string, so the spelling the erasure looks for and the spelling the write path produces
  // (server.ts, 514 — both `userSubject`) are the same function and cannot drift. It also
  // rejects a malformed id rather than composing a subject that quietly matches nothing, which is
  // the failure mode where an erasure reports success and erases zero rows.
  const subject = userSubject(userId)

  const placeholder = `erased:${randomUUID()}`

  // Ordered so that no step depends on a cascade for its correctness.
  //
  // Pages go FIRST, and by the owner of their token rather than by their own `subject` column, so
  // both branches are covered by one statement: the pages of tokens about to be deleted (which the
  // cascade would also have taken) and the pages of tokens about to be retained (which it would
  // not). `subject` is matched as well, because it is a separate copy of the same identity and a
  // page whose token changed hands would otherwise keep it.
  const pages = await tx<{ id: string }[]>`
    delete from project_pages
     where subject = ${subject}
        or token_id in (select id from tokens where owner_subject = ${subject})
    returning id
  `

  // The retained set, read BEFORE the anonymisation so the old wallet id is still available to
  // redact out of the attempt details. `for update` because the deploy job writes these rows.
  const retained = await tx<{ id: string; owner_wallet_id: string }[]>`
    select id, owner_wallet_id
      from tokens
     where owner_subject = ${subject}
       and deploy_tx_hash is not null
     for update
  `

  let attemptDetailsRedacted = 0
  for (const token of retained) {
    const redacted = await tx<{ id: string }[]>`
      update token_deploy_attempts
         set detail = replace(detail, ${token.owner_wallet_id}, ${placeholder})
       where token_id = ${token.id}
         and detail is not null
         and position(${token.owner_wallet_id} in detail) > 0
      returning id
    `
    attemptDetailsRedacted += redacted.length
  }

  const anonymised = await tx<{ id: string }[]>`
    update tokens
       set owner_subject = ${placeholder},
           owner_wallet_id = ${placeholder},
           updated_at = now()
     where owner_subject = ${subject}
       and deploy_tx_hash is not null
    returning id
  `

  // Everything with no transaction hash. `token_deploy_attempts` goes with it by ON DELETE CASCADE
  // (migrations.ts) — relied on here, and proved rather than assumed in erasure.test.ts.
  //
  // The predicate is `deploy_tx_hash is null` and NOT `broadcast_at is null`, and the difference is
  // the window this whole repository is built around. A row with a hash but no broadcast_at has had
  // its bytes SIGNED and committed (tokens.ts records the hash at signing), and `resumeIfSigned`
  // exists precisely because those bytes may already be on a wire with the broadcast not yet
  // recorded. Deleting there is the frozen service's double-deploy defect wearing a GDPR hat: it
  // destroys the only record that a contract may exist. A hash means "this may be on a chain", and
  // that is the line.
  const deleted = await tx<{ id: string }[]>`
    delete from tokens
     where owner_subject = ${subject}
       and deploy_tx_hash is null
    returning id
  `

  // The outbox. Three statements rather than one clever one, because each is separately readable
  // and separately testable; the pre-read is what makes the count a count of ROWS rather than of
  // matches, since a row can satisfy more than one of them.
  const touched = await tx<{ id: string }[]>`
    select id from outbox
     where payload ->> 'ownerSubject' = ${subject}
        or payload ->> 'userId' = ${userId}
        or actor = ${subject}
     for update
  `
  await tx`
    update outbox
       set payload = jsonb_set(payload, '{ownerSubject}', to_jsonb(${placeholder}::text))
     where payload ->> 'ownerSubject' = ${subject}
  `
  // JSON null, not the placeholder: `userId` is a BARE uuid on the wire and every reader in the
  // estate parses it as one (activity's classifier, notify's userIdOf). Writing 'erased:<uuid>'
  // there would be a malformed user id rather than an absent one. Null is the value this payload
  // already carries when the owner is not a person (tokens.ts), so every consumer's null path
  // is the one that already exists.
  await tx`
    update outbox
       set payload = jsonb_set(payload, '{userId}', 'null'::jsonb)
     where payload ->> 'userId' = ${userId}
  `
  await tx`update outbox set actor = ${placeholder} where actor = ${subject}`

  return {
    tokensDeleted: deleted.length,
    tokensAnonymised: anonymised.length,
    projectPagesDeleted: pages.length,
    attemptDetailsRedacted,
    outboxRowsRedacted: touched.length,
  }
}
