// ============================================================================
// MTC review — every coil Claude read from a certificate, editable, compared
// with the register, before anything is saved. Amber: Claude was not sure
// (editing the cell clears the mark). Red: the row cannot be saved as it is.
// A coil already registered is left as it is unless Overwrite is ticked.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Info, Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { MTC_FIELD_LABEL, MTC_SM_TYPES, MTC_SUPPLIERS, mtcCoilKey, type MtcCoilField, type MtcExtractResult } from '@qc/shared/mtc'
import { Badge, Button, Card, Modal, type BadgeTone } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { saveCertificate, useExistingCoils } from '@/services/mtc'
import { useDebounced } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { useBottomBarRef } from '@/lib/bottomBar'
import { blankReviewRow, editReviewRow, reviewRows, saveRows, summarise, toReviewRows, type ReviewRow, type ReviewStatus, type ReviewedRow } from './review'

const STATUS: Record<ReviewStatus, { label: string; tone: BadgeTone; hint: string }> = {
  new: { label: 'New', tone: 'green', hint: 'Not registered yet: it is added.' },
  same: { label: 'Registered', tone: 'neutral', hint: 'Registered with these values: nothing changes.' },
  different: { label: 'Differs', tone: 'amber', hint: 'Registered with other values: left as it is unless you tick Overwrite.' },
  removed: { label: 'Removed', tone: 'violet', hint: 'Registered once and removed: Overwrite brings it back with these values.' },
  duplicate: { label: 'Twice', tone: 'red', hint: 'This coil number is listed more than once. Keep one row.' },
}

/** The editable columns, their input's width and kind. */
const FIELDS: { field: MtcCoilField; width: string; numeric?: boolean; list?: string }[] = [
  { field: 'coilNumber', width: 'w-36' },
  { field: 'grade', width: 'w-32' },
  { field: 'smType', width: 'w-16', list: 'mtc-sm-types' },
  { field: 'supplier', width: 'w-32', list: 'mtc-suppliers' },
  { field: 'thickness', width: 'w-20', numeric: true },
  { field: 'width', width: 'w-20', numeric: true },
  { field: 'yield', width: 'w-20', numeric: true },
  { field: 'notes', width: 'w-44' },
]

const show = (v: string | number | undefined) => (v === undefined || v === '' ? '—' : String(v))

export function MtcReview({ result, suppliers, onDone }: { result: MtcExtractResult; suppliers: string[]; onDone: (saved: boolean) => void }) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const [rows, setRows] = useState<ReviewRow[]>(() => toReviewRows(result.coils))
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [saving, setSaving] = useState(false)
  // The assistant's button floats above the save bar, not over its buttons.
  const bottomBar = useBottomBarRef<HTMLDivElement>()

  // The register's coils behind the numbers on screen, looked up again as numbers are corrected.
  // Keyed by the numbers' list, so editing a grade does not look the register up again.
  const numbersKey = useMemo(() => Array.from(new Set(rows.map((r) => mtcCoilKey(r.values.coilNumber)).filter(Boolean))).sort().join('\n'), [rows])
  const settledKey = useDebounced(numbersKey, 400)
  const settledNumbers = useMemo(() => (settledKey ? settledKey.split('\n') : []), [settledKey])
  const existing = useExistingCoils(settledNumbers, settledKey)
  const checking = existing.isFetching || settledKey !== numbersKey

  const reviewed = useMemo(() => reviewRows(rows, existing.data ?? []), [rows, existing.data])
  const summary = useMemo(() => summarise(reviewed), [reviewed])
  const toWrite = summary.added + summary.overwritten
  const supplierChoices = useMemo(() => Array.from(new Set([...MTC_SUPPLIERS, ...suppliers])).sort((a, b) => a.localeCompare(b)), [suppliers])

  // A reading is minutes of work: leaving the page by accident asks first.
  useEffect(() => {
    if (rows.length === 0) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [rows.length])

  const update = (id: string, change: (r: ReviewRow) => ReviewRow) => setRows((all) => all.map((r) => (r.id === id ? change(r) : r)))
  const setAllOverwrite = (overwrite: boolean) =>
    setRows((all) => {
      const differing = new Set(reviewed.filter((r) => r.status === 'different' || r.status === 'removed').map((r) => r.row.id))
      return all.map((r) => (differing.has(r.id) ? { ...r, overwrite } : r))
    })

  async function save() {
    setSaving(true)
    try {
      const res = await saveCertificate(queryClient, { fileName: result.fileName, rows: saveRows(reviewed) })
      const parts = [`${res.inserted.length} added`, `${res.updated.length} overwritten`]
      // Left alone: what the API skipped, and the coils registered with these very values, which were not sent.
      const kept = res.skipped.length + reviewed.filter((r) => r.status === 'same').length
      if (kept > 0) parts.push(`${kept} left as ${kept === 1 ? 'it was' : 'they were'}`)
      toast(`Saved: ${parts.join(', ')}.`, 'success')
      onDone(true)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The coils could not be saved.', 'error')
      void existing.refetch()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 pb-24">
      <datalist id="mtc-sm-types">
        {MTC_SM_TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <datalist id="mtc-suppliers">
        {supplierChoices.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <button
            type="button"
            onClick={() => (rows.length > 0 ? setConfirmLeave(true) : onDone(false))}
            className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand-600"
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> Coils
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-extrabold tracking-tight">Review — {result.fileName}</h1>
            <p className="text-sm text-muted">
              {summary.total} coil{summary.total === 1 ? '' : 's'} · {summary.added} new · {summary.different} registered with other values
              {summary.uncertain > 0 ? ` · ${summary.uncertain} to check` : ''}
              {checking && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin" aria-label="Checking the register" />}
            </p>
          </div>
        </div>

        {result.notCoils ? (
          <Banner tone="warning">{result.problem ?? 'This document is not a certificate of steel coils: nothing was read from it.'}</Banner>
        ) : (
          <>
            {result.problem && <Banner tone="warning">{result.problem}</Banner>}
            <Banner tone="info">
              Check every row against the certificate before saving. <span className="font-semibold">Amber</span> cells are values Claude was not sure of; editing a
              cell clears its mark. Coils already registered are left as they are unless you tick <span className="font-semibold">Overwrite</span>; a blank cell
              never erases a registered value.
            </Banner>
          </>
        )}

        {summary.different > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">{summary.different} already registered with other values:</span>
            <Button className="min-h-[40px]" onClick={() => setAllOverwrite(true)}>
              Overwrite all
            </Button>
            <Button className="min-h-[40px]" onClick={() => setAllOverwrite(false)}>
              Keep all as registered
            </Button>
          </div>
        )}
      </Card>

      {!result.notCoils && (
        <>
          {rows.length > 0 && (
            <ScrollX className="rounded-2xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" innerClassName="rounded-2xl" label="Coils read from the certificate">
              <table className="w-full min-w-[72rem] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
                  <tr>
                    <th className="px-2 py-2.5 font-bold">#</th>
                    <th className="px-2 py-2.5 font-bold">Status</th>
                    {FIELDS.map((f) => (
                      <th key={f.field} className={cn('px-2 py-2.5 font-bold', f.numeric && 'text-right')}>
                        {MTC_FIELD_LABEL[f.field]}
                      </th>
                    ))}
                    <th className="px-2 py-2.5 font-bold">Page</th>
                    <th className="px-2 py-2.5">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {reviewed.map((r, i) => (
                    <ReviewLine key={r.row.id} index={i} reviewed={r} onEdit={(field, value) => update(r.row.id, (row) => editReviewRow(row, field, value))} onOverwrite={(v) => update(r.row.id, (row) => ({ ...row, overwrite: v }))} onRemove={() => setRows((all) => all.filter((x) => x.id !== r.row.id))} />
                  ))}
                </tbody>
              </table>
            </ScrollX>
          )}
          {rows.length === 0 && <Card className="p-6 text-center text-sm text-muted">No coils were read from this certificate. Add them by hand, or go back.</Card>}
          <Button className="min-h-[44px]" onClick={() => setRows((all) => [...all, blankReviewRow()])} disabled={rows.length >= 500}>
            <Plus className="h-4 w-4" /> Add a coil Claude missed
          </Button>
        </>
      )}

      {/* What Save does, in view while the list scrolls. */}
      <div ref={bottomBar} className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur safe-bottom dark:border-slate-800 dark:bg-slate-900/95">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm">
            {summary.blocking > 0 ? (
              <span className="font-semibold text-rose-700 dark:text-rose-300">
                {summary.blocking} row{summary.blocking === 1 ? '' : 's'} to correct before saving.
              </span>
            ) : toWrite === 0 ? (
              <span className="text-muted">Nothing to add or change.</span>
            ) : (
              <span>
                Save adds <b>{summary.added}</b>, overwrites <b>{summary.overwritten}</b>
                {summary.kept > 0 ? (
                  <>
                    , leaves <b>{summary.kept}</b> as registered
                  </>
                ) : null}
                .{summary.warnings > 0 && <span className="text-amber-700 dark:text-amber-300"> {summary.warnings} with unusual values.</span>}
                {summary.uncertain > 0 && (
                  <span className="text-amber-700 dark:text-amber-300">
                    {' '}
                    {summary.uncertain} row{summary.uncertain === 1 ? '' : 's'} still marked amber.
                  </span>
                )}
              </span>
            )}
          </p>
          <Button className="min-h-[44px]" disabled={saving} onClick={() => (rows.length > 0 ? setConfirmLeave(true) : onDone(false))}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-[44px]" disabled={saving || checking || summary.blocking > 0 || toWrite === 0 || result.notCoils} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save to coils
          </Button>
        </div>
      </div>

      <Modal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Discard this review?"
        icon={<Trash2 className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setConfirmLeave(false)}>
              Keep reviewing
            </Button>
            <Button variant="danger" className="min-h-[48px]" onClick={() => onDone(false)}>
              Discard
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">Nothing has been saved. To see these coils again the certificate must be uploaded and read again.</p>
      </Modal>
    </div>
  )
}

function ReviewLine({
  index,
  reviewed,
  onEdit,
  onOverwrite,
  onRemove,
}: {
  index: number
  reviewed: ReviewedRow
  onEdit: (field: MtcCoilField, value: string) => void
  onOverwrite: (v: boolean) => void
  onRemove: () => void
}) {
  const { row, status, existing, changed, problems } = reviewed
  const status_ = STATUS[status]
  const choosable = status === 'different' || status === 'removed'
  return (
    <tr className={cn('align-top', problems.some((p) => p.blocking) && 'bg-rose-50/60 dark:bg-rose-500/5')}>
      <td className="px-2 py-2 text-xs tabular-nums text-muted">{index + 1}</td>
      <td className="px-2 py-2">
        <span data-tip={status_.hint}>
          <Badge tone={status_.tone}>{status_.label}</Badge>
        </span>
        {/* The choice sits with the status it answers, so it never scrolls out of sight. */}
        {choosable && (
          <label className="mt-1 flex min-h-[36px] cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs font-semibold">
            <input type="checkbox" className="h-4 w-4" checked={row.overwrite} onChange={(e) => onOverwrite(e.target.checked)} aria-label={`Overwrite the registered coil, row ${index + 1}`} />
            {status === 'removed' ? 'Bring back' : 'Overwrite'}
          </label>
        )}
      </td>
      {FIELDS.map(({ field, width, numeric, list }) => {
        const problem = problems.find((p) => p.field === field)
        const unsure = row.uncertain.includes(field)
        const label = `${MTC_FIELD_LABEL[field]}, row ${index + 1}`
        return (
          <td key={field} className="px-2 py-2">
            <input
              value={row.values[field]}
              onChange={(e) => onEdit(field, e.target.value)}
              aria-label={label}
              aria-invalid={problem?.blocking || undefined}
              inputMode={numeric ? 'decimal' : undefined}
              list={list}
              spellCheck={false}
              className={cn(
                'input h-9 px-2 py-0 text-sm',
                width,
                numeric && 'text-right tabular-nums',
                field === 'coilNumber' && 'font-mono',
                unsure && 'bg-amber-50 ring-2 ring-amber-400 dark:bg-amber-500/10',
                problem?.blocking && 'ring-2 ring-rose-500',
              )}
            />
            {problem && <p className={cn('mt-0.5 max-w-[12rem] text-[11px] leading-tight', problem.blocking ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300')}>{problem.message}</p>}
            {existing && field !== 'coilNumber' && changed.includes(field) && (
              <p className="mt-0.5 max-w-[12rem] truncate text-[11px] leading-tight text-muted" title={show(existing[field])}>
                Registered: {show(existing[field])}
              </p>
            )}
          </td>
        )
      })}
      <td className="px-2 py-2 text-xs tabular-nums text-muted">{row.page ?? ''}</td>
      <td className="px-1 py-1">
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove row ${index + 1}`}
          data-tip="Not a coil of this delivery: leave it out"
          className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}

function Banner({ tone, children }: { tone: 'info' | 'warning'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex gap-2 rounded-xl px-3 py-2 text-sm',
        tone === 'info' ? 'bg-slate-50 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200',
      )}
    >
      {tone === 'info' ? <Info className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{children}</span>
    </div>
  )
}
