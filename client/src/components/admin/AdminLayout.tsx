import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { ADMIN_NAV } from '@/components/layout/AppShell'
import { Badge, Card } from '@/components/ui'
import { useAuth } from '@/store/AuthContext'
import { can, type Capability } from '@qc/shared/rules'
import { cn } from '@/lib/utils'

/**
 * The frame every administration page sits in: a heading, the section
 * switcher on the left, the page on the right. A role that may not use the
 * page sees why instead of an empty screen.
 */
export function AdminLayout({
  title,
  needs,
  actions,
  children,
}: {
  title: string
  /** Capability the page requires. */
  needs: Capability
  /** Buttons shown beside the heading. */
  actions?: ReactNode
  children: ReactNode
}) {
  const { role } = useAuth()
  const sections = ADMIN_NAV.filter((n) => !n.needs || can(role, n.needs))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Administration</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{title}</h1>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>

      <div className="lg:flex lg:items-start lg:gap-6">
        <nav aria-label="Administration sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 lg:mx-0 lg:w-60 lg:shrink-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
          {sections.map((s) => (
            <NavLink
              key={s.to}
              to={s.to}
              className={({ isActive }) =>
                cn(
                  'group inline-flex min-h-[48px] shrink-0 items-center gap-3 rounded-2xl px-4 text-sm font-semibold transition-[background-color,color,box-shadow,transform] duration-200 lg:w-full lg:justify-start',
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

        <div className="mt-2 min-w-0 flex-1 lg:mt-0">
          {can(role, needs) ? (
            children
          ) : (
            <Card className="flex flex-col items-center gap-3 p-8 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
                <ShieldAlert className="h-6 w-6" />
              </span>
              <div>
                <p className="text-lg font-bold">You don't have access to {title}</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
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
