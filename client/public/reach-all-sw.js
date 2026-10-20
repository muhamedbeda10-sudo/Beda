// ============================================================================
// One reload of every open window, once per device, when the owner asks for a
// version to reach everyone at once (vite.config.ts imports this file into the
// service worker Workbox generates). Each new version takes over by itself,
// but a page reloads into it only when its own code says so — and a page of
// an older version may never say so (main.tsx, lib/appUpdate.ts). This worker
// reloads them itself when it takes over: every window of the app, whatever
// version it runs, opens again on the same address in the newest version.
// A sample being recorded is kept as its draft and comes back after the
// reload; a figure typed into a dialog and not saved does not.
//
// FORCED_RELOAD names the request. Once a device has done it, it is marked in
// a cache of its own and never repeated; later versions reload only through
// the app, never under unsaved work. To reach everyone again, give it a new
// name in the version that must reach them.
// ============================================================================

/* eslint-disable no-restricted-globals */

const FORCED_RELOAD = '2026-10-20-reach-all'
const FORCED_RELOADS_CACHE = 'qc-forced-reloads'

/** Every window of the app opens again on its own address, served by this worker: the newest version. */
async function reloadEveryWindow() {
  const windows = await self.clients.matchAll({ type: 'window' })
  await Promise.all(windows.map((c) => c.navigate(c.url).catch(() => null)))
}

self.addEventListener('activate', (event) => {
  const firstTime = (async () => {
    const done = await caches.open(FORCED_RELOADS_CACHE)
    if (await done.match(FORCED_RELOAD)) return false
    // Marked first: a window that cannot be reloaded is never retried in a loop.
    await done.put(FORCED_RELOAD, new Response(new Date().toISOString()))
    return true
  })()
  // Taken over first: only a window this worker controls can be reloaded by it.
  event.waitUntil(firstTime.then(() => self.clients.claim()))
  // Never awaited inside activate: a reloaded window's request is answered by this worker only once it is active,
  // so activation waiting on the reload would wait on itself and the window would hang.
  firstTime.then((reload) => {
    if (reload) setTimeout(() => void reloadEveryWindow(), 0)
  })
})
