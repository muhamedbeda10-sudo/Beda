// ============================================================================
// §6 — History's grouped view: the sessions of an order (read whole), of an
// item, of a machine, or of the filters as they stand, laid on their order
// lines with what each line's sessions inspected and found. A session chip
// opens that session: in place in History, through History from Access.
// On a phone each line is a card ending in its session chips, finger-sized;
// from a small tablet up, a table with the sessions right after the order.
// ============================================================================

import { useMemo, type ReactNode } from 'react'
import { Layers } from 'lucide-react'
import type { HistoryGroupQuery, HistoryGroupSession } from '@qc/shared/api'
import { HISTORY_GROUP_LIMIT } from '@qc/shared/api'
import { Modal } from '@/components/ui'
import { useHistoryGroup } from '@/services/queries'
import { cn, formatDateTime } from '@/lib/utils'
import { useTableView, ViewNote, ViewTh } from '@/components/ui/ColumnFilter'

export interface GroupSpec {
  title: string
  subtitle?: string
  query: HistoryGroupQuery
}

/** A session's stages in a chip's title: " · stages 1 + 2"; nothing for a lone stage 1 or another machine. */
const stageWords = (stages: number[]) => (stages.length > 1 ? ` · stages ${stages.join(' + ')}` : stages[0] > 1 ? ` · stage ${stages[0]}` : '')

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

/** A line's three heaviest defects and their pieces, and how many more: "Burr 12 · Dent 3 · +2". */
function topDefects(r: LineRow): string {
  if (!r.defects.length) return '—'
  const shown = r.defects.slice(0, 3).map((d) => `${d.defectName} ${num(d.pieces)}`).join(' · ')
  return r.defects.length > 3 ? `${shown} · +${r.defects.length - 3}` : shown
}

/** The button that opens one session: its number, and the stages it covered on a universal machine. Green while open. */
function SessionChip({ session: s, onOpen, className }: { session: HistoryGroupSession; onOpen: (sessionId: string) => void; className?: string }) {
  const tip = `${formatDateTime(s.startedAt)} · ${s.inspectorName} · ${num(s.piecesInspected)} inspected, ${num(s.defectPieces)} defect pcs${stageWords(s.stages)}`
  return (
    <button
      type="button"
      onClick={() => onOpen(s.sessionId)}
      data-tip={tip}
      className={cn(
        'inline-flex items-center justify-center rounded-md text-xs font-semibold',
        s.status === 'Open'
          ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300'
          : 'bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300',
        className,
      )}
    >
      #{s.seq}
      {s.stages.length > 1 || (s.stages[0] ?? 1) > 1 ? ` · S${s.stages.join('+')}` : ''}
    </button>
  )
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

export function SessionGroupModal({ spec, onClose, onOpenSession, footer }: { spec: GroupSpec | null; onClose: () => void; onOpenSession: (sessionId: string) => void; footer?: ReactNode }) {
  const { data, isLoading, error } = useHistoryGroup(spec?.query ?? null)
  const rows = useMemo(() => byLine(data?.sessions ?? []), [data])
  const view = useTableView(rows, [
    { key: 'order', value: (r) => r.orderNumber },
    { key: 'item', value: (r) => `${r.item}${r.itemCode ? ` ${r.itemCode}` : ''}` },
    { key: 'machine', value: (r) => r.machine },
    { key: 'inspected', value: (r) => num(r.inspected), sortValue: (r) => r.inspected, numeric: true },
    { key: 'defectPieces', value: (r) => num(r.defectPieces), sortValue: (r) => r.defectPieces, numeric: true },
    { key: 'defects', value: (r) => r.defects.map((d) => d.defectName).join(', ') || '—' },
    { key: 'sessions', value: (r) => String(r.sessions.length), sortValue: (r) => r.sessions.length, numeric: true },
  ])
  if (!spec) return null
  const inspected = rows.reduce((n, r) => n + r.inspected, 0)
  const defectPieces = rows.reduce((n, r) => n + r.defectPieces, 0)
  const open = rows.reduce((n, r) => n + r.open, 0)
  return (
    <Modal open onClose={onClose} title={spec.title} icon={<Layers className="h-5 w-5" />} size="xl" footer={footer}>
      <div className="space-y-3">
        {spec.subtitle && <p className="text-xs text-muted">{spec.subtitle}</p>}
        {isLoading ? (
          <div className="skeleton h-40" />
        ) : error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error instanceof Error ? error.message : 'Could not load the sessions.'}</p>
        ) : !data || data.total === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No session here.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {num(data.total)} {data.total === 1 ? 'session' : 'sessions'}
              {open > 0 && `, ${num(open)} open`}, on {rows.length} order {rows.length === 1 ? 'line' : 'lines'}: {num(inspected)} pieces inspected, {num(defectPieces)} defect pieces
              {data.truncated ? `; the newest ${HISTORY_GROUP_LIMIT} are listed` : ''}. Tap a session to open it.
            </p>
            {/* Phone: a card per order line, its session chips last and wrapping — each the height of a finger. */}
            <ul className="space-y-2 sm:hidden" aria-label="Order lines">
              {view.rows.map((r) => (
                <li key={r.key} className="rounded-2xl px-3 py-2.5 ring-1 ring-slate-200 dark:ring-slate-700">
                  <p className="min-w-0 break-words font-semibold">
                    {r.orderNumber} · <bdi>{r.item}</bdi>
                    {r.itemCode && <span className="ms-1.5 text-xs font-normal text-muted">{r.itemCode}</span>}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-600 dark:text-slate-300">{r.machine}</p>
                  <p className="mt-1 text-xs tabular-nums text-muted">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{num(r.inspected)}</span> inspected ·{' '}
                    <span className={cn('font-semibold', r.defectPieces > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-slate-100')}>{num(r.defectPieces)}</span> defect pcs
                  </p>
                  {r.defects.length > 0 && (
                    <p className="mt-0.5 break-words text-xs text-muted" dir="auto">
                      {topDefects(r)}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {r.sessions.map((s) => (
                      <SessionChip key={s.sessionId} session={s} onOpen={onOpenSession} className="min-h-[44px] min-w-[44px] px-3" />
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            {/* From a small tablet: the table, the sessions right after the order so the way in is never off to the right. */}
            <div className="relative hidden max-h-[60vh] overflow-auto sm:block">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                    <ViewTh view={view} column="order" label="Order" className="px-2 py-1.5 font-semibold" />
                    <ViewTh view={view} column="sessions" label="Sessions" className="px-2 py-1.5 font-semibold" />
                    <ViewTh view={view} column="item" label="Item" className="px-2 py-1.5 font-semibold" />
                    <ViewTh view={view} column="machine" label="Machine" className="px-2 py-1.5 font-semibold" />
                    <ViewTh view={view} column="inspected" label="Inspected" className="px-2 py-1.5 text-right font-semibold" />
                    <ViewTh view={view} column="defectPieces" label="Defect pcs" className="px-2 py-1.5 text-right font-semibold" />
                    <ViewTh view={view} column="defects" label="Defects" className="px-2 py-1.5 font-semibold" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {view.rows.map((r) => (
                    <tr key={r.key} className="align-top">
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">{r.orderNumber}</td>
                      <td className="px-2 py-1.5">
                        <span className="flex min-w-[5rem] flex-wrap gap-1">
                          {r.sessions.map((s) => (
                            <SessionChip key={s.sessionId} session={s} onOpen={onOpenSession} className="min-h-[36px] px-2 touch:min-h-[44px] touch:min-w-[44px]" />
                          ))}
                        </span>
                      </td>
                      <td className="px-2 py-1.5" dir="auto">
                        {r.item}
                        {r.itemCode && <span className="ml-1 text-xs text-muted">{r.itemCode}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">{r.machine}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{num(r.inspected)}</td>
                      <td className={cn('px-2 py-1.5 text-right font-semibold tabular-nums', r.defectPieces > 0 && 'text-rose-600 dark:text-rose-400')}>{num(r.defectPieces)}</td>
                      <td className="px-2 py-1.5 text-xs text-muted" dir="auto">
                        {topDefects(r)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">Green: still open. S2, S1+2…: the stages a session covered on a universal machine.</p>
          </>
        )}
      </div>
    </Modal>
  )
}
