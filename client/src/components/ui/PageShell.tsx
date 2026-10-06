// ============================================================================
// The shell every list page shares. One header row (≤ 56 px): the page's
// title, its figures inline ("1,351 sessions · 2 open"), and its actions on
// the right, the exports gathered in one Export control. Under it one filter
// row (≤ 48 px): the search, the two or three filters used most, "More
// filters" holding the rest, and Reset. A row of removable chips names the
// filters in force, and only while any is. The filter row stays in view as
// the page scrolls.
// ============================================================================

import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Download, Info, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react'
import { FloatingPanel } from '@/components/dashboard/filters'
import { cn } from '@/lib/utils'

// ---- Header ------------------------------------------------------------------

export function PageHeader({ title, lead, stats, actions }: { title: string; lead?: ReactNode; stats?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-[40px] flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="text-xl font-bold tracking-tight">{title}</h1>
      {lead}
      {stats && <div className="flex flex-wrap items-center gap-x-1.5 text-13 text-muted">{stats}</div>}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** One figure in the header's line: the number bold, its noun muted; a button when it opens what it counts. */
export function HeaderStat({ value, label, onClick, tip, tone }: { value: number; label: string; onClick?: () => void; tip?: string; tone?: 'success' }) {
  const body = (
    <>
      <span className={cn('font-semibold tabular-nums text-slate-900 dark:text-slate-100', tone === 'success' && value > 0 && 'text-success-700 dark:text-success-400')}>{value.toLocaleString()}</span> {label}
    </>
  )
  if (!onClick || value === 0) return <span data-tip={tip}>{body}</span>
  return (
    <button type="button" onClick={onClick} data-tip={tip} className="rounded underline-offset-4 hover:text-brand-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-brand-300">
      {body}
    </button>
  )
}

/** The dot between header figures. */
export const StatDot = () => (
  <span aria-hidden className="text-muted">
    ·
  </span>
)

/** A two-or-three-way switch the height of the header row. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex h-9 items-center rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-800 touch:h-11">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-13 font-semibold transition-colors touch:h-10',
            value === o.value ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-muted hover:text-slate-700 dark:hover:text-slate-200',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export interface ExportItem {
  label: string
  onClick: () => void
  disabled?: boolean
  icon?: ReactNode
}

/** The page's exports. One is a button; two or more share one Export menu. */
export function ExportMenu({ items, busy }: { items: ExportItem[]; busy?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  if (items.length === 1) {
    const [only] = items
    return (
      <button type="button" onClick={only.onClick} disabled={only.disabled || busy} className="btn-secondary h-9 min-h-0 px-3 py-0 text-13">
        <Download className="h-4 w-4" /> {busy ? 'Building…' : only.label}
      </button>
    )
  }
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} disabled={busy} className="btn-secondary h-9 min-h-0 px-3 py-0 text-13">
        <Download className="h-4 w-4" /> {busy ? 'Building…' : 'Export'}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <FloatingPanel anchor={anchor} open={open} onClose={() => setOpen(false)} width={200} label="Export">
        <div role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      </FloatingPanel>
    </>
  )
}

/**
 * An (i) beside a heading in place of a paragraph under it: the explanation
 * shows in the tooltip under a mouse, and opens in a small panel on a tap.
 */
export function InfoTip({ text, label = 'About this' }: { text: string; label?: string }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        aria-expanded={open}
        data-tip={open ? undefined : text}
        onClick={() => setOpen((o) => !o)}
        className="print-hidden inline-grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-9 touch:w-9"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <FloatingPanel anchor={anchor} open={open} onClose={() => setOpen(false)} width={320} label={label}>
        <p className="whitespace-pre-line p-2 text-13 leading-relaxed text-slate-700 dark:text-slate-200">{text}</p>
      </FloatingPanel>
    </>
  )
}

// ---- Filter bar --------------------------------------------------------------

/** A filter in force, named on a chip that removes it. */
export interface FilterChip {
  key: string
  label: string
  onRemove: () => void
}

/** A compact filter select for the filter row; its label is what a screen reader hears and what the chip says. */
export function FilterSelect({ label, value, onChange, children, className }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode; className?: string }) {
  return (
    <select
      aria-label={label}
      data-tip={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn('input h-10 truncate py-0 pl-3 pr-8 text-sm max-md:!w-[calc(50%-4px)] md:!w-auto md:min-w-[8rem] md:max-w-[12rem] touch:h-11', className)}
    >
      {children}
    </select>
  )
}

export function FilterBar({
  search,
  filters,
  more,
  moreCount = 0,
  chips,
  onReset,
  canReset,
  trailing,
}: {
  search: { value: string; onChange: (v: string) => void; placeholder: string; label: string }
  /** The two or three filters used most, in the row. */
  filters?: ReactNode
  /** The rest, in the More filters panel. */
  more?: ReactNode
  /** How many of the filters in the panel are in force. */
  moreCount?: number
  chips: FilterChip[]
  onReset: () => void
  canReset: boolean
  trailing?: ReactNode
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <div className="z-30 -mx-4 space-y-1.5 bg-slate-100/90 px-4 py-1 backdrop-blur sm:-mx-6 sm:px-6 md:sticky md:top-16 lg:-mx-8 lg:px-8 dark:bg-slate-950/90">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full md:w-auto md:min-w-[12rem] md:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder}
            aria-label={search.label}
            className="input h-10 py-0 pl-9 pr-9 text-sm touch:h-11"
          />
          {search.value && (
            <button type="button" onClick={() => search.onChange('')} aria-label="Clear the search" data-tip="Clear the search" className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {filters}
        {more && (
          <>
            <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} className={cn('btn-secondary h-10 min-h-0 px-3 py-0 text-sm max-md:flex-1 touch:h-11', moreCount > 0 && 'text-brand-700 ring-brand-300 dark:text-brand-200 dark:ring-brand-500/50')}>
              <SlidersHorizontal className="h-4 w-4" /> More filters
              {moreCount > 0 && <span className="rounded bg-brand-600 px-1.5 text-[11px] font-bold leading-[18px] text-white">{moreCount}</span>}
            </button>
            <FloatingPanel anchor={anchor} open={open} onClose={() => setOpen(false)} width={320} label="More filters">
              <div className="space-y-3 p-2">{more}</div>
            </FloatingPanel>
          </>
        )}
        <button type="button" onClick={onReset} disabled={!canReset} aria-label="Reset all filters" data-tip="Reset all filters" className="grid h-10 w-10 place-items-center rounded-lg text-muted touch:h-11 touch:w-11 transition-colors hover:bg-slate-200/70 hover:text-slate-700 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-200">
          <RotateCcw className="h-4 w-4" />
        </button>
        {trailing}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Filters in force">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.onRemove}
              aria-label={`Remove the filter ${c.label}`}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-info-50 px-2 text-xs font-semibold text-info-700 ring-1 ring-inset ring-info-200 hover:bg-info-100 dark:bg-info-500/10 dark:text-info-300 dark:ring-info-500/25 dark:hover:bg-info-500/20"
            >
              <span className="max-w-[16rem] truncate">{c.label}</span>
              <X className="h-3.5 w-3.5" />
            </button>
          ))}
          {chips.length > 1 && (
            <button type="button" onClick={onReset} className="h-7 rounded-md px-2 text-xs font-semibold text-muted hover:text-slate-700 hover:underline dark:hover:text-slate-200">
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  )
}
