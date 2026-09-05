import { useEffect, useState } from 'react'

/** The event Chromium-based browsers fire when the app may be installed. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISSED_KEY = 'qc-install-dismissed'

/** True when the app is already running from the home screen. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

/** iPhone and iPad only install through Safari's share sheet; there is no prompt to call. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  return /iPhone|iPad|iPod/.test(ua) || iPadOs
}

/**
 * How this device can install the app: with a native prompt (Android,
 * desktop Chrome and Edge), by hand through Safari's share sheet (iOS), or
 * not at all (already installed, or the browser does not offer it).
 */
export function useInstallPrompt(): {
  mode: 'prompt' | 'ios' | 'none'
  install: () => Promise<void>
  dismiss: () => void
} {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [installed, setInstalled] = useState(isStandalone)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const mode: 'prompt' | 'ios' | 'none' = installed || dismissed ? 'none' : deferred ? 'prompt' : isIos() ? 'ios' : 'none'

  return {
    mode,
    install: async () => {
      if (!deferred) return
      await deferred.prompt()
      const { outcome } = await deferred.userChoice
      if (outcome === 'accepted') setInstalled(true)
      setDeferred(null)
    },
    dismiss: () => {
      setDismissed(true)
      try {
        localStorage.setItem(DISMISSED_KEY, '1')
      } catch {
        /* the banner simply returns next time */
      }
    },
  }
}
