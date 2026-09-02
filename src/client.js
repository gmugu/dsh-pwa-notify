/**
 * dsh-pwa-notify — client half (browser bundle, discovered via dsh.client).
 *
 * Runs on every device with no React and no slots dependency:
 *   1. registers the service worker served by this plugin's host half at
 *      /_dsh/pwa-notify/sw.js with scope "/" (the host sends
 *      Service-Worker-Allowed: /);
 *   2. asks for notification permission through an opt-in bottom card
 *      (7-day snooze, iOS installed-PWA hint — the flow dsh-zen-remote's
 *      pwa/inject.js proved out);
 *   3. subscribes to Web Push with the VAPID key the host injects into the
 *      page (__DSH_PWA_NOTIFY_VAPID__) — iOS only allows this from a
 *      home-screen install, never a Safari tab, so the card guides there.
 *
 * Push is the ONLY notification transport (the earlier poll fallback was
 * removed by design): the SW's push event displays everything, and this page
 * code has no display path of its own at all. Returning visitors with
 * permission already granted silently resync their subscription.
 *
 * Disable per browser with ?pwaNotify=0 or localStorage 'dsh-pwa-notify'='0'.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pwa-notify',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const BASE = '/_dsh/pwa-notify'
    const SNOOZE_KEY = 'dsh-pwa-notify-snooze'
    const DISABLE_KEY = 'dsh-pwa-notify'
    const CARD_ID = 'dsh-pwa-notify-card'
    const SNOOZE_MS = 7 * 24 * 3600 * 1000
    const ICON = BASE + '/icon-192.png'

    const state = {
      reg: null,
      card: null,
      booted: false,
      loadListener: null,
    }

    // ---- environment -------------------------------------------------------

    function disabledByUrl() {
      try {
        return new URLSearchParams(location.search).get('pwaNotify') === '0'
      } catch (_) {
        return false
      }
    }

    function disabledByStorage() {
      try {
        return localStorage.getItem(DISABLE_KEY) === '0'
      } catch (_) {
        return false
      }
    }

    function secureOk() {
      return window.isSecureContext === true
    }

    function swSupported() {
      return 'serviceWorker' in navigator
    }

    function notifSupported() {
      return swSupported() && 'Notification' in window
    }

    function isIOS() {
      return /iPad|iPhone|iPod/.test(navigator.userAgent)
    }

    function isStandalone() {
      return (
        window.navigator.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      )
    }

    function permission() {
      return notifSupported() ? window.Notification.permission : 'unsupported'
    }

    function pushSupported() {
      return swSupported() && notifSupported() && 'PushManager' in window
    }

    // iOS grants Web Push only to home-screen installs, never to a Safari
    // tab — attempting subscribe there just errors (zen-remote's finding).
    function pushAllowedHere() {
      return pushSupported() && secureOk() && (!isIOS() || isStandalone())
    }

    /** VAPID public key: injected into the page by the host when push is on;
     * absent when push: false (then subscribe is simply skipped). */
    function vapidKeyBytes() {
      var s = String(window.__DSH_PWA_NOTIFY_VAPID__ || '')
      if (!s) return undefined
      s = s.replace(/-/g, '+').replace(/_/g, '/')
      while (s.length % 4) s += '='
      var raw = atob(s)
      var a = new Uint8Array(raw.length)
      for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i)
      return a
    }

    /** Short client-derived hint for the management list, e.g.
     * 「iPhone · 主屏」/「Mac · 浏览器」. Best-effort from the UA string. */
    function deviceLabel() {
      var ua = navigator.userAgent || ''
      var device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : '设备'
      var m = /OS (\d+(?:_\d+)?)/.exec(ua)
      var os = m ? ' iOS/macOS ' + m[1].replace('_', '.') : ''
      return device + os + (isStandalone() ? ' · 主屏' : ' · 浏览器')
    }

    async function subscribePush() {
      if (state.pushReady || !pushAllowedHere()) return false
      var key = vapidKeyBytes()
      if (!key) return false
      try {
        var reg = await swReady()
        if (!reg) return false
        var sub = await reg.pushManager.getSubscription()
        if (!sub) {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        }
        var res = await fetch(BASE + '/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), device: { label: deviceLabel() } }),
        })
        if (!res.ok) return false
        state.pushReady = true
        return true
      } catch (err) {
        console.warn('[dsh-pwa-notify] push subscribe failed:', err)
        return false
      }
    }

    function snoozed() {
      try {
        const at = Number(localStorage.getItem(SNOOZE_KEY) || 0)
        return Date.now() - at < SNOOZE_MS
      } catch (_) {
        return false
      }
    }

    function snooze() {
      try {
        localStorage.setItem(SNOOZE_KEY, String(Date.now()))
      } catch (_) {}
    }

    // ---- service worker ----------------------------------------------------

    async function registerSW() {
      if (!swSupported() || !secureOk()) return null
      try {
        const reg = await navigator.serviceWorker.register(BASE + '/sw.js', { scope: '/' })
        state.reg = reg
        return reg
      } catch (err) {
        console.warn('[dsh-pwa-notify] service worker registration failed:', err)
        return null
      }
    }

    async function swReady() {
      if (!swSupported()) return null
      try {
        const reg = await navigator.serviceWorker.ready
        state.reg = reg
        return reg
      } catch (_) {
        return null
      }
    }

    // ---- opt-in card (DOM, zen-remote inject.js style) ---------------------

    const BTN_ON =
      '<button data-act="on" style="flex:1;background:#4c8dff;color:#fff;border:0;border-radius:9px;padding:9px 0;font-weight:600">开启</button>'
    const BTN_OFF =
      '<button data-act="off" style="flex:1;background:#2a2f3a;color:#9aa3b2;border:0;border-radius:9px;padding:9px 0">暂不</button>'
    const BTN_CLOSE =
      '<button data-act="off" style="flex:1;background:#2a2f3a;color:#9aa3b2;border:0;border-radius:9px;padding:9px 0">知道了</button>'
    const BTN_TEST =
      '<button data-act="test" style="flex:1;background:#4c8dff;color:#fff;border:0;border-radius:9px;padding:9px 0;font-weight:600">发个测试通知</button>'
    const BTN_DONE =
      '<button data-act="off" style="flex:1;background:#2a2f3a;color:#9aa3b2;border:0;border-radius:9px;padding:9px 0">完成</button>'

    function removeCard() {
      if (state.card) {
        state.card.remove()
        state.card = null
      }
    }

    function card(title, bodyHtml, buttonsHtml) {
      removeCard()
      const el = document.createElement('div')
      el.id = CARD_ID
      el.style.cssText =
        'position:fixed;left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));' +
        'bottom:max(96px,calc(env(safe-area-inset-bottom) + 96px));z-index:2147483005;max-width:420px;margin:0 auto;' +
        'background:rgba(22,26,34,.96);border:1px solid #2a2f3a;border-radius:14px;' +
        'padding:14px 16px;color:#e6e8ec;font:13px/1.6 system-ui;' +
        '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.5)'
      el.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px">' + title + '</div>' +
        '<div style="color:#9aa3b2;margin-bottom:10px">' + bodyHtml + '</div>' +
        '<div style="display:flex;gap:8px">' + buttonsHtml + '</div>'
      document.body.appendChild(el)
      state.card = el
      return el
    }

    async function requestPermissionInGesture() {
      try {
        // Must run inside the click gesture: Safari rejects permission
        // requests (and subscription) outside one.
        return await window.Notification.requestPermission()
      } catch (err) {
        console.warn('[dsh-pwa-notify] permission request failed:', err)
        return 'denied'
      }
    }

    function showGrantedCard() {
      const viaPush = state.pushReady
      const el = card(
        '🔔 通知已开启',
        viaPush
          ? '已订阅系统级推送：智能体等你授权、等你回答时会推到锁屏——即使这个应用已被系统杀掉。想确认链路，发一条试试。'
          : '智能体等你授权 / 提问时会提醒你（本页面在后台时）。想确认链路，发一条试试。',
        BTN_TEST + BTN_DONE,
      )
      el.querySelector('[data-act="test"]').addEventListener('click', function () {
        sendTest()
      })
      el.querySelector('[data-act="off"]').addEventListener('click', function () {
        removeCard()
      })
    }

    function showAskCard() {
      if (!notifSupported()) {
        if (isIOS() && !isStandalone()) {
          showIOSHintCard()
        }
        return
      }
      if (permission() === 'denied') return
      if (permission() === 'granted') return
      const el = card(
        '🔔 DSH 通知',
        '开启后，智能体等你授权、等你回答时会推送系统通知到这台设备——页面切到后台也会响。通知不含对话正文。',
        BTN_ON + BTN_OFF,
      )
      el.querySelector('[data-act="on"]').addEventListener('click', function () {
        el.remove()
        requestPermissionInGesture().then(function (result) {
          if (result === 'granted') {
            // Inside the click's promise chain where possible: Safari wants
            // the subscribe call tied to the user gesture too.
            subscribePush().then(function () {
              showGrantedCard()
            })
          }
        })
      })
      el.querySelector('[data-act="off"]').addEventListener('click', function () {
        snooze()
        removeCard()
      })
    }

    function showIOSHintCard() {
      const el = card(
        '🔔 DSH 通知',
        '在 iPhone / iPad 上，通知只对「添加到主屏幕」后的应用生效。请先用 Safari 分享菜单把 DSH 添加到主屏幕，再从主屏图标打开本页。',
        BTN_CLOSE,
      )
      el.querySelector('[data-act="off"]').addEventListener('click', function () {
        snooze()
        removeCard()
      })
    }

    async function sendTest() {
      try {
        await fetch(BASE + '/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'DSH 测试通知', body: '如果你看到了它，通知链路是通的。' }),
        })
      } catch (err) {
        console.warn('[dsh-pwa-notify] test send failed:', err)
      }
    }

    // ---- public debug/API surface ------------------------------------------

    window.__DSH_PWA_NOTIFY__ = {
      ask: function () {
        showAskCard()
      },
      test: function () {
        if (permission() === 'granted') sendTest()
        else showAskCard()
      },
      status: function () {
        return {
          permission: permission(),
          serviceWorker: !!state.reg,
          pushSubscribed: state.pushReady,
          pushAllowedHere: pushAllowedHere(),
          secureContext: secureOk(),
        }
      },
    }

    // ---- lifecycle ---------------------------------------------------------

    function boot() {
      if (state.booted) return
      state.booted = true
      registerSW()
      // Returning visitor with permission already granted: resync the push
      // subscription — the host may have lost it (state reset, failed POST)
      // and a silent resync needs no prompt (zen-remote's resyncPush).
      if (permission() === 'granted') subscribePush()
      if (!snoozed() && permission() !== 'granted') showAskCard()
    }

    function apply(ctx) {
      applySettings(ctx)
      if (disabledByUrl() || disabledByStorage()) {
        window.__DSH_PWA_NOTIFY__.disabled = true
        return
      }
      // Everything created here is removed when this plugin fiber stops
      // (bundle hot-reload or removal), so no DOM/listeners leak across
      // updates.
      ctx.effect(() => {
        if (document.readyState === 'complete') boot()
        else {
          state.loadListener = function () {
            boot()
          }
          window.addEventListener('load', state.loadListener, { once: true })
        }
        return () => {
          if (state.loadListener !== null) {
            window.removeEventListener('load', state.loadListener)
            state.loadListener = null
          }
          removeCard()
          state.booted = false
          state.pushReady = false
          // Best-effort: with the plugin gone, its SW has nothing left to
          // say. Unregister keeps scope '/' clean for other PWA plugins
          // (dsh-zen-remote's gateway SW, for one).
          if (swSupported() && secureOk()) {
            navigator.serviceWorker
              .getRegistration('/')
              .then(function (reg) {
                if (reg && reg.active && reg.active.scriptUrl) {
                  try {
                    if (new URL(reg.active.scriptUrl).pathname.indexOf(BASE + '/') === 0) return reg.unregister()
                  } catch (_) {}
                }
                return undefined
              })
              .catch(function () {})
          }
        }
      }, 'dsh-pwa-notify: client')
    }

    // ---- Settings → 通知推送 (settings.section slot) -------------------------
    //
    // Backed by the host's `dsh-pwa-notify` settings namespace (scope.get/set
    // persist through dsh-settings-file) plus this plugin's own routes for
    // test sends and the subscription count. Styling/classes follow
    // dsh-login-gate's proven settings-card shape.

    var SETTINGS_CSS = `.pwn-section{max-width:560px;display:flex;flex-direction:column;gap:2px}
.pwn-section-title{margin:0 0 2px;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e8ec);line-height:1.4}
.pwn-section-desc{margin:0 0 10px;color:var(--dsw-alias-label-tertiary,#9aa3af);font-size:13px;line-height:1.5}
.pwn-field{display:flex;flex-direction:column;gap:7px;padding:12px 0}
.pwn-field+.pwn-field{border-top:1px solid var(--dsw-alias-border-l2,#2c313a)}
.pwn-label{color:var(--dsw-alias-label-primary,#c2c8d0);font-size:13px;font-weight:500;line-height:1.5}
.pwn-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pwn-input{border:1px solid var(--dsw-alias-border-l2,#333945);background:var(--dsw-alias-bg-layer-3,#16181d);height:34px;font:inherit;color:var(--dsw-alias-label-primary,#e6e8ec);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box;flex:1;min-width:0}
.pwn-input:focus-visible{border-color:var(--dsw-alias-brand-primary,#4f8ef7);outline:none}
.pwn-input::placeholder{color:var(--dsw-alias-label-tertiary,#6b7280)}
.pwn-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:6px 14px;font-size:13px;line-height:1.5;background:#3567f6;color:#fff;align-self:flex-start}
.pwn-btn:hover{background:#2c58dd}
[data-ds-dark-theme] .pwn-btn{background:#000;color:#fff}
[data-ds-dark-theme] .pwn-btn:hover{background:#1f2127}
.pwn-btn-ghost{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#333945);border-radius:8px;padding:6px 14px;font-size:13px;line-height:1.5;background:transparent;color:var(--dsw-alias-label-secondary,#c2c8d0)}
.pwn-btn-ghost:hover{border-color:var(--dsw-alias-brand-primary,#4f8ef7);color:var(--dsw-alias-label-primary,#e6e8ec)}
.pwn-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary,#c2c8d0);line-height:1.5;cursor:pointer}
.pwn-check input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,#4f8ef7);cursor:pointer}
.pwn-hint{color:var(--dsw-alias-label-tertiary,#6b7280);margin:0;font-size:12px;line-height:1.5}
.pwn-msg{margin:4px 0 0;font-size:12px;line-height:1.5}
.pwn-msg-ok{color:#7bd88f}
.pwn-msg-err{color:#ff9aa4}
.pwn-code{font-family:ui-monospace,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-3,#16181d);border:1px solid var(--dsw-alias-border-l2,#2c313a);border-radius:4px;padding:0 4px}`

    function ensureSettingsStyle() {
      if (document.querySelector('style[data-plugin="dsh-pwa-notify-settings"]') === null) {
        var tag = document.createElement('style')
        tag.setAttribute('data-plugin', 'dsh-pwa-notify-settings')
        tag.textContent = SETTINGS_CSS
        document.head.appendChild(tag)
      }
    }

    var TEXT_FIELDS = [
      { key: 'textApprovalTitle', label: '授权 · 标题', ph: 'DSH 等你授权' },
      { key: 'textApprovalBody', label: '授权 · 内容', ph: '{tool} 需要授权才能继续' },
      { key: 'textQuestionTitle', label: '提问 · 标题', ph: 'DSH 等你回答（含计划审阅）' },
      { key: 'textQuestionBody', label: '提问 · 内容', ph: '{question}（计划审阅填计划开头；关掉摘要时固定为提示语）' },
      { key: 'textTurnTitle', label: '完成 · 标题', ph: 'DSH 任务完成' },
      { key: 'textTurnBody', label: '完成 · 内容', ph: '{summary}（关掉摘要时固定为提示语）' },
      { key: 'textErrorTitle', label: '出错 · 标题', ph: 'DSH 任务出错' },
      { key: 'textErrorBody', label: '出错 · 内容', ph: '{error}（诊断信息，不受摘要开关影响）' },
      { key: 'textGoalTitle', label: '受阻 · 标题', ph: 'DSH 目标受阻' },
      { key: 'textGoalBody', label: '受阻 · 内容', ph: '{reason}（不受摘要开关影响）' },
      { key: 'textJobTitle', label: '任务结束 · 标题', ph: 'DSH 后台任务结束' },
      { key: 'textJobBody', label: '任务结束 · 内容', ph: '{label}（{status}）' },
    ]

    var KIND_TESTS = [
      { kind: 'approval', label: '测试·授权' },
      { kind: 'question', label: '测试·提问' },
      { kind: 'turn-end', label: '测试·完成' },
      { kind: 'error', label: '测试·出错' },
      { kind: 'goal', label: '测试·受阻' },
      { kind: 'job', label: '测试·任务' },
    ]

    function postTest(kind) {
      return fetch(BASE + '/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kind }),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return { ok: false }
          })
        })
        .catch(function () {
          return { ok: false }
        })
    }

    function NotifySection(props) {
      var scope = props.scope
      var snapState = react.useState(function () { return scope.getSnapshot() })
      var snap = snapState[0]
      var setSnap = snapState[1]
      react.useEffect(function () {
        return scope.subscribe(function () { setSnap(scope.getSnapshot()) })
      }, [scope])

      var msgState = react.useState(null)
      var msg = msgState[0]
      var setMsg = msgState[1]

      var subState = react.useState(null)
      var subs = subState[0]
      var setSubs = subState[1]
      var refreshSubs = function () {
        fetch(BASE + '/devices', { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) { if (d && d.ok) setSubs(d.devices) })
          .catch(function () {})
      }
      react.useEffect(refreshSubs, [])

      function removeDevice(endpoint) {
        if (!window.confirm('删除这台设备的推送订阅？若该设备仍在使用，它下次打开应用会自动重新订阅。')) return
        setMsg(null)
        fetch(BASE + '/devices/remove', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: endpoint }),
        })
          .then(function (r) { return r.json() })
          .then(function (r) {
            if (r.ok) {
              setMsg({ kind: 'ok', text: r.removed ? '已删除该设备的订阅。' : '未找到该订阅（可能已删除）。' })
              refreshSubs()
            } else setMsg({ kind: 'err', text: '删除失败，请重试。' })
          })
          .catch(function () { setMsg({ kind: 'err', text: '删除失败，请重试。' }) })
      }

      function fmtTime(ts) {
        if (ts === null || ts === undefined) return '—'
        var d = new Date(ts)
        var pad = function (n) { return (n < 10 ? '0' : '') + n }
        return d.getMonth() + 1 + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      }

      var ready = snap.status === 'ready'
      var v = ready && snap.value ? snap.value : null

      // text inputs keep local draft state; 保存 writes all six keys at once
      var draftState = react.useState({})
      var draft = draftState[0]
      var setDraft = draftState[1]
      var draftFor = function (key) {
        return key in draft ? draft[key] : v ? String(v[key] || '') : ''
      }
      var setDraftKey = function (key, value) {
        var next = Object.assign({}, draft)
        next[key] = value
        setDraft(next)
      }

      function saveToggle(key, checked) {
        setMsg(null)
        scope.set(key, checked).then(
          function () { setMsg({ kind: 'ok', text: '已保存，即时生效。' }) },
          function () { setMsg({ kind: 'err', text: '保存失败，请重试。' }) },
        )
      }

      function saveTexts() {
        setMsg(null)
        var chain = Promise.resolve()
        var _loop = function (f) {
          if (f.key in draft) {
            chain = chain.then(function () { return scope.set(f.key, draft[f.key].trim()) })
          }
        }
        for (var i = 0; i < TEXT_FIELDS.length; i++) _loop(TEXT_FIELDS[i])
        chain.then(
          function () {
            setDraft({})
            setMsg({ kind: 'ok', text: '文案已保存，即时生效。' })
          },
          function () { setMsg({ kind: 'err', text: '保存失败，请重试。' }) },
        )
      }

      function sendKindTest(kind) {
        setMsg(null)
        postTest(kind).then(function (r) {
          if (r.ok && r.sent > 0) setMsg({ kind: 'ok', text: '已推送到 ' + r.sent + ' 台设备：' + r.title })
          else if (r.ok) setMsg({ kind: 'err', text: '发送成功，但当前没有已订阅设备（先在页面/主屏 PWA 里开启通知）。' })
          else setMsg({ kind: 'err', text: '发送失败，请重试。' })
        })
      }

      return h('div', { className: 'pwn-section' },
        h('h2', { className: 'pwn-section-title' }, '通知推送'),
        h('p', { className: 'pwn-section-desc' }, 'PWA 锁屏推送的开关、文案与测试'),
        !ready ? h('p', { className: 'pwn-hint' }, '正在读取设置…') : null,
        ready ? h('div', { className: 'pwn-field' },
          h('label', { className: 'pwn-label' }, '推送开关'),
          h('label', { className: 'pwn-check' },
            h('input', { type: 'checkbox', checked: v && v.approvalPush !== false, onChange: function (e) { saveToggle('approvalPush', e.target.checked) } }),
            '工具等授权时推送'
          ),
          h('label', { className: 'pwn-check' },
            h('input', { type: 'checkbox', checked: v && v.questionPush !== false, onChange: function (e) { saveToggle('questionPush', e.target.checked) } }),
            '智能体提问时推送'
          ),
          h('label', { className: 'pwn-check' },
            h('input', { type: 'checkbox', checked: v && v.turnEndPush === true, onChange: function (e) { saveToggle('turnEndPush', e.target.checked) } }),
            '回合完成时推送'
          ),
          h('label', { className: 'pwn-check' },
            h('input', { type: 'checkbox', checked: v && v.errorPush !== false, onChange: function (e) { saveToggle('errorPush', e.target.checked) } }),
            '回合出错时推送（模型失败/限流等）'
          ),
          h('label', { className: 'pwn-check' },
            h('input', { type: 'checkbox', checked: v && v.goalPush !== false, onChange: function (e) { saveToggle('goalPush', e.target.checked) } }),
            '目标受阻时推送'
          ),
          h('label', { className: 'pwn-check' },
            h('input', { type: 'checkbox', checked: v && v.jobPush !== false, onChange: function (e) { saveToggle('jobPush', e.target.checked) } }),
            '后台任务结束时推送（完成/失败）'
          ),
          h('label', { className: 'pwn-check' },
            h('input', { type: 'checkbox', checked: v && v.includeSummary === true, onChange: function (e) { saveToggle('includeSummary', e.target.checked) } }),
            '通知带对话摘要（填入 {question} / {summary}）'
          ),
          h('p', { className: 'pwn-hint' }, '子代理的回合完成永远不推。')
        ) : null,
        ready ? h('div', { className: 'pwn-field' },
          h('label', { className: 'pwn-label' }, '推送文案'),
          TEXT_FIELDS.map(function (f) {
            return h('input', {
              key: f.key,
              className: 'pwn-input',
              type: 'text',
              placeholder: f.ph,
              value: draftFor(f.key),
              onChange: function (e) { setDraftKey(f.key, e.target.value) },
            })
          }),
          h('div', { className: 'pwn-row' },
            h('button', { type: 'button', className: 'pwn-btn', onClick: saveTexts }, '保存文案')
          ),
          h('p', { className: 'pwn-hint' },
            '留空用默认。可用变量：', h('span', { className: 'pwn-code' }, '{tool}'), ' 工具名、',
            h('span', { className: 'pwn-code' }, '{question}'), ' 提问原文、',
            h('span', { className: 'pwn-code' }, '{summary}'), ' 本回合摘要；后两个只在开启「带摘要」时有内容。'
          )
        ) : null,
        ready ? h('div', { className: 'pwn-field' },
          h('label', { className: 'pwn-label' }, '测试发送'),
          h('div', { className: 'pwn-row' },
            KIND_TESTS.map(function (t) {
              return h('button', { key: t.kind, type: 'button', className: 'pwn-btn-ghost', onClick: function () { sendKindTest(t.kind) } }, t.label)
            })
          ),
          h('p', { className: 'pwn-hint' }, '按当前文案模板 + 示例变量推一条真通知到已订阅设备，用于预览自定义效果。')
        ) : null,
        ready ? h('div', { className: 'pwn-field' },
          h('label', { className: 'pwn-label' }, '订阅设备'),
          subs === null
            ? h('p', { className: 'pwn-hint' }, '读取中…')
            : subs.length === 0
              ? h('p', { className: 'pwn-hint' }, '还没有已订阅设备（页面或主屏 PWA 里开启过通知才会出现）。')
              : subs.map(function (d) {
                  return h('div', {
                    key: d.endpoint,
                    style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
                  },
                    h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary,#c2c8d0)' } }, d.label),
                    h('span', { className: 'pwn-hint', style: { margin: 0 } },
                      d.host + ' · 活跃 ' + fmtTime(d.updatedAt)),
                    h('button', {
                      type: 'button',
                      className: 'pwn-btn-ghost',
                      style: { padding: '2px 10px', fontSize: '12px' },
                      onClick: function () { removeDevice(d.endpoint) },
                    }, '删除'),
                  )
                }),
          h('p', { className: 'pwn-hint' },
            '「活跃」是该设备最近一次打开应用自动续订的时间——常用设备会一直刷新，废弃设备停在很久以前。删除是软操作：被删的设备若仍在用，下次打开会自动重新订阅；要彻底踢掉某台设备，请在那台设备上关闭通知权限或删除主屏 App。'
          ),
          h('div', { className: 'pwn-row' },
            h('button', { type: 'button', className: 'pwn-btn-ghost', onClick: refreshSubs }, '刷新')
          )
        ) : null,
        msg ? h('p', { className: 'pwn-msg ' + (msg.kind === 'ok' ? 'pwn-msg-ok' : 'pwn-msg-err') }, msg.text) : null,
      )
    }

    function applySettings(ctx) {
      ensureSettingsStyle()
      var scope = ctx.settingsScope.bind({ namespace: 'dsh-pwa-notify' })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-pwa-notify',
            order: 40,
            label: function () { return '通知推送' },
            inject: function () { return { scope: scope } },
          },
          NotifySection,
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    return module.exports
  },
})
