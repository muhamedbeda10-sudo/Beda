import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { uid } from '@/lib/utils'
import { getUser, setUser as persistUser } from '@/store/db'

type Theme = 'light' | 'dark'

export interface Toast {
  id: string
  message: string
  kind: 'success' | 'error' | 'info' | 'warning'
}

interface AppContextValue {
  theme: Theme
  toggleTheme: () => void
  user: string
  setUser: (name: string) => void
  toasts: Toast[]
  toast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: string) => void
}

const AppContext = createContext<AppContextValue | null>(null)

const THEME_KEY = 'qc-system-theme'

function initTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY) as Theme | null
  if (saved) return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initTheme)
  const [user, setUserState] = useState<string>(getUser())
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])

  const setUser = useCallback((name: string) => {
    persistUser(name)
    setUserState(name)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const toast = useCallback(
    (message: string, kind: Toast['kind'] = 'info') => {
      const id = uid('toast')
      setToasts((t) => [...t, { id, message, kind }])
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
    },
    [],
  )

  return (
    <AppContext.Provider value={{ theme, toggleTheme, user, setUser, toasts, toast, dismissToast }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
