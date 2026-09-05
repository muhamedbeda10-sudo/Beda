import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  ClipboardCheck,
  History,
  Settings,
  Sun,
  Moon,
  Menu,
  X,
  CheckCircle2,
  AlertCircle,
  Info,
  AlertTriangle,
  LogOut,
  SlidersHorizontal,
  UploadCloud,
  Users,
  ScrollText,
  ChevronRight,
} from 'lucide-react'
import { Brand } from '@/components/brand/Brand'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn } from '@/lib/utils'
import { can, type Capability } from '@qc/shared/rules'

interface NavItem {
  to: string
  label: string
  icon: typeof ClipboardCheck
  end?: boolean
  needs?: Capability
  /** One line shown under the label in the administration menu. */
  hint?: string
}

/** The work an inspector does, centred in the bar. */
const NAV: NavItem[] = [
  { to: '/', label: 'Inspections', icon: ClipboardCheck, end: true },
  { to: '/history', label: 'History', icon: History },
]

/** Administration, behind the gear. Each entry is shown only to a role that may use it. */
export const ADMIN_NAV: NavItem[] = [
  { to: '/admin/configuration', label: 'Configuration', icon: SlidersHorizontal, needs: 'manage-admin-data', hint: 'Machines, items, defects, grades' },
  { to: '/admin/import', label: 'Data import', icon: UploadCloud, needs: 'manage-admin-data', hint: 'Production orders and coils' },
  { to: '/admin/users', label: 'Users', icon: Users, needs: 'manage-admin-data', hint: 'Accounts and roles' },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, needs: 'edit-closed-session', hint: 'Who changed what, and when' },
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
            role="status"
            className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl bg-white px-4 py-3 shadow-lift ring-1 ring-slate-200 animate-scale-in dark:bg-slate-800 dark:ring-slate-700"
            onClick={() => dismissToast(t.id)}
          >
            <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', tones[t.kind])} />
            <span className="text-sm font-medium">{t.message}</span>
          </div>
        )
      })}
    </div>
  )
}

/** The gear: an icon-only control on the far right that opens administration. */
function AdminMenu({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const inAdmin = location.pathname.startsWith('/admin')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Close after navigating so the menu never lingers over the new page.
  useEffect(() => setOpen(false), [location.pathname])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Administration"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn('icon-btn group', (open || inAdmin) && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200')}
      >
        <Settings className={cn('h-5 w-5 transition-transform duration-500 ease-out group-hover:rotate-45', open && 'rotate-90')} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-80 origin-top-right overflow-hidden rounded-2xl bg-white p-1.5 shadow-lift ring-1 ring-slate-200 animate-drop-in dark:bg-slate-900 dark:ring-slate-800"
        >
          <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Administration</p>
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              role="menuitem"
              className={({ isActive }) =>
                cn(
                  'group/item flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors',
                  isActive ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-100' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
                )
              }
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 transition-[background-color,color,transform] duration-200 group-hover/item:scale-105 group-hover/item:bg-brand-600 group-hover/item:text-white dark:bg-slate-800 dark:text-slate-300">
                <n.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-sm font-semibold">{n.label}</span>
                {n.hint && <span className="block truncate text-xs text-slate-400">{n.hint}</span>}
              </span>
              <ChevronRight className="h-4 w-4 text-slate-300 transition-transform duration-200 group-hover/item:translate-x-0.5 group-hover/item:text-brand-500" />
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, toggleTheme, user } = useApp()
  const { role, signOutUser, profile } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  const admin = ADMIN_NAV.filter((n) => !n.needs || can(role, n.needs))
  const displayName = profile?.name || user
  const initials = (displayName ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  const isActive = (n: NavItem) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to))

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/85 shadow-[0_1px_0_rgba(255,255,255,.6)_inset] backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/85 safe-top">
        <div className="grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 sm:gap-3 sm:px-6 lg:px-8">
          {/* Left — brand */}
          <button type="button" onClick={() => navigate('/')} className="justify-self-start rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-label="Home">
            <Brand />
          </button>

          {/* Centre — the inspector's tabs */}
          <nav className="hidden items-center gap-1 rounded-2xl bg-slate-100/80 p-1 ring-1 ring-slate-200/70 md:flex dark:bg-slate-800/70 dark:ring-slate-700/70" aria-label="Main">
            {NAV.map((n) => {
              const active = isActive(n)
              return (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  className={cn(
                    'group relative flex min-h-[40px] items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200',
                    active
                      ? 'bg-white text-brand-800 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:text-white dark:ring-slate-700'
                      : 'text-slate-600 hover:text-brand-700 dark:text-slate-300 dark:hover:text-white',
                  )}
                >
                  <n.icon className={cn('h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5', active && 'text-accent-500')} />
                  {n.label}
                </NavLink>
              )
            })}
          </nav>

          {/* Right — theme, administration, account */}
          <div className="flex items-center gap-1 justify-self-end">
            <button onClick={toggleTheme} className="icon-btn" aria-label="Toggle light or dark theme">
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            {admin.length > 0 && (
              <div className="hidden md:block">
                <AdminMenu items={admin} />
              </div>
            )}
            <div className="mx-1 hidden h-6 w-px bg-slate-200 dark:bg-slate-700 md:block" />
            <div className="hidden items-center gap-2 md:flex">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-xs font-bold text-white shadow-card" title={displayName}>
                {initials || '?'}
              </span>
              <span className="hidden max-w-[10rem] truncate text-sm font-semibold xl:block">{displayName}</span>
              <button onClick={() => signOutUser()} className="icon-btn hover:text-rose-600" aria-label="Sign out">
                <LogOut className="h-5 w-5" />
              </button>
            </div>
            <button onClick={() => setMenuOpen(true)} className="icon-btn md:hidden" aria-label="Open menu">
              <Menu className="h-6 w-6" />
            </button>
          </div>
        </div>
        {/* A phone has no room beside the brand: the tabs get their own row, centred. */}
        <nav className="flex justify-center px-3 pb-2 md:hidden" aria-label="Main">
          <div className="flex w-full max-w-sm items-center gap-1 rounded-2xl bg-slate-100/80 p-1 ring-1 ring-slate-200/70 dark:bg-slate-800/70 dark:ring-slate-700/70">
            {NAV.map((n) => {
              const active = isActive(n)
              return (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  className={cn(
                    'flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200',
                    active
                      ? 'bg-white text-brand-800 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:text-white dark:ring-slate-700'
                      : 'text-slate-600 dark:text-slate-300',
                  )}
                >
                  <n.icon className={cn('h-4 w-4', active && 'text-accent-500')} />
                  {n.label}
                </NavLink>
              )
            })}
          </div>
        </nav>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-[85%] max-w-sm overflow-y-auto bg-white shadow-lift animate-slide-up dark:bg-slate-900 safe-top">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <Brand />
              <button onClick={() => setMenuOpen(false)} className="icon-btn" aria-label="Close menu">
                <X className="h-6 w-6" />
              </button>
            </div>
            <nav className="flex flex-col gap-1 p-3">
              {NAV.map((n) => (
                <DrawerLink key={n.to} item={n} active={isActive(n)} onClick={() => setMenuOpen(false)} />
              ))}
              {admin.length > 0 && (
                <>
                  <p className="px-4 pb-1 pt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Administration</p>
                  {admin.map((n) => (
                    <DrawerLink key={n.to} item={n} active={isActive(n)} onClick={() => setMenuOpen(false)} />
                  ))}
                </>
              )}
            </nav>
            <div className="mt-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
              <p className="text-sm text-slate-500">
                Signed in as <span className="font-semibold text-slate-700 dark:text-slate-200">{displayName}</span>
              </p>
              <p className="mt-0.5 text-xs capitalize text-slate-400">Role: {role}</p>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  signOutUser()
                }}
                className="btn-secondary mt-3 hover:text-rose-600"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full width; each route change replays the entrance so a page feels placed, not swapped. */}
      <main className="px-4 py-5 sm:px-6 lg:px-8 safe-bottom">
        <div key={location.pathname} className="animate-page-in">
          {children}
        </div>
      </main>
      <ToastHost />
    </div>
  )
}

function DrawerLink({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-2xl px-4 py-4 text-base font-semibold transition-colors',
        active ? 'bg-brand-700 text-white shadow-card' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
      )}
    >
      <item.icon className="h-5 w-5" />
      {item.label}
    </NavLink>
  )
}
