// A module's parts as icons and names across the top of its page (Planning, QA): a select on a phone; from a
// tablet up a strip of icons and names, a thin rule between one group and the next.

import { useEffect, useRef } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { Select } from '@/components/ui'
import { EdgeShadows, useScrollEdges } from '@/components/ui/ScrollX'
import { cn } from '@/lib/utils'

export interface SectionTab {
  key: string
  label: string
  icon: LucideIcon
  /** What it shows, in a line: the icon's tooltip. */
  hint: string
  /** The group it sits in: a rule parts it from the group before. Tabs of a group sit together. */
  group?: string
}

/**
 * Under a mouse the strip stays on one row and scrolls sideways when the window is narrower than it (the open part
 * brought into view, the ends shaded); on a touch screen, where there is no wheel to scroll it with and a cut-off
 * name reads as broken, it wraps onto a second row instead, every part in sight.
 */
export function SectionTabs({
  name,
  tabs,
  groups,
  current,
  pathOf,
  trailing,
}: {
  /** The module's name, for a screen reader: "Planning" reads "Planning parts" on the strip, "Planning part" on the select. */
  name: string
  tabs: readonly SectionTab[]
  /** The groups' names, in order, for the phone's select; without them the select lists the parts plainly. */
  groups?: readonly { id: string; name: string }[]
  current: SectionTab
  pathOf: (key: string) => string
  trailing?: JSX.Element | false
}) {
  const navigate = useNavigate()
  const strip = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(strip)
  useEffect(() => {
    strip.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [current.key])
  const option = (t: SectionTab) => (
    <option key={t.key} value={t.key}>
      {t.label}
    </option>
  )
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Select aria-label={`${name} part`} value={current.key} onChange={(e) => navigate(pathOf(e.target.value))} className="min-h-[44px] flex-1 sm:hidden">
        {groups
          ? groups.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {tabs.filter((t) => t.group === g.id).map(option)}
              </optgroup>
            ))
          : tabs.map(option)}
      </Select>
      <nav aria-label={`${name} parts`} className="relative hidden min-w-0 flex-1 sm:block">
        <div ref={strip} className="scrollbar-none flex gap-0.5 overflow-x-auto rounded-xl bg-slate-200/70 p-0.5 dark:bg-slate-800 touch:flex-wrap">
          {tabs.map((t, i) => (
            <span key={t.key} className="flex shrink-0 items-center">
              {i > 0 && tabs[i - 1].group !== t.group && <span aria-hidden className="mx-1 h-6 w-px bg-slate-300 dark:bg-slate-700" />}
              <NavLink
                to={pathOf(t.key)}
                end
                data-tip={t.hint}
                className={({ isActive }) =>
                  cn(
                    'group inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-13 font-semibold transition-colors duration-200 touch:h-11',
                    isActive ? 'bg-white text-brand-800 shadow-sm dark:bg-slate-900 dark:text-white' : 'text-muted hover:text-brand-700 dark:hover:text-white',
                  )
                }
              >
                <t.icon className="h-4 w-4 shrink-0" aria-hidden />
                {t.label}
              </NavLink>
            </span>
          ))}
        </div>
        <EdgeShadows {...edges} />
      </nav>
      {trailing}
    </div>
  )
}
