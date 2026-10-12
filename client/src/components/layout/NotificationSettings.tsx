// ============================================================================
// §24 — "Notifications on this device", in the account panel and the phone's
// menu: whether they are on, turning them off (or on again: the browser asks
// first), and the app's own chime on or off. The browser itself asks to allow
// them at the first tap in the app (lib/push.ts); this is where they are
// changed later. Says plainly why they cannot be on when they cannot: blocked
// in the browser, a browser without them, or an iPhone where the app must
// first be added to the Home Screen.
// ============================================================================

import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff, Loader2, Volume2, VolumeX } from 'lucide-react'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { chimeOn, playChime, setChimeOn } from '@/lib/chime'
import { PUSH_CHANGED_EVENT, disablePush, enablePush, pushState, type PushState } from '@/lib/push'
import { cn } from '@/lib/utils'

const WHY_NOT: Partial<Record<PushState, string>> = {
  unsupported: 'This browser cannot show notifications. Use Chrome, Edge, Firefox or Safari, or the installed app.',
  'install-first': 'On iPhone or iPad: tap Share, then “Add to Home Screen”, open the app from there and turn notifications on.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back here.',
  'server-off': 'Notifications are switched off on the server.',
}

const ROW = 'flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors touch:min-h-[44px] disabled:opacity-50'

export function NotificationSettings() {
  const { profile } = useAuth()
  const { toast } = useApp()
  const userId = profile?.id ?? ''
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState<'on' | 'off' | null>(null)
  const [sound, setSound] = useState(chimeOn())

  const refresh = useCallback(async () => {
    if (userId) setState(await pushState(userId))
  }, [userId])
  useEffect(() => {
    void refresh()
    // The browser's question answered at a tap elsewhere, or turned off on another screen: this follows.
    const follow = () => void refresh()
    window.addEventListener(PUSH_CHANGED_EVENT, follow)
    return () => window.removeEventListener(PUSH_CHANGED_EVENT, follow)
  }, [refresh])

  const act = async (what: 'on' | 'off', fn: () => Promise<void>) => {
    setBusy(what)
    try {
      await fn()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work.', 'error')
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const on = state === 'on'
  const why = state ? WHY_NOT[state] : undefined
  return (
    <div className="space-y-2 rounded-xl bg-slate-100 p-2 dark:bg-slate-800">
      <p className="flex items-center gap-1.5 px-1 text-xs font-bold uppercase tracking-wide text-muted">
        <Bell className="h-3.5 w-3.5" aria-hidden /> Notifications on this device
      </p>
      {state === null ? (
        <p className="flex items-center gap-2 px-1 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
        </p>
      ) : why ? (
        <p className="px-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{why}</p>
      ) : (
        <>
          <p className="px-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {on
              ? 'On: alerts, chat messages and notices reach this device with its sound, even with the app closed.'
              : 'Get alerts, chat messages and notices here with a sound, even with the app closed.'}
          </p>
          {on ? (
            <button type="button" className={cn(ROW, 'bg-white text-muted shadow-sm hover:text-rose-600 dark:bg-slate-950')} disabled={busy !== null} onClick={() => void act('off', () => disablePush(userId))}>
              {busy === 'off' ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellOff className="h-4 w-4" />} Turn off
            </button>
          ) : (
            <button type="button" className={cn(ROW, 'bg-brand-600 text-white hover:bg-brand-700')} disabled={busy !== null} onClick={() => void act('on', async () => {
              await enablePush(userId)
              toast('Notifications are on for this device.', 'success')
            })}>
              {busy === 'on' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />} Turn on notifications
            </button>
          )}
        </>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={sound}
        onClick={() => {
          const next = !sound
          setChimeOn(next)
          setSound(next)
          if (next) playChime()
        }}
        className={cn(ROW, 'justify-start text-slate-700 hover:bg-white/70 dark:text-slate-200 dark:hover:bg-slate-900/60')}
      >
        {sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        <span className="flex-1 text-start">Sound while the app is open</span>
        <span className={cn('text-xs', sound ? 'text-brand-700 dark:text-brand-300' : 'text-muted')}>{sound ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}
