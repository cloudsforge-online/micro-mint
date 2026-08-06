#!/usr/bin/env node
/**
 * Does `micro-indexer` serve the paths this service asks it for?
 *
 * ## Why this exists
 *
 * Both methods of `src/indexerclient.ts` spent their whole life requesting paths the indexer has
 * never served. `token()` asked for `/v1/chains/:chain/:network/tokens/:address`, got a 404, and
 * mapped it to null — so every ForgeMint project page rendered its supply and its authorities as
 * "not yet indexed", permanently. Every test passed throughout, because every one of them stubbed
 * the client rather than asking whether the request could reach a route. That is the eighth
 * instance of this shape in the estate (18-build-status §3.3i), and the runtime fix — a 404 with an
 * unexpected code now throws — closes it one deploy too late. This closes it in CI.
 *
 * ## Why it is a script and not a test
 *
 * It needs `micro-indexer` on disk, and `pnpm test` has to pass without it. The estate has already
 * settled this: "an invariant needing a private sibling is a JOB, not a test"
 * (`micro-sdk/.github/workflows/ci.yml`). A test would have to skip, and a skipped test is an
 * unmeasured one. So CI checks the indexer out and runs this, and then MUTATES the checkout and
 * requires this to go red — because a job that grades a file it failed to fetch looks exactly like
 * a job that passed.
 *
 * ## What it reads
 *
 * The indexer's route table is a module-level constant of one-line entries specifically so that it
 * can be read as TEXT (`indexer/src/server.ts`, `DOMAIN`). It is never imported: importing it would
 * mean resolving another repository's `@cloudsforge/*` workspace, and rule 2 of the estate's CI
 * forbids reaching into a sibling checkout from source at all. This is a script, not source, and it
 * reads the file the way a linter would.
 *
 * **Comments are stripped from both files before anything is matched.** The header of
 * `indexerclient.ts` quotes the two dead paths in prose, and six guards in this estate have now
 * fired on their own documentation. A checker that cannot tell a request from a sentence about one
 * is not a checker.
 *
 * Usage: node scripts/checkindexerroutes.mjs --indexer <path to a micro-indexer checkout>
 *                                            [--client src/indexerclient.ts]
 */

import { readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

function arg(name, fallback) {
  const at = argv.indexOf(`--${name}`)
  if (at === -1 || at === argv.length - 1) return fallback
  return argv[at + 1]
}

const indexerRoot = arg('indexer', null)
const clientPath = arg('client', 'src/indexerclient.ts')

if (!indexerRoot) {
  fail('no --indexer path given; this check has no skip path')
}

function fail(message, detail) {
  console.error(`::error::${message}`)
  if (detail) console.error(detail)
  exit(1)
}

/** Block comments and whole-line comments, gone. Nothing else is touched. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    fail(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

/* ------------------------------------------------------------------ what the indexer serves */

const serverPath = `${indexerRoot}/src/server.ts`
const server = code(read(serverPath))

const prefixLine = /const PREFIXES\s*:[^=]*=\s*\[([^\]]*)\]/.exec(server)
if (!prefixLine) {
  fail(`no PREFIXES declaration in ${serverPath} — the route table cannot be read`)
}
const prefixes = [...prefixLine[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
if (prefixes.length === 0) fail(`PREFIXES in ${serverPath} is empty`)

// One entry per line, method and path as single-quoted literals — the shape `server.ts` documents
// as load-bearing precisely so that this can read it.
const entries = [...server.matchAll(/\[\s*'(GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']*)'/g)]
if (entries.length < 5) {
  fail(
    `only ${entries.length} route(s) parsed out of ${serverPath} — the table's shape has changed and this checker is reading nothing`,
  )
}

const served = []
for (const prefix of prefixes) {
  for (const [, method, path] of entries) served.push({ method, path: `${prefix}${path}` })
}

/* ------------------------------------------------------------------ what this service asks for */

const client = code(read(clientPath))
// A request path is a template literal starting with a slash. One literal per path, never
// concatenated: a path split across a `+` arrives here as a fragment and would be silently skipped.
const requested = [...client.matchAll(/`(\/[^`]*)`/g)].map((m) => m[1])
if (requested.length === 0) {
  fail(`no request paths found in ${clientPath} — this checker is reading nothing`)
}

/* ------------------------------------------------------------------ do they agree */

/**
 * A requested path matches a served pattern when they have the same number of segments and every
 * segment agrees: a `:param` accepts anything, a literal must match exactly.
 *
 * **Segment counts are compared, not prefixes.** A prefix check is what let this defect through in
 * the first place: `/v1/chains/ember/testnet/tokens/0x…` starts with `/v1/chains/`, which IS a
 * served prefix, and it is still a path nothing serves.
 *
 * An interpolation is exactly ONE segment, so `${chain}/${network}` written as one placeholder is a
 * path this checker refuses rather than guesses at.
 */
function matches(requestedPath, pattern) {
  const asked = requestedPath.split('/')
  const serves = pattern.split('/')
  if (asked.length !== serves.length) return false
  return serves.every((segment, index) => {
    const mine = asked[index]
    if (segment.startsWith(':')) return mine.length > 0
    return segment === mine
  })
}

/**
 * `${...}` becomes one opaque segment.
 *
 * A helper that expands to TWO segments — one `${scope}` standing for `chain/network` — therefore
 * produces a path one segment short of every pattern, and is refused rather than guessed at. That
 * is deliberate: a checker that accepts a path whose shape it cannot see would have passed the
 * defect it exists to catch.
 */
const placeholder = (path) => path.replace(/\$\{[^}]*\}/g, 'x')

const unserved = []
for (const path of requested) {
  if (!served.some((route) => matches(placeholder(path), route.path))) unserved.push(path)
}

if (unserved.length > 0) {
  fail(
    `this service requests ${unserved.length} path(s) micro-indexer does not serve`,
    [
      ...unserved.map((p) => `  asked for: ${p}`),
      '  served:',
      ...served.map((r) => `    ${r.method} ${r.path}`),
    ].join('\n'),
  )
}

console.log(
  `ok: all ${requested.length} path(s) in ${clientPath} match one of ${served.length} routes micro-indexer serves`,
)
for (const path of requested) console.log(`  ${path}`)
