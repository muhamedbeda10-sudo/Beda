import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

// public/reach-all-sw.js run as a service worker would run it, against a device's own caches and windows.
const source = readFileSync(fileURLToPath(new URL('../../public/reach-all-sw.js', import.meta.url)), 'utf8')

function device() {
  const stored = new Map<string, Response>()
  const navigated: string[] = []
  const windows = [{ url: 'http://app/history', navigate: async (u: string) => void navigated.push(u) }, { url: 'http://app/reports/1', navigate: async (u: string) => void navigated.push(u) }]
  let claimed = 0
  const caches = { open: async () => ({ match: async (k: string) => stored.get(k), put: async (k: string, v: Response) => void stored.set(k, v) }) }
  /** One worker of a new version taking over: its activate run to the end, as the browser runs it. */
  const activate = async () => {
    const listeners: ((e: { waitUntil(p: Promise<unknown>): void }) => void)[] = []
    const self = {
      addEventListener: (type: string, fn: (e: { waitUntil(p: Promise<unknown>): void }) => void) => type === 'activate' && listeners.push(fn),
      clients: { claim: async () => void claimed++, matchAll: async () => windows },
    }
    runInNewContext(source, { self, caches, Response, setTimeout, Date })
    let activation: Promise<unknown> = Promise.resolve()
    let reloadedDuringActivation = false
    for (const fn of listeners) fn({ waitUntil: (p) => void (activation = p) })
    await activation
    reloadedDuringActivation = navigated.length > 0
    await new Promise((r) => setTimeout(r, 5))
    return { reloadedDuringActivation }
  }
  return { activate, navigated, claimed: () => claimed }
}

describe('a version that must reach every open window at once', () => {
  it('reloads every window of the app once on its own address, after taking them over', async () => {
    const d = device()
    const first = await d.activate()
    expect(d.claimed()).toBe(1)
    expect(d.navigated).toEqual(['http://app/history', 'http://app/reports/1'])
    // Never awaited inside activate: a reloaded window's request waits for this worker to be active.
    expect(first.reloadedDuringActivation).toBe(false)
  })

  it('never again on that device: the next versions reload only through the app', async () => {
    const d = device()
    await d.activate()
    await d.activate()
    expect(d.navigated).toHaveLength(2)
  })
})
