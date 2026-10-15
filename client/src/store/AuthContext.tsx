import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AuthConfigResponse, AuthResponse, LoginRequest, RegisterRequest } from '@qc/shared/api'
import { can as holds, type Permission } from '@qc/shared/permissions'
import type { Role, UserProfile } from '@qc/shared/types'
import { ApiError, api, hasSessionMarker, refreshAccessToken, setAccessToken, setProfileHandler, setSessionLostHandler } from '@/lib/api'
import { disablePush } from '@/lib/push'

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

  const clearSession = useCallback(() => {
    setAccessToken(null)
    setProfile(null)
    queryClient.clear()
  }, [queryClient])

  // §14 — the account as the server sends it again (each token refresh, and on coming back to the app):
  // a role or permission changed meanwhile shows at once, without signing in again.
  useEffect(() => {
    setProfileHandler((user) => setProfile((p) => (p && p.id === user.id ? user : p)))
    let last = Date.now()
    const onFocus = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 60_000) return
      last = Date.now()
      api<UserProfile>('/auth/me', { noRetry: true })
        .then((me) => setProfile((p) => (p && p.id === me.id ? me : p)))
        .catch(() => {})
    }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      setProfileHandler(null)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // On load: try to resume the device session from the refresh cookie.
  useEffect(() => {
    setSessionLostHandler(clearSession)
    let cancelled = false
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
      if (hasSessionMarker() && (await refreshAccessToken())) {
        try {
          const me = await api<UserProfile>('/auth/me', { noRetry: true })
          if (!cancelled) setProfile(me)
        } catch {
          setAccessToken(null)
        }
      }
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
      setSessionLostHandler(null)
    }
  }, [clearSession])

  const accept = useCallback(
    (res: AuthResponse) => {
      setAccessToken(res.accessToken)
      setProfile(res.user)
      setError(null)
      queryClient.clear()
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
    setProfile(me)
  }, [])

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
