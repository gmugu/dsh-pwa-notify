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
 *   3. subscribes to REAL Web Push with the VAPID key the host injects into
 *      the page (__DSH_PWA_NOTIFY_VAPID__) — iOS only allows this from a
 *      home-screen install, never a Safari tab, so the card guides there;
 *   4. polls /_dsh/pwa-notify/poll?since=<seq> as the fallback channel and
 *      shows whatever the host's policy decided through the service worker
 *      while the page runs in the background (skipped once push is live, so
 *      the two channels never double-notify).
 *
 * Display rule for the poll channel: when the page is HIDDEN every item
 * notifies; when VISIBLE only approval/question items do (they may belong to
 * a session the user is not looking at). The push channel always notifies —
 * the SW's push event fires regardless of page state.
 *
 * Disable per browser with ?pwaNotify=0 or localStorage 'dsh-pwa-notify'='0'.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pwa-notify',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const BASE = '/_dsh/pwa-notify'
    const SNOOZE_KEY = 'dsh-pwa-notify-snooze'
    const DISABLE_KEY = 'dsh-pwa-notify'
    const CID_KEY = 'dsh-pwa-notify-cid'
    const CARD_ID = 'dsh-pwa-notify-card'
    const SNOOZE_MS = 7 * 24 * 3600 * 1000
    // Poll channel cadence. Hidden/visible pair drives the FALLBACK channel
    // (notifications to pages without a push subscription). Once push is
    // live the poll demotes to a slow heartbeat: it no longer displays
    // anything (the SW's push event owns that), it only keeps the sequence
    // baseline fresh and acts as a dead-man check for silently broken push
    // (expired subscription, unreachable push service) — a 5-minute-late
    // notification beats a silently lost one.
    const POLL_HIDDEN_MS = 8000
    const POLL_VISIBLE_MS = 40000
    const POLL_PUSH_READY_MS = 5 * 60 * 1000
    const ICON = BASE + '/icon-192.png'

    const state = {
      reg: null,
      lastSeq: null,
      timer: null,
      card: null,
      booted: false,
      loadListener: null,
      visibilityListener: null,
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
          body: JSON.stringify({ subscription: sub.toJSON() }),
        })
        if (!res.ok) return false
        state.pushReady = true
        // Demote the poll to a heartbeat now that push owns display.
        if (state.booted) schedule()
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

    function clientId() {
      try {
        let cid = localStorage.getItem(CID_KEY)
        if (!cid) {
          cid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2)
          localStorage.setItem(CID_KEY, cid)
        }
        return cid
      } catch (_) {
        return 'c-' + Date.now()
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

    // ---- poll loop ---------------------------------------------------------

    async function pollOnce() {
      try {
        const url = BASE + '/poll?since=' + (state.lastSeq === null ? 0 : state.lastSeq) + '&cid=' + encodeURIComponent(clientId())
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        if (!data || typeof data.seq !== 'number') return
        const first = state.lastSeq === null
        state.lastSeq = data.seq
        // First poll after load only adopts the current sequence — replaying
        // history would fire a burst of stale notifications on every open.
        if (first || !Array.isArray(data.items) || data.items.length === 0) return
        // Push-subscribed: the SW's push event already displays these (even
        // with the page killed); displaying again here would double-notify.
        // The poll still runs so the sequence baseline stays fresh.
        if (state.pushReady) return
        const hidden = document.hidden
        const due = data.items.filter((it) => hidden || it.kind === 'approval' || it.kind === 'question')
        if (due.length === 0) return
        if (permission() !== 'granted') return
        const reg = (await swReady()) || state.reg
        for (const it of due) {
          const options = {
            body: it.body || '',
            icon: ICON,
            badge: ICON,
            tag: it.tag || 'dsh',
            renotify: true,
            data: { url: '/' },
          }
          if (reg && typeof reg.showNotification === 'function') reg.showNotification(it.title || 'DSH', options)
        }
      } catch (_) {
        // Offline or behind a gate — tolerated; the next tick retries.
      }
    }

    function schedule() {
      if (state.timer !== null) clearInterval(state.timer)
      const interval = state.pushReady ? POLL_PUSH_READY_MS : document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS
      state.timer = setInterval(pollOnce, interval)
    }

    function onVisibilityChange() {
      // Immediate poll on hide serves the fallback channel only; a
      // push-subscribed client hears from the SW's push event instead.
      if (document.hidden && !state.pushReady) pollOnce()
      schedule()
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
              pollOnce()
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
          lastSeq: state.lastSeq,
          secureContext: secureOk(),
        }
      },
    }

    // ---- lifecycle ---------------------------------------------------------

    function boot() {
      if (state.booted) return
      state.booted = true
      registerSW()
      pollOnce()
      schedule()
      state.visibilityListener = onVisibilityChange
      document.addEventListener('visibilitychange', state.visibilityListener)
      // Returning visitor with permission already granted: resync the push
      // subscription — the host may have lost it (state reset, failed POST)
      // and a silent resync needs no prompt (zen-remote's resyncPush).
      if (permission() === 'granted') subscribePush()
      if (!snoozed() && permission() !== 'granted') showAskCard()
    }

    function apply(ctx) {
      if (disabledByUrl() || disabledByStorage()) {
        window.__DSH_PWA_NOTIFY__.disabled = true
        return
      }
      // Everything created here is removed when this plugin fiber stops
      // (bundle hot-reload or removal), so no DOM/timers leak across updates.
      ctx.effect(() => {
        if (document.readyState === 'complete') boot()
        else {
          state.loadListener = function () {
            boot()
          }
          window.addEventListener('load', state.loadListener, { once: true })
        }
        return () => {
          if (state.timer !== null) {
            clearInterval(state.timer)
            state.timer = null
          }
          if (state.loadListener !== null) {
            window.removeEventListener('load', state.loadListener)
            state.loadListener = null
          }
          if (state.visibilityListener !== null) {
            document.removeEventListener('visibilitychange', state.visibilityListener)
            state.visibilityListener = null
          }
          removeCard()
          state.booted = false
          state.lastSeq = null
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

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
