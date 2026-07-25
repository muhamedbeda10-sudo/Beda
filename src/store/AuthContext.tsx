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
import { firebaseEnabled, firebaseSeedEnabled, getAuthInstance, getDb } from '@/lib/firebase'
import { COL } from '@/services/repository'
import { seedMasterDataIfEmpty } from '@/services/seedData'
import type { Role, UserProfile } from '@/domain/types'

interface AuthValue {
  ready: boolean
  firebaseEnabled: boolean
  profile: UserProfile | null
  role: Role
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, name: string) => Promise<void>
  signOutUser: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

/**
 * Load the signed-in user's profile, creating it on first sign-in.
 *
 * The very first account to sign in becomes the admin — otherwise nobody could
 * reach Admin to promote anyone. Everyone after that starts as an inspector and
 * is promoted deliberately.
 */
async function loadOrCreateProfile(user: User): Promise<UserProfile> {
  const store = getDb()
  const ref = doc(store, COL.users, user.uid)
  const snap = await getDoc(ref)
  if (snap.exists()) {
    const d = snap.data() as Partial<UserProfile>
    return {
      uid: user.uid,
      email: user.email ?? d.email ?? '',
      name: d.name ?? user.displayName ?? user.email ?? 'Inspector',
      role: (d.role as Role) ?? 'inspector',
    }
  }

  const bootstrapRef = doc(store, COL.users, '__bootstrap__')
  const bootstrap = await getDoc(bootstrapRef)
  const isFirstUser = !bootstrap.exists()

  const profile: UserProfile = {
    uid: user.uid,
    email: user.email ?? '',
    name: user.displayName ?? user.email?.split('@')[0] ?? 'Inspector',
    role: isFirstUser ? 'admin' : 'inspector',
  }
  await setDoc(ref, profile)
  if (isFirstUser) {
    await setDoc(bootstrapRef, { claimedBy: user.uid, at: new Date().toISOString() })
  }
  return profile
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!firebaseEnabled)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!firebaseEnabled) return
    const unsub = onAuthStateChanged(getAuthInstance(), async (user) => {
      if (user) {
        try {
          const p = await loadOrCreateProfile(user)
          setProfile(p)
          // Master data is admin-writable only, so only an admin can seed it.
          // Only fills an empty database; never overwrites real data.
          if (firebaseSeedEnabled && p.role === 'admin') {
            await seedMasterDataIfEmpty().catch((e) => console.warn('[seed]', e))
          }
        } catch (e) {
          console.warn('[auth] profile load failed', e)
          setError('Signed in, but your profile could not be loaded.')
        }
      } else {
        setProfile(null)
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
    } catch (e) {
      setError(friendlyError(e))
      throw e
    }
  }, [])

  const signOutUser = useCallback(async () => {
    if (firebaseEnabled) await signOut(getAuthInstance())
  }, [])

  // Without Firebase the app runs as a local demo with full access.
  const effectiveProfile: UserProfile | null = firebaseEnabled
    ? profile
    : { uid: 'demo', email: 'demo@local', name: 'Demo User', role: 'admin' }

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
