# `micro-mint`

ForgeMint: a customer orders an ERC-20-family token, pays for it in Shards, and this service
deploys it. It owns the order lifecycle, the catalogue of what may be deployed, the deploy job, and
the project page — and it owns none of the four things that make a deploy possible. Keys are
`micro-custody`'s, money is `micro-ledger`'s, chain observation is `micro-indexer`'s, and the
contract source is `micro-contracts`'.

> **`POST /v1/tokens/:id/deploy` answers 202 and a status URL. It reaches no chain.** The whole
> handler is authenticate, check the mainnet allowlist, one conditional UPDATE to confirm the order
> can be deployed, one enqueue, and a `Location` header — it cannot take more than a few
> milliseconds because there is nothing in it that can (`src/server.ts:7-22`, handler at `:491`).
> **The frozen service held the request for up to 180 seconds**, awaiting a settlement pass, a
> balance read, a nonce read, a fee read, a gas estimate, a fifteen-second signing call, a
> broadcast, and then a receipt (`src/deploy.ts:8-11`).

> **It renders no on-chain fact from its own row.** `project_pages` records no supply, no
> authorities, no network and no contract address; those are read from the indexer at render time.
> A copy on this row would be **the order's intent presented as on-chain reality**, and the two
> diverge the moment a mint authority is renounced (`src/migrations.ts:229-232`).

---

## Why the 202 is the design, not a nicety

`src/deploy.ts:8-24` itemises what the frozen service does inside one HTTP request and what cuts it:

* **A rolling deploy kills it.** `obs.ts:241-258` calls `process.exit(0)` ten seconds after SIGTERM
  whatever is in flight, so a deploy in its receipt wait has about a 95% chance of being cut. **The
  bad landing is between the broadcast and the write that records the hash**: a real signed creation
  is on the wire, the row has no record of it, the lease expires, `tx_hash IS NULL` passes, and a
  second contract is deployed at the platform's expense with the first orphaned.
* **The edge kills it first.** Cloudflare's origin timeout is 100 seconds and the wait is 180, so
  the browser sees a 524 on deploys that then succeed server-side.
* **Nothing recovers it.** Settlement runs only when a request arrives for that specific order, so a
  customer who closes the tab leaves a broadcast deploy in `deploying` for ever.

Here the request does one conditional UPDATE and one enqueue. The sequence in the job is

```
claim → provision deployer → check funding → PREPARE (sign) → COMMIT bytes → broadcast
      → record broadcast → poll outcome
```

and each step precedes the next for a stated reason (`src/deploy.ts:30-41`): a crash **before** the
commit has broadcast nothing and the next tick rebuilds from a fresh nonce read; a crash **after**
the commit and before the send leaves bytes with no `broadcast_at`, and the next tick **resumes at
broadcast with the identical bytes** — a re-send of one transaction, never a second one; a crash
after the send is covered because the hash was written **with** the bytes.

---

## Routes

Read out of `src/server.ts`. Every domain route is served under `/v1` **only** — there is no
unprefixed spelling here, unlike `micro-indexer`.

`authenticate()` resolves the bearer token and checks **nothing else** (`src/server.ts:647`). Scope
is checked per-route and **only for service principals**: `if (principal.kind === 'service')
requireScope(principal, …)`. A user token is authorised by **ownership** instead — `ownedToken()`
looks the row up by owner subject, or by id if the principal is an `admin` (`src/server.ts:604-620`).

| Method | Path | Who | Idempotency-Key | What it does |
| --- | --- | --- | --- | --- |
| `GET` | `/livez` | **no auth** | — | liveness (`src/server.ts:314`) |
| `GET` | `/readyz` | **no auth** | — | 200/503 (`src/server.ts:316`) |
| `GET` | `/metrics` | **no auth** | — | Prometheus text (`src/server.ts:324`) |
| `GET` | `/v1/catalogue` | **no auth** | — | price, network and the three variants. **Public deliberately**: a catalogue behind a token cannot be browsed (`src/server.ts:340`, reasoning at `:339`) |
| `POST` | `/v1/tokens` | user, or service with `mint:write` | **none — see below** | opens an order. **Nothing is charged and nothing is deployed** (`src/server.ts:359`, scope at `:361`) |
| `GET` | `/v1/tokens` | user, or service with `mint:read` | — | the caller's orders. An `admin` may name another subject (`src/server.ts:417`, `:421`) |
| `GET` | `/v1/tokens/:id` | owner or admin | — | the order, plus **every deploy attempt**, so "what happened" is answered from the row rather than a log search (`src/server.ts:430`, `:440-448`) |
| `POST` | `/v1/tokens/:id/pay` | owner, or service with `mint:write` | **none** | debits Shards and moves the order to `paid`. **One transaction: the ledger entry and the state change together.** 201 fresh, **200 on a replay**, so a client can tell whether its retry did the work (`src/server.ts:454`, status at `:472`) |
| `POST` | `/v1/tokens/:id/deploy` | owner, or service with `mint:write` | **none** | **202 + `Location`.** Enqueues `token.deploy`. The mainnet allowlist is checked **here, before anything is queued**, so a refusal costs a request rather than a job that dead-letters somewhere an operator has to go and read (`src/server.ts:491`, allowlist at `:518-527`) |
| `PUT` | `/v1/tokens/:id/page` | owner, or service with `mint:write` | — | upserts the editorial half of the project page (`src/server.ts:546`) |
| `GET` | `/v1/tokens/:id/page` | **no auth** | — | renders the page: editorial fields from this database, **on-chain facts from the indexer** (`src/server.ts:572`) |

**Four routes make no `authenticate()` call**: `/livez`, `/readyz`, `/metrics` and
`/v1/catalogue` — plus `GET /v1/tokens/:id/page`, which is a public page by design
(`src/server.ts:572`).

"Does not exist" and "is not yours" are **the same 404** on purpose: a distinct 403 for the second
is an oracle that lets an unauthorised caller enumerate which order ids exist
(`src/server.ts:602-608`).

Amounts cross the wire as **strings** — a supply of 10²⁴ is an ordinary token and does not survive a
JSON number (`src/server.ts:628`).

### There is no idempotency infrastructure at all

**No helper, no table, no module, no header.** Grep the repository: `Idempotency-Key` appears
nowhere. A retried `POST /v1/tokens` therefore **creates a second draft order**.

This is a recorded, deliberately unfixed gap (`docs/ecosystem/18-build-status.md` §3.3d): the
consequence is a duplicate *draft* — the route charges nothing and deploys nothing — and porting a
subsystem into a shipped service is not a change to make unattended. `micro-market`'s equivalent
gaps *were* fixed, because it already had the machinery.

The two routes where a duplicate would cost money are protected by other means, and it is worth
being precise about which:

* `POST /pay` is a conditional state transition — an order already `paid` cannot be paid again, and
  the ledger entry and the state change commit together (`src/server.ts:454`). The replay answers
  200 rather than double-debiting.
* `POST /deploy` enqueues with `onConflict: 'keep'`, so **three clicks before the first job runs
  produce one run** (`src/server.ts:536-541`), and `claimDeploy`'s row-level lease makes two deploys
  of one token impossible (`src/jobs.ts:20-22`).

---

## Background work

Leased jobs only; CI greps for a `setInterval`. **The lease key names the contended resource**
(`src/jobs.ts:8-27`).

| Job | Lease key | Cadence | What two replicas do |
| --- | --- | --- | --- |
| `outbox.relay` | `stream` | 1s | one claims the stream (`src/jobs.ts:78`) |
| `token.deploy` | `<chain>:<network>` | on demand | **the key is the deployer's nonce sequence, not the token id** — and this is the decision most likely to be got wrong here. Every deploy reads `eth_getTransactionCount` on **its own per-order deployer address**, so two tokens are genuinely independent; but they share one node, one fee quote and one custody rate limit, and serialising them is what keeps a hundred queued orders from opening a hundred concurrent signing calls. The row-level lease inside `claimDeploy` is what makes two deploys of the *same* token impossible; this key bounds the load (`src/jobs.ts:13-22`) |
| `token.sweep` | `<chain>:<network>` | 15s | finds outstanding deploys and enqueues them. **It shares a key with `token.deploy` and that is safe for exactly one reason: it never signs and never sends** (`src/jobs.ts:23-25`, `:74-77`) |

**A key is not a lock across kinds.** The jobs table is unique on `(kind, key)`, so
`token.sweep / eth:testnet` and `token.deploy / eth:testnet` are two rows and two workers may hold
them at the same instant. That is tolerable only because the sweep claims nothing, signs nothing and
broadcasts nothing — **the moment anything in `token.sweep` reaches a chain it must be merged into
`token.deploy` rather than given its own key**, because sharing a key with a different kind buys
nothing at all (`src/jobs.ts:29-34`).

The sweep is the thing the frozen service has no equivalent of: there, settlement runs only when a
request arrives for that order, so a closed tab leaves a broadcast deploy with a live hash that
nothing ever looks at again (`src/jobs.ts:37-40`). It is seeded **for every chain rather than for
every chain with work**, because a job that only exists once there is something to do is a job whose
absence looks exactly like a job that is stuck, and `jobs_overdue` stops being a signal
(`src/jobs.ts:67-69`).

A dead-lettered recurring job is deliberately not re-armed (`src/jobs.ts:101-103`).

---

## The database

`tokens`, `token_deploy_attempts`, `project_pages`, plus `jobs`/`outbox`/`inbox`. Migrations in
`src/migrations.ts`, run only by `src/migrator.ts`.

| Constraint | Refuses | Why it is here rather than in a handler |
| --- | --- | --- |
| `tokens_paid_before_broadcast` — `broadcast_at is null or paid_journal_entry_id is not null` | putting anything on a chain that was not paid for | **money before chain, as a constraint.** A handler-level check holds for the path that went through the handler; this holds for the deploy job, a retry, a repair script and a psql session (`src/migrations.ts:190`) |
| `tokens_broadcast_has_hash` — `broadcast_at is null or deploy_tx_hash is not null` | a broadcast with no hash | **this is the Solana defect expressed as a constraint.** The frozen call site has no `onBroadcast`, so a lost confirmation race writes failure with a null hash and the next claim mints again — paying gas twice and orphaning a live contract. Here that row cannot be written (`src/migrations.ts:181`, reasoning at `:177-180`) |
| `tokens_deploy_tx_hash_uniq`, a **partial** unique index `where deploy_tx_hash is not null` | two tokens claiming one transaction | if two rows ever claim one deploy the second write **fails rather than quietly overwriting the evidence of the first** (`src/migrations.ts:195`, reasoning at `:192-193`). Partial because most rows have no hash yet, and a full unique index would refuse the second draft |
| `tokens_terminal_is_complete` | `deployed` without a contract address and hash, or `failed` without a reason | **a terminal state that says nothing is a terminal state nobody can act on** (`src/migrations.ts:184-187`) |
| `tokens_cap_covers_supply` — `cap is null or cap >= supply` | an order that is unsatisfiable at birth | it would otherwise be discovered by the constructor reverting, after the customer has paid (`src/migrations.ts:176`) |
| `tokens_supply_positive`, `tokens_decimals_sane` (0–36) | a zero-supply token, an absurd decimals | (`src/migrations.ts:175`, `:174`) |
| `tokens_status_known`, `tokens_network_known` | a state or network nobody enumerated | a status that exists in the data and in no report (`src/migrations.ts:169`, `:173`) |
| `token_deploy_attempts_uniq (token_id, attempt, outcome)` | a duplicated attempt record | the table is **append-only, every attempt including the ones that broadcast and then lost their confirmation** — without it a re-claim has no way to know a previous attempt put bytes on a wire (`src/migrations.ts:220`, reasoning at `:204-207`) |
| `project_pages_token_uniq` | two pages for one token | (`src/migrations.ts:248`) |
| `project_pages` has **no** supply / authority / address column | — | deliberate absence, and the most important line in that migration: those are read from the indexer at render time, because a copy here is the order's intent presented as on-chain reality (`src/migrations.ts:229-232`) |

`tokens_claimable_idx` is partial on the four in-flight statuses — the claim query's access path,
"work that is due, oldest first" (`src/migrations.ts:201-203`).

---

## Configuration

`.env.example` and `src/env.ts` were cross-checked and **agree**: every variable `loadEnv` reads is
present, defaults included, and the file names nothing the service does not read. `OUTBOX_SIGNING_SECRET`
and `MINT_SERVICE_TOKEN` ship **empty**, so a copied file refuses to boot until they are filled.

| Variable | Default | If it is wrong or missing |
| --- | --- | --- |
| `PORT` | `4000` | integer 1–65535 (`src/env.ts:251`) |
| `NODE_ENV` | `development` | labelling only (`src/env.ts:252`) |
| `LOG_LEVEL` | `info` | outside the four levels, boot fails (`src/env.ts:233`) |
| `CLOUDSFORGE_TAG` | `dev` | the reported version is wrong (`src/env.ts:253`) |
| `MINT_DATABASE_URL` | — | **required** (`src/env.ts:255`). Rule 1 |
| `MINT_DATABASE_POOL_MAX` | `10` | 1–100 (`src/env.ts:258`) |
| `IDENTITY_JWKS_URL` | — | **required**; unreachable → 503, never 401 (`src/env.ts:259`) |
| `IDENTITY_ISSUER` | — | **required**; wrong → universal 401 (`src/env.ts:260`) |
| `OUTBOX_SIGNING_SECRET` | — | **required, ≥24 chars, placeholders refused** (`src/env.ts:261`) |
| `INSTANCE_ID` | hostname | names this replica in `jobs.locked_by` (`src/env.ts:262`) |
| `CUSTODY_URL` | — | **required**. No signature, no deploy (`src/env.ts:264`) |
| `INDEXER_URL` | — | **required** (`src/env.ts:265`) |
| `LEDGER_URL` | — | **required**. No debit, no order (`src/env.ts:266`) |
| `MINT_SERVICE_TOKEN` | — | **required, ≥24 chars.** The scoped service credential — **not shared**, SD-05 (`src/env.ts:267`, `:175`) |
| `MINT_UPSTREAM_DEADLINE_MS` | `5000` | 100–60000 (`src/env.ts:268`) |
| `MINT_RPC_URLS` | `{}` | `chain → JSON-RPC endpoint` as JSON. **Empty means a chain with no endpoint refuses rather than falling back to a public node nobody chose** (`src/env.ts:270`, `:179-182`). A malformed value is refused at boot, because a silently-empty map is an outage that presents as "every deploy on every chain is refused for want of an endpoint" — a long way from the typo that caused it (`src/env.ts:112-117`) |
| `MINT_RPC_DEADLINE_MS` | `5000` | 100–60000 (`src/env.ts:271`) |
| `MINT_NETWORK` | `testnet` | **the one network this deployment mints on.** A single value rather than a free per-request parameter, because a service that can be asked for either is **one bad request away from putting a customer's contract on a mainnet they did not pay for** (`src/env.ts:272`, reasoning at `:186-193`) |
| `MINT_DEPLOYS_ENABLED` | `true` | set `false` to stop deploying **without stopping the service**, so orders still take payment (`src/env.ts:274`, `:196`) |
| `MINT_MAINNET_ALLOWLIST` | `` (nobody) | subjects permitted to deploy to a mainnet. **Empty means nobody, and that is the fail-closed default the frozen service does not have** — it gates mainnet on nothing at all (`src/env.ts:275`, reasoning at `:198-201` and `src/server.ts:90`) |
| `MINT_MIN_GAS_PRICE_WEI` | `1000000000` | parsed as **wei with `BigInt`, never `Number`**: one EMBER is 1e18 wei, four orders of magnitude past what a double holds exactly, and a rounded bound is a bound that does not hold at the value it was written for (`src/env.ts:237`, reasoning at `:100-104`) |
| `MINT_MAX_GAS_PRICE_WEI` | `500000000000` | must be ≥ the minimum, or boot fails (`src/env.ts:238-241`) |
| `MINT_MAX_FEE_WEI` | `1e18` | the most one deploy may cost in gas. Custody enforces its own ceiling at 2e18 (`src/env.ts:279`, `:206`) |
| `MINT_STUCK_MINUTES` | `30` | how long a deploy may sit unconfirmed before it is called stuck. **Above one confirmation window on every chain the estate deploys to, so a slow block is not an incident.** The frozen service had 180 *seconds*, and it was a request timeout rather than a stuck deadline (`src/env.ts:283`, reasoning at `:280-282`) |
| `MINT_DEPLOY_PRICE_SHARDS` | `2500` | **must be positive.** A zero price is a free deploy, which is a free gas bill paid by the platform for anyone who can open an order — refused rather than defaulted back, because the value was stated (`src/env.ts:243-248`) |

---

## What it talks to

| Upstream | Routes called | Verified against | When it is down |
| --- | --- | --- | --- |
| `micro-ledger` | `POST /entries` (`src/ledgerclient.ts:148`) | `ledger/src/server.ts:346` ✅ | **fail closed.** No debit, no order state change — they commit together, so a ledger outage means `POST /pay` fails and nothing half-happens |
| `micro-custody` | `POST /v1/sign` (`src/custodyclient.ts:148`), `POST /v1/addresses` (`src/custodyclient.ts:173`) | `custody/src/server.ts:424`, `:320` ✅ | **fail closed.** No signature, no bytes; the job retries under its lease. `/v1/sign` takes **seven** identity fields — address, chain, network, family, purpose, plus the payload — so a signature cannot be requested for a key the caller has misidentified (`src/custodyclient.ts:20`) |
| `micro-indexer` | `GET /v1/transactions/:chain/:network/:hash` (`src/indexerclient.ts:196`), `GET /v1/tokens/:chain/:network/:address` (`src/indexerclient.ts:212`) | `indexer/src/server.ts:157`, `:159` ✅ | **fail open, but only for the 404 that is an answer.** `transaction_not_found` and `token_not_found` are the indexer's statements about a chain and become `null`; **any other 404 throws `IndexerRouteError`** (`src/indexerclient.ts:205`, `:223`), because a path this service asked for and the indexer does not serve says nothing about anybody's chain |

The rule in `deploy.ts` is: **the indexer when it has the transaction, the node when it does not, and
neither is allowed to be silently absent** (`src/indexerclient.ts:12-13`). The indexer being a
*follower* is why: a creation broadcast four seconds ago is not in it yet, and "the indexer has never
heard of this hash" is emphatically not "the chain does not have it". Reading that absence as a
failure would mark every fresh broadcast lost and re-deploy it (`src/indexerclient.ts:8-12`).

**Both paths were wrong until this change, and neither failure had a symptom.** `transaction()`
asked for `/v1/chains/:chain/:network/transactions/:hash` — the *status* route's shape with a
resource bolted on — and `token()` for `/v1/chains/:chain/:network/tokens/:address`, which nothing
served in any spelling. Every call 404'd, every 404 became `null`, and `token()` therefore rendered
every project page's supply and authorities as "not yet indexed", permanently. All 113 tests passed
throughout, because every one of them stubs the client rather than asking whether the request could
reach a route.

Two things stop the next one. At runtime the 404 splits, above. Before that, in CI, the
`indexer-routes` job checks `micro-indexer` out and runs `scripts/checkindexerroutes.mjs`, which
parses the route table out of `indexer/src/server.ts:153-163` and fails if any path this client
requests is not one of them (`.github/workflows/ci.yml`). It compares **whole path shapes, not
prefixes**: the dead path began `/v1/chains/`, which is a prefix the indexer really does serve, so a
prefix check would have passed it. The job then mutates both sides and requires the check to go red,
because a job that grades a file it failed to fetch looks exactly like a job that passed.

`confirmations: null` from the indexer is **not zero** — it means the indexer knows the transaction
but cannot currently say how deep it is, which happens while a tip is being re-read after a reorg. A
caller that read null as zero would treat a confirmed deploy as fresh (`src/indexerclient.ts:126-128`).

---

## Running it

```bash
pnpm install
pnpm typecheck

# Migrations are a one-shot job and are NEVER run by the service process.
MINT_DATABASE_URL=postgres://mint:mint@127.0.0.1:55435/mint pnpm migrate
pnpm start
```

The suite needs a real Postgres whose database name contains `test`:

```bash
docker run -d --rm --name mint-pg \
  -e POSTGRES_USER=mint -e POSTGRES_PASSWORD=mint -e POSTGRES_DB=mint_test \
  -p 55435:5432 postgres:17-alpine

MINT_TEST_DATABASE_URL=postgres://mint:mint@127.0.0.1:55435/mint_test pnpm test
```

**121 `test(` declarations**, `node:test` only. The upstreams are faked at the client interface —
there is no live chain in the suite — so what the tests prove is the state machine, the constraints
and the crash-resumption points, not that the estate's other services answer as this service expects.
That boundary is exactly what let both indexer paths be wrong for the whole life of this service,
and it is why `src/indexerclient.test.ts` asserts the path **on the wire** and `indexer-routes` in CI
asserts it against the indexer's own source.

CI is bespoke (`.github/workflows/ci.yml`) and has four jobs: the suite against a real Postgres,
the committed-bytecode reproduction, the estate rules, and `indexer-routes` — which needs a
`micro-indexer` checkout and therefore cannot be a test.

---

## Known gaps

* **A token observation costs the indexer up to nine RPC calls, and nothing here caches it.**
  `GET /v1/tokens/…` makes the indexer read the contract's state at its canonical head — a block
  identity check, `eth_getCode`, and one `eth_call` per field. A project page is rendered on every
  request (`src/server.ts:572`), so a hot page is that traffic multiplied. Nothing has fallen over
  and no measurement exists; recorded here rather than pre-optimised, and the fix if it bites is a
  short-lived cache in the indexer, where the observation's block identity already lives.
* **`families.ts` still degrades to the node when the indexer answers badly.** The catch is narrowed
  to `IndexerUnavailableError` now rather than swallowing every throwable (`src/families.ts:265-270`),
  but `IndexerRouteError` is a subclass, so a wrong route on the deploy path still degrades silently
  to `eth_getTransactionReceipt` instead of failing. That is deliberate — refusing a customer's
  deploy over an integration bug is worse than deploying from the node's own receipt — and it is why
  the CI check above, not the runtime split, is the real guard for this half.
* **No route-level idempotency** — no helper, no table, no header. A retried `POST /v1/tokens`
  creates a second draft order. Recorded and deliberately unfixed at
  `docs/ecosystem/18-build-status.md` §3.3d.
* **`/metrics` is unauthenticated** (`src/server.ts:324`).
* **A failed deploy is not retried automatically** (`src/server.ts:501`). The order is terminal and
  needs an operator; `token_deploy_attempts` holds every attempt so the decision can be made from
  the row.
* **No OpenAPI description**, estate-wide (`docs/ecosystem/18-build-status.md` §3.3d, item 1).
