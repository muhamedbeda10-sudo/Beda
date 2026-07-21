import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { firebaseEnabled, getAuthInstance, getDb, type UserProfile, type UserRole } from '@/lib/firebase'
import { enableFirebaseSync, disableFirebaseSync, setUser as setDbUser } from '@/store/db'
import { useApp } from '@/store/AppContext'

interface AuthValue {
  ready: boolean
  firebaseEnabled: boolean
  profile: UserProfile | null
  role: UserRole
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, name: string) => Promise<void>
  signOutUser: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

async function loadOrCreateProfile(user: User): Promise<UserProfile> {
  const store = getDb()
  const pref = doc(store, 'users', user.uid)
  const snap = await getDoc(pref)
  if (snap.exists()) {
    const d = snap.data() as Partial<UserProfile>
    return {
      uid: user.uid,
      email: user.email ?? d.email ?? '',
      name: d.name ?? user.displayName ?? user.email ?? 'Inspector',
      role: (d.role as UserRole) ?? 'inspector',
    }
  }
  const profile: UserProfile = {
    uid: user.uid,
    email: user.email ?? '',
    name: user.displayName ?? user.email ?? 'Inspector',
    role: 'inspector',
  }
  await setDoc(pref, profile)
  return profile
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { user: demoName } = useApp()
  const [ready, setReady] = useState(!firebaseEnabled)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Firebase auth listener (only when configured)
  useEffect(() => {
    if (!firebaseEnabled) return
    const unsub = onAuthStateChanged(getAuthInstance(), async (user) => {
      if (user) {
        try {
          const p = await loadOrCreateProfile(user)
          setProfile(p)
          setDbUser(p.name)
          await enableFirebaseSync()
        } catch (e) {
          console.warn('profile load failed', e)
          setError('Failed to load profile')
        }
      } else {
        setProfile(null)
        disableFirebaseSync()
      }
      setReady(true)
    })
    return () => unsub()
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null)
    try {
      await signInWithEmailAndPassword(getAuthInstance(), email, password)
    } catch (e) {
      setError(friendlyError(e))
      throw e
    }
  }, [])

  const signUp = useCallback(async (email: string, password: string, name: string) => {
    setError(null)
    try {
      const cred = await createUserWithEmailAndPassword(getAuthInstance(), email, password)
      await updateProfile(cred.user, { displayName: name })
      await setDoc(doc(getDb(), 'users', cred.user.uid), {
        uid: cred.user.uid,
        email,
        name,
        role: 'inspector' as UserRole,
      })
    } catch (e) {
      setError(friendlyError(e))
      throw e
    }
  }, [])

  const signOutUser = useCallback(async () => {
    if (firebaseEnabled) await signOut(getAuthInstance())
  }, [])

  // Demo mode: synthesize a manager profile from the local display name.
  const effectiveProfile: UserProfile | null = firebaseEnabled
    ? profile
    : { uid: 'demo', email: 'demo@local', name: demoName, role: 'manager' }

  return (
    <AuthContext.Provider
      value={{
        ready,
        firebaseEnabled,
        profile: effectiveProfile,
        role: effectiveProfile?.role ?? 'inspector',
        error,
        signIn,
        signUp,
        signOutUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

function friendlyError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? ''
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found'))
    return 'Incorrect email or password.'
  if (code.includes('email-already-in-use')) return 'This email is already registered.'
  if (code.includes('weak-password')) return 'Password should be at least 6 characters.'
  if (code.includes('invalid-email')) return 'Please enter a valid email.'
  if (code.includes('network')) return 'Network error — check your connection.'
  return 'Something went wrong. Please try again.'
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
