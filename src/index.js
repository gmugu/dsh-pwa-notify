/**
 * dsh-pwa-notify — host half.
 *
 * Turns the DSH Web GUI into an installable PWA and notifies the browser when
 * the agent actually needs its human. Two reference plugins shape this design:
 *
 *   - dsh-zen-remote contributes the notification POLICY (approval/asked with
 *     a grace window, ask_user_question, opt-in turn-end, the notify-tool
 *     throttle) and the PWA asset set (manifest + service worker + icons).
 *     Its transport is a gateway subprocess running the `web-push` library;
 *     here the DSH host itself does REAL VAPID Web Push (src/webpush.js,
 *     RFC 8291 + 8292 hand-rolled on node:crypto) AND serves the PWA files.
 *     Web Push is the ONLY notification transport — the earlier page-poll
 *     fallback channel was removed by design: a push that cannot be sent is
 *     a push that is lost, and the device self-heals by resubscribing the
 *     next time it opens the app.
 *   - dsh-mobile-hanui contributes the packaging: zero npm dependencies, a
 *     plain-JS host entry + client bundle discovered via `dsh.client`, one
 *     `cordis.patch.yml` insert row, no build step.
 *
 * Host responsibilities:
 *   1. serve /_dsh/pwa-notify/{sw.js,manifest.json,icon-*.png} through the
 *      `webServer` service (the SW response carries Service-Worker-Allowed: /
 *      so a script living under /_dsh/pwa-notify/ may control scope "/");
 *   2. inject <link rel="manifest"> + theme-color + the VAPID public key into
 *      index.html through the structured `webserver/index-inject` event;
 *   3. listen to `session/event` + `agent/turn-stopping`, decide notifications
 *      with a pure policy function (exported for tests), and broadcast the
 *      decided ones as aes128gcm-encrypted Web Push to every subscribed device;
 *   4. expose POST /_dsh/pwa-notify/test for the "send a test notification"
 *      button and POST /subscribe + /unsubscribe + GET /vapid for the push
 *      channel;
 *   5. optionally register the `notify_user` model tool (hand-built
 *      ToolDefinition — `defineTool` is a thin schema wrapper, avoiding an
 *      import this package would have to declare as a dependency) plus a
 *      matching system-prompt guidance section.
 *
 * There is deliberately NO fetch handler in the service worker and no caching
 * of DSH's own assets: zen-remote's own postmortem (its sw v2→v3) documents
 * how cache-first JS/CSS breaks a bundle that changes on every deploy without
 * a filename change. This plugin's SW only displays notifications and focuses
 * the window on click.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createPushState } from './webpush.js'

/** All host routes live under this prefix (one `prefix` webServer route). */
export const BASE = '/_dsh/pwa-notify'

/** Push state (VAPID keys + subscriptions) lives beside the DSH config. */
export function defaultStateFile(env = process.env) {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'pwa-notify-state.json')
}

/** Plugin-row config with shipped defaults (see README for the knob table). */
export const DEFAULT_CONFIG = {
  /** Notify on ordinary turn end. Default off — finishing is not needing. */
  turnEnd: false,
  /** How long an approval may sit undecided before it counts as waiting on
   * a human. Auto-answerers (policy hooks, dsh-auto-approve) settle within
   * this window and suppress the notification. 5s covers a model answerer
   * with margin (measured ~2.4s avg on zen-remote). */
  approvalGraceMs: 5000,
  /** Minimum spacing between two automatic turn-end notifications. Approval
   * and question notifications are deliberately exempt — "something is
   * waiting for your OK" must never be swallowed. */
  debounceMs: 15000,
  /** Include the turn's final text (or last tool name) in turn-end bodies. */
  includeSummary: false,
  /** Register the notify_user model tool + prompt guidance. */
  notifyTool: true,
  /** RFC 8292 VAPID contact. Apple REJECTS the placeholder on iOS — set a
   * real mailto: or https: URL (zen-remote ships the same requirement). */
  vapidSubject: 'mailto:admin@localhost',
  /** Web Push switch. Off leaves the local poll channel only. */
  push: true,
}

/** Per-kind push envelope policy: how long a queued push may linger on the
 * push service (TTL seconds) and how insistently the device surfaces it. */
export const PUSH_POLICY = {
  approval: { ttl: 900, urgency: 'high' },
  question: { ttl: 900, urgency: 'high' },
  'turn-end': { ttl: 900, urgency: 'normal' },
  model: { ttl: 900, urgency: 'high' },
  test: { ttl: 60, urgency: 'normal' },
}

/**
 * User-facing settings namespace (`dsh-pwa-notify`), registered with the
 * settings service when one is mounted (the Web composition ships
 * dsh-settings-file): the Settings → 通知推送 card edits these live —
 * no restart. Flat keys on purpose (schemastery + settings UI both stay
 * simple); empty text = shipped default. `turnEndPush`/`includeSummary` are
 * seeded from the plugin-row config as their composition base layer.
 */
export const SettingsSchema = z.object({
  /** Notify when a tool approval is waiting on a human. */
  approvalPush: z.boolean().default(true),
  /** Notify when an ask_user_question is pending. */
  questionPush: z.boolean().default(true),
  /** Notify on ordinary turn end. */
  turnEndPush: z.boolean().default(false),
  /** Fill {question}/{summary} template variables with conversation text. */
  includeSummary: z.boolean().default(false),
  textApprovalTitle: z.string().default(''),
  textApprovalBody: z.string().default(''),
  textQuestionTitle: z.string().default(''),
  textQuestionBody: z.string().default(''),
  textTurnTitle: z.string().default(''),
  textTurnBody: z.string().default(''),
})

/** Body cap for the POST /test payload. */
const TEST_BODY_MAX = 4096

/** The model-facing tool of @deepseek-ai/dsh-tool-ask-user. Its `tool/call`
 * session event is appended BEFORE dispatch and the call then blocks until a
 * human answers — the call event IS the "a question is pending" signal. */
const ASK_USER_TOOL = 'ask_user_question'

const SUMMARY_MAX = 120
const clip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)

// ---------------------------------------------------------------------------
// Pure decision layer (ported from dsh-zen-remote dsh-push.mjs; everything is
// a plain function of its arguments so tests need no live DSH session).
// ---------------------------------------------------------------------------

/** Model-facing TEXT of one assistant message: `type: 'text'` blocks only.
 * Reasoning arrives as `{ type: 'reasoning' }` blocks on the same message;
 * taking every part that owns a `.text` would quote thinking, not answers. */
export function assistantText(message) {
  const c = message && message.content !== undefined ? message.content : message
  if (typeof c === 'string') return clip(c)
  if (!Array.isArray(c)) return ''
  const parts = []
  for (const p of c) {
    if (typeof p === 'string') parts.push(p)
    else if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
  }
  return clip(parts.join(' '))
}

/** Summary of the closing turn, from the session's append-only event log:
 * the LAST assistant message that produced real text, or — when the whole
 * turn was tool work with no prose — the last tool name. Never thinking. */
export function turnSummary(events, turn) {
  if (!Array.isArray(events)) return ''
  let lastTool = ''
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || !ev.data) continue
    // Stop at the turn boundary instead of reaching back into older turns.
    if (turn !== undefined && ev.data.turn !== undefined && ev.data.turn !== turn) break
    if (ev.type === 'assistant/message') {
      const text = assistantText(ev.data.message)
      if (text) return text
    } else if (!lastTool && ev.type === 'tool/call' && typeof ev.data.name === 'string') {
      lastTool = ev.data.name
    }
  }
  return lastTool ? `最后执行了 ${lastTool}` : ''
}

/** First question of an ask_user_question call, from the raw argument string
 * the model produced. Best-effort: garbage in, '' out. */
export function pendingQuestionText(rawArguments) {
  try {
    const q = JSON.parse(String(rawArguments)).questions
    return Array.isArray(q) && q[0] && typeof q[0].question === 'string' ? clip(q[0].question) : ''
  } catch {
    return ''
  }
}

const skip = (reason) => ({ shouldNotify: false, title: '', body: '', reason })

// --- notification texts: defaults + user-override templates ------------------
//
// Users override these through the Settings → 通知推送 card; an override is a
// template with `{tool}` / `{question}` / `{summary}` tokens. An empty
// override falls back to the shipped default. The `question`/`summary`
// variables are only filled when includeSummary is on — the
// no-conversation-content default must survive customization (a template
// without those tokens never leaks content either).

export const DEFAULT_TEXTS = {
  approvalTitle: 'DSH 等你授权',
  approvalBody: '{tool} 需要授权才能继续',
  questionTitle: 'DSH 等你回答',
  questionBody: '{question}',
  turnTitle: 'DSH 任务完成',
  turnBody: '{summary}',
}

/** Replace `{token}` references; unknown/empty variables render empty. */
export function renderTemplate(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''))
}

const TITLE_MAX = 80
const BODY_MAX = 200

/**
 * Titles/bodies for one decided notification, honoring user templates. Pure:
 * everything arrives as arguments — the /test preview and decideNotification
 * share it, and tests drive it directly.
 *
 * @param {string} kind 'approval' | 'question' | 'turn-end'
 * @param {object} input `{ toolName?, question?, summary? }`
 * @param {object} cfg `{ texts?, includeSummary }`
 */
export function renderTexts(kind, input, cfg) {
  const t = (cfg && cfg.texts) || {}
  const pick = (key) => {
    const custom = t[key]
    return typeof custom === 'string' && custom.trim() !== '' ? custom : DEFAULT_TEXTS[key]
  }
  const vars = {
    tool: input.toolName || '',
    question: cfg && cfg.includeSummary ? input.question || '' : '',
    summary: cfg && cfg.includeSummary ? input.summary || '' : '',
  }
  let title
  let body
  if (kind === 'approval') {
    title = renderTemplate(pick('approvalTitle'), vars)
    body = renderTemplate(input.toolName ? pick('approvalBody') : '有操作需要授权才能继续', vars)
  } else if (kind === 'question') {
    title = renderTemplate(pick('questionTitle'), vars)
    body = vars.question !== '' ? renderTemplate(pick('questionBody'), vars) : '智能体提了一个问题，正在等你回答'
  } else {
    title = renderTemplate(pick('turnTitle'), vars)
    body = vars.summary !== '' ? renderTemplate(pick('turnBody'), vars) : '智能体已完成当前回合'
  }
  return { title: title.slice(0, TITLE_MAX), body: body.slice(0, BODY_MAX) }
}

/**
 * The whole notification policy, as one pure function.
 *
 * @param {object} input
 *   kind            'turn-end' | 'approval' | 'question'
 *   now             current epoch ms
 *   lastSent        epoch ms of the previous automatic push (0 for none)
 *   delegationDepth session header's delegationDepth (undefined = top level)
 *   summary         already-extracted turn summary  ('turn-end')
 *   toolName        tool awaiting approval          ('approval')
 *   question        pending question text           ('question')
 * @param {object} cfg { turnEndEnabled, debounceMs, includeSummary,
 *                       approvalEnabled?, questionEnabled?, texts? }
 * @returns {{shouldNotify: boolean, title: string, body: string, reason: string}}
 */
export function decideNotification(input, cfg) {
  const debounced = input.now - input.lastSent < cfg.debounceMs

  switch (input.kind) {
    // Event leg. Exempt from the debounce on purpose: "a tool is waiting for
    // your OK" is the one notification that must never be swallowed. Both
    // toggles default ON and are user-switchable in the settings card.
    case 'approval': {
      if (cfg.approvalEnabled === false) return skip('approval-disabled')
      const texts = renderTexts('approval', input, cfg)
      return { shouldNotify: true, title: texts.title, body: texts.body, reason: 'approval-pending' }
    }
    case 'question': {
      if (cfg.questionEnabled === false) return skip('question-disabled')
      const texts = renderTexts('question', input, cfg)
      return { shouldNotify: true, title: texts.title, body: texts.body, reason: 'question-pending' }
    }

    // Turn end. Opt-in, top-level only, debounced.
    case 'turn-end': {
      if (!cfg.turnEndEnabled) return skip('turn-end-disabled')
      if ((input.delegationDepth ?? 0) !== 0) return skip('subagent')
      if (debounced) return skip('debounced')
      const texts = renderTexts('turn-end', input, cfg)
      return { shouldNotify: true, title: texts.title, body: texts.body, reason: 'turn-end' }
    }

    default:
      return skip('unknown-kind')
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (exported for tests; mock req/res drive them without a server).
// ---------------------------------------------------------------------------

/**
 * Accept a state-changing request only from this DSH Web application's origin.
 * Port of dsh-zen-remote src/index.ts sameOriginPost.
 * @param {import('node:http').IncomingMessage} req
 */
export function sameOriginPost(req) {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

function responseJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(status)
  res.end(bytes)
}

/** Read a capped request body as UTF-8 text; returns null when over budget. */
export function readBody(req, maxBytes = TEST_BODY_MAX) {
  return new Promise((resolve) => {
    const chunks = []
    let received = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (done) return
      received += chunk.length
      if (received > maxBytes) {
        finish(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
  })
}

/** Sample variables for the /test kind preview — what the settings card's
 * per-kind test buttons render the live templates with. */
export const TEST_SAMPLES = {
  approval: { toolName: 'bash（示例）' },
  question: { question: '示例问题：这两个方案你倾向哪个？' },
  'turn-end': { summary: '示例摘要：已修复通知卡片样式并提交（fix: notify-card）' },
}

/** POST {BASE}/test {kind?, title?, body?} — the test buttons.
 * With `kind`, renders that kind's LIVE templates with sample variables, so
 * the settings card previews exactly what a real push would look like;
 * without it, sends the free-form title/body. Response reports the real 2xx
 * accepted count. `getCfg` reads the live settings (apply wires it; tests
 * pass a static object). */
export async function handleTest(pushState, getCfg, req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
    return
  }
  if (!sameOriginPost(req)) {
    responseJson(res, 403, { ok: false, error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' } })
    return
  }
  const raw = await readBody(req)
  if (raw === null) {
    responseJson(res, 413, { ok: false, error: { code: 'too-large', message: 'test payload exceeds the 4096-byte limit' } })
    return
  }
  let parsed = {}
  try {
    parsed = raw === '' ? {} : JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') parsed = {}
  } catch {
    responseJson(res, 400, { ok: false, error: { code: 'bad-json', message: 'body must be JSON' } })
    return
  }
  const sample = TEST_SAMPLES[parsed.kind]
  let title
  let body
  if (sample !== undefined) {
    // Live-template preview: sample variables are always filled (they are
    // samples, not conversation content), regardless of includeSummary.
    const cfg = (typeof getCfg === 'function' ? getCfg() : null) || {}
    const preview = renderTexts(parsed.kind, sample, { ...cfg, includeSummary: true })
    title = preview.title
    body = preview.body
  } else {
    title = typeof parsed.title === 'string' && parsed.title.trim() !== '' ? parsed.title.trim().slice(0, 80) : 'DSH 测试通知'
    body = typeof parsed.body === 'string' ? parsed.body.slice(0, 200) : '如果你看到了它，推送链路是通的。'
  }
  const { sent } = await pushState.broadcast({ title, body, tag: 'dsh-test', url: '/' }, PUSH_POLICY.test)
  responseJson(res, 200, { ok: true, sent, title, body })
}

// ---------------------------------------------------------------------------
// Web Push routes (subscription management + VAPID public key).
// ---------------------------------------------------------------------------

const SUB_BODY_MAX = 8192

/** POST {BASE}/subscribe {subscription:{endpoint, keys:{p256dh, auth}}} —
 * register one browser/app for real Web Push (VAPID-keyed, persisted). */
export async function handleSubscribe(pushState, req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
    return
  }
  if (!sameOriginPost(req)) {
    responseJson(res, 403, { ok: false, error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' } })
    return
  }
  const raw = await readBody(req, SUB_BODY_MAX)
  if (raw === null) {
    responseJson(res, 413, { ok: false, error: { code: 'too-large', message: 'subscription payload exceeds the 8192-byte limit' } })
    return
  }
  let sub
  try {
    sub = JSON.parse(raw).subscription
  } catch {
    sub = undefined
  }
  try {
    const subscriptions = pushState.addSubscription(sub)
    responseJson(res, 200, { ok: true, subscriptions })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    responseJson(res, 400, { ok: false, error: { code: 'bad-subscription', message } })
  }
}

/** POST {BASE}/unsubscribe {endpoint} — drop one subscription. */
export async function handleUnsubscribe(pushState, req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } })
    return
  }
  if (!sameOriginPost(req)) {
    responseJson(res, 403, { ok: false, error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' } })
    return
  }
  const raw = await readBody(req, SUB_BODY_MAX)
  let endpoint = ''
  try {
    endpoint = String(JSON.parse(raw).endpoint || '')
  } catch {
    endpoint = ''
  }
  const removed = pushState.removeSubscription(endpoint)
  responseJson(res, 200, { ok: true, removed })
}

/** GET {BASE}/vapid — the public key clients subscribe with. */
export function handleVapid(pushState, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
    return
  }
  responseJson(res, 200, { ok: true, publicKey: pushState.vapidPublicKey(), subscriptions: pushState.subscriptions().length })
}

// ---------------------------------------------------------------------------
// Static PWA assets, served by the DSH host itself (no gateway, like
// zen-remote's lan-gate does for its /pwa/* set).
// ---------------------------------------------------------------------------

const PWA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pwa')

/** Immutable-per-install assets: route suffix -> file + content type + cache policy. */
export const ASSETS = {
  'manifest.json': { file: 'manifest.json', type: 'application/manifest+json; charset=utf-8', maxAge: 3600 },
  'sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8', maxAge: 0, swAllowed: true },
  'icon-192.png': { file: 'icons/icon-192.png', type: 'image/png', maxAge: 86400 },
  'icon-512.png': { file: 'icons/icon-512.png', type: 'image/png', maxAge: 86400 },
  'icon-maskable-512.png': { file: 'icons/icon-maskable-512.png', type: 'image/png', maxAge: 86400 },
}

const assetCache = new Map()

async function loadAsset(name) {
  if (assetCache.has(name)) return assetCache.get(name)
  const bytes = await readFile(join(PWA_DIR, ASSETS[name].file))
  assetCache.set(name, bytes)
  return bytes
}

/**
 * The single prefix route: static assets + push management + test.
 * @param {ReturnType<typeof createPushState>} pushState
 * @param {Function} getCfg live-settings accessor for the /test preview.
 */
export async function handleRoute(pushState, getCfg, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const rel = url.pathname.slice(BASE.length).replace(/^\/+/, '').replace(/\/+$/, '')
  try {
    if (rel === 'test') return await handleTest(pushState, getCfg, req, res)
    if (rel === 'subscribe') return await handleSubscribe(pushState, req, res)
    if (rel === 'unsubscribe') return await handleUnsubscribe(pushState, req, res)
    if (rel === 'vapid') return handleVapid(pushState, req, res)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD')
      responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
      return
    }
    const asset = ASSETS[rel]
    if (asset === undefined) {
      responseJson(res, 404, { ok: false, error: { code: 'not-found', message: `no such asset: ${rel}` } })
      return
    }
    const bytes = await loadAsset(rel)
    res.setHeader('Content-Type', asset.type)
    res.setHeader('Cache-Control', asset.maxAge > 0 ? `public, max-age=${asset.maxAge}` : 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // The SW script lives under /_dsh/pwa-notify/, but must control scope '/'
    // so it can serve the installed PWA's start_url and receive notification
    // clicks for the whole app. Browsers only allow a scope wider than the
    // script's own directory when the response carries this header.
    if (asset.swAllowed) res.setHeader('Service-Worker-Allowed', '/')
    res.writeHead(200)
    res.end(req.method === 'HEAD' ? undefined : bytes)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    responseJson(res, 500, { ok: false, error: { code: 'asset-error', message } })
  }
}

// ---------------------------------------------------------------------------
// notify_user model tool (the "model leg", ported from zen-remote's
// push_notify and renamed: a distinct name avoids colliding with zen-remote's
// push_notify when both are installed).
// ---------------------------------------------------------------------------

/** The single source of "when should you notify me" — embedded verbatim in
 * both the tool description and the system-prompt section so the two cannot
 * drift apart. The when-NOT-to half is load-bearing: listing only the
 * when-to half turns the tool into a per-turn reflex. */
export const NOTIFY_GUIDANCE =
  'Notify the user when: (1) they asked to be told once something is finished or a result is ready; ' +
  '(2) you cannot go on without them — a question that needs answering, an operation that needs ' +
  'authorization, a call only they can make; (3) something happened they almost certainly want to know ' +
  'immediately — the task failed, or you hit a blocker you cannot route around. ' +
  'Do NOT call this for: an ordinary end of turn, progress or status reports, intermediate milestones, ' +
  'or anything you can keep making headway on by yourself. Finishing a turn is not by itself a reason ' +
  'to buzz someone\'s phone.'

const NOTIFY_DESCRIPTION =
  'Raise a notification on the user\'s devices — lock screen included — via the DSH PWA. ' +
  'Delivery reaches every device subscribed to this deployment\'s Web Push (installed home-screen PWA on ' +
  'iOS; browser or PWA elsewhere), plus any device with the DSH page currently open in the background. ' +
  'Pushes are end-to-end encrypted (aes128gcm); the push provider only ever sees ciphertext. ' +
  NOTIFY_GUIDANCE +
  ' Calls are throttled (at most 1 per 60 seconds in this session, 20 total per hour across all sessions); ' +
  'calling too often gets the call silently dropped. `title` must be a short, complete sentence that fits ' +
  'on one notification line; `body` is optional detail shown when expanded. Returns how many devices ' +
  'received it, or throttled:true when the rate limit dropped the call.'

const NOTIFY_SECTION =
  'Reaching the user away from the window: this deployment can raise a notification on the user\'s ' +
  'devices — lock screen included — with the `notify_user` tool, via the DSH PWA\'s Web Push subscription ' +
  '(and any open DSH page). ' + NOTIFY_GUIDANCE +
  ' The harness already notifies on its own whenever a tool is waiting for authorization or an ' +
  '`ask_user_question` is unanswered, so you never need `notify_user` for those two.'

const NOTIFY_TOOL_SESSION_WINDOW_MS = 60_000
const NOTIFY_TOOL_GLOBAL_WINDOW_MS = 60 * 60_000
const NOTIFY_TOOL_GLOBAL_MAX = 20

/**
 * Build the notify_user ToolDefinition by hand. `defineTool` from
 * @deepseek-ai/dsh-tools only compiles the schema spec to JSON Schema and
 * wraps execute with validation; constructing the same shape directly keeps
 * this package dependency-free (the registry validates again anyway).
 * @param {ReturnType<typeof createPushState>} pushState (or its null stand-in).
 * @param {object} gate the shared debounce arm.
 */
export function buildNotifyTool(pushState, gate) {
  const lastSentBySession = new Map()
  let globalSends = []

  const isThrottled = (sessionId, now) => {
    const last = lastSentBySession.get(sessionId)
    if (last !== undefined && now - last < NOTIFY_TOOL_SESSION_WINDOW_MS) return true
    globalSends = globalSends.filter((t) => now - t < NOTIFY_TOOL_GLOBAL_WINDOW_MS)
    return globalSends.length >= NOTIFY_TOOL_GLOBAL_MAX
  }
  const reserve = (sessionId, now) => {
    lastSentBySession.set(sessionId, now)
    globalSends.push(now)
  }

  return {
    name: 'notify_user',
    description: NOTIFY_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Short, complete-sentence notification title that fits on one notification line (roughly 40-60 characters). This is the only part guaranteed visible without expanding.',
        },
        body: {
          type: 'string',
          description: 'Optional extra detail shown below the title once the notification is expanded. Omit for a title-only notification.',
        },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: {
            type: 'integer',
            description: 'Number of subscribed devices whose push service accepted the notification (HTTP 2xx). 0 when nothing is subscribed, delivery failed, or the call was throttled.',
          },
          throttled: {
            type: 'boolean',
            description: 'Present and true only when the rate limiter dropped the call instead of sending it.',
          },
        },
        required: ['delivered'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.throttled
            ? 'notify_user: not sent — rate limit hit (max 1 per 60s per session, 20/hour total).'
            : `notify_user: delivered to ${value.delivered} device(s).`,
        },
      ],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (exec.agent === undefined) throw new Error('notify_user requires an initiating agent')
      const sessionId = exec.agent.session.id
      const now = Date.now()
      if (isThrottled(sessionId, now)) return { delivered: 0, throttled: true }
      reserve(sessionId, now)
      // Counts toward the shared debounce clock so an automatic turn-end
      // notification landing right behind this one is suppressed.
      gate.arm(now)
      const title = String(args.title ?? '').slice(0, 120)
      const body = args.body === undefined ? '' : String(args.body).slice(0, 300)
      // Unlike the event legs, the tool awaits its broadcast: the returned
      // delivered count is the real 2xx-accepted count, not an estimate.
      const { sent } = await pushState.broadcast(
        { title, body, tag: 'dsh-notify-user', url: '/' },
        PUSH_POLICY.model,
      )
      return { delivered: sent }
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------

/**
 * Host half. All hard dependencies are injected INSIDE apply (not declared
 * top-level) so the plugin row still loads in compositions without them —
 * Electron carries no webServer, headless profiles may carry no tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] plugin-row config (see DEFAULT_CONFIG).
 */
export function apply(ctx, config = {}) {
  const num = (key) => {
    const v = config[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_CONFIG[key]
  }
  const str = (key) => {
    const v = config[key]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : DEFAULT_CONFIG[key]
  }
  // Live configuration. The static knobs (grace/debounce/subject/push/tool)
  // come from the plugin row; the user-owned knobs (toggles + text templates)
  // are overwritten live from the settings namespace below the moment it
  // mounts, and on every change thereafter.
  const cfg = {
    approvalEnabled: true,
    questionEnabled: true,
    turnEndEnabled: config.turnEnd === true,
    approvalGraceMs: num('approvalGraceMs'),
    debounceMs: num('debounceMs'),
    includeSummary: config.includeSummary === true,
    texts: {},
    notifyTool: config.notifyTool !== false,
    vapidSubject: str('vapidSubject'),
    push: config.push !== false,
  }

  // --- live user settings (Settings → 通知推送 card) -----------------------
  // Registered when the settings service mounts (the Web composition ships
  // dsh-settings-file); without one the row config applies as above.
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('dsh-pwa-notify', SettingsSchema, {
      base: { turnEndPush: config.turnEnd === true, includeSummary: config.includeSummary === true },
    })
    const applyLive = () => {
      const value = scope.get()
      cfg.approvalEnabled = value.approvalPush !== false
      cfg.questionEnabled = value.questionPush !== false
      cfg.turnEndEnabled = value.turnEndPush === true
      cfg.includeSummary = value.includeSummary === true
      cfg.texts = {
        approvalTitle: value.textApprovalTitle,
        approvalBody: value.textApprovalBody,
        questionTitle: value.textQuestionTitle,
        questionBody: value.textQuestionBody,
        turnTitle: value.textTurnTitle,
        turnBody: value.textTurnBody,
      }
    }
    applyLive()
    scope.watch(applyLive)
  })

  // Real Web Push state (VAPID keys + subscriptions). With the poll channel
  // gone this is THE notification transport: an unavailable state dir or no
  // fetch means notifications are off (the PWA-install half still works).
  let pushState = null
  if (cfg.push) {
    try {
      pushState = createPushState({ stateFile: defaultStateFile(), subject: cfg.vapidSubject })
    } catch (e) {
      console.warn(`[dsh-pwa-notify] Web Push disabled: ${String((e && e.message) || e)}`)
    }
  }

  /**
   * The one sink every automatic notification goes through: Web Push
   * broadcast. Fire-and-forget on the event legs (an event handler must not
   * block on push services); the notify_user tool awaits its own broadcast.
   */
  const emit = (kind, title, body, tag) => {
    if (pushState === null || pushState.subscriptions().length === 0) return
    const policy = PUSH_POLICY[kind] ?? { ttl: 900, urgency: 'normal' }
    pushState.broadcast({ title, body: body || '', tag: tag || 'dsh', url: '/' }, policy).catch(() => {})
  }

  // The one piece of mutable debounce state, shared by every automatic leg.
  let lastSent = 0
  const gate = {
    decide(input) {
      const decision = decideNotification({ ...input, now: Date.now(), lastSent }, cfg)
      if (decision.shouldNotify) lastSent = Date.now()
      return decision
    },
    arm(now) {
      lastSent = now
    },
  }
  const fire = (input) => {
    const decision = gate.decide(input)
    if (decision.shouldNotify) {
      const tag = input.kind + (input.id !== undefined ? `-${input.id}` : '')
      emit(input.kind, decision.title, decision.body, `dsh-${tag}`)
    }
    return decision
  }

  // --- Event leg: approvals and questions --------------------------------
  // `session/event` is the post-commit append feed for EVERY session,
  // subagent children included — those notify here, they just never notify
  // on turn end. An approval still undecided after the grace window is
  // waiting on a human; `approval/decided` within the window cancels it.
  const armed = new Map()
  try {
    ctx.on('session/event', (_session, event) => {
      if (!event || !event.data) return
      if (event.type === 'approval/asked') {
        const id = event.data.id
        const toolName = event.data.toolName
        const timer = setTimeout(() => {
          armed.delete(id)
          fire({ kind: 'approval', toolName, id })
        }, cfg.approvalGraceMs)
        if (typeof timer.unref === 'function') timer.unref()
        armed.set(id, timer)
      } else if (event.type === 'approval/decided') {
        const timer = armed.get(event.data.id)
        if (timer !== undefined) {
          clearTimeout(timer)
          armed.delete(event.data.id)
        }
      } else if (event.type === 'tool/call' && event.data.name === ASK_USER_TOOL) {
        fire({ kind: 'question', question: pendingQuestionText(event.data.arguments) })
      }
    })
  } catch (e) {
    console.warn(`[dsh-pwa-notify] cannot listen on "session/event": ${String((e && e.message) || e)}`)
  }

  // --- Turn-end leg (opt-in) ----------------------------------------------
  try {
    ctx.on('agent/turn-stopping', (payload) => {
      const session = payload && payload.agent && payload.agent.session
      const header = session && session.header
      // An ABSENT delegationDepth on a PRESENT header means top level. A
      // missing header is different — "could not tell whose turn this was" —
      // and passing its undefined through would fail OPEN, letting subagent
      // turn ends back in. Turn-end is the low-value leg: stay quiet.
      if (!header) return
      fire({
        kind: 'turn-end',
        delegationDepth: header.delegationDepth,
        summary: cfg.includeSummary ? turnSummary(session.events, payload && payload.turn) : '',
      })
    })
  } catch (e) {
    console.warn(`[dsh-pwa-notify] cannot listen on "agent/turn-stopping": ${String((e && e.message) || e)}`)
  }

  // --- PWA assets + push management + test routes ----------------------------
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: BASE,
          handler: (req, res) =>
            // Push disabled: /vapid and /subscribe answer with an explicit
            // error, /test reports sent:0 — the route table stays uniform.
            // getCfg reads live settings for the /test template preview.
            handleRoute(pushState !== null ? pushState : nullPushState(), () => cfg, req, res),
        }),
      'dsh-pwa-notify: pwa routes',
    )
  })

  // --- Manifest link + theme color + VAPID key in index.html -----------------
  try {
    ctx.on('webserver/index-inject', (table) => {
      table.push({
        kind: 'html',
        placement: 'head',
        html: `<link rel="manifest" href="${BASE}/manifest.json"><meta name="theme-color" content="#0f1115">`,
      })
      // The VAPID public key, fresh at emit time (first boot generates it
      // before the first index render can happen).
      if (cfg.push && pushState !== null) {
        table.push({ kind: 'global', name: '__DSH_PWA_NOTIFY_VAPID__', value: pushState.vapidPublicKey() })
      }
    })
  } catch (e) {
    console.warn(`[dsh-pwa-notify] cannot listen on "webserver/index-inject": ${String((e && e.message) || e)}`)
  }

  // --- notify_user model tool ---------------------------------------------
  if (cfg.notifyTool) {
    // ctx.inject, NOT ctx.get: the tools/systemPrompt services may be
    // provided by a plugin that loads AFTER this one; inject() defers the
    // callback until the service exists and degrades gracefully in
    // compositions without them.
    ctx.inject(['tools'], (toolsCtx) => {
      if (!toolsCtx.tools) return
      toolsCtx.effect(() => {
        try {
          return toolsCtx.tools.register(buildNotifyTool(pushState, gate))
        } catch (e) {
          // A name collision with another deployment's notify_user tool must
          // not take the plugin row down — warn and stay quiet.
          console.warn(`[dsh-pwa-notify] cannot register notify_user: ${String((e && e.message) || e)}`)
          return () => {}
        }
      }, 'dsh-pwa-notify: notify_user tool')
    })
    ctx.inject(['systemPrompt'], (promptCtx) => {
      if (!promptCtx.systemPrompt) return
      try {
        promptCtx.systemPrompt.section({ name: 'dsh-pwa-notify', order: 150, text: NOTIFY_SECTION })
      } catch (e) {
        console.warn(`[dsh-pwa-notify] cannot register prompt section: ${String((e && e.message) || e)}`)
      }
    })
  }

  console.log(
    `[dsh-pwa-notify] on — approval/question notifications (grace ${cfg.approvalGraceMs}ms); ` +
      `turn-end ${cfg.turnEndEnabled ? 'on' : 'off (set turnEnd: true in the plugin row to enable)'}; ` +
      `web push ${pushState !== null ? `on (${pushState.subscriptions().length} subscription(s), subject ${cfg.vapidSubject})` : 'OFF — no notifications will be delivered'}; ` +
      `notify_user tool ${cfg.notifyTool ? 'registered when the tools service is present' : 'disabled'}`,
  )
}

/** Stand-in used when Web Push is disabled: /vapid answers 503, subscribe
 * refuses, everything else behaves. Keeps the route table unconditional. */
function nullPushState() {
  const unavailable = () => {
    throw new Error('Web Push is disabled on this deployment (push: false)')
  }
  return {
    vapidPublicKey: unavailable,
    addSubscription: unavailable,
    removeSubscription: unavailable,
    subscriptions: () => [],
    broadcast: async () => ({ sent: 0, failed: 0, pruned: [] }),
    sendTo: async () => 0,
  }
}
