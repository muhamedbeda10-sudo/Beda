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
 * The frame every administration page sits in: a heading, the section
 * switcher on the left, the page on the right. A role that may not use the
 * page sees why instead of an empty screen.
 *
 * The switcher is a sidebar from lg (1024 px) only: below that the shell's
 * menu lists Administration already, and a row of seven pills wrapped into
 * four lines at the top of every page on a phone, before any content. With
 * one section alone there is nothing to switch to, so it is left out.
 */
export function AdminLayout({
  title,
  needs,
  allowed,
  actions,
  children,
}: {
  title: string
  /** Capability the page requires. */
  needs?: Capability
  /** In place of `needs`: whether this person may use the page, decided by the page (§20 — the AI assistant's owner, whatever the role). */
  allowed?: boolean
  /** Buttons shown beside the heading. */
  actions?: ReactNode
  children: ReactNode
}) {
  const { role } = useAuth()
  // The AI assistant's settings are listed for its owner alone (one cheap, cached call that the shell has made already).
  const { data: me } = useAiMe()
  const sections = visibleNav(ADMIN_NAV, role, me?.owner ?? false)
  const may = allowed ?? (needs ? can(role, needs) : false)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Administration</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{title}</h1>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>

      <div className="lg:flex lg:items-start lg:gap-6">
        {sections.length > 1 && (
          <nav aria-label="Administration sections" className="hidden w-60 shrink-0 flex-col gap-2 lg:flex">
            {sections.map((s) => (
              <NavLink
                key={s.to}
                to={s.to}
                className={({ isActive }) =>
                  cn(
                    'group inline-flex min-h-[48px] w-full shrink-0 items-center justify-start gap-3 rounded-2xl px-4 text-sm font-semibold transition-[background-color,color,box-shadow,transform] duration-200',
                  isActive
                    ? 'bg-brand-700 text-white shadow-hover'
                      : 'bg-white text-slate-600 ring-1 ring-slate-200/80 hover:-translate-y-0.5 hover:text-brand-700 hover:shadow-hover dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-800',
                  )
                }
              >
                <s.icon className="h-4 w-4 shrink-0 transition-transform duration-200 group-hover:scale-110" />
                <span className="whitespace-nowrap">{s.label}</span>
              </NavLink>
            ))}
          </nav>
        )}

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
