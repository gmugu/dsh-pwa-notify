/**
 * dsh-pwa-notify — client half (browser bundle, discovered via dsh.client).
 *
 * Runs on every device with no React and no slots dependency:
 *   1. registers the service worker served by this plugin's host half at
 *      /_dsh/pwa-notify/sw.js with scope "/" (the host sends
 *      Service-Worker-Allowed: /);
 *   2. subscribes to Web Push with the VAPID key the host injects into the
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
    const DISABLE_KEY = 'dsh-pwa-notify'
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

    // Permission must be asked from inside the click gesture: Safari
    // (including home-screen PWAs) rejects permission requests made outside
    // one. Returns 'denied' on throw so the caller can show a message.
    // (Accidentally deleted with the v0.8.0 card cutover while enablePush
    // still called it — every first-time opt-in silently died; restored.)
    async function requestPermissionInGesture() {
      try {
        return await window.Notification.requestPermission()
      } catch (err) {
        console.warn('[dsh-pwa-notify] permission request failed:', err)
        return 'denied'
      }
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
      test: function () {
        if (permission() === 'granted') sendTest()
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

      // Push onboarding state (mirrored locally so the row refreshes after
      // an action; the card is the ONLY opt-in entry since v0.8.0 — no
      // first-load popup anymore).
      var permState = react.useState(function () { return { perm: permission(), ready: state.pushReady } })
      var ps = permState[0]
      var setPs = permState[1]
      var refreshPerm = function () { setPs({ perm: permission(), ready: state.pushReady }) }

      // Every branch must leave a visible trace: a subscribePush() failure
      // used to render as "nothing happened" — surface it as an error line.
      function finishSubscribe() {
        subscribePush().then(function (ok) {
          refreshPerm()
          if (!ok) setMsg({ kind: 'err', text: '推送订阅失败，请重试（原因见浏览器控制台）。' })
        })
      }

      function enablePush() {
        setMsg(null)
        if (ps.perm === 'granted') {
          finishSubscribe()
          return
        }
        requestPermissionInGesture().then(function (result) {
          if (result === 'granted') finishSubscribe()
          else {
            refreshPerm()
            setMsg({ kind: 'err', text: '未获得通知权限（' + result + '）。' })
          }
        })
      }

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

      function saveToggle(key, checked) {
        setMsg(null)
        scope.set(key, checked).then(
          function () { setMsg({ kind: 'ok', text: '已保存，即时生效。' }) },
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
          h('label', { className: 'pwn-label' }, '推送状态'),
          h('div', { className: 'pwn-row' },
            ps.ready
              ? h('button', { type: 'button', className: 'pwn-btn', disabled: true, style: { opacity: 0.5, cursor: 'default' } }, '已开启推送')
              : ps.perm === 'denied'
                ? h('button', { type: 'button', className: 'pwn-btn', disabled: true, style: { opacity: 0.5, cursor: 'default' } }, '通知权限被拒绝')
                : !secureOk()
                  ? h('button', { type: 'button', className: 'pwn-btn', disabled: true, style: { opacity: 0.5, cursor: 'default' } }, '需要 HTTPS')
                  : isIOS() && !isStandalone()
                    ? h('button', { type: 'button', className: 'pwn-btn', disabled: true, style: { opacity: 0.5, cursor: 'default' } }, '先添加到主屏幕')
                    : h('button', { type: 'button', className: 'pwn-btn', onClick: enablePush }, ps.perm === 'granted' ? '重新连接' : '开启通知')
          ),
          h('p', { className: 'pwn-hint' },
            ps.ready
              ? '本机已在接收推送。'
              : ps.perm === 'denied'
                ? '通知权限已被拒绝，请到系统/浏览器的站点设置里重新允许后刷新。'
                : !secureOk()
                  ? '当前是非安全上下文（http），Service Worker 与推送不可用。'
                  : isIOS() && !isStandalone()
                    ? 'iPhone 上推送只对「添加到主屏幕」后的应用生效：先用 Safari 分享菜单添加，再从主屏图标打开本页开启。'
                    : ps.perm === 'granted'
                      ? '权限已授予但订阅未连上，点「重新连接」重试。'
                      : '开启后，智能体等你授权、等你回答、出错时会推送到这台设备（含锁屏）。'
          ),
          h('div', { className: 'pwn-row' },
            h('button', { type: 'button', className: 'pwn-btn-ghost', onClick: refreshPerm }, '刷新状态')
          )
        ) : null,
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
