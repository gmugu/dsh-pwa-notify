/**
 * dsh-pwa-notify — host half.
 *
 * Turns the DSH Web GUI into an installable PWA and notifies the browser when
 * the agent actually needs its human. Two reference plugins shape this design:
 *
 *   - dsh-zen-remote contributes the notification POLICY (approval/asked with
 *     a grace window, ask_user_question, opt-in turn-end, the notify-tool
 *     throttle) and the PWA asset set (manifest + service worker + icons).
 *     Its transport is a gateway subprocess doing real VAPID Web Push; here
 *     the transport is much lighter — the DSH host itself serves the PWA files
 *     and a small poll feed, and the CLIENT shows the notification through
 *     the service worker while the page/PWA is open in the background.
 *   - dsh-mobile-hanui contributes the packaging: zero npm dependencies, a
 *     plain-JS host entry + client bundle discovered via `dsh.client`, one
 *     `cordis.patch.yml` insert row, no build step.
 *
 * Host responsibilities:
 *   1. serve /_dsh/pwa-notify/{sw.js,manifest.json,icon-*.png} through the
 *      `webServer` service (the SW response carries Service-Worker-Allowed: /
 *      so a script living under /_dsh/pwa-notify/ may control scope "/");
 *   2. inject <link rel="manifest"> + theme-color into index.html through the
 *      structured `webserver/index-inject` event;
 *   3. listen to `session/event` + `agent/turn-stopping`, decide notifications
 *      with a pure policy function (exported for tests), and buffer the
 *      decided ones in a small sequence-numbered ring;
 *   4. expose GET /_dsh/pwa-notify/poll?since=<seq> for the client feed and
 *      POST /_dsh/pwa-notify/test for the "send a test notification" button;
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** All host routes live under this prefix (one `prefix` webServer route). */
export const BASE = '/_dsh/pwa-notify'

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
}

/** How long a buffered notification stays deliverable through the poll feed. */
export const ITEM_TTL_MS = 10 * 60 * 1000
/** Ring capacity; overflowing drops the oldest entries. */
export const RING_CAP = 200
/** Most items one poll response will carry. */
export const POLL_MAX_ITEMS = 50
/** A client that polled within this window counts as "actively listening". */
export const CLIENT_ACTIVE_MS = 30 * 1000
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
 * @param {object} cfg { turnEndEnabled, debounceMs, includeSummary }
 * @returns {{shouldNotify: boolean, title: string, body: string, reason: string}}
 */
export function decideNotification(input, cfg) {
  const debounced = input.now - input.lastSent < cfg.debounceMs

  switch (input.kind) {
    // Event leg. Exempt from the debounce on purpose: "a tool is waiting for
    // your OK" is the one notification that must never be swallowed.
    case 'approval':
      return {
        shouldNotify: true,
        title: 'DSH 等你授权',
        body: input.toolName ? `${input.toolName} 需要授权才能继续` : '有操作需要授权才能继续',
        reason: 'approval-pending',
      }
    case 'question':
      return {
        shouldNotify: true,
        title: 'DSH 等你回答',
        body: (cfg.includeSummary && input.question) || '智能体提了一个问题，正在等你回答',
        reason: 'question-pending',
      }

    // Turn end. Opt-in, top-level only, debounced.
    case 'turn-end':
      if (!cfg.turnEndEnabled) return skip('turn-end-disabled')
      if ((input.delegationDepth ?? 0) !== 0) return skip('subagent')
      if (debounced) return skip('debounced')
      return { shouldNotify: true, title: 'DSH 任务完成', body: input.summary || '智能体已完成当前回合', reason: 'turn-end' }

    default:
      return skip('unknown-kind')
  }
}

// ---------------------------------------------------------------------------
// Notification store: sequence-numbered ring + active-client tracking.
// ---------------------------------------------------------------------------

/**
 * Create one notification buffer. All state lives in this closure so tests
 * (and every apply() call) get an isolated instance.
 *
 * @param {object} [opts] `{ ttlMs, cap }` overrides for tests.
 */
export function createNotifyStore(opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : ITEM_TTL_MS
  const cap = Number.isFinite(opts.cap) ? opts.cap : RING_CAP
  let seq = 0
  const items = []
  const pollers = new Map() // client id -> last seen epoch ms

  const prunePollers = (now) => {
    for (const [cid, seen] of pollers) {
      if (now - seen > CLIENT_ACTIVE_MS) pollers.delete(cid)
    }
  }

  return {
    /** Buffer one decided notification; returns its sequence number. */
    push(kind, title, body, tag) {
      seq += 1
      items.push({ seq, kind, title: String(title ?? ''), body: String(body ?? ''), tag: String(tag ?? kind), ts: Date.now() })
      if (items.length > cap) items.splice(0, items.length - cap)
      return seq
    },
    /** Everything with `seq > since` that is still within its TTL. */
    poll(since, now = Date.now()) {
      const live = items.filter((it) => it.seq > since && now - it.ts <= ttlMs)
      return { seq, items: live.slice(-POLL_MAX_ITEMS) }
    },
    /** Record that a poll client is listening. */
    seenClient(cid, now = Date.now()) {
      if (typeof cid === 'string' && cid !== '') pollers.set(cid.slice(0, 64), now)
    },
    /** How many distinct clients polled recently (the notify_user audience). */
    activeClients(now = Date.now()) {
      prunePollers(now)
      return pollers.size
    },
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

/**
 * GET {BASE}/poll?since=<seq>&cid=<clientId> — the client feed.
 * The first poll (since=0) baselines: it reports the current sequence so an
 * just-loaded page does not replay history as notifications; the client
 * treats that response as adopt-only.
 */
export async function handlePoll(store, req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } })
    return
  }
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const sinceRaw = url.searchParams.get('since')
  const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : 0
  const cid = url.searchParams.get('cid') ?? undefined
  if (cid !== undefined) store.seenClient(cid)
  const { seq, items } = store.poll(since)
  responseJson(res, 200, { ok: true, seq, items })
}

/** POST {BASE}/test {title?, body?} — the "send a test notification" button. */
export async function handleTest(store, req, res) {
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
  const title = typeof parsed.title === 'string' && parsed.title.trim() !== '' ? parsed.title.trim().slice(0, 80) : 'DSH 测试通知'
  const body = typeof parsed.body === 'string' ? parsed.body.slice(0, 200) : '如果你看到了它，通知链路是通的。'
  const seq = store.push('test', title, body, 'dsh-test')
  responseJson(res, 200, { ok: true, seq })
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
 * The single prefix route: static assets + poll + test.
 * @param {ReturnType<typeof createNotifyStore>} store
 */
export async function handleRoute(store, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const rel = url.pathname.slice(BASE.length).replace(/^\/+/, '').replace(/\/+$/, '')
  try {
    if (rel === 'poll') return await handlePoll(store, req, res)
    if (rel === 'test') return await handleTest(store, req, res)
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
// push_notify and renamed: delivery is local-page-only, and a distinct name
 // avoids colliding with zen-remote's push_notify when both are installed).
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
  'Show a local notification on the user\'s DSH page or installed PWA. ' +
  'Delivery is LOCAL-ONLY: it reaches devices where the DSH Web UI (browser tab or home-screen PWA) is ' +
  'currently open — including running in the background — and nothing else; a fully closed app will not ' +
  'receive it. ' +
  NOTIFY_GUIDANCE +
  ' Calls are throttled (at most 1 per 60 seconds in this session, 20 total per hour across all sessions); ' +
  'calling too often gets the call silently dropped. `title` must be a short, complete sentence that fits ' +
  'on one notification line; `body` is optional detail shown when expanded. Returns how many listening ' +
  'clients received it, or throttled:true when the rate limit dropped the call.'

const NOTIFY_SECTION =
  'Reaching the user away from the window: this deployment can raise a local notification on the user\'s ' +
  'DSH page or installed PWA with the `notify_user` tool. ' + NOTIFY_GUIDANCE +
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
 */
export function buildNotifyTool(store, gate) {
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
            description: 'Number of DSH pages/PWAs currently listening that received the notification. 0 when nothing is listening (the user has no page open) or the call was throttled.',
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
            : `notify_user: delivered to ${value.delivered} listening page(s).`,
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
      store.push('model', title, body, 'dsh-notify-user')
      return { delivered: store.activeClients() }
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
  const cfg = {
    turnEndEnabled: config.turnEnd === true,
    approvalGraceMs: num('approvalGraceMs'),
    debounceMs: num('debounceMs'),
    includeSummary: config.includeSummary === true,
    notifyTool: config.notifyTool !== false,
  }

  const store = createNotifyStore()

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
      store.push(input.kind, decision.title, decision.body, `dsh-${tag}`)
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

  // --- PWA assets + poll/test routes --------------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: BASE,
          handler: (req, res) => handleRoute(store, req, res),
        }),
      'dsh-pwa-notify: pwa routes',
    )
  })

  // --- Manifest link + theme color in index.html ---------------------------
  try {
    ctx.on('webserver/index-inject', (table) => {
      table.push({
        kind: 'html',
        placement: 'head',
        html: `<link rel="manifest" href="${BASE}/manifest.json"><meta name="theme-color" content="#0f1115">`,
      })
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
      toolsCtx.effect(() => toolsCtx.tools.register(buildNotifyTool(store, gate)), 'dsh-pwa-notify: notify_user tool')
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
      `notify_user tool ${cfg.notifyTool ? 'registered when the tools service is present' : 'disabled'}`,
  )
}
