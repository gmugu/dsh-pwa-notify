/* dsh-pwa-notify · service worker
 *
 * Notification display + click-to-focus. NO fetch handler and no caching of
 * DSH's own assets: the app's JS/CSS bundles change on every deploy without
 * their filenames changing, so a caching worker would keep serving
 * yesterday's code on the next cold start (the "new DOM + old CSS" failure
 * dsh-zen-remote hit with its sw v2 and rewrote as v3). With no fetch
 * handler this worker is transparent to every request the app makes.
 *
 * Two display paths converge here:
 *   - push (real Web Push): the push service wakes this worker with an
 *     aes128gcm-encrypted payload the DSH host produced (src/webpush.js) —
 *     works with the app fully closed, which is the whole point on iOS;
 *   - local: the page (running in the background) polls the host and calls
 *     registration.showNotification() on this worker.
 *
 * Served by the host half at /_dsh/pwa-notify/sw.js with
 * Service-Worker-Allowed: / so it may control scope '/' despite living one
 * directory deep.
 */
'use strict'

self.addEventListener('install', function () {
  // Safe with no fetch handler: the worker only affects future notification
  // display; skipping the wait cannot yank code from a running page.
  self.skipWaiting()
})

self.addEventListener('activate', function (event) {
  // Take over already-open tabs right away so notifications work without a
  // reload after the plugin (or this worker) updates.
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', function (event) {
  var data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = {}
  }
  var title = data.title || 'DSH'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/_dsh/pwa-notify/icon-192.png',
      badge: '/_dsh/pwa-notify/icon-192.png',
      tag: data.tag || 'dsh',
      renotify: true,
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  // Click = focus the existing window when there is one (the local channel
  // implies one); open a fresh one for the push-with-app-closed case.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i]
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow('/')
    }),
  )
})
