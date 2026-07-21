import { useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  ClipboardCheck,
  FileText,
  BarChart3,
  History,
  Settings,
  Sun,
  Moon,
  Menu,
  X,
  ShieldCheck,
  ScrollText,
  CheckCircle2,
  AlertCircle,
  Info,
  AlertTriangle,
} from 'lucide-react'
import { LogOut } from 'lucide-react'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/lib/firebase'

const NAV: Array<{
  to: string
  label: string
  icon: typeof ClipboardCheck
  end?: boolean
  roles?: UserRole[]
}> = [
  { to: '/', label: 'Inspections', icon: ClipboardCheck, end: true },
  { to: '/orders', label: 'Order Summary', icon: FileText },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, roles: ['supervisor', 'manager'] },
  { to: '/history', label: 'History', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings, roles: ['supervisor', 'manager'] },
  { to: '/audit', label: 'Audit Logs', icon: ScrollText, roles: ['manager'] },
]

function ToastHost() {
  const { toasts, dismissToast } = useApp()
  const icons = { success: CheckCircle2, error: AlertCircle, info: Info, warning: AlertTriangle }
  const tones = {
    success: 'text-emerald-500',
    error: 'text-rose-500',
    info: 'text-brand-500',
    warning: 'text-amber-500',
  }
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-3">
      {toasts.map((t) => {
        const Icon = icons[t.kind]
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-lift ring-1 ring-slate-200 animate-scale-in dark:bg-slate-800 dark:ring-slate-700"
            onClick={() => dismissToast(t.id)}
          >
            <Icon className={cn('h-5 w-5 shrink-0', tones[t.kind])} />
            <span className="text-sm font-medium">{t.message}</span>
          </div>
        )
      })}
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, toggleTheme, user } = useApp()
  const { role, firebaseEnabled, signOutUser } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  const nav = NAV.filter((n) => !n.roles || n.roles.includes(role))

  return (
    <div className="min-h-full">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/85 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/85 safe-top">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-white shadow-sm">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <p className="text-base font-extrabold tracking-tight">QC SYSTEM</p>
              <p className="hidden text-xs text-slate-500 sm:block dark:text-slate-400">
                Welcome, <span className="font-semibold text-slate-700 dark:text-slate-200">{user}</span>
              </p>
            </div>
          </div>

          {/* Desktop nav */}
          <nav className="ml-6 hidden flex-1 items-center gap-1 lg:flex">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                    isActive
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                  )
                }
              >
                <n.icon className="h-4 w-4" />
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={toggleTheme}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            {firebaseEnabled && (
              <button
                onClick={() => signOutUser()}
                className="hidden rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-rose-600 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-rose-400 lg:block"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="h-5 w-5" />
              </button>
            )}
            <button
              onClick={() => setMenuOpen(true)}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-6 w-6" />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-[82%] max-w-sm bg-white shadow-lift animate-slide-up dark:bg-slate-900 safe-top">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-white">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <span className="text-lg font-extrabold">Menu</span>
              </div>
              <button onClick={() => setMenuOpen(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close menu">
                <X className="h-6 w-6" />
              </button>
            </div>
            <nav className="flex flex-col gap-1 p-3">
              {nav.map((n) => {
                const active = n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)
                return (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.end}
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      'flex items-center gap-3 rounded-2xl px-4 py-3.5 text-base font-semibold transition-colors',
                      active
                        ? 'bg-brand-600 text-white'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
                    )}
                  >
                    <n.icon className="h-5 w-5" />
                    {n.label}
                  </NavLink>
                )
              })}
            </nav>
            <div className="mt-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
              <p className="text-sm text-slate-500">
                Signed in as <span className="font-semibold text-slate-700 dark:text-slate-200">{user}</span>
              </p>
              <p className="mt-0.5 text-xs capitalize text-slate-400">Role: {role}</p>
              {firebaseEnabled && (
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    signOutUser()
                  }}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-rose-50 hover:text-rose-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-5 safe-bottom">{children}</main>
      <ToastHost />
    </div>
  )
}
