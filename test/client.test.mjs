/**
 * dsh-pwa-notify client-side smoke tests. Boots the real src/client.js
 * factory inside a stubbed browser sandbox (no jsdom, no deps — plain
 * objects + node:crypto), renders the Settings 通知推送 card with a React
 * stub, and CLICKS every wired control. Guards the class of accident where
 * the v0.8.0 card cutover deleted a function (requestPermissionInGesture)
 * while enablePush still called it: every first-time opt-in then died as a
 * ReferenceError inside the click handler — "button does nothing".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const CLIENT_SRC = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const BASE = '/_dsh/pwa-notify'
const ENDPOINT = 'https://push.example/dsh-test-sub/1'
const VAPID_B64 = Buffer.concat([Buffer.from([0x04]), randomBytes(64)]).toString('base64url')

// ---- stubs ---------------------------------------------------------------

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => () => {},
}

/** Boot the real client module. `perm` seeds Notification.permission,
 * `promptResult` is what a requestPermission() prompt returns. */
function bootClient({ perm = 'default', promptResult = 'granted' } = {}) {
  const loadCalls = []
  const calls = [] // recorded fetches
  let prompts = 0
  const reg = {
    scope: '/',
    pushManager: {
      getSubscription: async () => null,
      subscribe: async (opts) => {
        assert.equal(opts.userVisibleOnly, true)
        assert.equal(opts.applicationServerKey.length, 65, 'VAPID key decoded to 65 bytes')
        return { toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'k', auth: 'a' } }) }
      },
    },
  }
  const navigator = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) dsh-test',
    serviceWorker: {
      register: async () => reg,
      ready: Promise.resolve(reg),
      getRegistration: async () => null,
    },
  }
  const route = (url) => {
    if (url.endsWith('/subscribe')) return { ok: true }
    if (url.endsWith('/test')) return { ok: true, sent: 1, title: '测试' }
    if (url.endsWith('/devices')) return { ok: true, devices: [] }
    if (url.endsWith('/devices/remove')) return { ok: true, removed: true }
    return { ok: false }
  }
  const sandbox = {
    console,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    location: { search: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      readyState: 'complete',
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      head: { appendChild() {} },
    },
    navigator,
    fetch: (url, opts = {}) => {
      calls.push({ url, opts })
      return Promise.resolve({ ok: true, json: async () => route(url) })
    },
    window: {
      isSecureContext: true,
      navigator,
      PushManager: function PushManager() {},
      Notification: {
        permission: perm,
        requestPermission: async () => {
          prompts += 1
          return promptResult
        },
      },
      __ModuleLoader__: { load: (def) => loadCalls.push(def) },
      __DSH_PWA_NOTIFY_VAPID__: VAPID_B64,
    },
  }
  new Function('sandbox', `with (sandbox) {\n${CLIENT_SRC}\n}`)(sandbox)
  const mod = loadCalls[0].factory(() => reactStub)
  // `prompts` must be read through a getter — a plain property would
  // snapshot the value (0) at boot instead of tracking the live counter.
  return { mod, sandbox, calls, get prompts() { return prompts } }
}

/** Run apply() with a fake cordis ctx; returns what slots.register got. */
function applyToSettings(mod) {
  let slot = null
  mod.apply({
    slots: {
      inject: (name, body) => { slot = body() },
      register: (config, comp) => ({ config, comp }),
    },
    settingsScope: { bind: () => () => ({}) },
    effect: (fn) => {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
  })
  return slot
}

const scopeStub = {
  getSnapshot: () => ({ status: 'ready', value: { approvalPush: true, turnEndPush: false } }),
  subscribe: () => () => {},
  set: async () => {},
}

function walk(node, visit) {
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  if (node && typeof node === 'object') {
    visit(node)
    walk(node.children, visit)
  }
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf(node.children)
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return ''
}

function buttonsOf(tree) {
  const out = []
  walk(tree, (n) => { if (n.type === 'button') out.push({ text: textOf(n), onClick: n.props.onClick }) })
  return out
}

async function drain() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

// --- opt-in path -----------------------------------------------------------

test('开启通知 click with default permission prompts then POSTs subscribe (v0.8.0 regression)', async () => {
  const boot = bootClient({ perm: 'default', promptResult: 'granted' })
  const { mod, sandbox, calls } = boot
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'settingsScope'])

  const slot = applyToSettings(mod)
  assert.equal(slot.config.name, 'settings.section')
  const tree = slot.comp({ scope: scopeStub })

  // The exact state the deleted-and-re-added PWA lands in: permission
  // 'default', so the card must offer an ENABLED 开启通知 button.
  const optIn = buttonsOf(tree).find((b) => b.text === '开启通知')
  assert.ok(optIn, 'card renders the 开启通知 button')
  assert.equal(typeof optIn.onClick, 'function', 'button is wired (not greyed out)')

  // Click every wired control in the card: any dangling function reference
  // anywhere in a handler throws here (this is what v0.8.0 broke).
  assert.doesNotThrow(() => {
    walk(tree, (n) => {
      if (n.props && typeof n.props.onClick === 'function') n.props.onClick()
      if (n.type === 'input' && typeof n.props.onChange === 'function') {
        n.props.onChange({ target: { checked: true } })
      }
    })
  })
  await drain()

  assert.equal(boot.prompts, 1, 'one permission prompt from the click gesture')
  const sub = calls.find((c) => c.url === BASE + '/subscribe')
  assert.ok(sub, 'subscribe POST reached the host')
  const body = JSON.parse(sub.opts.body)
  assert.equal(body.subscription.endpoint, ENDPOINT)
  assert.ok(body.device.label.startsWith('Mac'), 'device label derived from UA')
  assert.equal(sandbox.window.__DSH_PWA_NOTIFY__.status().pushSubscribed, true)
})

// --- resync path -----------------------------------------------------------

test('permission already granted: silent resync at boot, 重新连接 needs no prompt', async () => {
  const boot = bootClient({ perm: 'granted' })
  const { mod, sandbox, calls } = boot
  const slot = applyToSettings(mod)
  const tree = slot.comp({ scope: scopeStub })
  const reconnect = buttonsOf(tree).find((b) => b.text === '重新连接')
  assert.ok(reconnect, 'granted-but-unsubscribed renders the 重新连接 button')
  assert.equal(typeof reconnect.onClick, 'function')
  await drain()
  assert.ok(calls.some((c) => c.url === BASE + '/subscribe'), 'boot resync subscribed')
  assert.equal(boot.prompts, 0, 'resync never re-prompts')
  assert.equal(sandbox.window.__DSH_PWA_NOTIFY__.status().pushSubscribed, true)
})

// --- denied path -----------------------------------------------------------

test('prompt denied: no subscribe POST, click stays non-fatal', async () => {
  const boot = bootClient({ perm: 'default', promptResult: 'denied' })
  const slot = applyToSettings(boot.mod)
  const tree = slot.comp({ scope: scopeStub })
  const optIn = buttonsOf(tree).find((b) => b.text === '开启通知')
  assert.doesNotThrow(() => optIn.onClick())
  await drain()
  assert.ok(!boot.calls.some((c) => c.url === BASE + '/subscribe'), 'no subscribe after denial')
})
