// ============================================================================
// The session on this device: resuming it when the app opens, and ending it.
//
// The app opens offline as often as not on a factory floor. A session whose
// refresh cookie may be perfectly good must not land the inspector on the
// sign-in screen just because the server cannot be reached: the person last
// signed in here is remembered (who they are and what they may open — no
// secret; the server still checks every request), and the app opens as them
// with no token. The first request once the network is back refreshes; a
// session the server then refuses signs them out as usual.
//
// The remembered profile is only ever used with the session marker present,
// and is forgotten whenever the session ends here, so it can never open the
// app for someone whose session is gone.
// ============================================================================

import type { UserProfile } from '@qc/shared/types'
import { ApiError, api, hasSessionMarker, refreshAccessToken, setAccessToken, setSignedInUser } from './api'
import { dropDeviceSubscription } from './push'
import { clearMediaCache } from '@/services/mediaCache'

const PROFILE_KEY = 'qc-profile-v1'

/** Keeps who is signed in on this device, for opening the app while the server cannot be reached. */
export function rememberProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch {
    /* private mode: the app needs the network to open, as before */
  }
}

/** The person last signed in on this device, if the app remembers them. */
export function rememberedProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as UserProfile
    return p && typeof p.id === 'string' && Array.isArray(p.permissions) ? p : null
  } catch {
    return null
  }
}

export function forgetProfile(): void {
  try {
    localStorage.removeItem(PROFILE_KEY)
  } catch {
    /* nothing kept */
  }
}

/** What opening the app found: the person signed in (or not), and whether the server could not be reached to ask. */
export interface Resumed {
  profile: UserProfile | null
  /** The server could not be asked: the profile, if any, is the remembered one, and no token is held yet. */
  unreachable: boolean
}

/** Whether an error means the server was not reached (or could not answer), as against an answer that refuses. */
function notReached(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status === 0 || e.status >= 500
}

/**
 * Resume the device's session from the refresh cookie. Signed out only when
 * there is no session to resume or the server refuses it; when it cannot be
 * reached, the remembered person, if any.
 */
export async function resumeSession(): Promise<Resumed> {
  if (!hasSessionMarker()) {
    forgetProfile()
    return { profile: null, unreachable: false }
  }
  const result = await refreshAccessToken()
  if (result === 'unreachable') return { profile: rememberedProfile(), unreachable: true }
  if (result !== 'ok') {
    forgetProfile()
    return { profile: null, unreachable: false }
  }
  try {
    const me = await api<UserProfile>('/auth/me', { noRetry: true })
    rememberProfile(me)
    return { profile: me, unreachable: false }
  } catch (e) {
    setAccessToken(null)
    if (notReached(e)) return { profile: rememberedProfile(), unreachable: true }
    forgetProfile()
    return { profile: null, unreachable: false }
  }
}

/**
 * Everything this device holds of the session, let go of: the token, who is
 * signed in, their notifications, and the photos and documents fetched with
 * their sign-in. Run whenever the session ends here — signed out, refused by
 * the server, or found to be another person's.
 */
export function endSessionOnDevice(): void {
  setAccessToken(null)
  setSignedInUser(null)
  forgetProfile()
  void dropDeviceSubscription()
  void clearMediaCache()
}
