/**
 * The three peers, and the credential this service presents to all of them.
 *
 * ── WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts` ────────────────────────────────────
 *
 * Because the defect it fixes was a WIRING defect, and wiring that lives in the composition root
 * is wiring no test can reach. `index.ts` opens a pool, asserts a schema and calls `listen()`;
 * importing it from a test starts a server. So the line that was wrong —
 *
 *     const token = () => env.serviceToken        // index.ts, for months
 *
 * — was structurally untestable, and a suite full of tests that build their own clients could not
 * have caught it however carefully they were written. A test that constructs its own provider
 * proves the provider works. Only a test that goes through THIS function proves the service uses
 * it. See `servicetoken.test.ts`.
 *
 * ── THE TEN-MINUTE CLIFF ───────────────────────────────────────────────────────────────────────
 *
 * A service token expires in 600 seconds (identity/src/tokens.ts). This service read one once
 * at boot and nothing re-minted it — nothing could, because minting required the `admin` role. Ten
 * minutes into every deployment, custody, the indexer and the ledger began refusing every call,
 * and no test here could see it because a test mints a token and uses it within seconds.
 *
 * That mattered more here than almost anywhere. `custody:sign:deployer` is how a contract gets
 * deployed; a deploy job whose token died mid-flight retries against a custody that refuses it,
 * and the failure looks like custody being broken rather than like this service holding a corpse.
 *
 * identity now mints for a service on demand. What this container holds at rest is a CREDENTIAL,
 * not a token: long-lived, revocable, worth nothing on its own, and exchangeable for an ordinary
 * ten-minute token whenever one is needed. The ten minutes is unchanged and must stay unchanged —
 * rotation IS expiry (SD-12).
 *
 * ── ONE PROVIDER FOR ALL THREE, AND NOT FOR THE RPC CLIENTS ────────────────────────────────────
 *
 * One provider, for the same reason there was one token: it is minted for `service:mint` with the
 * scopes mint needs and each peer checks the one it cares about.
 *
 * The per-chain JSON-RPC clients in `index.ts` are deliberately NOT wired to it. They dial public
 * chain nodes, which are not part of this estate and have no idea what an identity token is;
 * sending one there would leak a credential to a third party for no benefit at all.
 *
 * ── BOTH HOOKS, AND THE SECOND IS NOT DECORATION ───────────────────────────────────────────────
 *
 * `token` keeps the credential fresh on a schedule. `fetch` catches a 401 from a peer, re-mints
 * and replays once. Without the second, correctness would depend on this process and the peer
 * agreeing about what time it is.
 */

import {
  ServiceTokenProvider,
  ServiceTokenUnavailableError,
  type ProviderEvent,
} from '@cloudsforge/auth'
import { httpCustodyClient, type CustodyClient } from './custodyclient.ts'
import { httpIndexerClient, type IndexerClient } from './indexerclient.ts'
import { httpLedgerClient, type LedgerClient } from './ledgerclient.ts'
import { httpPricingClient, type PricingClient } from './pricingclient.ts'
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That
// is the same "untestable therefore unchecked" property that let the cliff survive.
import type { Env } from './env.ts'

export interface Upstreams {
  /**
   * `null` when no credential is configured. Handed to `serviceTokenProbe`, which reports that as
   * a hard readiness failure — the image must be able to BOOT without one so CI can smoke-test
   * `/livez`, but a replica in that state must never take traffic.
   */
  readonly identityTokens: ServiceTokenProvider | null
  readonly custody: CustodyClient
  readonly indexer: IndexerClient
  readonly ledger: LedgerClient
  /**
   * The USD→EMBER rate board. **Unauthenticated**, unlike the three above: the rate board is public
   * in this estate by design (`pricing/src/server.ts`), so this client presents no credential and
   * needs no service-token grant. Wiring it to `token` would demand a scope nobody issues.
   */
  readonly pricing: PricingClient
}

export interface UpstreamOptions {
  /** This service's name, for the ledger's `originating-service` header. `SERVICE` from `env.ts`. */
  readonly originatingService: string
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined
}

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  | 'identityUrl'
  | 'identityCredential'
  | 'custodyUrl'
  | 'indexerUrl'
  | 'ledgerUrl'
  | 'pricingUrl'
  | 'upstreamDeadlineMs'
>

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null

  /**
   * What every peer client asks for the `Authorization` header.
   *
   * Rejects rather than resolving `undefined` when there is no credential. `HttpClient` omits the
   * header entirely for `undefined`, so the request would go out unauthenticated and come back
   * 401 — telling an operator that custody rejected mint, when the truth is that nobody configured
   * mint. `ServiceTokenUnavailableError` is 503 under `statusFor`, which is the same answer the
   * estate already gives when a verifier is unreachable and for the same reason.
   */
  const token = (): Promise<string> =>
    identityTokens
      ? identityTokens.token()
      : Promise.reject(new ServiceTokenUnavailableError('no identity credential is configured'))

  const peerFetch = identityTokens?.authorizedFetch ?? options.fetch
  const common = {
    token,
    deadlineMs: env.upstreamDeadlineMs,
    ...(peerFetch ? { fetch: peerFetch } : {}),
  }

  return {
    identityTokens,
    custody: httpCustodyClient({ baseUrl: env.custodyUrl, ...common }),
    indexer: httpIndexerClient({ baseUrl: env.indexerUrl, ...common }),
    ledger: httpLedgerClient({
      baseUrl: env.ledgerUrl,
      originatingService: options.originatingService,
      ...common,
    }),
    // No `...common`: no token, deliberately. See the field comment.
    pricing: httpPricingClient({
      baseUrl: env.pricingUrl,
      deadlineMs: env.upstreamDeadlineMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  }
}
