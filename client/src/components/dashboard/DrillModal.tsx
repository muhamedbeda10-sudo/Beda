// ============================================================================
// §15 — what is behind a number on the dashboard. A bar, a slice, a row or a
// tile opens the sessions whose rejected pieces make it, laid on the order
// lines they belong to, with the defects of each and a link to every session.
// ============================================================================

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import type { KpiDrillQuery, KpiDrillSession, KpiFirstPartDrillQuery } from '@qc/shared/kpi'
import { KPI_DRILL_LIMIT } from '@qc/shared/kpi'
import { Modal } from '@/components/ui'
import { useFirstPartDrill, useKpiDrill } from '@/services/queries'
import { formatDateTime } from '@/lib/utils'
import { sessionDetailPath } from '@/lib/links'

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
  if (!spec) return null
  return (
    <Modal open onClose={onClose} title={spec.title} icon={<Search className="h-5 w-5" />} size="xl">
      <div className="space-y-3">
        {spec.subtitle && <p className="text-xs text-slate-400">{spec.subtitle}</p>}
        {isLoading ? (
          <div className="skeleton h-40" />
        ) : error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error instanceof Error ? error.message : 'Could not load the sessions.'}</p>
        ) : !data || data.totalSessions === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">No session behind this number.</p>
        ) : (
          <>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {num(data.totalPieces)} pieces {what} in {num(data.totalSessions)} {data.totalSessions === 1 ? 'session' : 'sessions'} on {rows.length} order {rows.length === 1 ? 'line' : 'lines'}
              {data.truncated ? `; the ${KPI_DRILL_LIMIT} sessions with the most are listed` : ''}. The orders behind them:
            </p>
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-2 py-1.5 font-semibold">Order</th>
                    <th className="px-2 py-1.5 font-semibold">Item</th>
                    <th className="px-2 py-1.5 font-semibold">Machine</th>
                    {showDefects && <th className="px-2 py-1.5 font-semibold">Defects</th>}
                    <th className="px-2 py-1.5 text-right font-semibold">{spec.firstPart ? 'Rejected before' : 'Rejected'}</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((r) => (
                    <tr key={r.key} className="align-top">
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">{r.orderNumber}</td>
                      <td className="px-2 py-1.5" dir="auto">
                        {r.item}
                        {r.itemCode && <span className="ml-1 text-xs text-slate-400">{r.itemCode}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">{r.machine}</td>
                      {showDefects && (
                        <td className="px-2 py-1.5 text-xs text-slate-500" dir="auto">
                          {r.defects.slice(0, 3).map((d) => `${d.defectName} ${num(d.pieces)}`).join(' · ')}
                          {r.defects.length > 3 && ` · +${r.defects.length - 3}`}
                        </td>
                      )}
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums">{num(r.pieces)} pcs</td>
                      <td className="px-2 py-1.5 text-right">
                        <span className="inline-flex flex-wrap justify-end gap-1">
                          {r.sessions.map((s) => (
                            <button
                              key={s.sessionId}
                              type="button"
                              onClick={() => navigate(sessionDetailPath(s.sessionId))}
                              title={`${formatDateTime(s.at)} · ${s.inspectorName} · ${num(s.pieces)} pcs`}
                              className="rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300"
                            >
                              Session #{s.seq}
                            </button>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
