/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **Expand/contract is not advice.** A rolling deploy always runs two versions of this service
 * against one schema, so every change is four releases: add a column, deploy code that writes
 * both, backfill, deploy code that reads the new one, then drop the old one.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 4" means. The fix for a wrong migration is always a new migration.
 *
 * ---------------------------------------------------------------------------------------------
 * **THREE CONSTRAINTS IN VERSION 4 ARE THE POINT OF THIS FILE**, and each one makes a defect of
 * the frozen service impossible rather than merely unlikely:
 *
 *   `tokens_broadcast_has_hash`     A row with a `broadcast_at` must carry a `deploy_tx_hash`.
 *                                   The frozen Solana path calls `deploySplToken` with no
 *                                   `onBroadcast`, so a broadcast that loses the confirmation race
 *                                   records failure with a NULL hash — and the lease then re-claims
 *                                   and mints a second time, paying rent and gas twice with no
 *                                   record of the first. Here that write cannot commit.
 *
 *   `tokens_terminal_is_complete`   A `deployed` row must carry both a contract address and a
 *                                   transaction hash, and a `failed` row must carry a reason. A
 *                                   terminal state that says nothing about why is the state an
 *                                   operator cannot act on.
 *
 *   `tokens_deploy_tx_hash_uniq`    One transaction hash belongs to at most one token. If two rows
 *                                   ever claim one deploy, the second write fails rather than
 *                                   quietly overwriting the evidence of the first.
 * ---------------------------------------------------------------------------------------------
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs table
    // missing the (kind, key) unique constraint, which silently turns every recurring enqueue into
    // a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'tokens',
    up: `
      create table if not exists tokens (
        id                    uuid        primary key default gen_random_uuid(),

        -- 04-domain-model §5.2. The subject is the ledger's spelling ('user:<uuid>'), so the
        -- entry that pays for a deploy needs no translation at the point it is posted.
        owner_subject         text        not null,
        owner_wallet_id       text        not null,
        -- THE CONTRACT OWNER, and never the platform. The frozen service gets this right and it
        -- is the single most important thing carried forward: the customer's own wallet owns the
        -- contract, and the platform deployer below only pays the gas.
        owner_address         text        not null,

        chain                 text        not null,
        network               text        not null,
        standard              text        not null default 'erc20',

        name                  text        not null,
        symbol                text        not null,
        decimals              integer     not null,
        -- numeric(78,0), not text and never a float. 2^256 is 78 digits, so this holds any
        -- smallest-unit quantity an EVM chain can express and the database enforces the
        -- arithmetic. The frozen schema stores these as TEXT.
        supply                numeric(78,0) not null,
        cap                   numeric(78,0),
        features              text[]      not null default '{}',
        metadata_uri          text,
        brand_kit_id          uuid,

        status                text        not null default 'draft',

        -- Payment. The entry id is written in the SAME transaction as the move to 'paid'; see
        -- orders.ts for why the ledger call sits inside that transaction.
        price_shards          numeric(78,0) not null,
        paid_journal_entry_id text,
        paid_at               timestamptz,

        -- The chain attempt.
        deployer_address      text,
        deploy_nonce          bigint,
        raw_tx                text,
        custody_audit_id      text,
        deploy_tx_hash        text,
        contract_address      text,
        broadcast_at          timestamptz,
        confirmed_at          timestamptz,
        failure_reason        text,

        -- The lease. A single conditional UPDATE ... RETURNING claims it; see claimDeploy.
        lease_owner           text,
        lease_until           timestamptz,
        deploy_attempts       integer     not null default 0,

        created_at            timestamptz not null default now(),
        updated_at            timestamptz not null default now(),

        constraint tokens_status_known check (status in (
          'draft','awaiting_payment','paid','provisioning','awaiting_funds','deploying',
          'deployed','failed'
        )),
        constraint tokens_network_known check (network in ('mainnet','testnet')),
        constraint tokens_decimals_sane check (decimals between 0 and 36),
        constraint tokens_supply_positive check (supply > 0),
        constraint tokens_cap_covers_supply check (cap is null or cap >= supply),

        -- A broadcast with no hash is the Solana defect, expressed as a constraint. See the file
        -- header: the frozen call site has no onBroadcast, so a lost confirmation race writes
        -- failure with a null hash and the next claim mints again.
        constraint tokens_broadcast_has_hash check (broadcast_at is null or deploy_tx_hash is not null),

        -- A terminal state that says nothing is a terminal state nobody can act on.
        constraint tokens_terminal_is_complete check (
          (status <> 'deployed' or (contract_address is not null and deploy_tx_hash is not null))
          and (status <> 'failed' or failure_reason is not null)
        ),

        -- Money before chain: nothing may be on chain that was not paid for.
        constraint tokens_paid_before_broadcast check (broadcast_at is null or paid_journal_entry_id is not null)
      );

      -- One transaction hash belongs to at most one token. If two rows ever claim one deploy, the
      -- second write fails rather than quietly overwriting the evidence of the first.
      create unique index if not exists tokens_deploy_tx_hash_uniq
        on tokens (deploy_tx_hash)
        where deploy_tx_hash is not null;

      create index if not exists tokens_owner_idx on tokens (owner_subject, created_at desc);
      -- The claim query's access path: work that is due, oldest first.
      create index if not exists tokens_claimable_idx
        on tokens (status, lease_until)
        where status in ('paid','provisioning','awaiting_funds','deploying');

      -- Append-only. Every attempt, whatever became of it, including the ones that broadcast and
      -- then lost their confirmation. Without this a re-claim has no way to know a previous
      -- attempt put bytes on a wire.
      create table if not exists token_deploy_attempts (
        id             uuid        primary key default gen_random_uuid(),
        token_id       uuid        not null references tokens (id) on delete cascade,
        attempt        integer     not null,
        family         text        not null,
        outcome        text        not null,
        tx_hash        text,
        detail         text,
        created_at     timestamptz not null default now(),
        constraint token_deploy_attempts_outcome_known check (outcome in (
          'signed','broadcast','confirmed','reverted','refused','unavailable','not_implemented'
        )),
        constraint token_deploy_attempts_uniq unique (token_id, attempt, outcome)
      );

      create index if not exists token_deploy_attempts_token_idx
        on token_deploy_attempts (token_id, created_at);
    `,
  },
  {
    version: 5,
    name: 'project_pages',
    up: `
      -- 04-domain-model §5.3. Nothing here records supply, authorities, network or contract
      -- address: those are read from the INDEXER at render time, which is the invariant. A copy
      -- of them on this row would be the ORDER's intent presented as on-chain reality, and the
      -- two diverge the moment a mint authority is renounced.
      create table if not exists project_pages (
        id                  uuid        primary key default gen_random_uuid(),
        token_id            uuid        not null references tokens (id) on delete cascade,
        subject             text        not null,
        description         text        not null default '',
        links               jsonb       not null default '[]'::jsonb,
        team                jsonb       not null default '[]'::jsonb,
        roadmap             jsonb       not null default '[]'::jsonb,
        risk_disclosures    text        not null default '',
        verification_status text        not null default 'unverified',
        community_id        uuid,
        created_at          timestamptz not null default now(),
        updated_at          timestamptz not null default now(),
        constraint project_pages_token_uniq unique (token_id),
        constraint project_pages_verification_known check (
          verification_status in ('unverified','claimed','verified','flagged')
        )
      );
    `,
  },

  {
    version: 6,
    name: 'retire_shard_pricing',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- SHARDS OUT OF FORGE CREATE. The order becomes durable in USD; EMBER is settled at payment.
      --
      -- SHARD was retired on 2026-08-04 in micro-contracts (RETIRED_ASSETS) and micro-billing
      -- (migration 11, 'retire_shard_prices'). THIS SERVICE WAS NOT MIGRATED WITH THEM. It went on
      -- pricing a deploy in Shards (MINT_DEPLOY_PRICE_SHARDS), serving that number to the browser
      -- as 'priceShards', and posting a real SHARD debit to micro-ledger. The customer's screen
      -- said "Pay 2,500 Shards" and it was TRUE — which is why the screen could not be fixed by
      -- relabelling it, and why this migration is the fix.
      --
      -- The shape is billing's, deliberately, because two services quoting the same estate in two
      -- different bases is how a price becomes unauditable.
      --
      -- ── WHY USD AND NOT EMBER ───────────────────────────────────────────────────────────────
      --
      -- The owner's decision (docs/ecosystem/15 §3.2) is that a stated USD price does not move and
      -- the unit changes. EMBER cannot carry a catalogue price: it has no exchange listing, so
      -- micro-pricing carries an ADMINISTERED figure for it — a number an operator typed. Store
      -- EMBER here and every future edit to that figure silently restates the price of a deploy,
      -- with no migration and no record. USD is durable; how much EMBER it buys is a
      -- settlement-time question, answered per payment and recorded on the row that used it.
      --
      -- ── WHY THE INTEGER DOES NOT MOVE ────────────────────────────────────────────────────────
      --
      -- SHARD has decimals 0. USD is held as cents, decimals 2. The documented peg is 100 Shards to
      -- the dollar, so 100 Shards = 100 cents and ONE SHARD IS EXACTLY ONE CENT. The backfill below
      -- is the identity on the stored number: 2,500 Shards was $25.00 and 2,500 cents is $25.00.
      -- Nothing is multiplied, divided or rounded.
      --
      -- The alternative that was rejected is worth naming, because it is the plausible one:
      -- relabelling price_shards as 'EMBER' would leave the integer 2500 to be read at 18 decimals
      -- — 2500 wei, or 0.0000000000000025 EMBER — a price moved by eighteen orders of magnitude by
      -- an UPDATE that touched a text column. That is the silent scale change this is not.
      --
      -- ── WHY THE ROW RECORDS BOTH AMOUNTS AND THE RATE ───────────────────────────────────────
      --
      -- price_usd_cents is what the customer was QUOTED. charge_amount is what actually left their
      -- balance. They are two numbers, not one, and recording only the first loses what a refund
      -- needs: a refund must return the EMBER that was TAKEN, not whatever today's administered
      -- rate says $25.00 is worth, or a customer refunded across a rate change is refunded the
      -- wrong amount. rate_usd_scaled is the third column for the same reason — without it,
      -- price_usd_cents and charge_amount are two numbers with no stated relationship and nobody
      -- can tell a rate change from a bug.
      --
      -- ── SUPERSEDED IN PLACE, NEVER CONVERTED, NEVER DELETED ─────────────────────────────────
      --
      -- price_shards stays, and stays populated on the rows that had it. It is what a past order
      -- ACTUALLY cost; rewriting it would retroactively restate history, and it is the marker that
      -- says which era a row belongs to — the job status='retired' does in billing's prices table.
      -- Nothing written from here on sets it, and no money is destroyed here because none is held
      -- here: the 69,000 units of real SHARD liability live in micro-ledger, are guarded by its
      -- migration 13, and are drained separately.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      alter table tokens
        add column if not exists price_usd_cents  numeric(78,0),
        add column if not exists charge_asset_code text,
        add column if not exists charge_amount     numeric(78,0),
        add column if not exists rate_usd_scaled   numeric(78,0);

      -- One Shard is one cent. See above; this is the identity, not a conversion.
      update tokens set price_usd_cents = price_shards where price_usd_cents is null;

      -- What a paid order was actually charged. Every order that already exists was charged in the
      -- same unit it was priced in, at no conversion — that is what a Shard price and a Shard debit
      -- MEANT — so rate_usd_scaled stays NULL rather than being back-filled with a 1:1 figure that
      -- would claim a rate was consulted when none was.
      update tokens
         set charge_asset_code = 'SHARD',
             charge_amount     = price_shards
       where paid_journal_entry_id is not null
         and charge_asset_code is null;

      -- New rows state their price in the durable unit. price_shards becomes nullable rather than
      -- being dropped, because dropping it would delete what past orders cost.
      alter table tokens alter column price_shards drop not null;

      -- ── THE GUARD ───────────────────────────────────────────────────────────────────────────
      --
      -- A comment does not stop an INSERT, and this service is one deploy away from being wrong
      -- while the row outlives the deploy. No order CREATED from here on may be charged in a
      -- retired asset, whatever the application code believes, in any deployment.
      --
      -- BOTH halves of the predicate, because each covers the other's weakness. A Shard charge is
      -- permitted only on a row that is a Shard-era row (it carries the Shard price it was quoted
      -- at) AND was created before the cutoff:
      --
      --   * price_shards alone is a marker column, and a marker can be written by the same bug
      --     that writes the wrong charge.
      --   * created_at alone depends on a literal instant, and the first draft of this constraint
      --     picked midnight — which was seventy-one minutes in the FUTURE when the migration was
      --     written, leaving the hole open for the rest of the evening. It was caught by a test
      --     that expected a rejection and got none.
      --
      -- The cutoff is MEASURED, not assumed. The live estate holds three orders, all created at
      -- 2026-08-04 06:31 UTC and NONE of them paid — so no row anywhere carries a Shard charge at
      -- all, and 22:00 UTC is comfortably after every real row and comfortably in the past. That
      -- matters beyond the INSERT: this is checked on UPDATE too, so a cutoff placed before a live
      -- row would make that row unwritable for ever.
      --
      -- The literal carries an explicit offset so it does not depend on the session's TimeZone.
      --
      -- micro-ledger enforces the other half: its migration 13 refuses a posting of kind
      -- 'purchase' denominated in a retired asset, from any caller. Both are needed. That one
      -- cannot see this table, and this one cannot bind the other eleven services.
      alter table tokens
        drop constraint if exists tokens_no_new_shard_charge;
      alter table tokens
        add constraint tokens_no_new_shard_charge check (
          charge_asset_code is distinct from 'SHARD'
          or (price_shards is not null and created_at < timestamptz '2026-08-04 22:00:00+00')
        );

      -- Every order states a price in one of the two units. NOT a NOT NULL on price_usd_cents:
      -- the migrator runs BEFORE the new code starts, so for the length of a rollout the old build
      -- is still inserting rows that name price_shards and nothing else. A NOT NULL here would
      -- turn that window into a 500 on every launch; this accepts both eras and still refuses a
      -- row with no price at all.
      alter table tokens
        drop constraint if exists tokens_priced;
      alter table tokens
        add constraint tokens_priced check (
          price_usd_cents is not null or price_shards is not null
        );

      -- A paid order records what was TAKEN, not only what was quoted. Without this the refund
      -- path has nothing to return and the two-column design is decorative.
      alter table tokens
        drop constraint if exists tokens_paid_records_charge;
      alter table tokens
        add constraint tokens_paid_records_charge check (
          paid_journal_entry_id is null
          or (charge_asset_code is not null and charge_amount is not null)
        );

      -- A converted charge records the rate that produced it. A legacy Shard charge had no
      -- conversion, so it has no rate to record and must not invent one.
      alter table tokens
        drop constraint if exists tokens_converted_charge_records_rate;
      alter table tokens
        add constraint tokens_converted_charge_records_rate check (
          charge_asset_code is null
          or charge_asset_code = 'SHARD'
          or rate_usd_scaled is not null
        );
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the old
 * schema when a deploy runs ahead of its migrator. Here that is more than hygiene: below version 4
 * the three constraints in the header do not exist, and a replica running without them can record
 * a broadcast it cannot identify.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted. A new service leaves this at 0.
 *
 * The frozen `forge-mint` schema is NOT adopted by this service: its amounts are TEXT, it has no
 * lease columns of this shape and none of the three constraints, so a baseline that claimed
 * version 4 already applied would be a lie about exactly the guarantees this file exists to make.
 * Migration is a data copy, described in 10-migration-strategy, not a baseline.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'project_pages',
  'token_deploy_attempts',
  'tokens',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
])
