import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AuthConfigResponse, AuthResponse, LoginRequest, RegisterRequest } from '@qc/shared/api'
import { can as holds, type Permission } from '@qc/shared/permissions'
import type { Role, UserProfile } from '@qc/shared/types'
import {
  ApiError,
  api,
  clearSessionMarker,
  setAccessToken,
  setProfileHandler,
  setSessionChangedHandler,
  setSessionLostHandler,
  setSignedInUser,
  shareToken,
} from '@/lib/api'
import { disablePush } from '@/lib/push'
import { endSessionOnDevice, rememberProfile, resumeSession } from '@/lib/session'

interface AuthValue {
  /** False until the first refresh attempt has settled. */
  ready: boolean
  profile: UserProfile | null
  role: Role
  /** §14 — what the person may open and do now (their role's set with their own overrides; everything for ADMIN+). */
  permissions: readonly Permission[]
  /** §14 — whether they may: the app hides what they may not, and the server refuses it anyway. */
  can: (permission: Permission) => boolean
  /** §14 — the AI assistant's owner, above the roles. */
  adminPlus: boolean
  error: string | null
  selfRegistrationOpen: boolean
  /** IANA zone the factory runs on — shifts are shown in it, as the API stores them. */
  factoryTimeZone: string
  signIn: (username: string, password: string) => Promise<void>
  signUp: (username: string, password: string, name: string) => Promise<void>
  signOutUser: () => Promise<void>
  /** Re-read the profile (after an admin changed a role, or a password change). */
  reloadProfile: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

const NONE: readonly Permission[] = []

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [ready, setReady] = useState(false)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selfRegistrationOpen, setSelfRegistrationOpen] = useState(true)
  const [factoryTimeZone, setFactoryTimeZone] = useState('Africa/Cairo')
  // Who is signed in now, for comparing an account the server sends back with.
  const current = useRef<UserProfile | null>(null)
  current.current = profile

  // Remembered for opening the app offline (lib/session.ts), and told to the API client, which never uses a token
  // for anyone else in this tab.
  useEffect(() => {
    setSignedInUser(profile?.id ?? null)
    if (profile) rememberProfile(profile)
  }, [profile])

  // The session ended here — expired, revoked, signed out: nothing of it stays on the device.
  const clearSession = useCallback(() => {
    endSessionOnDevice()
    setProfile(null)
    queryClient.clear()
  }, [queryClient])

  // The session on this device is another person's now (someone signed in from another tab of a shared tablet):
  // nothing of the old person's may go on under the new person's sign-in, so the app starts over as whoever it is.
  const sessionChanged = useCallback(() => {
    clearSession()
    window.location.reload()
  }, [clearSession])

  // §14 — the account as the server sends it again (each token refresh, and on coming back to the app):
  // a role or permission changed meanwhile shows at once, without signing in again.
  useEffect(() => {
    setProfileHandler((user) => setProfile((p) => (p && p.id === user.id ? user : p)))
    let last = Date.now()
    const onFocus = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 60_000) return
      last = Date.now()
      api<UserProfile>('/auth/me', { noRetry: true })
        .then((me) => {
          if (current.current && current.current.id !== me.id) sessionChanged()
          else setProfile((p) => (p && p.id === me.id ? me : p))
        })
        .catch(() => {})
    }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      setProfileHandler(null)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [sessionChanged])

  // On load: try to resume the device session from the refresh cookie. With the server out of reach, the person
  // last signed in here carries on offline; with no one remembered, the sign-in screen says why and tries again
  // when the network is back.
  useEffect(() => {
    setSessionLostHandler(clearSession)
    setSessionChangedHandler(sessionChanged)
    let cancelled = false
    let retryOnline: (() => void) | null = null
    const resume = async () => {
      const { profile: resumed, unreachable } = await resumeSession()
      if (cancelled) return
      setProfile(resumed)
      setReady(true)
      if (!resumed && unreachable) {
        setError('Cannot reach the server — check your connection. You are still signed in on this device.')
        retryOnline = () => {
          window.removeEventListener('online', retryOnline!)
          retryOnline = null
          setError(null)
          void resume()
        }
        window.addEventListener('online', retryOnline)
      }
    }
    void (async () => {
      try {
        const cfg = await api<AuthConfigResponse>('/auth/config', { noRetry: true })
        if (!cancelled) {
          setSelfRegistrationOpen(cfg.selfRegistrationOpen)
          setFactoryTimeZone(cfg.factoryTimeZone)
        }
      } catch {
        /* the login screen still works without it */
      }
      await resume()
    })()
    return () => {
      cancelled = true
      if (retryOnline) window.removeEventListener('online', retryOnline)
      setSessionLostHandler(null)
      setSessionChangedHandler(null)
    }
  }, [clearSession, sessionChanged])

  const accept = useCallback(
    (res: AuthResponse) => {
      setAccessToken(res.accessToken)
      setProfile(res.user)
      setError(null)
      queryClient.clear()
      // The app's other tabs go on as this person, or start over if they were someone else's.
      shareToken(res.accessToken, res.user.id)
    },
    [queryClient],
  )

  const signIn = useCallback(
    async (username: string, password: string) => {
      setError(null)
      try {
        const body: LoginRequest = { username, password }
        accept(await api<AuthResponse>('/auth/login', { method: 'POST', body, noRetry: true }))
      } catch (e) {
        setError(friendlyError(e))
        throw e
      }
    },
    [accept],
  )

  const signUp = useCallback(
    async (username: string, password: string, name: string) => {
      setError(null)
      try {
        const body: RegisterRequest = { username, password, name }
        accept(await api<AuthResponse>('/auth/register', { method: 'POST', body, noRetry: true }))
        setSelfRegistrationOpen((open) => open)
      } catch (e) {
        setError(friendlyError(e))
        throw e
      }
    },
    [accept],
  )

  const signOutUser = useCallback(async () => {
    // §24 — this device stops getting this person's notifications (a shared tablet never shows them to the next one);
    // their choice is kept, so it is on again when they sign back in here.
    if (profile) await disablePush(profile.id, true).catch(() => {})
    try {
      await api<void>('/auth/logout', { method: 'POST', noRetry: true })
    } catch {
      /* the cookie is cleared locally either way */
    }
    // Signed out with no network the API never heard of it: the next app opened here must not resume this session.
    clearSessionMarker()
    clearSession()
    try {
      const cfg = await api<AuthConfigResponse>('/auth/config', { noRetry: true })
      setSelfRegistrationOpen(cfg.selfRegistrationOpen)
    } catch {
      /* ignore */
    }
  }, [clearSession, profile])

  const reloadProfile = useCallback(async () => {
    const me = await api<UserProfile>('/auth/me')
    if (current.current && current.current.id !== me.id) sessionChanged()
    else setProfile(me)
  }, [sessionChanged])

  const value = useMemo<AuthValue>(
    () => ({
      ready,
      profile,
      role: profile?.role ?? 'inspector',
      permissions: profile?.permissions ?? NONE,
      can: (permission: Permission) => holds(profile?.permissions, permission),
      adminPlus: profile?.adminPlus ?? false,
      error,
      selfRegistrationOpen,
      factoryTimeZone,
      signIn,
      signUp,
      signOutUser,
      reloadProfile,
    }),
    [ready, profile, error, selfRegistrationOpen, factoryTimeZone, signIn, signUp, signOutUser, reloadProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Network error — check your connection.'
    return e.message
  }
  return 'Something went wrong. Please try again.'
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
