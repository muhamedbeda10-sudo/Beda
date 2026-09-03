import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AuthConfigResponse, AuthResponse, LoginRequest, RegisterRequest } from '@qc/shared/api'
import type { Role, UserProfile } from '@qc/shared/types'
import { ApiError, api, hasSessionMarker, refreshAccessToken, setAccessToken, setSessionLostHandler } from '@/lib/api'

interface AuthValue {
  /** False until the first refresh attempt has settled. */
  ready: boolean
  profile: UserProfile | null
  role: Role
  error: string | null
  selfRegistrationOpen: boolean
  /** IANA zone the factory runs on — shifts are shown in it, as the API stores them. */
  factoryTimeZone: string
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, name: string) => Promise<void>
  signOutUser: () => Promise<void>
  /** Re-read the profile (after an admin changed a role, or a password change). */
  reloadProfile: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

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
    async (email: string, password: string) => {
      setError(null)
      try {
        const body: LoginRequest = { email, password }
        accept(await api<AuthResponse>('/auth/login', { method: 'POST', body, noRetry: true }))
      } catch (e) {
        setError(friendlyError(e))
        throw e
      }
    },
    [accept],
  )

  const signUp = useCallback(
    async (email: string, password: string, name: string) => {
      setError(null)
      try {
        const body: RegisterRequest = { email, password, name }
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
  }, [clearSession])

  const reloadProfile = useCallback(async () => {
    const me = await api<UserProfile>('/auth/me')
    setProfile(me)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      ready,
      profile,
      role: profile?.role ?? 'inspector',
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
