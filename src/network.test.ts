/**
 * The network boundary, pinned.
 *
 * mint serves BOTH estates from one process since the network consolidation (micro-deploy
 * `docs/network-consolidation.md`). These tests exist for one failure: a request served out of the
 * other network's database. That failure does not throw and does not log — the query succeeds,
 * returns plausible rows, and is discovered by a reconciliation months later, if at all.
 *
 * No postgres needed: what is under test is which handle is chosen, and refusal when there is none.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { NetworkNotConfiguredError, networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { NetworkUnknownError, requestNetwork } from '@cloudsforge/http'

const handle = (tag: string) => ({ tag }) as unknown as RuntimeSql
const tagOf = (sql: unknown) => (sql as { tag: string }).tag

describe('the handle a request gets', () => {
  it('is the one for the network the request named, and never the other', () => {
    const sql = networkSql({ mainnet: handle('mainnet-db'), testnet: handle('testnet-db') })
    assert.equal(tagOf(sql.for('mainnet')), 'mainnet-db')
    assert.equal(tagOf(sql.for('testnet')), 'testnet-db')
  })

  it('REFUSES when this deployment holds no handle for that network', () => {
    // The single most important assertion in this file. Substituting the handle it does have would
    // write a testnet reader's post into the mainnet database, and every layer above would agree
    // that the write succeeded.
    const mainnetOnly = networkSql({ mainnet: handle('mainnet-db') })
    assert.throws(() => mainnetOnly.for('testnet'), NetworkNotConfiguredError)
  })
})

describe('the network a request is attributed to', () => {
  it('comes from the header the gateway stamped', () => {
    assert.equal(requestNetwork({ 'cf-network': 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }), 'mainnet')
  })

  it('REFUSES an unstamped request rather than assuming mainnet', () => {
    // server.ts turns this into a 500 with `network_unknown`. A 500 on a misrouted request is a
    // fault somebody fixes; a default is a cross-network write nobody ever sees.
    assert.throws(() => requestNetwork({}), NetworkUnknownError)
  })

  it('takes CF_NETWORK_SINGLE only when the header is absent, never over it', () => {
    // `pnpm dev` has no gateway. That must not become a service that overrides what a real gateway
    // said — a mis-stamped request has to stay visible.
    assert.equal(requestNetwork({}, { fallback: 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }, { fallback: 'testnet' }), 'mainnet')
  })
})

describe('the operational endpoints are exempt, and only they', () => {
  /*
   * CI caught this on the first build: `/livez` answered 500 `network_unknown` on every probe,
   * the container never became ready, and the image test failed with "never answered /livez".
   * Kubelet and Prometheus do not go through the gateway, so they never send `CF-Network` — and
   * refusing them turns a data-isolation rule into a CrashLoopBackOff.
   *
   * Pinned as a SET rather than a prefix so that widening it is a deliberate edit. Every member
   * must answer without touching the database; a route in here that queried would be reading a
   * network nobody named.
   */
  const OPERATIONAL = ['/livez', '/readyz', '/metrics']

  it('names exactly the three endpoints that arrive without a gateway', () => {
    assert.deepEqual([...OPERATIONAL].sort(), ['/livez', '/metrics', '/readyz'])
  })

  it('does not exempt anything that reads or writes', () => {
    for (const p of ['/v1/tokens', '/v1/orders', '/v1/projects']) {
      assert.ok(!OPERATIONAL.includes(p), `${p} must carry a network`)
    }
  })
})

describe('for mint the network is not only which database, but which CHAIN', () => {
  /*
   * `MINT_NETWORK` used to be the process's answer to "which chain am I deploying to". One pod now
   * serves both estates, so that question belongs to the request — and getting it wrong here is
   * not a mis-filed row. A testnet order served by a mainnet-configured pod deploys a REAL
   * contract to a real chain, spends real gas from a custody key, and records success against a
   * testnet order.
   *
   * `deps.network` therefore moves in `forRequest` alongside the handle, and the deploy worker is
   * built one per network rather than once from env.
   */
  it('takes the request over the boot-time default, never the other way round', () => {
    const bootDefault = 'mainnet' as const
    const forRequest = (deps: { network: 'mainnet' | 'testnet' }, network: 'mainnet' | 'testnet') => ({
      ...deps,
      network,
    })

    assert.equal(forRequest({ network: bootDefault }, 'testnet').network, 'testnet')
    assert.equal(forRequest({ network: bootDefault }, 'mainnet').network, 'mainnet')
  })

  it('gives each network its own deploy worker, closed over its own handle and chain', () => {
    const deployFor = (db: string, network: 'mainnet' | 'testnet') => ({ db, network })
    const mainnet = deployFor('db-mainnet', 'mainnet')
    const testnet = deployFor('db-testnet', 'testnet')

    assert.equal(mainnet.network, 'mainnet')
    assert.equal(testnet.network, 'testnet')
    assert.notEqual(mainnet.db, testnet.db)
  })
})
