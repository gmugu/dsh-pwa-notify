/* dsh-pwa-notify · service worker
 *
 * Notification display + click-to-focus ONLY. Deliberately no fetch handler
 * and no caching of DSH's own assets: the app's JS/CSS bundles change on
 * every deploy without their filenames changing, so a caching worker would
 * keep serving yesterday's code on the next cold start (the "new DOM + old
 * CSS" failure dsh-zen-remote hit with its sw v2 and rewrote as v3). With no
 * fetch handler this worker is transparent to every request the app makes.
 *
 * Notifications are LOCAL: the page (or this installed PWA) polls the host
 * route /_dsh/pwa-notify/poll and calls registration.showNotification() on
 * this worker, which works while the app runs in the background. There is no
 * push event handler because there is no Web Push transport here.
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

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  // Notifications here imply the app is open somewhere (they are local), so
  // click = focus the existing window; open a fresh one only as a fallback.
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
