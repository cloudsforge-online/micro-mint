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
import type { Network } from '@cloudsforge/contracts-chain'

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

/**
 * Values that must never be accepted. The list holds the strings that actually appear in this
 * repository's own `.env.example` and compose files, because those are the ones that get copied
 * into a deployment by someone in a hurry.
 */
const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'dev-outbox-signing-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
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
  /** The scoped service credential. Not shared: SD-05. */
  readonly serviceToken: string
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
  /** The price of one token deploy, in Shards. Debited from the customer at `POST /pay`. */
  readonly deployPriceShards: bigint
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

  const deployPriceShards = wei(source, 'MINT_DEPLOY_PRICE_SHARDS', 2_500n)
  if (deployPriceShards <= 0n) {
    // A zero price is a free deploy, which is a free gas bill paid by the platform for anyone who
    // can open an order. Refused rather than defaulted back, because the value was stated.
    throw new EnvError('MINT_DEPLOY_PRICE_SHARDS must be positive')
  }

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'MINT_DATABASE_URL'),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'MINT_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    custodyUrl: required(source, 'CUSTODY_URL'),
    indexerUrl: required(source, 'INDEXER_URL'),
    ledgerUrl: required(source, 'LEDGER_URL'),
    serviceToken: requiredSecret(source, 'MINT_SERVICE_TOKEN'),
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
    deployPriceShards,
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
