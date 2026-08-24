/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from custody:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic, and a placeholder that boots is a placeholder that reaches production.
 *
 * ## `MINT_MAINNET_ALLOWLIST` is not a feature flag
 *
 * A mainnet deploy spends the platform's own gas on a contract that then exists for ever at an
 * address a customer will publish. The frozen service gates it on nothing at all: `network` is a
 * request field, so any authenticated caller with a paid order can put a contract on Ethereum
 * mainnet at the platform's expense. Here mainnet is refused for every subject not named in this
 * allowlist, the list is EMPTY by default, and an empty list means no mainnet deploy is possible.
 * That is a deliberate fail-closed default: the cost of an unconfigured allowlist is a support
 * ticket, and the cost of an unconfigured flag is a gas bill.
 */

import { hostname } from 'node:os'
import type { IssuableAssetCode, Network } from '@cloudsforge/contracts-chain'
import { assertGeneratedSecret, assertServiceCredential, SecretError } from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'mint'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * `@cloudsforge/secrets` raises `SecretError`; this file's contract is that `loadEnv` raises
 * `EnvError`, and every test and caller in this repository is written to that.
 *
 * So a shape failure is re-wrapped rather than rethrown, and the message is carried across
 * VERBATIM: it already names the variable and the command that fixes it, and by construction it
 * contains no part of the value. Only the class changes, so there is one thing to catch here and
 * nothing to re-derive by matching on text.
 */
function asEnvError(err: unknown): never {
  throw err instanceof SecretError ? new EnvError(err.message) : err
}

/**
 * The estate's shared event-bus HMAC key, held to a shape rather than to a deny-list.
 *
 * THE LOCAL `requiredSecret`, `optionalSecret` AND `PLACEHOLDERS` ARE GONE RATHER THAN KEPT IN
 * FRONT. They refused a fixed list of exact strings and anything under 24 characters, and the
 * value that sat on 54 lines of a PUBLIC compose
 * file — `estate-only-outbox-secret-00000000000000` — was on no list and was 40 characters, so it
 * passed every service in the estate (micro-org #142). A check that could not fail read as the
 * absence of a problem. It matters here more than most: this key is what tells `micro-ledger` that
 * a mint event is genuinely from mint, and a forgeable one is a forgeable token supply.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` in front of it and nothing else, deliberately: the deleted checks were a strict
 * subset of the stronger ones, and running them first would answer a 40-character placeholder with
 * "must be at least 24 characters" — a message that is true, useless, and points the operator at
 * the wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  try {
    assertGeneratedSecret(name, value)
  } catch (err) {
    asEnvError(err)
  }
  return value
}

/**
 * A service credential that may be absent, but must be a REAL credential if present.
 *
 * The distinction matters: absent is a deployment that has not been given one yet and is reported
 * by `/readyz`; a placeholder is a deployment that believes it HAS one, and fails on its first call
 * to a peer with a 401 that reads as "identity rejected mint" rather than "nobody set this
 * variable".
 *
 * ── WHY THIS IS `assertServiceCredential` AND NOT THE SIGNING-KEY RULE ────────────────────────
 *
 * The guard class is not predictable from the variable's NAME, so it was MEASURED rather than
 * inferred — the estate has `*_TOKEN` variables holding `cfsc_` credentials and `*_TOKEN` variables
 * holding JWTs under the same suffix. `MINT_IDENTITY_CREDENTIAL` on the live estate, 2026-08-06:
 *
 *     mainnet   cfsc_ + 43 characters, base64url body, CONTAINS A HYPHEN
 *     testnet   cfsc_ + 43 characters, base64url body
 *
 * A credential is minted by micro-identity, not by `openssl`, so it is neither wholly base64 nor
 * wholly hex — the underscore in its own `cfsc_` prefix disqualifies it. Pointing this at
 * `assertGeneratedSecret`, which is the obvious-looking reuse, would refuse every credential the
 * estate has ever minted and exit 1 at boot on BOTH networks.
 *
 * THE BODY MAY CONTAIN A HYPHEN, and one of the two estates' does while the other's does not — see
 * the measurement above. A "no hyphens" rule is correct for a generated key, reads as obviously
 * right in review, and would pass one network while killing the other at boot. `@cloudsforge/secrets`
 * pins a hyphenated fixture so that regression fails CI rather than an estate.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  try {
    assertServiceCredential(name, value)
  } catch (err) {
    asEnvError(err)
  }
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * A wei quantity as a decimal string.
 *
 * Never a number. One EMBER is 1e18 wei, four orders of magnitude past what a double holds
 * exactly, so a gas bound read through `Number()` would be silently rounded — and a rounded bound
 * is a bound that does not hold at the value it was written for.
 */
function wei(source: Source, name: string, fallback: bigint): bigint {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new EnvError(`${name} must be a whole number of wei (got ${raw})`)
  return BigInt(raw)
}

/**
 * A JSON object of `chain → value`, refused rather than defaulted when it will not parse.
 *
 * A silently-empty map here is an outage that presents as "every deploy on every chain is refused
 * for want of an endpoint", which is a long way from the typo that caused it.
 */
function jsonMap(source: Source, name: string, fallback: string): Readonly<Record<string, string>> {
  const raw = optional(source, name, fallback)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EnvError(`${name} must be a JSON object (got ${raw.slice(0, 60)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvError(`${name} must be a JSON object of string keys to string values`)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new EnvError(`${name}.${key} must be a non-empty string`)
    }
    out[key] = value
  }
  return Object.freeze(out)
}

/** A comma-separated list, trimmed and de-duplicated. Empty by default and empty means empty. */
function list(source: Source, name: string): readonly string[] {
  const raw = source[name]?.trim()
  if (!raw) return Object.freeze([])
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return Object.freeze([...new Set(items)])
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  /**
   * The TESTNET database, when this deployment serves both networks. Empty means single-network —
   * `networkSql` then holds one handle and REFUSES a testnet request rather than answering it out
   * of mainnet rows (micro-deploy `docs/network-consolidation.md` §2.2).
   */
  readonly databaseUrlTestnet: string
  /**
   * The network to assume when a request carries no `CF-Network`, or empty to refuse. Set for
   * `pnpm dev`, which has no gateway. Never in production, where guessing makes a routing fault a
   * silent cross-network write.
   */
  readonly singleNetwork: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes — in both cases the thing an operator would
   * search for after finding a stuck lease.
   */
  readonly instanceId: string

  readonly custodyUrl: string
  readonly indexerUrl: string
  readonly ledgerUrl: string
  /**
   * Where micro-pricing is, for `GET /rates/:asset`.
   *
   * A new upstream, and a real availability coupling: a deploy cannot be paid for while the rate
   * is unreadable. That is the fail-closed choice `pricingclient.ts` argues — you cannot charge
   * somebody in a currency you cannot price, and the only alternative to refusing is guessing how
   * much of their money to take.
   */
  readonly pricingUrl: string

  /**
   * Where identity is, for `POST /service-tokens/exchange`.
   *
   * Defaults to `IDENTITY_ISSUER`, which is already required and is identity's own base URL — the
   * issuer of a token is by definition where the token came from. `IDENTITY_URL` overrides it for a
   * deployment where the two genuinely differ. Deriving rather than demanding a fourth identity
   * variable keeps them in step: pointing the exchange at one identity and trusting the JWKS of
   * another fails with a signature error nobody reads as a configuration mistake.
   */
  readonly identityUrl: string

  /**
   * **The long-lived credential this service exchanges for short-lived tokens.**
   *
   * It replaces `MINT_SERVICE_TOKEN`, which was a 600-second token read once at boot
   * (identity/src/tokens.ts). Ten minutes into any deployment it expired and every call to a
   * peer failed; nothing could re-mint it, because minting requires the `admin` role. A credential
   * is not a token: it confers nothing by itself, it is revocable, and it survives a restart. See
   * `micro-identity` `src/serviceCredentials.ts` and `@cloudsforge/auth` `ServiceTokenProvider`.
   *
   * OPTIONAL, AND DELIBERATELY SO — but not "unconfigured is fine". It is optional because the
   * image must be able to BOOT without one: CI's startup smoke test builds the container, migrates
   * it and reads `/livez`, and that job's environment is fixed in a workflow file. Making this
   * required would fail that job rather than this service.
   *
   * The absence is not silent. `/readyz` reports the `identity-credential` probe as a HARD failure,
   * so an unconfigured replica never takes traffic, and every upstream call fails closed with 503
   * rather than being sent unauthenticated.
   */
  readonly identityCredential: string | null

  /**
   * Whether the retired `MINT_SERVICE_TOKEN` is still set.
   *
   * Read for exactly one purpose: to say so at boot. An operator who redeploys with the old
   * variable and not the new one would otherwise get a service that looks configured and is not.
   */
  readonly legacyServiceTokenPresent: boolean
  readonly upstreamDeadlineMs: number

  /**
   * `chain → JSON-RPC endpoint`. Empty by default, which makes a chain with no endpoint refuse
   * rather than fall back to a public node nobody chose.
   */
  readonly rpcUrls: Readonly<Record<string, string>>
  readonly rpcDeadlineMs: number

  /**
   * The one network this deployment mints on, and the default for an order that names none.
   *
   * A single value rather than a free per-request parameter, because a service that can be asked
   * for either is a service one bad request away from putting a customer's contract on a mainnet
   * they did not pay for. An order may still NAME mainnet — the allowlist below is what decides
   * whether it deploys.
   */
  readonly network: Network

  /** Deploys can be turned off without turning the service off, so orders still take payment. */
  readonly deploysEnabled: boolean
  /**
   * Subjects permitted to deploy to a MAINNET. Empty by default; empty means nobody, and that is
   * the fail-closed default the frozen service does not have.
   */
  readonly mainnetAllowlist: readonly string[]

  readonly minGasPriceWei: bigint
  readonly maxGasPriceWei: bigint
  /** The most one deploy may cost in gas. Custody enforces its own ceiling too, at 2e18. */
  readonly maxFeeWei: bigint
  /** How long a deploy may sit unconfirmed before it is called stuck and an operator is told. */
  readonly stuckMinutes: number
  /**
   * How many times one order may ask settlement to fund its deployer address.
   *
   * A bound, not a retry budget: if three top-ups have been sent and the address is still short,
   * the fourth will not be the one that works, and each one spends real treasury. The order waits
   * in `awaiting_funds` for an operator instead.
   */
  readonly fundingMaxRequests: number
  /**
   * The gap between one order's funding requests, in minutes.
   *
   * A top-up has to be planned, signed, broadcast and MINED before the deployer's balance changes.
   * The sweep re-measures every tick, so without this a stuck order would exhaust its whole request
   * allowance inside a minute, before the first transfer had a chance to land.
   */
  readonly fundingCooldownMinutes: number
  /**
   * The price of one token deploy, in **US cents**. Quoted at `POST /tokens`, settled at
   * `POST /pay`.
   *
   * It was `deployPriceShards` and the default was 2,500 Shards. One Shard is exactly one cent
   * (SHARD has decimals 0, USD is cents, the peg is 100 Shards to the dollar), so 2,500 cents is
   * the same $25.00 and the re-denomination moved no number. See migration 6.
   */
  readonly deployPriceUsdCents: bigint

  /**
   * What a customer is actually charged in.
   *
   * Typed `IssuableAssetCode` — `Exclude<AssetCode, 'SHARD'>` — and not a string. A build that
   * tried to route this back through Shards would not compile, which is the difference between a
   * rule and a comment, and it is the check this service did not have on 2026-08-04.
   */
  readonly settlementAsset: IssuableAssetCode
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const NETWORKS = new Set(['mainnet', 'testnet'])

/** Exported so the allowlist check and the tests share one spelling of "is this a mainnet". */
export function isMainnet(network: string): network is Network {
  return network === 'mainnet'
}

export function parseNetwork(value: string): Network {
  if (!NETWORKS.has(value)) throw new EnvError(`network must be mainnet or testnet (got ${value})`)
  return value as Network
}

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const minGasPriceWei = wei(source, 'MINT_MIN_GAS_PRICE_WEI', 1_000_000_000n)
  const maxGasPriceWei = wei(source, 'MINT_MAX_GAS_PRICE_WEI', 500_000_000_000n)
  if (minGasPriceWei > maxGasPriceWei) {
    throw new EnvError('MINT_MIN_GAS_PRICE_WEI exceeds MINT_MAX_GAS_PRICE_WEI')
  }

  // MINT_DEPLOY_PRICE_SHARDS is gone rather than accepted-and-ignored. A deployment that still
  // sets it is stating a price in a retired unit, and silently pricing in something else would be
  // the same class of mistake as the one this release exists to fix — the operator would believe a
  // number that is not the one being charged.
  if ((source['MINT_DEPLOY_PRICE_SHARDS'] ?? '').trim().length > 0) {
    throw new EnvError(
      'MINT_DEPLOY_PRICE_SHARDS is retired with the asset it names. Set ' +
        'MINT_DEPLOY_PRICE_USD_CENTS instead — one Shard was exactly one cent, so the same ' +
        'number is the same price.',
    )
  }
  const deployPriceUsdCents = wei(source, 'MINT_DEPLOY_PRICE_USD_CENTS', 2_500n)
  if (deployPriceUsdCents <= 0n) {
    // A zero price is a free deploy, which is a free gas bill paid by the platform for anyone who
    // can open an order. Refused rather than defaulted back, because the value was stated.
    throw new EnvError('MINT_DEPLOY_PRICE_USD_CENTS must be positive')
  }

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'MINT_DATABASE_URL'),
    databaseUrlTestnet: source['MINT_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'MINT_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    custodyUrl: required(source, 'CUSTODY_URL'),
    indexerUrl: required(source, 'INDEXER_URL'),
    ledgerUrl: required(source, 'LEDGER_URL'),
    pricingUrl: required(source, 'PRICING_URL'),
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    // Optional, not required: see the field comment. The absence is caught by `/readyz`, which is
    // a check that can fail, rather than by a boot CI cannot perform.
    identityCredential: optionalCredential(source, 'MINT_IDENTITY_CREDENTIAL'),
    legacyServiceTokenPresent: (source['MINT_SERVICE_TOKEN']?.trim() ?? '').length > 0,
    upstreamDeadlineMs: integer(source, 'MINT_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),

    rpcUrls: jsonMap(source, 'MINT_RPC_URLS', '{}'),
    rpcDeadlineMs: integer(source, 'MINT_RPC_DEADLINE_MS', 5_000, 100, 60_000),
    network: parseNetwork(optional(source, 'MINT_NETWORK', 'testnet')),

    deploysEnabled: optional(source, 'MINT_DEPLOYS_ENABLED', 'true') !== 'false',
    mainnetAllowlist: list(source, 'MINT_MAINNET_ALLOWLIST'),

    minGasPriceWei,
    maxGasPriceWei,
    maxFeeWei: wei(source, 'MINT_MAX_FEE_WEI', 10n ** 18n),
    // Above one confirmation window on every chain the estate deploys to, so a slow block is not
    // an incident. The frozen service had 180 SECONDS, and it was a request timeout rather than a
    // stuck deadline — see the header of `deploy.ts`.
    stuckMinutes: integer(source, 'MINT_STUCK_MINUTES', 30, 1, 1_440),
    fundingMaxRequests: integer(source, 'MINT_FUNDING_MAX_REQUESTS', 3, 0, 20),
    // Five minutes is many blocks on every chain this service deploys to, and it is short enough
    // that a customer watching the status page sees the second attempt rather than giving up.
    // Zero is allowed and means no cooldown, which is what the tests use.
    fundingCooldownMinutes: integer(source, 'MINT_FUNDING_COOLDOWN_MINUTES', 5, 0, 1_440),
    deployPriceUsdCents,
    // Not read from the environment. EMBER is the estate's settlement asset and the only chain-
    // backed unit a customer holds; making it configurable would be offering an operator a way to
    // put a retired code back, which is exactly what the type forbids.
    settlementAsset: 'EMBER',
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it. The message is the one `loadEnv` produced, which by construction never
 * contains a value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
