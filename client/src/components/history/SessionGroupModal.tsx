// ============================================================================
// §6 — History's grouped view: the sessions of an order (read whole), of an
// item, of a machine, or of the filters as they stand, laid on their order
// lines with what each line's sessions inspected and found. A session chip
// opens that session in History.
// ============================================================================

import { useMemo } from 'react'
import { Layers } from 'lucide-react'
import type { HistoryGroupQuery, HistoryGroupSession } from '@qc/shared/api'
import { HISTORY_GROUP_LIMIT } from '@qc/shared/api'
import { Modal } from '@/components/ui'
import { useHistoryGroup } from '@/services/queries'
import { cn, formatDateTime } from '@/lib/utils'

export interface GroupSpec {
  title: string
  subtitle?: string
  query: HistoryGroupQuery
}

const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }))

interface LineRow {
  key: string
  orderNumber: string
  item: string
  itemCode: string
  machine: string
  inspected: number
  defectPieces: number
  open: number
  sessions: HistoryGroupSession[]
  defects: { defectName: string; pieces: number }[]
}

function byLine(sessions: HistoryGroupSession[]): LineRow[] {
  const lines = new Map<string, LineRow>()
  for (const s of sessions) {
    let row = lines.get(s.orderId)
    if (!row) {
      row = { key: s.orderId, orderNumber: s.orderNumber, item: s.item, itemCode: s.itemCode, machine: s.machine, inspected: 0, defectPieces: 0, open: 0, sessions: [], defects: [] }
      lines.set(s.orderId, row)
    }
    row.inspected += s.piecesInspected
    row.defectPieces += s.defectPieces
    if (s.status === 'Open') row.open += 1
    row.sessions.push(s)
    for (const d of s.defects) {
      const had = row.defects.find((x) => x.defectName === d.defectName)
      if (had) had.pieces += d.pieces
      else row.defects.push({ ...d })
    }
  }
  for (const row of lines.values()) {
    row.sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    row.defects.sort((a, b) => b.pieces - a.pieces || a.defectName.localeCompare(b.defectName))
  }
  // Largest first: the lines with the most defect pieces, then the most inspected.
  return Array.from(lines.values()).sort((a, b) => b.defectPieces - a.defectPieces || b.inspected - a.inspected || a.orderNumber.localeCompare(b.orderNumber))
}

export function SessionGroupModal({ spec, onClose, onOpenSession }: { spec: GroupSpec | null; onClose: () => void; onOpenSession: (sessionId: string) => void }) {
  const { data, isLoading, error } = useHistoryGroup(spec?.query ?? null)
  const rows = useMemo(() => byLine(data?.sessions ?? []), [data])
  if (!spec) return null
  const inspected = rows.reduce((n, r) => n + r.inspected, 0)
  const defectPieces = rows.reduce((n, r) => n + r.defectPieces, 0)
  const open = rows.reduce((n, r) => n + r.open, 0)
  return (
    <Modal open onClose={onClose} title={spec.title} icon={<Layers className="h-5 w-5" />} size="xl">
      <div className="space-y-3">
        {spec.subtitle && <p className="text-xs text-slate-400">{spec.subtitle}</p>}
        {isLoading ? (
          <div className="skeleton h-40" />
        ) : error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error instanceof Error ? error.message : 'Could not load the sessions.'}</p>
        ) : !data || data.total === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">No session here.</p>
        ) : (
          <>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {num(data.total)} {data.total === 1 ? 'session' : 'sessions'}
              {open > 0 && `, ${num(open)} open`}, on {rows.length} order {rows.length === 1 ? 'line' : 'lines'}: {num(inspected)} pieces inspected, {num(defectPieces)} defect pieces
              {data.truncated ? `; the newest ${HISTORY_GROUP_LIMIT} are listed` : ''}. Tap a session to open it.
            </p>
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-2 py-1.5 font-semibold">Order</th>
                    <th className="px-2 py-1.5 font-semibold">Item</th>
                    <th className="px-2 py-1.5 font-semibold">Machine</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Inspected</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Defect pcs</th>
                    <th className="px-2 py-1.5 font-semibold">Defects</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Sessions</th>
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
                      <td className="px-2 py-1.5 text-right tabular-nums">{num(r.inspected)}</td>
                      <td className={cn('px-2 py-1.5 text-right font-semibold tabular-nums', r.defectPieces > 0 && 'text-rose-600 dark:text-rose-400')}>{num(r.defectPieces)}</td>
                      <td className="px-2 py-1.5 text-xs text-slate-500" dir="auto">
                        {r.defects.length ? r.defects.slice(0, 3).map((d) => `${d.defectName} ${num(d.pieces)}`).join(' · ') : '—'}
                        {r.defects.length > 3 && ` · +${r.defects.length - 3}`}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <span className="inline-flex flex-wrap justify-end gap-1">
                          {r.sessions.map((s) => (
                            <button
                              key={s.sessionId}
                              type="button"
                              onClick={() => onOpenSession(s.sessionId)}
                              title={`${formatDateTime(s.startedAt)} · ${s.inspectorName} · ${num(s.piecesInspected)} inspected, ${num(s.defectPieces)} defect pcs${s.stage && s.stage > 1 ? ` · stage ${s.stage}` : ''}`}
                              className={cn(
                                'rounded-md px-1.5 py-0.5 text-xs font-semibold',
                                s.status === 'Open'
                                  ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300'
                                  : 'bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300',
                              )}
                            >
                              #{s.seq}
                              {s.stage && s.stage > 1 ? ` · S${s.stage}` : ''}
                            </button>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-400">Green: still open. S2, S3…: a later stage on a universal machine.</p>
          </>
        )}
      </div>
    </Modal>
  )
}
