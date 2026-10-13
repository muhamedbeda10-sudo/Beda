import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { ADMIN_NAV, visibleNav } from '@/components/layout/navItems'
import { Badge, Card } from '@/components/ui'
import { useAiMe } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'
import { can, type Capability } from '@qc/shared/rules'
import { cn } from '@/lib/utils'

/**
 * The frame every administration page sits in: the section switcher on the
 * left, and beside it the page — its title, a line on what it is for and its
 * buttons on one row, then the page. A role that may not use the page sees
 * why instead of an empty screen.
 *
 * The switcher is one compact card from lg (1024 px), kept in view while a
 * long page scrolls: below that the shell's menu lists Administration
 * already, and a row of pills wrapped into lines at the top of every page on
 * a phone, before any content. With one section alone there is nothing to
 * switch to, so it is left out.
 */
export function AdminLayout({
  title,
  description,
  needs,
  allowed,
  actions,
  children,
}: {
  title: string
  /** One line under the title: what the page is for. */
  description?: ReactNode
  /** Capability the page requires. */
  needs?: Capability
  /** In place of `needs`: whether this person may use the page, decided by the page. */
  allowed?: boolean
  /** Buttons shown beside the heading. */
  actions?: ReactNode
  children: ReactNode
}) {
  const { role } = useAuth()
  const { data: me } = useAiMe()
  const sections = visibleNav(ADMIN_NAV, role, me?.owner ?? false)
  const may = allowed ?? (needs ? can(role, needs) : false)
  const switcher = sections.length > 1

  return (
    <div className="lg:flex lg:items-start lg:gap-6">
      {switcher && (
        <nav
          aria-label="Administration sections"
          className="sticky top-[calc(5rem+env(safe-area-inset-top))] hidden w-56 shrink-0 flex-col gap-0.5 rounded-2xl bg-white p-2 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800 lg:flex"
        >
          <p className="px-3 pb-1.5 pt-2 text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Administration</p>
          {sections.map((s) => (
            <NavLink
              key={s.to}
              to={s.to}
              className={({ isActive }) =>
                cn(
                  'group flex min-h-[40px] items-center gap-2.5 rounded-xl px-3 text-sm font-semibold transition-colors touch:min-h-[44px]',
                  isActive
                    ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800/60 dark:hover:text-white',
                )
              }
            >
              <s.icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{s.label}</span>
            </NavLink>
          ))}
        </nav>
      )}

      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {/* The section's name is in the switcher on a desktop; below it, over the title. */}
            <p className={cn('text-[11px] font-bold uppercase tracking-[0.18em] text-muted', switcher && 'lg:hidden')}>Administration</p>
            <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
            {description && <p className="mt-0.5 max-w-4xl text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>

        <div className="min-w-0 flex-1">
          {may ? (
            children
          ) : (
            <Card className="flex flex-col items-center gap-3 p-8 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                <ShieldAlert className="h-6 w-6" />
              </span>
              <div>
                <p className="text-lg font-bold">You don't have access to {title}</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted">
                  A change here affects every inspection that follows, so it is limited to administrators. Ask one if you need something added or
                  corrected.
                </p>
              </div>
              <Badge tone="neutral">Signed in as {role}</Badge>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
