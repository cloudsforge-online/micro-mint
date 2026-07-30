/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`POST /v1/tokens/:id/deploy` ANSWERS 202 AND A STATUS URL. IT REACHES NO CHAIN.**
 *
 * The whole handler is: authenticate, check the mainnet allowlist, one conditional UPDATE to
 * confirm the order is in a state that can be deployed, one enqueue, and a `Location` header. It
 * cannot take more than a few milliseconds because there is nothing in it that can.
 *
 * The frozen handler awaits a settlement pass, a balance read, a nonce read, a fee read, a gas
 * estimate, a fifteen-second signing call, a broadcast, and then up to **180 seconds** for a
 * receipt — inside the request. Three separate things then cut it: a rolling deploy
 * (`process.exit(0)` ten seconds after SIGTERM, whatever is in flight), Cloudflare's 100-second
 * origin timeout, and any client that gives up. The worst landing is between the broadcast and
 * the write that records the hash, which orphans a real contract and deploys a second one.
 *
 * A 202 is not a nicety here. It is the only shape in which the work can be made to survive the
 * process that started it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The one decision that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because identity is having a bad minute.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Network } from '@cloudsforge/contracts-chain'
import { userSubject } from '@cloudsforge/contracts-money'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { JobQueue } from '@cloudsforge/jobs'
import { chainKey, isChainId, isNetwork, type ChainId } from './chains.ts'
import { canonicaliseEvm } from './evm.ts'
import { isFeature, variantFor, type Feature } from './catalogue.ts'
import { InsufficientBalanceError, OrderStateError, payForDeploy, type PayDeps } from './orders.ts'
import { renderProjectPage, upsertProjectPage, type RenderDeps } from './projectpages.ts'
import { DEPLOY_KIND } from './jobs.ts'
import {
  CLAIMABLE,
  findOwnedToken,
  findToken,
  listAttempts,
  listTokens,
  createToken,
  type TokenRecord,
} from './tokens.ts'
import type { Db } from './outbox.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export const READ_SCOPE = 'mint:read'
export const WRITE_SCOPE = 'mint:write'

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly sql: Db
  readonly producer: string
  readonly network: Network
  readonly pay: PayDeps
  readonly render: RenderDeps
  readonly queue: Pick<JobQueue, 'enqueue'>
  readonly priceShards: bigint
  /**
   * Subjects permitted to deploy to a mainnet. Empty means nobody, and empty is the default.
   * The frozen service gates mainnet on nothing at all, so any authenticated caller with a paid
   * order can put a contract on Ethereum mainnet at the platform's expense.
   */
  readonly mainnetAllowlist: readonly string[]
  readonly beforeScrape?: () => Promise<void>
}

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'mint_orders_total',
      help: 'Orders, by outcome. A 402 is a customer answer, not a failure.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'mint_deploys_total',
      help: 'Deploys reaching a terminal state, by chain and outcome.',
      kind: 'counter',
      labels: ['chain', 'outcome'],
    })
    .register({
      name: 'mint_deploys_broadcast_total',
      help: 'Creations that reached a node. Counted at the broadcast, not at the confirmation.',
      kind: 'counter',
      labels: ['chain'],
    })
    .register({
      name: 'mint_deploys_outstanding',
      help: 'Deploys not yet terminal. Sampled by the sweep, which is the thing that recovers them.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'mint_mainnet_refusals_total',
      help: 'Mainnet deploys refused by the allowlist. Zero is the expected value.',
      kind: 'counter',
      labels: [],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 64 * 1024
const MAX_NAME = 64
const MAX_SYMBOL = 12

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
}

interface Route {
  readonly method: string
  /** Used verbatim as the metric label, so cardinality is bounded by the number of routes. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/v1/tokens/:id/deploy` into a matcher. The segment pattern excludes `/` so a parameter
 * cannot swallow the rest of the path and make one route answer for another.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', { method, route: routeLabel, status: String(status) })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

/**
 * Map every failure onto a status, grouped by what the caller should do about it.
 *
 *   * **400** — the request could not be a legal order. Fix it; retrying will not help.
 *   * **402** — the customer cannot afford it. The ledger decided, and this is an answer, not an
 *     error. Deliberately not a 500.
 *   * **403** — a scope, a role, or the mainnet allowlist.
 *   * **404** — something named does not exist, or belongs to somebody else. The two are the same
 *     answer on purpose: a distinct 403 for "exists but is not yours" is an enumeration oracle.
 *   * **409** — well formed, but the state refuses it: an order already paid, or already deployed.
 *   * **503** — an upstream is unreachable. We do not know whether the entry posted, the order
 *     rolled back, and the caller's retry carries the same derived key. Retrying IS the right
 *     response, which is what 503 tells a client and 500 does not.
 */
async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof InsufficientBalanceError) {
      deps.metrics.increment('mint_orders_total', { outcome: 'insufficient_balance' })
      return errorReply(402, 'insufficient_balance', err.message, ctx.requestId)
    }
    if (err instanceof OrderStateError) {
      if (err.status === 'not_found') {
        return errorReply(404, 'not_found', err.message, ctx.requestId)
      }
      return errorReply(409, 'order_state', err.message, ctx.requestId)
    }
    if (err instanceof BadRequestError || err instanceof RangeError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (err instanceof Error && err.name === 'ChainError') {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (err instanceof Error && err.name === 'LedgerUnavailableError') {
      ctx.log.error('the ledger could not be reached', { err })
      return errorReply(503, 'ledger_unavailable', 'the order could not be completed; retry', ctx.requestId)
    }
    if (err instanceof Error && err.name === 'LedgerRefusedError') {
      ctx.log.error('the ledger refused an entry', { err })
      return errorReply(409, 'ledger_rejected', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      // 503 is what removes this replica from the balancer. A soft probe failure leaves the report
      // `degraded` but still ready, because taking a product out of rotation over a non-essential
      // upstream is worse than serving without it.
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would
        // lose every other metric too, and blind the dashboard at the moment it is needed.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /** What this service will deploy. Public: a catalogue behind a token cannot be browsed. */
    define('GET', '/v1/catalogue', async (_ctx, deps) => ({
      status: 200,
      body: {
        priceShards: deps.priceShards.toString(),
        network: deps.network,
        variants: (['fixed', 'mintable', 'foundry'] as const).map((variant) => {
          const spec = variantFor(
            variant === 'fixed'
              ? []
              : variant === 'mintable'
                ? (['mintable', 'burnable'] as Feature[])
                : (['mintable', 'burnable', 'pausable'] as Feature[]),
          )
          return { variant: spec.variant, contract: spec.contract, features: spec.features, cap: spec.cap }
        }),
      },
    })),

    /** Open an order. Nothing is charged and nothing is deployed. */
    define('POST', '/v1/tokens', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(principal, stringOrUndefined(body['userId']))

      const chain = requireString(body, 'chain')
      if (!isChainId(chain)) throw new BadRequestError(`chain must be one of ember, eth, sol`)
      const network = stringOrUndefined(body['network']) ?? deps.network
      if (!isNetwork(network)) throw new BadRequestError('network must be mainnet or testnet')

      const name = requireString(body, 'name')
      if (name.length > MAX_NAME) throw new BadRequestError(`name must be at most ${MAX_NAME} characters`)
      const symbol = requireString(body, 'symbol')
      if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
        throw new BadRequestError(`symbol must be 2 to ${MAX_SYMBOL} upper-case letters or digits`)
      }
      const decimals = requireInteger(body, 'decimals', 0, 18)
      const supply = requireQuantity(body, 'supply')
      const cap = body['cap'] == null ? null : requireQuantity(body, 'cap')
      const features = readFeatures(body['features'])
      // Refuse here rather than at deploy time. A request for a feature set no committed contract
      // provides is a request that can never succeed, and discovering that after payment is the
      // worst possible moment.
      variantFor(features)

      // EIP-55 checksummed, and the zero address refused. This is the field that decides who owns
      // the contract for ever; a mistyped character here is a token nobody holds the key to.
      const ownerAddress = canonicaliseEvm(requireString(body, 'ownerAddress'))
      const ownerWalletId = requireString(body, 'ownerWalletId')

      const done = deps.lifecycle.track()
      try {
        const token = await createToken(deps.sql, deps.producer, {
          ownerSubject: userSubject(userId),
          ownerWalletId,
          ownerAddress,
          chain,
          network,
          name,
          symbol,
          decimals,
          supply,
          cap,
          features,
          metadataUri: stringOrUndefined(body['metadataUri']) ?? null,
          brandKitId: stringOrUndefined(body['brandKitId']) ?? null,
          priceShards: deps.priceShards,
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('mint_orders_total', { outcome: 'created' })
        return { status: 201, body: { token: toWire(token) } }
      } finally {
        done()
      }
    }),

    define('GET', '/v1/tokens', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
      const tokens = await listTokens(deps.sql, userSubject(userId), 100)
      return { status: 200, body: { tokens: tokens.map(toWire) } }
    }),

    /**
     * The status URL a 202 points at. Cheap, pollable, and it reaches no chain: everything it
     * reports was written by the job, so a customer polling it cannot make a deploy slower.
     */
    define('GET', '/v1/tokens/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const token = await ownedToken(ctx, deps, principal)
      const attempts = await listAttempts(deps.sql, token.id)
      return {
        status: 200,
        body: {
          token: toWire(token),
          // The evidence, in order. An operator asking "did this ever reach a chain" gets an
          // answer from the row rather than from a log search.
          attempts: attempts.map((attempt) => ({
            attempt: attempt.attempt,
            family: attempt.family,
            outcome: attempt.outcome,
            txHash: attempt.txHash,
            detail: attempt.detail,
            at: attempt.createdAt.toISOString(),
          })),
        },
      }
    }),

    /** Pay for an order. One transaction: the ledger entry and the state change together. */
    define('POST', '/v1/tokens/:id/pay', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const userId = subjectUserId(principal, undefined)

      const done = deps.lifecycle.track()
      try {
        const result = await payForDeploy(deps.pay, {
          tokenId: tokenIdOf(ctx),
          ownerSubject: userSubject(userId),
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('mint_orders_total', {
          outcome: result.replayed ? 'replayed' : 'paid',
        })
        ctx.log.info(result.replayed ? 'order payment replayed' : 'order paid', {
          tokenId: result.token.id,
          journalEntryId: result.journalEntryId,
        })
        // 200 on a replay, 201 on a fresh debit: a client can tell whether its retry did the work
        // or merely found it done, without comparing bodies.
        return {
          status: result.replayed ? 200 : 201,
          body: { token: toWire(result.token), replayed: result.replayed },
        }
      } finally {
        done()
      }
    }),

    /**
     * **202. THE DEPLOY LEAVES THE REQUEST HERE.** See the file header.
     *
     * One conditional UPDATE to confirm the order can be deployed, one enqueue, one `Location`.
     * No chain call, no signature, no wait.
     */
    define('POST', '/v1/tokens/:id/deploy', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const token = await ownedToken(ctx, deps, principal)

      if (token.status === 'deployed') {
        throw new OrderStateError('this token is already deployed', token.status)
      }
      if (token.status === 'failed') {
        throw new OrderStateError('this deploy failed and will not be retried automatically', token.status)
      }
      if (token.status === 'awaiting_payment' || token.status === 'draft') {
        throw new OrderStateError('this order has not been paid for', token.status)
      }
      if (!(CLAIMABLE as readonly string[]).includes(token.status)) {
        throw new OrderStateError(`an order in ${token.status} cannot be deployed`, token.status)
      }

      // The mainnet allowlist. Checked HERE, before anything is queued, so a refusal costs a
      // request rather than a job that dead-letters somewhere an operator has to go and read.
      if (token.network === 'mainnet' && !deps.mainnetAllowlist.includes(token.ownerSubject)) {
        deps.metrics.increment('mint_mainnet_refusals_total')
        ctx.log.warn('mainnet deploy refused by the allowlist', {
          tokenId: token.id,
          subject: token.ownerSubject,
        })
        throw new ForbiddenError('mainnet deploys are limited to allowlisted subjects')
      }

      // The key is the CHAIN, not the token: what would break if two of these ran at once is the
      // node and the signing budget, not the row. `claimDeploy` is what makes two deploys of one
      // token impossible. `keep` means three clicks before the first job runs produce one run.
      await deps.queue.enqueue({
        kind: DEPLOY_KIND,
        key: chainKey(token.chain as ChainId, token.network),
        payload: { tokenId: token.id },
        onConflict: 'keep',
      })
      ctx.log.info('deploy accepted', { tokenId: token.id, chain: token.chain })

      const statusUrl = `/v1/tokens/${token.id}`
      return {
        status: 202,
        headers: { location: statusUrl },
        body: {
          accepted: true,
          tokenId: token.id,
          status: token.status,
          // Named in the body as well as the header, because a browser client reading JSON should
          // not have to know that `Location` on a 202 means something different from a 201.
          statusUrl,
        },
      }
    }),

    define('PUT', '/v1/tokens/:id/page', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const token = await ownedToken(ctx, deps, principal)
      const body = await readJson(ctx.req)
      const page = await upsertProjectPage(deps.sql, {
        tokenId: token.id,
        subject: token.ownerSubject,
        description: stringOrUndefined(body['description']) ?? '',
        links: Array.isArray(body['links']) ? body['links'] : [],
        team: Array.isArray(body['team']) ? body['team'] : [],
        roadmap: Array.isArray(body['roadmap']) ? body['roadmap'] : [],
        riskDisclosures: stringOrUndefined(body['riskDisclosures']) ?? '',
        communityId: stringOrUndefined(body['communityId']) ?? null,
      })
      return { status: 200, body: { page } }
    }),

    /**
     * The public project page. **Supply and authorities come from the indexer**, never from the
     * order record — 04-domain-model §5.3. See `projectpages.ts` for why that distinction is the
     * difference between a fact and a claim.
     *
     * Public, deliberately: a project page nobody can read without an account is a project page
     * that cannot do the one job it has.
     */
    define('GET', '/v1/tokens/:id/page', async (ctx, deps) => {
      const rendered = await renderProjectPage(deps.render, tokenIdOf(ctx))
      if (!rendered) return errorReply(404, 'not_found', 'no such token', ctx.requestId)
      return { status: 200, body: rendered }
    }),
  ]
}

/**
 * A path parameter that will be compared against a `uuid` column.
 *
 * Checked in the application rather than left to Postgres, because Postgres answers a malformed
 * uuid with error 22P02 — which reaches the error handler as an unrecognised fault and becomes a
 * **500**. A caller typing a wrong id would then get "something went wrong on our side" for a
 * request that was simply about a thing that does not exist. Caught by `server.test.ts`.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function tokenIdOf(ctx: RequestContext): string {
  const id = ctx.params['id'] ?? ''
  // A 404 rather than a 400: from the caller's side "that is not an id" and "no such token" are
  // the same fact, and the narrower answer tells them nothing they can use.
  if (!UUID.test(id)) throw new OrderStateError('no such token', 'not_found')
  return id
}

/**
 * The row, or a 404.
 *
 * "Does not exist" and "is not yours" are the same answer on purpose. A distinct 403 for the
 * second is an oracle that lets an unauthorised caller enumerate which order ids exist.
 */
async function ownedToken(
  ctx: RequestContext,
  deps: ServerDeps,
  principal: Principal,
): Promise<TokenRecord> {
  const id = tokenIdOf(ctx)
  const token = isAdmin(principal)
    ? await findToken(deps.sql, id)
    : await findOwnedToken(deps.sql, id, userSubject(subjectUserId(principal, undefined)))
  if (!token) throw new OrderStateError('no such token', 'not_found')
  return token
}

function toWire(token: TokenRecord): Record<string, unknown> {
  return {
    id: token.id,
    ownerSubject: token.ownerSubject,
    ownerAddress: token.ownerAddress,
    chain: token.chain,
    network: token.network,
    standard: token.standard,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    // Strings. A supply of 10^24 is an ordinary token and does not survive a JSON number.
    supply: token.supply.toString(),
    cap: token.cap === null ? null : token.cap.toString(),
    features: token.features,
    status: token.status,
    priceShards: token.priceShards.toString(),
    paidJournalEntryId: token.paidJournalEntryId,
    deployerAddress: token.deployerAddress,
    contractAddress: token.contractAddress,
    deployTxHash: token.deployTxHash,
    broadcastAt: token.broadcastAt?.toISOString() ?? null,
    confirmedAt: token.confirmedAt?.toISOString() ?? null,
    failureReason: token.failureReason,
    deployAttempts: token.deployAttempts,
    createdAt: token.createdAt.toISOString(),
    updatedAt: token.updatedAt.toISOString(),
  }
}

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being
  // a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

function actorOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = stringOrUndefined(body[field])
  if (!value) throw new BadRequestError(`${field} is required`)
  return value
}

function requireInteger(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${field} must be a whole number between ${min} and ${max}`)
  }
  return value
}

/**
 * A smallest-unit quantity, as a decimal STRING.
 *
 * A number is refused rather than coerced. One token with 18 decimals is 10^18 smallest units,
 * which a JSON number cannot carry exactly — and it does not fail, it arrives subtly wrong. The
 * frozen service stores these as TEXT for the same reason and is right to.
 */
function requireQuantity(body: Record<string, unknown>, field: string): bigint {
  const value = body[field]
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value)) {
    throw new BadRequestError(`${field} must be a positive decimal string of up to 78 digits`)
  }
  return BigInt(value)
}

function readFeatures(value: unknown): readonly Feature[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadRequestError('features must be an array')
  const out: Feature[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !isFeature(item)) {
      throw new BadRequestError('features may only be mintable, burnable or pausable')
    }
    if (!out.includes(item)) out.push(item)
  }
  return out
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive any
    // unauthenticated caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line and the trace.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health, metrics and order status are a point-in-time fact. A cached 200 from a replica that
    // has since gone unready is exactly the lie this arrangement exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
