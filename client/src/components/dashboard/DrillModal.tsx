// ============================================================================
// §15 — what is behind a number on the dashboard. A bar, a slice, a row or a
// tile opens the sessions whose rejected pieces make it, laid on the order
// lines they belong to, with the defects of each and a link to every session.
// A table from a tablet up, the way to each session beside its order; on a
// phone one card per order line, its sessions as full-width buttons that say
// which session each is — the day and the inspector, not a tooltip.
// ============================================================================

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Search } from 'lucide-react'
import type { KpiDrillQuery, KpiDrillSession, KpiFirstPartDrillQuery } from '@qc/shared/kpi'
import { KPI_DRILL_LIMIT } from '@qc/shared/kpi'
import { Modal } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { FilterNote, FilterTh, useColumnFilters } from '@/components/dashboard/filters'
import { useFirstPartDrill, useKpiDrill } from '@/services/queries'
import { formatDate, formatDateTime } from '@/lib/utils'
import { sessionDetailPath } from '@/lib/links'
import { PHONE, useMediaQuery } from '@/lib/media'

export type DrillSpec = { title: string; subtitle?: string } & ({ query: KpiDrillQuery; firstPart?: undefined } | { firstPart: KpiFirstPartDrillQuery; query?: undefined })

const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }))

interface LineRow {
  key: string
  orderNumber: string
  item: string
  itemCode: string
  machine: string
  pieces: number
  sessions: KpiDrillSession[]
  defects: { defectName: string; pieces: number }[]
}

/** What a session's button says: which session, when and by whom. */
const sessionWords = (s: KpiDrillSession) => `Session #${s.seq} · ${formatDate(s.at)} · ${s.inspectorName}`

/** A line's defects, each its own chip: a name in its own direction (an Arabic one keeps its count beside it, not inside it) and its pieces. */
function DefectChips({ defects, most }: { defects: LineRow['defects']; most: number }) {
  return (
    <span className="flex flex-wrap gap-1">
      {defects.slice(0, most).map((d) => (
        <span key={d.defectName} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <bdi>{d.defectName}</bdi>
          <span className="font-semibold tabular-nums">{num(d.pieces)}</span>
        </span>
      ))}
      {defects.length > most && <span className="px-1 py-0.5 text-xs text-muted">+{defects.length - most}</span>}
    </span>
  )
}

/** The sessions laid on their order lines, largest line first; each line's defects added up. */
function byLine(sessions: KpiDrillSession[]): LineRow[] {
  const lines = new Map<string, LineRow>()
  for (const s of sessions) {
    let row = lines.get(s.orderId)
    if (!row) {
      row = { key: s.orderId, orderNumber: s.orderNumber, item: s.item, itemCode: s.itemCode, machine: s.machine, pieces: 0, sessions: [], defects: [] }
      lines.set(s.orderId, row)
    }
    row.pieces += s.pieces
    row.sessions.push(s)
    for (const d of s.defects) {
      const had = row.defects.find((x) => x.defectName === d.defectName)
      if (had) had.pieces += d.pieces
      else row.defects.push({ ...d })
    }
  }
  for (const row of lines.values()) {
    row.sessions.sort((a, b) => a.at.localeCompare(b.at))
    row.defects.sort((a, b) => b.pieces - a.pieces || a.defectName.localeCompare(b.defectName))
  }
  return Array.from(lines.values()).sort((a, b) => b.pieces - a.pieces || a.orderNumber.localeCompare(b.orderNumber))
}

export function DrillModal({ spec, onClose }: { spec: DrillSpec | null; onClose: () => void }) {
  const navigate = useNavigate()
  const rejects = useKpiDrill(spec?.query ?? null)
  const firstPart = useFirstPartDrill(spec?.firstPart ?? null)
  const { data, isLoading, error } = spec?.firstPart ? firstPart : rejects
  const rows = useMemo(() => byLine(data?.sessions ?? []), [data])
  // A slice that is one defect already says which; otherwise each line names its defects.
  const showDefects = !!spec?.query && !spec.query.defect
  const what = spec?.firstPart ? 'rejected before release' : 'rejected'
  const filters = useColumnFilters(rows, [
    { key: 'order', value: (r) => r.orderNumber },
    { key: 'item', value: (r) => `${r.item}${r.itemCode ? ` ${r.itemCode}` : ''}` },
    { key: 'machine', value: (r) => r.machine },
    { key: 'defects', value: (r) => r.defects.map((d) => d.defectName).join(', ') },
    { key: 'pieces', value: (r) => `${num(r.pieces)} pcs`, numeric: true },
  ])
  const phone = useMediaQuery(PHONE)
  if (!spec) return null
  return (
    <Modal open onClose={onClose} title={spec.title} icon={<Search className="h-5 w-5" />} size="xl">
      <div className="space-y-3">
        {spec.subtitle && <p className="text-xs text-muted">{spec.subtitle}</p>}
        {isLoading ? (
          <div className="skeleton h-40" />
        ) : error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error instanceof Error ? error.message : 'Could not load the sessions.'}</p>
        ) : !data || data.totalSessions === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No session behind this number.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {num(data.totalPieces)} pieces {what} in {num(data.totalSessions)} {data.totalSessions === 1 ? 'session' : 'sessions'} on {rows.length} order {rows.length === 1 ? 'line' : 'lines'}
              {data.truncated ? `; the ${KPI_DRILL_LIMIT} sessions with the most are listed` : ''}. The orders behind them:
            </p>
            {phone ? (
              <ul className="space-y-2">
                {filters.rows.map((r) => (
                  <li key={r.key} className="rounded-xl p-3 ring-1 ring-slate-200 dark:ring-slate-700">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="whitespace-nowrap font-semibold">{r.orderNumber}</span>
                      <span className="whitespace-nowrap font-semibold tabular-nums">
                        {num(r.pieces)} pcs <span className="text-xs font-normal text-muted">{what}</span>
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 break-words text-sm text-slate-600 dark:text-slate-300">
                      <bdi>{r.item}</bdi>
                      {r.itemCode && <span className="ml-1 text-xs text-muted">{r.itemCode}</span>}
                    </p>
                    <p className="line-clamp-1 text-xs text-muted">{r.machine}</p>
                    {showDefects && r.defects.length > 0 && (
                      <div className="mt-1.5">
                        <DefectChips defects={r.defects} most={6} />
                      </div>
                    )}
                    <div className="mt-2 grid gap-1.5">
                      {r.sessions.map((s) => (
                        <button
                          key={s.sessionId}
                          type="button"
                          onClick={() => navigate(sessionDetailPath(s.sessionId))}
                          aria-label={`Open ${sessionWords(s)}, ${num(s.pieces)} pieces`}
                          className="flex min-h-[44px] w-full items-center gap-2 rounded-lg bg-brand-50 px-3 text-left text-sm font-semibold text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300"
                        >
                          <span className="min-w-0 flex-1">
                            {sessionWords(s)}
                            <span className="ml-1 font-normal tabular-nums text-brand-700/80 dark:text-brand-300/80">· {num(s.pieces)} pcs</span>
                          </span>
                          <ChevronRight className="h-4 w-4 shrink-0" />
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <ScrollX shadows="end">
                <table className="table-sticky-first w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                      <FilterTh filters={filters} column="order" label="Order" />
                      <th className="px-2 py-1.5 font-semibold">Open</th>
                      <FilterTh filters={filters} column="pieces" label={spec.firstPart ? 'Rejected before' : 'Rejected'} className="text-right" />
                      <FilterTh filters={filters} column="item" label="Item" />
                      <FilterTh filters={filters} column="machine" label="Machine" />
                      {showDefects && <FilterTh filters={filters} column="defects" label="Defects" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filters.rows.map((r) => (
                      <tr key={r.key} className="align-top">
                        <td className="whitespace-nowrap px-2 py-1.5 font-semibold">{r.orderNumber}</td>
                        <td className="px-2 py-1">
                          <span className="flex min-w-[9.5rem] flex-col items-start gap-1">
                            {r.sessions.map((s) => (
                              <button
                                key={s.sessionId}
                                type="button"
                                onClick={() => navigate(sessionDetailPath(s.sessionId))}
                                aria-label={`Open ${sessionWords(s)}, ${num(s.pieces)} pieces`}
                                data-tip={`${formatDateTime(s.at)} · ${s.inspectorName} · ${num(s.pieces)} pcs`}
                                className="rounded-md bg-brand-50 px-2 py-1 text-left text-xs font-semibold leading-tight text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 touch:min-h-[44px]"
                              >
                                Session #{s.seq}
                                <span className="block whitespace-nowrap text-[11px] font-normal text-brand-700/80 dark:text-brand-300/80">
                                  {formatDate(s.at)} · {s.inspectorName}
                                </span>
                              </button>
                            ))}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums">{num(r.pieces)} pcs</td>
                        <td className="min-w-[10rem] px-2 py-1.5">
                          <bdi>{r.item}</bdi>
                          {r.itemCode && <span className="ml-1 whitespace-nowrap text-xs text-muted">{r.itemCode}</span>}
                        </td>
                        <td className="min-w-[8rem] px-2 py-1.5 text-slate-600 dark:text-slate-300">{r.machine}</td>
                        {showDefects && (
                          <td className="min-w-[10rem] px-2 py-1.5">
                            <DefectChips defects={r.defects} most={3} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
            )}
            <FilterNote filters={filters} total={rows.length} />
          </>
        )}
      </div>
    </Modal>
  )
}
