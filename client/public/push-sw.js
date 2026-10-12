// ============================================================================
// §24 — pushes, in the app's service worker (vite.config.ts imports this file
// into the one Workbox generates). A push shows as a notification with the
// device's own sound, even with the app closed; tapping it opens the app at
// what it is about (an open window is brought forward and taken there).
// While the app is open and in front, no notification is shown: the app is
// told instead, plays its chime and refreshes what changed. Every open
// window is told, so their badges follow at once.
// ============================================================================

/* eslint-disable no-restricted-globals */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = { title: 'LinkMisr QC', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'LinkMisr QC'
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const inFront = windows.some((c) => c.focused && c.visibilityState === 'visible')
      for (const c of windows) c.postMessage({ type: 'qc-push', payload: data, inFront })
      if (inFront) return
      await self.registration.showNotification(title, {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: data.tag || undefined,
        // A newer message of the same conversation replaces the older one, and still sounds.
        renotify: !!data.tag,
        silent: false,
        requireInteraction: data.severity === 'critical',
        vibrate: [180, 80, 180],
        dir: 'auto',
        timestamp: Date.now(),
        data: { url },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    (async () => {
      const target = new URL(url, self.location.origin).href
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin)
      if (open) {
        // The app goes there itself, without reloading (src/lib/push.ts: usePushBridge).
        open.postMessage({ type: 'qc-open', url })
        await open.focus()
        return
      }
      await self.clients.openWindow(target)
    })(),
  )
})

// The browser replaced the device's subscription (a key rotation): the app re-subscribes the next time it opens.
self.addEventListener('pushsubscriptionchange', () => {})
