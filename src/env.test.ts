/**
 * Configuration, and the two things it must refuse.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'

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
  // GENERATED, not written. `assertGeneratedSecret` refuses a typed value, and a fixture exempt
  // from the rule it is meant to exercise is how the placeholder in micro-org #142 survived every
  // test in the estate. The literal that used to sit here — "a-real-looking-secret-of-sufficient-
  // length" — is now refused twice over: it is not base64, and it reads as a placeholder.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
  CUSTODY_URL: 'http://127.0.0.1:4005',
  INDEXER_URL: 'http://127.0.0.1:4008',
  LEDGER_URL: 'http://127.0.0.1:4007',
  PRICING_URL: 'http://127.0.0.1:4009',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

/**
 * The credential is NOT in `BASE`, because it is not required — see the field comment in `env.ts`.
 * `MINT_SERVICE_TOKEN` is not there either: it was removed, and the tests below assert that its absence is
 * fine and its presence is reported rather than silently obeyed.
 */
/**
 * A realistic minted credential: `cfsc_` then a 43-character base64url body, 32 bytes, 5.240 bits
 * per character.
 *
 * THE BODY CARRIES A HYPHEN ON PURPOSE. A credential body is base64**url**, and measured live on
 * 2026-08-06 one estate's body contains a hyphen for a given variable while the other's does not —
 * `MINT_IDENTITY_CREDENTIAL` has one on mainnet and none on testnet, `NDA_IDENTITY_CREDENTIAL` the
 * other way round. A "no hyphens" rule is correct for a GENERATED key, reads as obviously right in
 * review, passes one network and kills the other at boot. This fixture makes that regression fail
 * CI instead of failing an estate.
 *
 * The literal that used to sit here, `cfsc_a-long-lived-credential-that-does-not-expire`, was a
 * TYPED English phrase: 43 characters and 32 bytes, but 3.785 bits per character, below the 4.0
 * floor. It is now correctly refused — a fixture exempt from the rule it exercises is how the
 * placeholder in micro-org #142 survived every test in the estate.
 */
const CREDENTIAL = 'cfsc_vFpu5q-4UwZTvGSezkD9nTOy8r6lxWbhIBm8eaJoXiE'

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

test('a short secret is refused, on bytes for the signing key and on length for the credential', () => {
  // MINT_SERVICE_TOKEN used to be the subject here; it is retired, and the credential that
  // replaced it takes the same length floor for the same reason.
  //
  // The two messages differ on purpose. The signing key is measured in DECODED BYTES, because 32
  // characters of prose is not 32 bytes of key; the credential is still on the old character
  // floor, which is all a deny-list guard can say.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }, 'host'),
    /3 bytes of key material/,
  )
  // The credential's unit is BYTES too, not keystrokes — and before that it must carry the `cfsc_`
  // prefix identity mints, which `short` does not. The old assertion here was `/at least 24/`, the
  // message of the deny-list guard that passed a 40-character placeholder for months.
  assert.throws(
    () => loadEnv({ ...BASE, MINT_IDENTITY_CREDENTIAL: 'short' }, 'host'),
    /not a service credential/,
  )
})

test('the credential guard refuses what the deny-list guard passed — micro-org #212', () => {
  // Every value here cleared the old guard: none is one of its nine exact strings, and each is
  // longer than 24 characters. The class was chosen by MEASURING the live value (cfsc_ + 43
  // base64url, both networks), never by reading the variable's name.
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    // 40 characters, live on 44 containers across both networks (micro-org #142).
    ['estate-only-outbox-secret-00000000000000', /not a service credential/],
    // The prefix is not the credential: long enough and varied enough to clear the byte and
    // entropy floors, so only the marker check on the BODY refuses it.
    ['cfsc_ci-only-Xq7Zm2Bv9Kd4Rt6Yw1Ns3Hj5Lp8Fg0Ac2De4Uz', /reads as a placeholder/],
    // A ten-minute bearer read once at boot is dead on the next restart — micro-org #197/#222.
    ['eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJtaW50In0.AAAA', /carries a TOKEN, not a credential/],
  ]
  for (const [value, expected] of cases) {
    assert.throws(
      () => loadEnv({ ...BASE, MINT_IDENTITY_CREDENTIAL: value }),
      (err: unknown) => err instanceof EnvError && expected.test(err.message),
      `MINT_IDENTITY_CREDENTIAL should refuse a ${value.length}-character value`,
    )
  }
})

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED, and every near miss with it', () => {
  // micro-org #142. Each of these cleared the old guard — a deny-list of exact strings plus a
  // 24-character floor — and each is a real string that was deployed or set in CI, not an invented
  // one. If a future edit weakens the floor, it fails against evidence rather than against taste.
  for (const value of [
    'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
    'ci-only-not-a-real-secret-000000000000', // this workflow's own former smoke-env value
    'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // the estate's former test fixture: 32 chars, 24 bytes
    '0'.repeat(64), // right alphabet, right length, no entropy
  ]) {
    assert.throws(
      () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: value }, 'host'),
      (err: unknown) => {
        // The refusal must not echo the value: the reason this guard exists is that the value was
        // readable, and a message carrying it moves the secret to the log collector.
        const message = (err as Error).message
        assert.ok(!message.includes(value), 'the refusal echoed the value')
        assert.match(message, /OUTBOX_SIGNING_SECRET/)
        assert.match(message, /openssl rand -base64 48/)
        return true
      },
    )
  }
})

test('a generated secret is accepted, in either alphabet', () => {
  assert.doesNotThrow(() =>
    loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64') }, 'host'),
  )
  assert.doesNotThrow(() =>
    loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') }, 'host'),
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
  assert.throws(() => loadEnv({ ...BASE, MINT_DEPLOY_PRICE_USD_CENTS: '0' }, 'host'), /positive/)
})

test('the retired price variable is refused outright, never accepted and ignored', () => {
  // A deployment that still sets MINT_DEPLOY_PRICE_SHARDS is stating a price in a unit the estate
  // stopped issuing on 2026-08-04. Ignoring it and charging the default instead would leave an
  // operator believing a number that is not the one being charged — the same class of mistake as
  // the one this release fixes. It fails at boot, where somebody is looking.
  assert.throws(
    () => loadEnv({ ...BASE, MINT_DEPLOY_PRICE_SHARDS: '2500' }, 'host'),
    /MINT_DEPLOY_PRICE_USD_CENTS/,
  )
})

test('the default price is unchanged in value: 2,500 Shards was 2,500 cents', () => {
  // One Shard is exactly one cent — SHARD has decimals 0, USD is cents, the peg is 100 Shards to
  // the dollar. This asserts the re-denomination moved no number, which is the whole safety
  // argument of migration 6.
  assert.equal(loadEnv(BASE, 'host').deployPriceUsdCents, 2_500n)
})

test('the settlement asset cannot be a retired one, and is not configurable', () => {
  assert.equal(loadEnv({ ...BASE, MINT_SETTLEMENT_ASSET: 'SHARD' }, 'host').settlementAsset, 'EMBER')
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
