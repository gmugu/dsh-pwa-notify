/**
 * dsh-pwa-notify host-side tests. Pure functions + route handlers driven with
 * mock req/res — no live DSH session, no server socket (creating one would
 * burn real tokens; the workspace hard rule).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideNotification,
  assistantText,
  turnSummary,
  pendingQuestionText,
  createNotifyStore,
  sameOriginPost,
  handlePoll,
  handleTest,
  handleRoute,
  BASE,
} from '../src/index.js'

const CFG = { turnEndEnabled: false, debounceMs: 15000, includeSummary: false }
const CFG_ON = { ...CFG, turnEndEnabled: true, includeSummary: true }

// --- decideNotification -----------------------------------------------------

test('approval always notifies, exempt from debounce', () => {
  const d = decideNotification(
    { kind: 'approval', now: 1000, lastSent: 999, toolName: 'bash' },
    CFG,
  )
  assert.equal(d.shouldNotify, true)
  assert.equal(d.reason, 'approval-pending')
  assert.match(d.body, /bash/)
})

test('question notifies; summary body only when includeSummary', () => {
  const plain = decideNotification({ kind: 'question', now: 1, lastSent: 0, question: '用哪个？' }, CFG)
  assert.equal(plain.shouldNotify, true)
  assert.equal(plain.body, '智能体提了一个问题，正在等你回答')

  const rich = decideNotification(
    { kind: 'question', now: 1, lastSent: 0, question: '用哪个？' },
    CFG_ON,
  )
  assert.equal(rich.body, '用哪个？')
})

test('turn-end: off by default, subagent never, debounced suppressed, top-level passes', () => {
  assert.equal(decideNotification({ kind: 'turn-end', now: 1, lastSent: 0 }, CFG).reason, 'turn-end-disabled')
  assert.equal(
    decideNotification({ kind: 'turn-end', now: 1, lastSent: 0, delegationDepth: 1 }, CFG_ON).reason,
    'subagent',
  )
  // absent delegationDepth on a present header means top level (0);
  // now must clear the debounce window
  assert.equal(decideNotification({ kind: 'turn-end', now: 60000, lastSent: 0 }, CFG_ON).shouldNotify, true)
  assert.equal(
    decideNotification({ kind: 'turn-end', now: 10000, lastSent: 1, delegationDepth: 0 }, CFG_ON).reason,
    'debounced',
  )
  const ok = decideNotification(
    { kind: 'turn-end', now: 60000, lastSent: 1, delegationDepth: 0, summary: '做完了' },
    CFG_ON,
  )
  assert.equal(ok.shouldNotify, true)
  assert.equal(ok.body, '做完了')
})

// --- summary helpers --------------------------------------------------------

test('assistantText takes text blocks only (reasoning excluded), clipped to 120', () => {
  assert.equal(assistantText('hello'), 'hello')
  assert.equal(
    assistantText({ content: [{ type: 'reasoning', text: 'thinking...' }, { type: 'text', text: 'answer' }] }),
    'answer',
  )
  const long = 'x'.repeat(300)
  assert.equal(assistantText(long).length, 120)
})

test('turnSummary prefers final text, falls back to tool name, stops at turn boundary', () => {
  const events = [
    { type: 'tool/call', data: { turn: 1, name: 'bash' } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '第一轮' }] } } },
    { type: 'tool/call', data: { turn: 2, name: 'read' } },
    { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'reasoning', text: '嗯' }] } } },
  ]
  assert.equal(turnSummary(events, 2), '最后执行了 read')
  // The walk starts at the log's end and stops at the first turn boundary,
  // so only the CLOSING turn can be summarized — an older turn yields ''.
  assert.equal(turnSummary(events, 1), '')
  assert.equal(turnSummary('nope', 1), '')
})

test('pendingQuestionText parses best-effort', () => {
  assert.equal(pendingQuestionText('{"questions":[{"question":"哪个？"}]}'), '哪个？')
  assert.equal(pendingQuestionText('not json'), '')
  assert.equal(pendingQuestionText('{"questions":[]}'), '')
})

// --- notification store -----------------------------------------------------

test('store: sequence monotonic, since filter, TTL expiry, cap overflow', async () => {
  const store = createNotifyStore({ ttlMs: 50, cap: 3 })
  const s1 = store.push('approval', 'a', '', 't1')
  store.push('approval', 'b', '', 't2')
  const s3 = store.push('approval', 'c', '', 't3')
  assert.equal(s3, s1 + 2)

  let poll = store.poll(0)
  assert.equal(poll.items.length, 3)
  assert.equal(poll.seq, s3)

  poll = store.poll(s1)
  assert.equal(poll.items.length, 2)

  // TTL: after expiry nothing older than the window is delivered
  await sleep(60)
  poll = store.poll(0, Date.now())
  assert.equal(poll.items.length, 0)

  // cap: overflow drops oldest
  const big = createNotifyStore({ ttlMs: 60000, cap: 3 })
  for (let i = 0; i < 5; i++) big.push('test', String(i), '', 't')
  assert.equal(big.poll(0).items.length, 3)
  assert.equal(big.poll(0).items[0].title, '2')
})

test('store: activeClients tracks recent pollers only', () => {
  const store = createNotifyStore()
  assert.equal(store.activeClients(), 0)
  store.seenClient('a')
  store.seenClient('b')
  assert.equal(store.activeClients(), 2)
  assert.equal(store.activeClients(Date.now() + 60000), 0)
})

// --- HTTP helpers -----------------------------------------------------------

test('sameOriginPost port: origin/host match, mismatch, and sec-fetch fallback', () => {
  assert.equal(sameOriginPost({ headers: { origin: 'http://x:1', host: 'x:1' } }), true)
  assert.equal(sameOriginPost({ headers: { origin: 'http://evil', host: 'x:1' } }), false)
  assert.equal(sameOriginPost({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(sameOriginPost({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(sameOriginPost({ headers: {} }), false)
})

// --- route handlers ---------------------------------------------------------

function mockRes() {
  const state = { status: 0, headers: {}, body: null, ended: false }
  return {
    state,
    setHeader(k, v) {
      state.headers[k.toLowerCase()] = v
    },
    writeHead(code) {
      state.status = code
    },
    end(bytes) {
      state.ended = true
      state.body = bytes
    },
    destroy() {},
  }
}

function mockReq({ method = 'GET', url = '/', headers = {}, body = null }) {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    on(ev, cb) {
      ;(listeners[ev] ??= []).push(cb)
    },
    destroy() {},
  }
  if (body !== null) {
    // Deliver the body after the handler has registered its listeners.
    queueMicrotask(() => {
      for (const cb of listeners.data ?? []) cb(Buffer.from(body))
      for (const cb of listeners.end ?? []) cb()
    })
  }
  return req
}

test('handlePoll: baseline reports seq, cid tracked, method enforced', async () => {
  const store = createNotifyStore()
  store.push('test', 'one', '', 't')

  const res = mockRes()
  await handlePoll(store, mockReq({ url: `${BASE}/poll?since=0&cid=abc` }), res)
  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['cache-control'], 'no-store')
  const data = JSON.parse(res.state.body)
  assert.equal(data.ok, true)
  assert.equal(data.items.length, 1)
  assert.equal(store.activeClients(), 1)

  const res405 = mockRes()
  await handlePoll(store, mockReq({ method: 'POST', url: `${BASE}/poll` }), res405)
  assert.equal(res405.state.status, 405)
})

test('handleTest: same-origin enforced, body capped, enqueues test item', async () => {
  const store = createNotifyStore()

  const res403 = mockRes()
  await handleTest(store, mockReq({ method: 'POST', url: `${BASE}/test`, headers: { origin: 'http://evil', host: 'ok' }, body: '{}' }), res403)
  assert.equal(res403.state.status, 403)

  const resOk = mockRes()
  await handleTest(
    store,
    mockReq({
      method: 'POST',
      url: `${BASE}/test`,
      headers: { origin: 'http://ok:1', host: 'ok:1' },
      body: JSON.stringify({ title: '嗨', body: '测试' }),
    }),
    resOk,
  )
  assert.equal(resOk.state.status, 200)
  const polled = store.poll(0)
  assert.equal(polled.items.length, 1)
  assert.equal(polled.items[0].kind, 'test')
  assert.equal(polled.items[0].title, '嗨')

  const resBad = mockRes()
  await handleTest(
    store,
    mockReq({ method: 'POST', url: `${BASE}/test`, headers: { origin: 'http://ok:1', host: 'ok:1' }, body: 'not json' }),
    resBad,
  )
  assert.equal(resBad.state.status, 400)
})

test('handleRoute: 404 unknown, sw.js carries Service-Worker-Allowed, manifest served', async () => {
  const store = createNotifyStore()

  const res404 = mockRes()
  await handleRoute(store, mockReq({ url: `${BASE}/nope.png` }), res404)
  assert.equal(res404.state.status, 404)

  const resSw = mockRes()
  await handleRoute(store, mockReq({ url: `${BASE}/sw.js` }), resSw)
  assert.equal(resSw.state.status, 200)
  assert.equal(resSw.state.headers['service-worker-allowed'], '/')
  assert.equal(resSw.state.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(resSw.state.headers['cache-control'], 'no-cache')
  assert.ok(resSw.state.body.includes('notificationclick'))

  const resManifest = mockRes()
  await handleRoute(store, mockReq({ url: `${BASE}/manifest.json` }), resManifest)
  assert.equal(resManifest.state.status, 200)
  assert.equal(resManifest.state.headers['content-type'], 'application/manifest+json; charset=utf-8')
  const manifest = JSON.parse(resManifest.state.body)
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.icons.length >= 2)

  const resIcon = mockRes()
  await handleRoute(store, mockReq({ url: `${BASE}/icon-192.png` }), resIcon)
  assert.equal(resIcon.state.status, 200)
  assert.equal(resIcon.state.headers['content-type'], 'image/png')
  assert.equal(resIcon.state.body.subarray(1, 4).toString('ascii'), 'PNG')
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
