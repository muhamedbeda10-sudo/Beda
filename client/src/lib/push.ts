// ============================================================================
// §24 — notifications on this device, with the app closed (Web Push). They
// are on unless the person turns them off: the first time they tap anywhere
// in the app, the browser asks them to allow notifications (browsers show
// that question only right after a tap or a key press, so it cannot appear
// on its own). Allowed, the device subscribes with the server's key and the
// server pushes the bell's alerts, chat messages and notices to it; allowed
// once, every later sign-in on the device subscribes again by itself. A
// question dismissed is asked again the next time the app opens; one blocked
// is not asked again. Signing out turns the device off (a shared tablet never
// shows the last person's messages); "Turn off" in the account panel keeps it
// off for that person on that device.
//
// On an iPhone or iPad a web page cannot get pushes: the app must be added to
// the Home Screen and opened from there (iOS 16.4 and later).
// ============================================================================

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { PushConfigResponse, PushPayload } from '@qc/shared/api'
import { api } from './api'
import { playChime } from './chime'

export type PushState =
  /** This browser has no push at all. */
  | 'unsupported'
  /** An iPhone or iPad in the browser: add to the Home Screen first. */
  | 'install-first'
  /** The person blocked notifications for this site. */
  | 'blocked'
  /** The server does not send them. */
  | 'server-off'
  | 'off'
  | 'on'

const PREF_KEY = (userId: string) => `qc-push:${userId}`
/** The browser's question was put this time the app opened: not again before it opens anew. */
const ASKED_KEY = 'qc-push-asked'
/** Told when this device turns notifications on or off, so the account panel follows. */
export const PUSH_CHANGED_EVENT = 'qc-push-changed'
/** The service worker is ready within this, or push is not available here (e.g. the dev server, which runs none). */
const READY_TIMEOUT_MS = 4000

const isAppleMobile = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** The person turned them off on this device ("Turn off"): nothing is asked or subscribed for them here. */
function turnedOff(userId: string): boolean {
  try {
    return localStorage.getItem(PREF_KEY(userId)) === 'off'
  } catch {
    return false
  }
}

function setChoice(userId: string, on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY(userId), on ? 'on' : 'off')
  } catch {
    /* private mode: the default (on) stays */
  }
  window.dispatchEvent(new Event(PUSH_CHANGED_EVENT))
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), READY_TIMEOUT_MS))])
}

/** The server's key, as the browser takes it. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const sameKey = (sub: PushSubscription, key: Uint8Array) => {
  const have = sub.options?.applicationServerKey
  if (!have) return true
  const a = new Uint8Array(have)
  return a.length === key.length && a.every((b, i) => b === key[i])
}

/** Where this device stands, for the person signed in. */
export async function pushState(userId: string): Promise<PushState> {
  if (!pushSupported()) return isAppleMobile() && !isStandalone() ? 'install-first' : 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  const reg = await registration()
  if (!reg) return 'unsupported'
  const sub = await reg.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' && !turnedOff(userId) ? 'on' : 'off'
}

/** Subscribe this device and tell the server it is this person's. Asks the browser's permission when it has not been given. */
async function subscribe(userId: string): Promise<void> {
  const config = await api<PushConfigResponse>('/push/config')
  if (!config.enabled || !config.publicKey) throw new Error('Notifications are switched off on this server.')
  const reg = await registration()
  if (!reg) throw new Error('This browser cannot receive notifications here.')
  const key = keyBytes(config.publicKey)
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await api<void>('/push/subscriptions', { method: 'POST', body: sub.toJSON() })
  setChoice(userId, true)
}

/** The browser's question while it is open: a second ask (the first tap was on "Turn on" itself) waits for the same answer. */
let question: Promise<NotificationPermission> | null = null

/** Turn notifications on for this device: the browser asks first. Call it from a tap: browsers ask only then. */
export async function enablePush(userId: string): Promise<void> {
  // Asked before anything is awaited, so the browser still counts the tap.
  question ??= Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission().finally(() => (question = null))
  const permission = await question
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser’s site settings.' : 'Notifications were not allowed.')
  await subscribe(userId)
}

/** Turn them off for this device: the server forgets it, then the browser does. `keepChoice` (signing out): on again at the next sign-in. */
export async function disablePush(userId: string, keepChoice = false): Promise<void> {
  const reg = await registration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  if (sub) {
    try {
      await api<void>('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint }, noRetry: true })
    } catch {
      /* the server forgets it anyway when its push service says it is gone */
    }
    await sub.unsubscribe().catch(() => false)
  }
  if (!keepChoice) setChoice(userId, false)
  else window.dispatchEvent(new Event(PUSH_CHANGED_EVENT))
}

/** Signed in (or the app opened) with notifications allowed: this device is subscribed for this person. Quiet: never asks, never throws. */
export async function resumePush(userId: string): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted' || turnedOff(userId)) return
    await subscribe(userId)
  } catch {
    /* next time */
  }
}

/** Whether to put the browser's question at the next tap: not yet answered, not turned off, not already put since the app opened. */
export function shouldAskOnTap(userId: string): boolean {
  if (!pushSupported() || Notification.permission !== 'default' || turnedOff(userId)) return false
  try {
    return sessionStorage.getItem(ASKED_KEY) !== '1'
  } catch {
    return true
  }
}

/**
 * At the first tap or key press anywhere in the app, the browser asks to
 * allow notifications (it asks only then). Allowed, the device is subscribed.
 * Returns the clean-up that stops waiting for the tap.
 */
export function askOnFirstTap(userId: string): () => void {
  if (!shouldAskOnTap(userId)) return () => {}
  const events = ['click', 'keydown'] as const
  const stop = () => events.forEach((e) => document.removeEventListener(e, onTap, true))
  function onTap(e: Event) {
    // Typing in a field is not a moment to interrupt; the next tap will do.
    if (e.type === 'keydown' && e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]')) return
    stop()
    try {
      sessionStorage.setItem(ASKED_KEY, '1')
    } catch {
      /* asked again next tap: harmless */
    }
    void enablePush(userId).catch(() => window.dispatchEvent(new Event(PUSH_CHANGED_EVENT)))
  }
  events.forEach((e) => document.addEventListener(e, onTap, true))
  return stop
}

/**
 * What a push changes on screen, refreshed at once. An alert may say an answer of the assistant is ready (§20): its
 * conversation and the list of them catch up too.
 */
const REFRESH: Record<PushPayload['kind'], readonly (readonly string[])[]> = {
  alert: [['notifications'], ['ai', 'conversations'], ['ai', 'messages']],
  chat: [['chat']],
  notice: [['notices']],
}

/**
 * The open app and its service worker: a push while the app is in front is
 * shown here instead of as a notification — the chime, and what it changed
 * refreshed — and a tapped notification opens its page without a reload.
 * Also subscribes this device for the person when they allowed notifications,
 * and has the browser ask them at their first tap when they have not answered.
 */
export function usePushBridge(userId: string | null): void {
  const qc = useQueryClient()
  const navigate = useNavigate()

  useEffect(() => {
    if (!userId) return
    void resumePush(userId)
    return askOnFirstTap(userId)
  }, [userId])

  useEffect(() => {
    if (!pushSupported()) return
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; payload?: PushPayload; inFront?: boolean; url?: string } | null
      if (msg?.type === 'qc-open' && typeof msg.url === 'string' && msg.url.startsWith('/') && !msg.url.startsWith('//')) {
        navigate(msg.url)
        return
      }
      if (msg?.type !== 'qc-push' || !msg.payload) return
      for (const key of REFRESH[msg.payload.kind] ?? []) void qc.invalidateQueries({ queryKey: [...key] })
      if (msg.inFront && document.visibilityState === 'visible' && document.hasFocus()) playChime()
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [qc, navigate])
}
