/**
 * Smoke test for the Host half.
 *
 * Exercises the two routes against the real window, which means the window
 * really does go topmost for a moment and is put back at the end. On anything
 * but Windows there is nothing to exercise, so the run reports skipped.
 *
 * Run with `npm test`.
 */

import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = join(homedir(), '.dsh')
const CONFIG = join(HOME, 'dsh-pin-window.json')
const STATE = join(HOME, 'dsh-pin-window.state.json')

if (process.platform !== 'win32') {
  console.log('smoke: skipped (Windows only)')
  process.exit(0)
}

// Keep the run quiet: no restore flight, and a short idle window.
await writeFile(CONFIG, JSON.stringify({ idleTimeoutMs: 2000, restoreOnStart: false }), 'utf8')
await rm(STATE, { force: true })

const { apply } = await import('../index.js')

const routes = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1',
  },
  get(name) {
    return name === 'webServer' ? this.webServer : undefined
  },
  effect(fn) {
    return fn()
  },
}

apply(ctx)

assert.equal(routes.length, 2, 'expected exactly two routes')
const stateRoute = routes.find((route) => route.path === '/dsh-pin/api/state')
const toggleRoute = routes.find((route) => route.path === '/dsh-pin/api/toggle')
assert.ok(stateRoute, 'state route registered')
assert.ok(toggleRoute, 'toggle route registered')

function respond() {
  const response = { status: 0, body: '' }
  response.writeHead = (status) => {
    response.status = status
  }
  response.end = (text) => {
    response.body = text ?? ''
  }
  return response
}

function postRequest(payload) {
  const body = JSON.stringify(payload ?? {})
  return {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
}

async function call(route, request) {
  const response = respond()
  await route.handler(request, response)
  assert.equal(response.status, 200, 'route answered 200')
  return JSON.parse(response.body || '{}')
}

const initial = await call(stateRoute, { method: 'GET', headers: {} })
assert.equal(initial.supported, true, 'state reports a supported platform')
assert.equal(typeof initial.topmost, 'boolean', 'state carries a boolean')

const first = await call(toggleRoute, postRequest())
assert.equal(first.ok, true, 'first toggle succeeded')
const second = await call(toggleRoute, postRequest())
assert.equal(second.ok, true, 'second toggle succeeded')
assert.notEqual(first.topmost, second.topmost, 'toggle flips the bit')

const cleared = await call(toggleRoute, postRequest({ action: 'off' }))
assert.equal(cleared.ok, true, 'explicit off succeeded')
assert.equal(cleared.topmost, false, 'window is unpinned after the run')

await rm(CONFIG, { force: true })
await rm(STATE, { force: true })

console.log('smoke: ok')
process.exit(0)
