/**
 * Configuration, and the two things it must refuse.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The
 * failure cases below go through `loadEnv`, which is pure over its source and therefore testable
 * without a child process.
 */
const BASE: Record<string, string> = {
  MINT_DATABASE_URL: 'postgres://mint:mint@127.0.0.1:5432/mint',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  OUTBOX_SIGNING_SECRET: 'a-real-looking-secret-of-sufficient-length',
  CUSTODY_URL: 'http://127.0.0.1:4005',
  INDEXER_URL: 'http://127.0.0.1:4008',
  LEDGER_URL: 'http://127.0.0.1:4007',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

/**
 * The credential is NOT in `BASE`, because it is not required — see the field comment in `env.ts`.
 * `MINT_SERVICE_TOKEN` is not there either: it was removed, and the tests below assert that its absence is
 * fine and its presence is reported rather than silently obeyed.
 */
const CREDENTIAL = 'cfsc_a-long-lived-credential-that-does-not-expire'

const { EnvError, SERVICE, env, loadEnv } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, BASE['MINT_DATABASE_URL'])
  assert.equal(SERVICE, 'mint')
})

test('a missing variable names itself', () => {
  const { MINT_DATABASE_URL: _omitted, ...rest } = BASE
  assert.throws(() => loadEnv(rest, 'host'), (err: unknown) => {
    assert.ok(err instanceof EnvError)
    assert.match(err.message, /MINT_DATABASE_URL/)
    return true
  })
})

test('a known placeholder secret is refused outright', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'changeme' }, 'host'),
    /known placeholder/,
  )
})

test('a short secret is refused, because length is the only entropy proxy available', () => {
  // MINT_SERVICE_TOKEN used to be the subject here; it is retired, and the credential that
  // replaced it takes the same length floor for the same reason.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }, 'host'), /at least 24/)
  assert.throws(
    () => loadEnv({ ...BASE, MINT_IDENTITY_CREDENTIAL: 'short' }, 'host'),
    /at least 24/,
  )
})

test('the mainnet allowlist is EMPTY by default, and empty means nobody', () => {
  const env = loadEnv(BASE, 'host')
  assert.deepEqual(env.mainnetAllowlist, [])
})

test('the mainnet allowlist is a comma-separated list, trimmed and de-duplicated', () => {
  const env = loadEnv(
    { ...BASE, MINT_MAINNET_ALLOWLIST: 'user:a , user:b,user:a ,' },
    'host',
  )
  assert.deepEqual(env.mainnetAllowlist, ['user:a', 'user:b'])
})

test('the network defaults to testnet, so an unconfigured deployment cannot reach a mainnet', () => {
  assert.equal(loadEnv(BASE, 'host').network, 'testnet')
})

test('a gas bound is read as a bigint, never through Number', () => {
  // 2e18 wei has nineteen digits, four orders of magnitude past what a double holds exactly. A
  // bound read through Number() would be silently rounded, and a rounded bound is a bound that
  // does not hold at the value it was written for.
  const env = loadEnv({ ...BASE, MINT_MAX_FEE_WEI: '2000000000000000001' }, 'host')
  assert.equal(env.maxFeeWei, 2_000_000_000_000_000_001n)
})

test('a gas floor above the ceiling is refused rather than silently reordered', () => {
  assert.throws(
    () => loadEnv({ ...BASE, MINT_MIN_GAS_PRICE_WEI: '100', MINT_MAX_GAS_PRICE_WEI: '10' }, 'host'),
    /exceeds/,
  )
})

test('a zero deploy price is refused: a free deploy is a free gas bill', () => {
  assert.throws(() => loadEnv({ ...BASE, MINT_DEPLOY_PRICE_SHARDS: '0' }, 'host'), /positive/)
})

test('an unparseable RPC map is refused rather than defaulted to empty', () => {
  // A silently-empty map is an outage that presents as "every deploy on every chain is refused for
  // want of an endpoint", which is a long way from the typo that caused it.
  assert.throws(() => loadEnv({ ...BASE, MINT_RPC_URLS: '{oops' }, 'host'), /must be a JSON object/)
})

test('INSTANCE_ID falls back to the hostname, which is what names a stuck lease', () => {
  assert.equal(loadEnv(BASE, 'pod-7').instanceId, 'pod-7')
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The credential that replaced MINT_SERVICE_TOKEN. See `env.ts` and `@cloudsforge/auth`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('the identity credential is read, and its absence is a null rather than a throw', () => {
  assert.equal(loadEnv({ ...BASE, MINT_IDENTITY_CREDENTIAL: CREDENTIAL }).identityCredential, CREDENTIAL)
  // Absent must LOAD — the image has to boot without one so the CI smoke test can read /livez —
  // and is caught by the hard `identity-credential` readiness probe instead.
  assert.equal(loadEnv(BASE).identityCredential, null)
})

test('a credential that is present but too short is refused, not accepted as configured', () => {
  // Absent is a deployment nobody has given a credential to. A short one is a deployment that
  // BELIEVES it has one, and would fail on its first call to a peer with a 401 that reads as
  // "identity rejected this service" rather than "nobody set this variable".
  assert.throws(
    () => loadEnv({ ...BASE, MINT_IDENTITY_CREDENTIAL: 'cfsc_short' }),
    (err: unknown) => err instanceof EnvError && err.message.includes('MINT_IDENTITY_CREDENTIAL'),
  )
})

test('identityUrl derives from the issuer, and IDENTITY_URL overrides it', () => {
  // The issuer of a token is by definition where the token came from, so demanding a fourth
  // identity variable would only create a way for the exchange and the JWKS to disagree.
  assert.equal(loadEnv(BASE).identityUrl, BASE['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv({ ...BASE, IDENTITY_URL: 'http://identity.internal:4000' }).identityUrl,
    'http://identity.internal:4000',
  )
})

test('MINT_SERVICE_TOKEN is no longer required, and being set is reported rather than obeyed', () => {
  // The retired variable. It was a 600-second token read once at boot; ten minutes into every
  // deployment every call to a peer failed and nothing could re-mint it.
  assert.equal(loadEnv(BASE).legacyServiceTokenPresent, false)
  const withLegacy = loadEnv({ ...BASE, MINT_SERVICE_TOKEN: 'a-real-looking-secret-of-sufficient-length' })
  assert.equal(withLegacy.legacyServiceTokenPresent, true)
  // And it confers nothing: setting it must not make the service look configured.
  assert.equal(withLegacy.identityCredential, null)
})
