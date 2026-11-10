/**
 * Neon 5cm/s — plugin contract tests.
 *
 * Offline and deterministic: no browser, no DOM, no DSH runtime. The browser
 * half is loaded through a fake `window.__ModuleLoader__`, then `apply()` runs
 * against a fake Cordis context and a fake `theme` service. What is asserted
 * here is exactly the contract the plugin depends on:
 *
 *   - the client module id, Host/manifest/bundle-patch shape and locale metadata;
 *   - `theme.register()` receives `{ id: 'anime', colorScheme: 'dark', tokens }`
 *     with every required alias token and no leftover patch-era tokens;
 *   - activation waits for the stock theme plugin's settings status and then
 *     sets the `anime` preference (the boot race the old script also fixed);
 *   - the plugin-owned effect returns a disposer and restores the previous
 *     preference when the bundle is switched off;
 *   - the sakura button / petal rain keep using the documented DOM attributes
 *     and never reintroduce the hash class names from the old bundle patch.
 *
 * Run with: node tests/contract.test.js
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const CLIENT_SOURCE = readFileSync(join(PACKAGE_DIR, 'client.js'), 'utf8')
const HOST_SOURCE = readFileSync(join(PACKAGE_DIR, 'index.js'), 'utf8')
const PATCH_FILE = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')

// ---------------------------------------------------------------------------
// Tiny harness, same style as disk-doctor's fixture tests.
// ---------------------------------------------------------------------------

const tests = []

/** Register one synchronous test. */
function test(name, fn) {
  tests.push({ name, fn })
}

/** Load client.js and return the module-loader registration. */
function loadClientModule() {
  let registration
  const window = {
    __ModuleLoader__: {
      load(config) {
        registration = config
      },
    },
  }
  // A `vm` realm has its own intrinsics but no timers: the browser half only
  // needs what a browser provides, so pass the host timers through.
  vm.runInNewContext(CLIENT_SOURCE, { window, console, setTimeout, clearTimeout }, { filename: 'client.js' })
  assert.ok(registration, 'client.js must call window.__ModuleLoader__.load()')
  return registration
}

/** Create the fake context/theme pair one plugin instance runs against. */
function createHarness(plugins) {
  const calls = { effectLabels: [], on: [], setTheme: [], get: [] }
  const registered = []
  const snapshot = {
    preference: 'light',
    active: { id: 'light', colorScheme: 'light', tokens: {} },
    themes: [],
    revision: 1,
  }
  const theme = {
    getTheme() {
      return plugins.snapshot ?? snapshot
    },
    setTheme(id) {
      calls.setTheme.push(id)
      const active = id === 'anime' ? registered[registered.length - 1].definition : { id, colorScheme: 'dark', tokens: {} }
      const next = { ...(plugins.snapshot ?? snapshot), preference: id, active }
      plugins.snapshot = next
    },
    register(definition) {
      registered.push({ definition })
      return () => {
        registered.pop()
      }
    },
  }
  const disposers = []
  const settingsForm = {
    getSnapshot: () => plugins.settingsSnapshot ?? { status: 'ready', value: undefined },
    subscribe: (listener) => {
      plugins.settingsListener = listener
      return () => {
        plugins.settingsListener = undefined
      }
    },
  }
  let injectedScope
  const ctx = {
    effect(fn, label) {
      calls.effectLabels.push(label)
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
    on(name) {
      calls.on.push(name)
      return () => {}
    },
    get(name) {
      calls.get.push(name)
      if (name === 'configForms') return { get: () => settingsForm }
      return undefined
    },
    inject(services, callback) {
      // Arrays crossing the vm boundary keep their own prototype: compare elements.
      assert.equal(services.length, 1)
      assert.equal(services[0], 'theme')
      // The injected scope sees the parent services plus the injected `theme`.
      injectedScope = {
        effect: ctx.effect,
        on: ctx.on,
        get: (name) => (name === 'theme' ? theme : ctx.get(name)),
      }
      callback(injectedScope)
    },
  }
  return { ctx, theme, calls, registered, settingsForm, dispose: () => disposers.forEach((dispose) => dispose()) }
}

const THEME_TOKEN_NAMES = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]

// ---------------------------------------------------------------------------
// Manifest and package shape.
// ---------------------------------------------------------------------------

test('package.json declares the DSH bundle and web client half', () => {
  assert.equal(PACKAGE_JSON.name, '@local/neon-5cms-theme')
  assert.equal(PACKAGE_JSON.private, true)
  assert.equal(PACKAGE_JSON.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(PACKAGE_JSON.dsh.client.platform, 'web')
  assert.equal(PACKAGE_JSON.dsh.client.immediately, true)
  assert.ok(
    PACKAGE_JSON.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-theme'),
    'the stock theme package must load before this one',
  )
  assert.ok(PACKAGE_JSON.exports['./client'])
  assert.ok(PACKAGE_JSON.exports['./icon'])
})

test('bundle patch inserts one row that addresses this package', () => {
  assert.match(PATCH_FILE, /id: neon-5cms-theme/)
  assert.match(PATCH_FILE, /name: '@local\/neon-5cms-theme'/)
})

test('locale metadata exists for zh and en', () => {
  for (const language of ['zh', 'en']) {
    const meta = JSON.parse(readFileSync(join(PACKAGE_DIR, 'locale', `${language}.json`), 'utf8'))
    assert.equal(typeof meta.meta.title, 'string')
    assert.ok(meta.meta.title.length > 0)
    assert.equal(typeof meta.meta.description, 'string')
    assert.ok(meta.meta.description.length > 0)
  }
  const zh = JSON.parse(readFileSync(join(PACKAGE_DIR, 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(PACKAGE_DIR, 'locale', 'en.json'), 'utf8'))
  assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort())
})

test('the Host half stays a no-op with no Host dependencies', () => {
  assert.match(HOST_SOURCE, /export function apply\(\)/)
  assert.doesNotMatch(HOST_SOURCE, /^import /m)
  assert.doesNotMatch(HOST_SOURCE, /require\(/)
})

test('the client half is plain JS that requires nothing from other packages', () => {
  assert.match(CLIENT_SOURCE, /window\.__ModuleLoader__\.load\(\{/)
  assert.doesNotMatch(CLIENT_SOURCE, /require\(['"]@deepseek-ai\//)
  assert.doesNotMatch(CLIENT_SOURCE, /^import /m)
})

// ---------------------------------------------------------------------------
// Theme registration and activation.
// ---------------------------------------------------------------------------

test('loader entry points at this package', () => {
  const registration = loadClientModule()
  assert.equal(registration.id, '@local/neon-5cms-theme')
  assert.equal(typeof registration.factory, 'function')
})

test('factory returns a cordis object plugin with an inject list and apply', () => {
  const plugin = loadClientModule().factory()
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(typeof plugin.apply, 'function')
})

test('apply mounts the stylesheet, waits for the theme service and the petal rain', () => {
  const plugins = {}
  const harness = createHarness(plugins)
  const plugin = loadClientModule().factory()
  plugin.apply(harness.ctx)
  assert.deepEqual(harness.calls.effectLabels, [
    'neon-5cms: plugin stylesheet',
    'neon-5cms: theme activation',
    'neon-5cms: pixel petal rain',
  ])
  assert.ok(harness.calls.get.includes('configForms'), 'activation reads the stock theme settings status')
  assert.ok(harness.calls.on.includes('theme/change'), 'activation follows theme changes')
  harness.dispose()
})

test('activation registers the third-party theme, then makes it active', async () => {
  const plugins = { snapshot: undefined }
  const harness = createHarness(plugins)
  const plugin = loadClientModule().factory()
  plugin.apply(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.equal(harness.registered.length, 1)
  const { definition } = harness.registered[0]
  assert.equal(definition.id, 'anime')
  assert.equal(definition.colorScheme, 'dark')
  assert.equal(typeof definition.tokens, 'object')
  for (const token of THEME_TOKEN_NAMES) {
    assert.equal(typeof definition.tokens[token], 'string', `missing theme token ${token}`)
    assert.ok(definition.tokens[token].length > 0)
  }
  assert.match(definition.tokens['--dsw-alias-bg-base'], /^#[0-9a-f]{6}$/i)
  assert.equal(typeof definition.tokens['--dsw-anime-bg-glow'], 'string')
  assert.equal(definition.tokens['--dsw-anime-sakura-send'], undefined, 'the old CSS gate token is gone')
  assert.equal(definition.tokens['--dsw-specific-sidebar-nav-item-hover'], undefined, 'obsolete token removed')
  assert.equal(harness.calls.setTheme[0], 'anime')
  harness.dispose()
})

test('activation waits while the settings document is still loading', async () => {
  const plugins = { settingsSnapshot: { status: 'loading', value: undefined } }
  const harness = createHarness(plugins)
  const plugin = loadClientModule().factory()
  plugin.apply(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(harness.registered.length, 0, 'must not register before the settings document settles')
  assert.deepEqual(harness.calls.setTheme, [])

  plugins.settingsSnapshot = { status: 'ready', value: { preference: 'dark' } }
  plugins.settingsListener()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(harness.registered.length, 1)
  assert.equal(harness.calls.setTheme[0], 'anime')
  harness.dispose()
})

test('switching the bundle off restores the previous preference and unregisters', async () => {
  const plugins = { snapshot: undefined }
  const harness = createHarness(plugins)
  const dispose = loadClientModule()
    .factory()
    .apply(harness.ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(harness.registered.length, 1)

  harness.dispose()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(harness.registered.length, 0, 'theme registration must be disposed')
  // The previous preference was the persisted one seen at activation.
  assert.equal(harness.calls.setTheme[harness.calls.setTheme.length - 1], 'light')
  harness.dispose()
})

// ---------------------------------------------------------------------------
// DOM contract carried by the stylesheet / rain listeners.
// ---------------------------------------------------------------------------

test('the sakura button targets stable composer attributes, not hash classes', () => {
  assert.match(CLIENT_SOURCE, /\[data-composer-seat\] button\[aria-busy\]/)
  assert.match(CLIENT_SOURCE, /:not\(:has\(svg rect\)\):not\(:has\(svg circle\)\)/)
  assert.doesNotMatch(CLIENT_SOURCE, /\.[A-Za-z0-9_-]{6}_primary/, 'old CSS-module hash must not come back')
  assert.doesNotMatch(CLIENT_SOURCE, /uV2eYG_/, 'old CSS-module hash must not come back')
})

test('every plugin-owned style rule is gated on the active-theme attribute', () => {
  const rules = [...CLIENT_SOURCE.matchAll(/^body\[data-anime-theme\][^{]*\{/gm)]
  assert.ok(rules.length >= 5, `expected the gated style rules, found ${rules.length}`)
  const styleBlock = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const STYLES = `'), CLIENT_SOURCE.indexOf('`;\n\n    /** 9×11'))
  const selectors = [...styleBlock.matchAll(/^([^\n{]+)\{/gm)].map((match) => match[1])
  assert.ok(selectors.length > 0)
  for (const selector of selectors) {
    assert.match(selector, /^body\[data-anime-theme\]/, `unexpected ungated rule: ${selector}`)
  }
})

test('the petal rain listens to the composer input and the primary button', () => {
  assert.match(CLIENT_SOURCE, /\[data-composer-input\]/)
  assert.match(CLIENT_SOURCE, /closest\('\[data-composer-seat\] button\[aria-busy\]'\)/)
  assert.match(CLIENT_SOURCE, /prefers-reduced-motion/)
  assert.match(CLIENT_SOURCE, /requestAnimationFrame\(frame\)/)
})

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok - ${name}`)
    console.error(error?.stack ?? error)
  }
}

console.log(`\n${tests.length - failed}/${tests.length} tests passed`)
if (failed > 0) process.exitCode = 1
