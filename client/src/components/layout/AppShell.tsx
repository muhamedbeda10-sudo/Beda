import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronRight, Info, LogOut, Menu, MessagesSquare, Settings, X } from 'lucide-react'
import { WhatsNewPrompt } from '@/components/releases/WhatsNew'
import { NoticeBell } from '@/components/notices/NoticeBell'
import { NoticesButton } from '@/components/notices/NoticesButton'
import { useChatUnread } from '@/services/queries'
import { Brand } from '@/components/brand/Brand'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn } from '@/lib/utils'
import { ADMIN_PLUS } from '@qc/shared/permissions'
import { AccountMenu, AvatarEditor, ThemeSwitch } from '@/components/layout/AccountMenu'
import { NotificationSettings } from '@/components/layout/NotificationSettings'
import { ADMIN_NAV, NAV, TOOLS_NAV, visibleNav, type NavItem } from '@/components/layout/navItems'
import { AiAssistantProvider, useAi } from '@/components/ai/AiAssistantProvider'
import { AiButton } from '@/components/ai/AiButton'
import { AiPanelHost } from '@/components/ai/AiPanelHost'
import { useNavFit } from '@/components/layout/navFit'
import { useCoarsePointer } from '@/lib/media'

function ToastHost() {
  const { toasts, dismissToast } = useApp()
  const icons = { success: CheckCircle2, error: AlertCircle, info: Info, warning: AlertTriangle }
  const tones = {
    success: 'text-emerald-500',
    error: 'text-rose-500',
    info: 'text-brand-500',
    warning: 'text-amber-500',
  }
  // Under the header, never over it: a toast lies over the page, not over the chat, the bell or the menu it may be
  // about. No wider than the screen, and held to its left edge: should a page ever lay itself out wider than the
  // screen (a phone then widens its layout), the toasts stay on the part that shows rather than centring on the rest.
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(4.5rem+env(safe-area-inset-top))] z-[70] flex max-w-[100vw] flex-col items-center gap-2 px-3">
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
                {/* The whole hint, on two lines if it must: the menu is wide enough, and a finger gets no tooltip. */}
                {n.hint && <span className="block text-xs text-muted">{n.hint}</span>}
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
  const { user } = useApp()
  const { role: roleName, signOutUser, profile, can, permissions, adminPlus } = useAuth()
  // §14 — the AI assistant's owner reads as ADMIN+, above the roles.
  const role = adminPlus ? ADMIN_PLUS : roleName
  const ai = useAi()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  // §21 — Automations open from the assistant's header and Follow-ups from the bell: neither is a tab.
  const nav = visibleNav(NAV, permissions, false)
  const tools = visibleNav(TOOLS_NAV, permissions, false)
  // The tabs keep their names while those fit beside the brand and the icons; then tighter padding; then icons alone, the
  // names in tooltips. Measured on this bar, for these tabs and this window (navFit), not guessed from how many there are.
  const barRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const fit = useNavFit(barRef, navRef, nav.map((n) => n.to).join(' '))
  // A finger gets no tooltip, so on a touch screen the tabs never stand as bare icons: where only icons would fit (a
  // landscape tablet, six tabs), the bar keeps the menu button, as on a portrait tablet, and the menu names them. The
  // tabs stay laid out, out of sight and out of the row, so navFit goes on measuring them and the names come back as
  // soon as they fit. A mouse keeps the icons, with their names in tooltips.
  const coarse = useCoarsePointer()
  const menuAtLg = coarse && fit === 'icons'
  const admin = visibleNav(ADMIN_NAV, permissions, ai.owner)
  const displayName = profile?.name || user

  const isActive = (n: NavItem) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to))
  // §21 — a follow-up opens in a drawer over the list: /follow-ups and /follow-ups/<id> are one page.
  const pageKey = location.pathname.startsWith('/follow-ups') ? '/follow-ups' : location.pathname

  return (
    <div className="min-h-full">
      <header className="print:hidden sticky top-0 z-40 border-b border-slate-200/80 bg-white/85 shadow-[0_1px_0_rgba(255,255,255,.6)_inset] backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/85 safe-top">
        {/* A desktop centres the tabs and shows the gear and the account; a tablet or phone keeps all of that behind the menu button.
            From lg the brand and the icons share what the tabs leave, half each, so the tabs sit in the middle while they
            can; when the icons need more than half, the brand's spare room goes to the tabs before they lose their names. */}
        <div ref={barRef} className="flex h-16 items-center gap-2 px-3 sm:gap-3 sm:px-6 lg:px-8">
          {/* Left — brand */}
          <div className="flex shrink-0 lg:flex-1">
            <button type="button" onClick={() => navigate('/')} className="flex min-h-[44px] items-center rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-label="Home">
              <Brand />
            </button>
          </div>

          {/* The inspector's tabs, centred — desktop only */}
          <nav
            ref={navRef}
            aria-hidden={menuAtLg || undefined}
            className={cn(
              'hidden shrink-0 items-center gap-1 rounded-2xl bg-slate-100/80 p-1 ring-1 ring-slate-200/70 lg:flex dark:bg-slate-800/70 dark:ring-slate-700/70',
              menuAtLg && 'pointer-events-none invisible absolute',
            )}
            aria-label="Main"
          >
            {nav.map((n) => {
              const active = isActive(n)
              return (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  data-tip={fit === 'icons' ? n.label : undefined}
                  className={cn(
                    // On one line: a name that wrapped would hide that the tabs no longer fit.
                    'group relative flex min-h-[40px] items-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-[background-color,color,box-shadow] duration-200',
                    fit === 'full' ? 'px-4' : 'px-3',
                    active
                      ? 'bg-white text-brand-800 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:text-white dark:ring-slate-700'
                      : 'text-slate-600 hover:text-brand-700 dark:text-slate-300 dark:hover:text-white',
                  )}
                >
                  <n.icon className={cn('h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5', active && 'text-accent-500')} />
                  <span className={cn(fit === 'icons' && 'sr-only')}>{n.label}</span>
                </NavLink>
              )
            })}
          </nav>

          {/* Right — chat, notices, the bell, administration, account (the theme is in the account panel / the menu; the assistant floats in the bottom corner) */}
          <div className="ml-auto flex shrink-0 items-center justify-end gap-1 lg:flex-1">
            {can('use-chat') && <ChatButton />}
            {/* §16 — notices on a button of their own, for whoever receives them or writes them; §21 — everyone has the bell for their alerts. */}
            <NoticesButton receives={can('read-notices')} manage={can('manage-notices')} />
            <NoticeBell />
            {/* With the menu button kept at lg, the menu holds administration and the account as well: the bar reads as on a portrait tablet. */}
            {admin.length > 0 && (
              <div className={cn('hidden', !menuAtLg && 'lg:block')}>
                <AdminMenu items={admin} />
              </div>
            )}
            <div className={cn('mx-1 hidden h-6 w-px bg-slate-200 dark:bg-slate-700', !menuAtLg && 'lg:block')} />
            <div className={cn('hidden items-center gap-2', !menuAtLg && 'lg:flex')}>
              {/* Only the circle: the photo or the initials; the name is in its tooltip and its panel. */}
              <AccountMenu name={displayName ?? ''} role={role ?? ''} username={profile?.username} />
              <button onClick={() => signOutUser()} className="icon-btn hover:text-rose-600" aria-label="Sign out">
                <LogOut className="h-5 w-5" />
              </button>
            </div>
            <button onClick={() => setMenuOpen(true)} className={cn('icon-btn relative', !menuAtLg && 'lg:hidden')} aria-label="Open menu" aria-expanded={menuOpen}>
              <Menu className="h-6 w-6" />
            </button>
          </div>
        </div>
      </header>

      {menuOpen && (
        <div className={cn('fixed inset-0 z-50', !menuAtLg && 'lg:hidden')}>
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-[85%] max-w-sm overflow-y-auto overscroll-contain bg-white shadow-lift animate-slide-up dark:bg-slate-900 safe-top">
            {/* The way out stays in view however far a long menu (an administrator's) is scrolled. */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
              <Brand />
              <button onClick={() => setMenuOpen(false)} className="icon-btn" aria-label="Close menu">
                <X className="h-6 w-6" />
              </button>
            </div>
            <nav className="flex flex-col gap-1 p-3">
              {/* The assistant is the floating button on every screen, so the menu does not offer it a second time. */}
              {nav.map((n) => (
                <DrawerLink key={n.to} item={n} active={isActive(n)} onClick={() => setMenuOpen(false)} />
              ))}
              {tools.length > 0 && (
                <>
                  <p className="px-4 pb-1 pt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Tools</p>
                  {tools.map((n) => (
                    <DrawerLink key={n.to} item={n} active={isActive(n)} onClick={() => setMenuOpen(false)} />
                  ))}
                </>
              )}
              {admin.length > 0 && (
                <>
                  <p className="px-4 pb-1 pt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">Administration</p>
                  {/* With the line under each name that the gear's menu shows: "AI assistant" says it holds the settings. */}
                  {admin.map((n) => (
                    <DrawerLink key={n.to} item={n} active={isActive(n)} onClick={() => setMenuOpen(false)} hint />
                  ))}
                </>
              )}
            </nav>
            <div className="mt-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
              <p className="text-sm text-muted">
                Signed in as <span className="font-semibold text-slate-700 dark:text-slate-200">{displayName}</span>
              </p>
              <p className={cn('mt-0.5 text-xs text-muted', !adminPlus && 'capitalize')}>Role: {role}</p>
              <div className="mt-3">
                <AvatarEditor name={displayName ?? ''} size={56} />
              </div>
              <div className="mt-3">
                <ThemeSwitch />
              </div>
              <div className="mt-3">
                <NotificationSettings />
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

      {/* Full width; each route change replays the entrance so a page feels placed, not swapped. */}
      <main className="px-4 py-5 sm:px-6 lg:px-8 safe-bottom">
        <div key={pageKey} className="animate-page-in">
          {children}
        </div>
        {/* Room under the last thing on a page (a row's actions, Load more) to scroll it clear of the assistant's
            floating button. Not on the chat, which fills the window to the pixel and lifts the button over Send instead. */}
        {(ai.enabled || ai.owner) && !location.pathname.startsWith('/chat') && <div aria-hidden className="h-16" />}
      </main>
      {/* §20 — the assistant: its floating button in the bottom corner, and its popup. Outside <main>, which remounts
          on every route: an answer keeps streaming while its asker moves around. */}
      {(ai.enabled || ai.owner) && <AiButton />}
      <AiPanelHost />
      <ToastHost />
      <WhatsNewPrompt />
    </div>
  )
}

/** `hint`: the entry's line under its name (administration), as the gear's menu shows it. */
function DrawerLink({ item, active, onClick, hint = false }: { item: NavItem; active: boolean; onClick: () => void; hint?: boolean }) {
  const sub = hint ? item.hint : undefined
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-2xl px-4 text-base font-semibold transition-colors',
        sub ? 'py-3' : 'py-4',
        active ? 'bg-brand-700 text-white shadow-card' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
      )}
    >
      <item.icon className="h-5 w-5 shrink-0" />
      {sub ? (
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block">{item.label}</span>
          <span className={cn('mt-0.5 block text-xs font-medium', active ? 'text-white/80' : 'text-muted')}>{sub}</span>
        </span>
      ) : (
        <span className="flex-1">{item.label}</span>
      )}
    </NavLink>
  )
}
