// ============================================================================
// Firebase bootstrap.
// Everything here is OPTIONAL: if the VITE_FIREBASE_* env vars are not set,
// `firebaseEnabled` is false and the whole app falls back to the local
// (localStorage) demo backend. This lets the app build & run with zero config,
// and switch to a real shared backend the moment credentials are provided.
// ============================================================================
import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'
import { getStorage, type FirebaseStorage } from 'firebase/storage'

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
}

/** True only when the minimum required config is present. */
export const firebaseEnabled = Boolean(cfg.apiKey && cfg.projectId && cfg.appId && cfg.authDomain)

/** Whether to upload images to Cloud Storage (requires the Blaze plan).
 *  Set VITE_FIREBASE_USE_STORAGE=false (Spark / free plan) to store images as
 *  compressed base64 inside Firestore instead — no Storage or billing needed. */
export const firebaseUseStorage =
  firebaseEnabled && import.meta.env.VITE_FIREBASE_USE_STORAGE !== 'false'

/** Auto-seed demo data into an empty Firestore on first sign-in.
 *  Set VITE_FIREBASE_SEED=false to start with a completely empty database. */
export const firebaseSeedEnabled = import.meta.env.VITE_FIREBASE_SEED !== 'false'

let app: FirebaseApp | null = null
let authInstance: Auth | null = null
let dbInstance: Firestore | null = null
let storageInstance: FirebaseStorage | null = null

function ensureApp(): FirebaseApp {
  if (!firebaseEnabled) throw new Error('Firebase is not configured')
  if (!app) app = initializeApp(cfg as Record<string, string>)
  return app
}

export function getAuthInstance(): Auth {
  if (!authInstance) authInstance = getAuth(ensureApp())
  return authInstance
}

export function getDb(): Firestore {
  if (!dbInstance) dbInstance = getFirestore(ensureApp())
  return dbInstance
}

export function getStorageInstance(): FirebaseStorage {
  if (!storageInstance) storageInstance = getStorage(ensureApp())
  return storageInstance
}

export type UserRole = 'inspector' | 'supervisor' | 'manager'

export interface UserProfile {
  uid: string
  email: string
  name: string
  role: UserRole
}
