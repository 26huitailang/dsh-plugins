/**
 * Integration harness for the Host half: imports the real plugin entry,
 * provides a mock Cordis context, and exercises the fetch routes + AI tracking
 * against the live df/diskutil/JXA output of the current machine.
 *
 * macOS only (the collector runs /bin/df, /usr/sbin/diskutil, /usr/bin/osascript).
 * Not part of the installed package; run with `node .tools/harness-host.mjs`.
 */
import assert from 'node:assert/strict'
import { apply } from '../disk-doctor/index.js'

const disposers = []
const listeners = new Map()
const routes = new Map()
const calls = { create: [], prompt: [] }
let promptSignal = null

const services = {
  sessionController: {
    async create(request) {
      calls.create.push(request)
      return { sessionId: 'sess-test-1' }
    },
    async prompt(request, signal) {
      calls.prompt.push(request)
      promptSignal = signal
      return { accepted: true }
    },
  },
}

const ctx = {
  effect(fn) {
    const d = fn()
    disposers.push(typeof d === 'function' ? d : () => {})
    return d
  },
  on(name, fn) {
    listeners.set(name, fn)
    return () => {}
  },
  get(name) {
    return services[name]
  },
  logger: { info() {}, warn() {}, error() {} },
  connection: {
    fetch: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  },
}

apply(ctx, {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function call(path, method, body) {
  const route = routes.get(path)
  assert.ok(route, `route registered: ${path}`)
  assert.ok(route.methods.includes(method), `${path} accepts ${method}`)
  const init = { method }
  if (body !== undefined) init.body = JSON.stringify(body)
  return route.fetch(new Request(`http://local${path}`, init))
}

// Wait for the startup sample (real df + diskutil commands).
for (let i = 0; i < 100; i += 1) {
  const view = await (await call('/api/disk-doctor.snapshot', 'GET')).json()
  if (view.snapshot !== null) break
  await sleep(100)
}

const view = await (await call('/api/disk-doctor.snapshot', 'GET')).json()
assert.equal(view.ok, true)
assert.ok(view.snapshot, 'snapshot collected from the real machine')
assert.ok(view.snapshot.totalBytes > 1e11, 'total bytes sane')
assert.ok(view.snapshot.freeBytes > 1e10, 'free bytes sane')
assert.ok(view.snapshot.freeBytes < view.snapshot.totalBytes, 'free < total')
assert.equal(view.snapshot.usedBytes, view.snapshot.totalBytes - view.snapshot.freeBytes)
assert.ok(Math.abs(view.snapshot.percentUsed + view.snapshot.freePercent - 100) < 0.2)
// Volume metadata is machine-dependent: APFS macOS usually reports a name and
// `apfs`, but the contract allows null when diskutil is unavailable.
assert.ok(view.snapshot.volumeName === null || typeof view.snapshot.volumeName === 'string')
assert.ok(view.snapshot.fileSystem === null || view.snapshot.fileSystem === 'apfs')
assert.ok(typeof view.snapshot.finderAvailableBytes === 'number', 'finderAvailableBytes probed live')
assert.ok(view.snapshot.finderAvailableBytes >= view.snapshot.freeBytes, 'finder available >= raw free')
assert.ok(typeof view.snapshot.purgeableBytes === 'number', 'purgeableBytes present')
assert.ok(
  view.snapshot.purgeableBytes === view.snapshot.finderAvailableBytes - view.snapshot.freeBytes,
  'purgeable = finder available - raw free',
)
const { formatGb } = await import('../disk-doctor/lib/view.js')
assert.equal(formatGb(994662584320), '994.7', 'decimal GB formatting')
assert.equal(formatGb(67795099648), '67.8', 'decimal GB formatting of raw free')
assert.equal(view.ai.status, 'idle')
assert.ok(Array.isArray(view.history) && view.history.length >= 1)
const lastHistory = view.history[view.history.length - 1]
assert.ok(typeof lastHistory.finderAvailableBytes === 'number', 'history row carries finder availability')
assert.equal(lastHistory.totalBytes, view.snapshot.totalBytes)
assert.ok(!JSON.stringify(view.history).includes('undefined'), 'history JSON has no undefined')
assert.ok(view.generatedAt > 0)
assert.ok(!JSON.stringify(view).includes('undefined'), 'view JSON has no undefined')

// POST collect is scripted and returns the view; the sample count grows.
const collected = await (await call('/api/disk-doctor.collect', 'POST', {})).json()
assert.equal(collected.ok, true)
assert.ok(collected.history.length >= view.history.length)
const malformed = await (await routes
  .get('/api/disk-doctor.collect')
  .fetch(new Request('http://local/api/disk-doctor.collect', { method: 'POST', body: '{bad' }))).json()
assert.equal(malformed.ok, false)
assert.equal(malformed.error.code, 'bad-request')

// POST inspect starts one session with a Chinese structured prompt.
const inspect = await (await call('/api/disk-doctor.inspect', 'POST', {})).json()
assert.equal(inspect.ok, true)
assert.equal(inspect.sessionId, 'sess-test-1')
assert.equal(calls.create.length, 1)
assert.equal(calls.prompt.length, 1)
const prompt = calls.prompt[0]
assert.equal(prompt.sessionId, 'sess-test-1')
assert.equal(prompt.mode, 'queue')
assert.equal(prompt.content.length, 1)
assert.equal(prompt.content[0].type, 'text')
assert.ok(prompt.content[0].text.includes('清理建议'))
assert.ok(prompt.content[0].text.includes('GB'))
assert.ok(prompt.content[0].text.includes('macOS'))
assert.ok(typeof prompt.requestId === 'string' && prompt.requestId.length > 10)
assert.ok(promptSignal && typeof promptSignal.throwIfAborted === 'function')

const busy = await (await call('/api/disk-doctor.inspect', 'POST', {})).json()
assert.equal(busy.ok, false, 'second inspection while running is refused')
assert.equal(busy.error.code, 'busy')
assert.equal(calls.create.length, 1, 'busy guard starts no second session')

// Simulate the tracked session's events through the registered listener.
const emit = listeners.get('session/event')
assert.ok(typeof emit === 'function', 'session/event listener registered')
const event = (type, data, time = Date.now()) => ({ type, time, seq: 1, data })
emit({ id: 'other-session' }, event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'wrong session' }] } }))
emit({ id: 'sess-test-1' }, event('turn/start', { turn: 1 }))
emit({ id: 'sess-test-1' }, event('assistant/message', {
  turn: 1,
  step: 2,
  message: { content: [{ type: 'reasoning', text: '...' }, { type: 'text', text: '结论：可释放约 40 GB。\n\n1. ~/Library/Caches — 建议清理' }] },
}))
const midView = await (await call('/api/disk-doctor.snapshot', 'GET')).json()
assert.equal(midView.ai.status, 'running')
assert.match(midView.ai.report.text, /可释放约 40 GB/)

emit({ id: 'sess-test-1' }, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
const doneView = await (await call('/api/disk-doctor.snapshot', 'GET')).json()
assert.equal(doneView.ai.status, 'done')
assert.ok(doneView.ai.finishedAt > 0)
assert.equal(doneView.ai.sessionId, 'sess-test-1')

// Unload: every disposer runs, no timers or children remain owned by the plugin.
for (const d of disposers.reverse()) d()
await sleep(50)

console.log('HARNESS OK')
console.log(JSON.stringify({
  snapshot: {
    volumeName: view.snapshot.volumeName,
    totalGb: (view.snapshot.totalBytes / 1024 ** 3).toFixed(1),
    usedGb: (view.snapshot.usedBytes / 1024 ** 3).toFixed(1),
    freeGb: (view.snapshot.freeBytes / 1024 ** 3).toFixed(1),
    percentUsed: view.snapshot.percentUsed,
    freePercent: view.snapshot.freePercent,
  },
  history: collected.history.length,
  promptFirstLines: prompt.content[0].text.split('\n').slice(0, 3),
  ai: { status: doneView.ai.status, reportChars: doneView.ai.report.text.length },
  routes: [...routes.keys()],
  disposers: disposers.length,
}, null, 2))
