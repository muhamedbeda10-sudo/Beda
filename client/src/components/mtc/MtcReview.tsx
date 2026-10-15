// ============================================================================
// MTC review — every item Claude read from a certificate, editable, compared
// with its register, before anything is saved. The same screen for coils,
// welding wire and mesh wire: the register's description gives the columns.
// Amber: Claude was not sure (editing the cell clears the mark). Red: the row
// cannot be saved as it is. An item already registered is left as it is
// unless Overwrite is ticked.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Info, Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { MTC_MAX_ROWS, MTC_SUPPLIERS, mtcIdField, type MtcExtractResult, type MtcField, type MtcRegister } from '@qc/shared/mtc'
import { Badge, Button, Card, Modal, type BadgeTone } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { saveCertificate, useExistingItems } from '@/services/mtc'
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
  duplicate: { label: 'Twice', tone: 'red', hint: 'Listed more than once. Keep one row.' },
}

/** An input's width by what it holds. */
function widthOf(f: MtcField): string {
  if (f.type === 'number') return 'w-20'
  if (f.key === 'notes') return 'w-44'
  if (f.identifies) return 'w-36'
  if (f.choices) return 'w-28'
  return 'w-32'
}

const show = (v: string | number | undefined) => (v === undefined || v === '' ? '—' : String(v))
const headerOf = (f: MtcField) => (f.unit ? `${f.label} (${f.unit})` : f.label)

export function MtcReview({
  register,
  result,
  suppliers,
  onDone,
}: {
  register: MtcRegister
  result: MtcExtractResult
  suppliers: string[]
  onDone: (saved: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const [rows, setRows] = useState<ReviewRow[]>(() => toReviewRows(register, result.rows))
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [saving, setSaving] = useState(false)
  // The assistant's button floats above the save bar, not over its buttons.
  const bottomBar = useBottomBarRef<HTMLDivElement>()

  // The register's items behind the identifiers on screen, looked up again as identifiers are corrected —
  // keyed by their list, so editing a grade does not look the register up again.
  const idField = mtcIdField(register).key
  const idsKey = useMemo(() => Array.from(new Set(rows.map((r) => r.values[idField].trim().toLowerCase()).filter(Boolean))).sort().join('\n'), [rows, idField])
  const settledKey = useDebounced(idsKey, 400)
  const settledIds = useMemo(() => (settledKey ? settledKey.split('\n') : []), [settledKey])
  const existing = useExistingItems(register.kind, settledIds, settledKey)
  const checking = existing.isFetching || settledKey !== idsKey

  const reviewed = useMemo(() => reviewRows(register, rows, existing.data ?? []), [register, rows, existing.data])
  const summary = useMemo(() => summarise(reviewed), [reviewed])
  const toWrite = summary.added + summary.overwritten
  const supplierChoices = useMemo(
    () => Array.from(new Set([...(register.kind === 'coils' ? MTC_SUPPLIERS : []), ...suppliers])).sort((a, b) => a.localeCompare(b)),
    [register.kind, suppliers],
  )

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
      const res = await saveCertificate(queryClient, register.kind, { fileName: result.fileName, rows: saveRows(reviewed) })
      const parts = [`${res.inserted.length} added`, `${res.updated.length} overwritten`]
      // Left alone: what the API skipped, and the items registered with these very values, which were not sent.
      const kept = res.skipped.length + reviewed.filter((r) => r.status === 'same').length
      if (kept > 0) parts.push(`${kept} left as ${kept === 1 ? 'it was' : 'they were'}`)
      toast(`${register.label} saved: ${parts.join(', ')}.`, 'success')
      onDone(true)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The certificate could not be saved.', 'error')
      void existing.refetch()
    } finally {
      setSaving(false)
    }
  }

  const listId = (f: MtcField) => (f.key === 'supplier' ? `mtc-${register.kind}-suppliers` : f.choices ? `mtc-${register.kind}-${f.key}` : undefined)

  return (
    <div className="space-y-3 pb-24">
      {register.fields.map(
        (f) =>
          listId(f) && (
            <datalist key={f.key} id={listId(f)}>
              {(f.key === 'supplier' ? supplierChoices : (f.choices ?? [])).map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          ),
      )}

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <button
            type="button"
            onClick={() => (rows.length > 0 ? setConfirmLeave(true) : onDone(false))}
            className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand-600"
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {register.label}
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-extrabold tracking-tight">
              <Badge tone="blue">{register.label}</Badge> <span className="align-middle">{result.fileName}</span>
            </h1>
            <p className="text-sm text-muted">
              {summary.total} {summary.total === 1 ? register.singular : register.plural} · {summary.added} new · {summary.different} registered with other values
              {summary.uncertain > 0 ? ` · ${summary.uncertain} to check` : ''}
              {checking && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin" aria-label="Checking the register" />}
            </p>
          </div>
        </div>

        {result.problem && <Banner tone="warning">{result.problem}</Banner>}
        <Banner tone="info">
          Check every row against the certificate before saving. <span className="font-semibold">Amber</span> cells are values Claude was not sure of; editing a cell
          clears its mark. Items already registered are left as they are unless you tick <span className="font-semibold">Overwrite</span>; a blank cell never erases a
          registered value.
        </Banner>

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

      {rows.length > 0 ? (
        <ScrollX className="rounded-2xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" innerClassName="rounded-2xl" label="Items read from the certificate">
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
              <tr>
                <th className="px-2 py-2.5 font-bold">#</th>
                <th className="px-2 py-2.5 font-bold">Status</th>
                {register.fields.map((f) => (
                  <th key={f.key} className={cn('whitespace-nowrap px-2 py-2.5 font-bold', f.type === 'number' && 'text-right')}>
                    {headerOf(f)}
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
                <ReviewLine
                  key={r.row.id}
                  register={register}
                  index={i}
                  reviewed={r}
                  listId={listId}
                  onEdit={(field, value) => update(r.row.id, (row) => editReviewRow(row, field, value))}
                  onOverwrite={(v) => update(r.row.id, (row) => ({ ...row, overwrite: v }))}
                  onRemove={() => setRows((all) => all.filter((x) => x.id !== r.row.id))}
                />
              ))}
            </tbody>
          </table>
        </ScrollX>
      ) : (
        <Card className="p-6 text-center text-sm text-muted">Nothing was read from this certificate. Add the items by hand, or go back.</Card>
      )}
      <Button className="min-h-[44px]" onClick={() => setRows((all) => [...all, blankReviewRow(register)])} disabled={rows.length >= MTC_MAX_ROWS}>
        <Plus className="h-4 w-4" /> Add a {register.singular} Claude missed
      </Button>

      {/* What Save does, in view while the list scrolls. */}
      <div
        ref={bottomBar}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur safe-bottom dark:border-slate-800 dark:bg-slate-900/95"
      >
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
          <Button variant="primary" className="min-h-[44px]" disabled={saving || checking || summary.blocking > 0 || toWrite === 0} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save to {register.label.toLowerCase()}
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
        <p className="text-sm text-slate-600 dark:text-slate-300">Nothing has been saved. To see these items again the certificate must be uploaded and read again.</p>
      </Modal>
    </div>
  )
}

function ReviewLine({
  register,
  index,
  reviewed,
  listId,
  onEdit,
  onOverwrite,
  onRemove,
}: {
  register: MtcRegister
  index: number
  reviewed: ReviewedRow
  listId: (f: MtcField) => string | undefined
  onEdit: (field: string, value: string) => void
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
            <input type="checkbox" className="h-4 w-4" checked={row.overwrite} onChange={(e) => onOverwrite(e.target.checked)} aria-label={`Overwrite the registered item, row ${index + 1}`} />
            {status === 'removed' ? 'Bring back' : 'Overwrite'}
          </label>
        )}
      </td>
      {register.fields.map((f) => {
        const problem = problems.find((p) => p.field === f.key)
        const unsure = row.uncertain.includes(f.key)
        return (
          <td key={f.key} className="px-2 py-2">
            <input
              value={row.values[f.key] ?? ''}
              onChange={(e) => onEdit(f.key, e.target.value)}
              aria-label={`${f.label}, row ${index + 1}`}
              aria-invalid={problem?.blocking || undefined}
              inputMode={f.type === 'number' ? 'decimal' : undefined}
              list={listId(f)}
              spellCheck={false}
              className={cn(
                'input h-9 px-2 py-0 text-sm',
                widthOf(f),
                f.type === 'number' && 'text-right tabular-nums',
                f.mono && 'font-mono',
                unsure && 'bg-amber-50 ring-2 ring-amber-400 dark:bg-amber-500/10',
                problem?.blocking && 'ring-2 ring-rose-500',
              )}
            />
            {problem && (
              <p className={cn('mt-0.5 max-w-[12rem] text-[11px] leading-tight', problem.blocking ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300')}>{problem.message}</p>
            )}
            {existing && !f.identifies && changed.includes(f.key) && (
              <p className="mt-0.5 max-w-[12rem] truncate text-[11px] leading-tight text-muted" title={show(existing[f.key])}>
                Registered: {show(existing[f.key])}
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
          data-tip="Not part of this delivery: leave it out"
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
