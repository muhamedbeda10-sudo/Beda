import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle, AlertTriangle, Bot, CheckCircle2, ChevronRight, Info, LogOut, Menu, MessagesSquare, Moon, Settings, Sun, X } from 'lucide-react'
import { WhatsNewPrompt } from '@/components/releases/WhatsNew'
import { NoticeBell } from '@/components/notices/NoticeBell'
import { useChatUnread } from '@/services/queries'
import { Brand } from '@/components/brand/Brand'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn } from '@/lib/utils'
import { can } from '@qc/shared/rules'
import { AccountMenu, AvatarEditor } from '@/components/layout/AccountMenu'
import { ADMIN_NAV, NAV, visibleNav, type NavItem } from '@/components/layout/navItems'
import { AiAssistantProvider, useAi } from '@/components/ai/AiAssistantProvider'
import { AiBusyDot, AiButton } from '@/components/ai/AiButton'
import { AiPanelHost } from '@/components/ai/AiPanelHost'

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

/** Chat: an icon on the right beside the bell, on every screen size, with what is still unread on it. */
function ChatButton() {
  const location = useLocation()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { data } = useChatUnread(!!profile)
  const unread = data?.unreadTotal ?? 0
  const mentions = data?.mentionTotal ?? 0
  const inChat = location.pathname.startsWith('/chat')
  return (
    <button
      type="button"
      onClick={() => navigate('/chat')}
      className={cn('icon-btn relative', inChat && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200')}
      aria-label={unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
      aria-current={inChat ? 'page' : undefined}
    >
      <MessagesSquare className="h-5 w-5" />
      {unread > 0 && (
        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-bold leading-[18px] text-white ring-2 ring-white dark:ring-slate-900',
            mentions > 0 ? 'bg-accent-500' : 'bg-rose-600',
          )}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
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
          <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Administration</p>
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
                {n.hint && <span className="block truncate text-xs text-muted">{n.hint}</span>}
              </span>
              <ChevronRight className="h-4 w-4 text-slate-300 transition-transform duration-200 group-hover/item:translate-x-0.5 group-hover/item:text-brand-500" />
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * §20 — the assistant's state sits above the whole shell, so its header
 * button, the menu entry and the panel share it. Whether any of them is there
 * is /ai/me's to say (the owner gives the assistant to people one by one), not
 * the role's.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AiAssistantProvider>
      <Shell>{children}</Shell>
    </AiAssistantProvider>
  )
}

function Shell({ children }: { children: ReactNode }) {
  const { theme, toggleTheme, user } = useApp()
  const { role, signOutUser, profile } = useAuth()
  const ai = useAi()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  const nav = visibleNav(NAV, role, false)
  const admin = visibleNav(ADMIN_NAV, role, ai.owner)
  const displayName = profile?.name || user

  const isActive = (n: NavItem) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to))

  return (
    <div className="min-h-full">
      <header className="print:hidden sticky top-0 z-40 border-b border-slate-200/80 bg-white/85 shadow-[0_1px_0_rgba(255,255,255,.6)_inset] backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/85 safe-top">
        {/* A desktop centres the tabs and shows the gear and the account; a tablet or phone keeps all of that behind the menu button. */}
        <div className="flex h-16 items-center gap-2 px-3 sm:gap-3 sm:px-6 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:px-8">
          {/* Left — brand */}
          <button type="button" onClick={() => navigate('/')} className="shrink-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:justify-self-start" aria-label="Home">
            <Brand />
          </button>

          {/* The inspector's tabs, centred — desktop only */}
          <nav className="hidden items-center gap-1 rounded-2xl bg-slate-100/80 p-1 ring-1 ring-slate-200/70 lg:flex lg:justify-self-center dark:bg-slate-800/70 dark:ring-slate-700/70" aria-label="Main">
            {nav.map((n) => {
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
          <div className="ml-auto flex shrink-0 items-center gap-1 lg:ml-0 lg:justify-self-end">
            {ai.enabled && <AiButton />}
            {can(role, 'use-chat') && <ChatButton />}
            {can(role, 'read-notices') && <NoticeBell />}
            <button onClick={toggleTheme} className="icon-btn" aria-label="Toggle light or dark theme" data-tip={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            {admin.length > 0 && (
              <div className="hidden lg:block">
                <AdminMenu items={admin} />
              </div>
            )}
            <div className="mx-1 hidden h-6 w-px bg-slate-200 dark:bg-slate-700 lg:block" />
            <div className="hidden items-center gap-2 lg:flex">
              {/* Only the circle: the photo or the initials; the name is in its tooltip and its panel. */}
              <AccountMenu name={displayName ?? ''} role={role ?? ''} username={profile?.username} />
              <button onClick={() => signOutUser()} className="icon-btn hover:text-rose-600" aria-label="Sign out">
                <LogOut className="h-5 w-5" />
              </button>
            </div>
            <button onClick={() => setMenuOpen(true)} className="icon-btn relative lg:hidden" aria-label="Open menu">
              <Menu className="h-6 w-6" />
              {/* A phone keeps the assistant in the menu: the menu shows an answer being written. */}
              {ai.busy && <AiBusyDot className="sm:hidden" />}
            </button>
          </div>
        </div>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-[85%] max-w-sm overflow-y-auto bg-white shadow-lift animate-slide-up dark:bg-slate-900 safe-top">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <Brand />
              <button onClick={() => setMenuOpen(false)} className="icon-btn" aria-label="Close menu">
                <X className="h-6 w-6" />
              </button>
            </div>
            <nav className="flex flex-col gap-1 p-3">
              {nav.map((n) => (
                <DrawerLink key={n.to} item={n} active={isActive(n)} onClick={() => setMenuOpen(false)} />
              ))}
              {ai.enabled && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    ai.setOpen(true)
                  }}
                  className="flex items-center gap-3 rounded-2xl px-4 py-4 text-left text-base font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Bot className="h-5 w-5" />
                  <span className="flex-1">Ask the AI assistant</span>
                  {ai.busy && <span className="text-xs font-semibold text-accent-600 dark:text-accent-400">Answering…</span>}
                </button>
              )}
              {admin.length > 0 && (
                <>
                  <p className="px-4 pb-1 pt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Administration</p>
                  {admin.map((n) => (
                    <DrawerLink key={n.to} item={n} active={isActive(n)} onClick={() => setMenuOpen(false)} />
                  ))}
                </>
              )}
            </nav>
            <div className="mt-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
              <p className="text-sm text-muted">
                Signed in as <span className="font-semibold text-slate-700 dark:text-slate-200">{displayName}</span>
              </p>
              <p className="mt-0.5 text-xs capitalize text-muted">Role: {role}</p>
              <div className="mt-3">
                <AvatarEditor name={displayName ?? ''} size={56} />
              </div>
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

      {/* Full width; each route change replays the entrance so a page feels placed, not swapped.
          On a very wide screen the page makes room for the docked assistant; narrower, the panel lies over its right edge. */}
      <main className={cn('px-4 py-5 transition-[padding] duration-300 sm:px-6 lg:px-8 safe-bottom', ai.open && ai.docked && '2xl:pr-[32rem]')}>
        <div key={location.pathname} className="animate-page-in">
          {children}
        </div>
      </main>
      {/* Outside <main>, which remounts on every route: an answer keeps streaming while its asker moves around. */}
      <AiPanelHost />
      <ToastHost />
      <WhatsNewPrompt />
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
