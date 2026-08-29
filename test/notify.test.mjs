/**
 * dsh-pwa-notify host-side tests. Pure functions + route handlers driven with
 * mock req/res — no live DSH session, no server socket (creating one would
 * burn real tokens; the workspace hard rule).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPushState } from '../src/webpush.js'
import {
  decideNotification,
  renderTemplate,
  renderTexts,
  DEFAULT_TEXTS,
  TEST_SAMPLES,
  assistantText,
  turnSummary,
  pendingQuestionText,
  sameOriginPost,
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

// --- HTTP helpers -----------------------------------------------------------

test('sameOriginPost port: origin/host match, mismatch, and sec-fetch fallback', () => {
  assert.equal(sameOriginPost({ headers: { origin: 'http://x:1', host: 'x:1' } }), true)
  assert.equal(sameOriginPost({ headers: { origin: 'http://evil', host: 'x:1' } }), false)
  assert.equal(sameOriginPost({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(sameOriginPost({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(sameOriginPost({ headers: {} }), false)
})

// --- texts + toggles ----------------------------------------------------------

test('renderTemplate replaces tokens; unknown/empty vars render empty', () => {
  assert.equal(renderTemplate('{tool} 需要授权', { tool: 'bash' }), 'bash 需要授权')
  assert.equal(renderTemplate('{question}', { question: '' }), '')
  assert.equal(renderTemplate('a {nope} b', {}), 'a  b')
})

test('renderTexts: defaults, user overrides, summary gating, clipping', () => {
  // default approval body with tool
  let t = renderTexts('approval', { toolName: 'bash' }, {})
  assert.equal(t.title, DEFAULT_TEXTS.approvalTitle)
  assert.equal(t.body, 'bash 需要授权才能继续')
  // no tool -> fixed fallback
  t = renderTexts('approval', {}, {})
  assert.equal(t.body, '有操作需要授权才能继续')
  // custom template wins
  t = renderTexts('approval', { toolName: 'bash' }, { texts: { approvalTitle: '审批 {tool}', approvalBody: '请处理 {tool}' } })
  assert.equal(t.title, '审批 bash')
  assert.equal(t.body, '请处理 bash')
  // question: summary off -> fixed hint even with input
  t = renderTexts('question', { question: '哪个？' }, {})
  assert.equal(t.body, '智能体提了一个问题，正在等你回答')
  // summary on -> template renders the question
  t = renderTexts('question', { question: '哪个？' }, { includeSummary: true })
  assert.equal(t.body, '哪个？')
  // turn-end: summary on, custom template, clip long
  t = renderTexts('turn-end', { summary: 'x'.repeat(300) }, { includeSummary: true, texts: { turnBody: '{summary}!' } })
  assert.equal(t.body.length, 200)
  assert.ok(t.body.endsWith('!') === false || t.body.length <= 200)
})

test('decideNotification honors toggles and custom texts', () => {
  assert.equal(decideNotification({ kind: 'approval', now: 1, lastSent: 0 }, { ...CFG, approvalEnabled: false }).reason, 'approval-disabled')
  assert.equal(decideNotification({ kind: 'question', now: 1, lastSent: 0 }, { ...CFG, questionEnabled: false }).reason, 'question-disabled')
  const d = decideNotification(
    { kind: 'approval', now: 1, lastSent: 0, toolName: 'bash' },
    { ...CFG, texts: { approvalTitle: '要授权啦' } },
  )
  assert.equal(d.title, '要授权啦')
  // legacy CFG without the new keys keeps old behavior (backwards compat)
  assert.equal(decideNotification({ kind: 'approval', now: 1, lastSent: 0, toolName: 'bash' }, CFG).body, 'bash 需要授权才能继续')
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

test('handleTest: same-origin enforced, bad JSON rejected, pushes via broadcast', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-notify-'))
  try {
    const push = createPushState({ stateFile: join(dir, 'state.json') })

    const res403 = mockRes()
    await handleTest(push, null, mockReq({ method: 'POST', url: `${BASE}/test`, headers: { origin: 'http://evil', host: 'ok' }, body: '{}' }), res403)
    assert.equal(res403.state.status, 403)

    // No subscriptions: broadcast is a clean no-op reporting sent: 0.
    const resOk = mockRes()
    await handleTest(
      push,
      null,
      mockReq({
        method: 'POST',
        url: `${BASE}/test`,
        headers: { origin: 'http://ok:1', host: 'ok:1' },
        body: JSON.stringify({ title: '嗨', body: '测试' }),
      }),
      resOk,
    )
    assert.equal(resOk.state.status, 200)
    assert.equal(JSON.parse(resOk.state.body).sent, 0)

    const resBad = mockRes()
    await handleTest(
      push,
      null,
      mockReq({ method: 'POST', url: `${BASE}/test`, headers: { origin: 'http://ok:1', host: 'ok:1' }, body: 'not json' }),
      resBad,
    )
    assert.equal(resBad.state.status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handleRoute: 404 unknown, sw.js carries Service-Worker-Allowed, manifest served', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-notify-'))
  try {
    const push = createPushState({ stateFile: join(dir, 'state.json') })

    const res404 = mockRes()
    await handleRoute(push, null, mockReq({ url: `${BASE}/nope.png` }), res404)
    assert.equal(res404.state.status, 404)

    const resSw = mockRes()
    await handleRoute(push, null, mockReq({ url: `${BASE}/sw.js` }), resSw)
    assert.equal(resSw.state.status, 200)
    assert.equal(resSw.state.headers['service-worker-allowed'], '/')
    assert.equal(resSw.state.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal(resSw.state.headers['cache-control'], 'no-cache')
    assert.ok(resSw.state.body.includes('notificationclick'))
    assert.ok(resSw.state.body.includes('push'))

    const resManifest = mockRes()
    await handleRoute(push, null, mockReq({ url: `${BASE}/manifest.json` }), resManifest)
    assert.equal(resManifest.state.status, 200)
    assert.equal(resManifest.state.headers['content-type'], 'application/manifest+json; charset=utf-8')
    const manifest = JSON.parse(resManifest.state.body)
    assert.equal(manifest.display, 'standalone')
    assert.ok(manifest.icons.length >= 2)

    const resIcon = mockRes()
    await handleRoute(push, null, mockReq({ url: `${BASE}/icon-192.png` }), resIcon)
    assert.equal(resIcon.state.status, 200)
    assert.equal(resIcon.state.headers['content-type'], 'image/png')
    assert.equal(resIcon.state.body.subarray(1, 4).toString('ascii'), 'PNG')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
