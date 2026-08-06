/**
 * A 404 is an answer or it is a defect, and which one it is decides what every project page says.
 *
 * ## What this used to be
 *
 * Both methods asked for paths `micro-indexer` has never served — `token()` for
 * `/v1/chains/:chain/:network/tokens/:address`, which is the STATUS route's shape with a resource
 * bolted on. Every call 404'd; the 404 became `null`; and `projectpages.ts` turned that into
 * "the indexer has not yet indexed this contract" on every ForgeMint project page, permanently and
 * silently. 04-domain-model §5.3 requires those pages to render supply and authorities **from the
 * indexer** — so the invariant was not merely unmet, it was reported as met-but-pending, for ever.
 *
 * All of this service's tests passed throughout, because every one of them stubs the client rather
 * than asking whether the request could reach a route.
 *
 * ## What is asserted now
 *
 *   * the exact path, **on the wire** — a template literal that reads right can still send the
 *     wrong path, so this asks what was requested rather than what was written;
 *   * the 404 split: the indexer's own `*_not_found` codes are answers, and any other 404 is
 *     `IndexerRouteError`, which is a bug in this service and says so;
 *   * that a body which cannot be read is never promoted into a confident "nothing there".
 *
 * The third leg is `scripts/checkindexerroutes.mjs`, which compares these paths against the route
 * table in `micro-indexer`'s own source in CI. It lives outside the suite because it needs that
 * repository on disk and `pnpm test` must pass without it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  IndexerRouteError,
  IndexerUnavailableError,
  httpIndexerClient,
} from './indexerclient.ts'

const CLIENT = readFileSync(fileURLToPath(new URL('./indexerclient.ts', import.meta.url)), 'utf8')

const HASH = `0x${'a'.repeat(64)}`
const TOKEN = `0x${'c'.repeat(40)}`

/** A client whose indexer answers exactly this, and a record of what it was asked for. */
function clientWith(
  status: number,
  body: unknown,
): { client: ReturnType<typeof httpIndexerClient>; asked: string[] } {
  const asked: string[] = []
  const client = httpIndexerClient({
    baseUrl: 'http://indexer.test',
    token: () => 'token',
    deadlineMs: 1_000,
    fetch: async (input) => {
      asked.push(new URL(String(input)).pathname)
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
      })
    },
  })
  return { client, asked }
}

const notFound = (code: string): unknown => ({ error: { code, message: 'no', requestId: 'r' } })

/* ------------------------------------------------------------------ the paths */

test('both calls ask for the route the indexer actually serves', async () => {
  // The indexer's convention is the RESOURCE first, then `:chain/:network`, then the key
  // (`indexer/src/server.ts`). Asserted on the wire, not on the source.
  const transaction = clientWith(200, { hash: HASH, status: 'success' })
  await transaction.client.transaction('ember', 'testnet', HASH)
  assert.deepEqual(transaction.asked, [`/v1/transactions/ember/testnet/${HASH}`])

  const token = clientWith(200, { contractAddress: TOKEN })
  await token.client.token('ember', 'testnet', TOKEN)
  assert.deepEqual(token.asked, [`/v1/tokens/ember/testnet/${TOKEN}`])
})

test('the paths this client requests are shaped like the indexer\'s, and not like the status route', () => {
  // A source-level backstop for the CI check, so a regression is visible in `pnpm test` too. It is
  // deliberately about SHAPE — `/v1/chains/…/tokens/…` is what was there, and it starts with a
  // prefix the indexer really does serve, which is exactly why a prefix test would have passed it.
  //
  // COMMENTS STRIPPED FIRST. This file and the client both quote the two dead paths in prose, and
  // a checker that cannot tell a request from a sentence about one is not a checker.
  const code = CLIENT.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
  const paths = [...code.matchAll(/`(\/[^`]*)`/g)].map((m) => m[1] ?? '')
  assert.equal(paths.length, 2, `expected exactly two request paths, found: ${paths.join(', ')}`)
  for (const path of paths) {
    const segments = path.replace(/\$\{[^}]*\}/g, 'x').split('/')
    // ['', 'v1', resource, chain, network, key] — five segments after the leading empty one.
    assert.equal(segments.length, 6, path)
    assert.equal(segments[1], 'v1', path)
    assert.ok(['transactions', 'tokens'].includes(segments[2] ?? ''), path)
  }
})

/* ------------------------------------------------------------------ the 404 split */

test('a hash the indexer has never seen is an ANSWER, not a fault', async () => {
  // A creation broadcast four seconds ago is not in the indexer yet. Reading that as an outage
  // would retry at error level for the whole of a normal confirmation window; reading it as "the
  // chain does not have it" would re-deploy the contract and pay gas twice.
  const { client } = clientWith(404, notFound('transaction_not_found'))
  assert.equal(await client.transaction('ember', 'testnet', HASH), null)
})

test('a contract the indexer cannot observe yet is an ANSWER, not a fault', async () => {
  // What a deployment above the indexer's head looks like. It renders as "not yet indexed", which
  // is true, and is never filled in from the order record.
  const { client } = clientWith(404, notFound('token_not_found'))
  assert.equal(await client.token('ember', 'testnet', TOKEN), null)
})

test('a 404 from a path the indexer does not serve is a DEFECT, and names itself', async () => {
  // THE DEFECT THIS FILE WAS. Returning null here is what rendered "not yet indexed" on every
  // project page for ever. It throws now, and the message says the route does not exist rather
  // than blaming the chain.
  for (const call of [
    (c: ReturnType<typeof httpIndexerClient>) => c.transaction('ember', 'testnet', HASH),
    (c: ReturnType<typeof httpIndexerClient>) => c.token('ember', 'testnet', TOKEN),
  ]) {
    const { client } = clientWith(404, notFound('not_found'))
    await assert.rejects(
      () => call(client),
      (err: unknown) =>
        err instanceof IndexerRouteError &&
        err instanceof IndexerUnavailableError &&
        /does not serve/.test(err.message),
    )
  }
})

test('a 404 whose body cannot be read is a defect, never a confident "nothing there"', async () => {
  for (const body of ['<html>gateway</html>', {}, { error: {} }, { error: { code: 7 } }]) {
    const { client } = clientWith(404, body)
    await assert.rejects(
      () => client.token('ember', 'testnet', TOKEN),
      (err: unknown) => err instanceof IndexerRouteError,
      JSON.stringify(body),
    )
  }
})

test('a real outage is an outage, and is NOT a route error', async () => {
  // The distinction the subclass exists for: somebody else's incident, which retrying fixes,
  // versus our own wrong path, which it never will.
  for (const status of [500, 502, 503]) {
    const { client } = clientWith(status, { error: { code: 'internal' } })
    await assert.rejects(
      () => client.token('ember', 'testnet', TOKEN),
      (err: unknown) => err instanceof IndexerUnavailableError && !(err instanceof IndexerRouteError),
      String(status),
    )
  }
})

/* ------------------------------------------------------------------ what reaches the page */

test('an observation is passed through as the chain reported it', async () => {
  const { client } = clientWith(200, {
    contractAddress: TOKEN,
    name: 'Forge',
    symbol: 'FRG',
    decimals: 18,
    totalSupply: '12000000000000000000000000',
    cap: null,
    owner: `0x${'0'.repeat(40)}`,
    mintAuthority: false,
    paused: false,
    observedAtBlock: 98,
  })
  const observed = await client.token('ember', 'testnet', TOKEN)
  assert.equal(observed?.mintAuthority, false)
  // A decimal STRING. `BigInt(onchain.totalSupply)` in `projectpages.ts` throws on a JSON
  // number that has already lost its low digits, and a supply that renders wrong is the whole
  // reason this comes from the chain rather than from the order.
  assert.equal(typeof observed?.totalSupply, 'string')
  assert.equal(observed?.observedAtBlock, 98)
})
