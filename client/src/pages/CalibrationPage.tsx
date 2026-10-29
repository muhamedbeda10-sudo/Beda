// ============================================================================
// §27 — Calibration: the plan of the measuring instruments (F-Q-05-01), each
// due date worked out, the overdue first — counted by status at the top,
// filtered by category, department, status, kind and due period, exported to
// Excel; each instrument opened for its details, certificates, history and
// scrapping. The scrap log (F-Q-05-03) lists the scrapped; Setup holds the
// categories, departments and the old workbooks' import.
// ============================================================================

import { useState } from 'react'
import { Ban, CalendarClock, Gauge, Loader2, Plus, Settings2 } from 'lucide-react'
import {
  CALIBRATION_FORMS, CALIBRATION_KINDS, CALIBRATION_KIND_NAMES, CALIBRATION_PERMISSIONS, CALIBRATION_STATUSES, CALIBRATION_STATUS_NAMES, DUE_SOON_DAYS, intervalLabel,
  type CalibrationItem, type CalibrationItemListQuery, type CalibrationOptions, type CalibrationStatus,
} from '@qc/shared/calibration'
import { Button, Card, EmptyState, Field, Input } from '@/components/ui'
import { ExportMenu, FilterBar, FilterSelect, Segmented } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { CalibrationSetup } from '@/components/calibration/CalibrationSetup'
import { ItemDialog } from '@/components/calibration/ItemDialog'
import { ItemView } from '@/components/calibration/ItemView'
import { calDay, daysText, KindBadge, STATUS_TONE, StatusBadge } from '@/components/calibration/common'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn } from '@/lib/utils'
import { fetchAllCalibrationItems, useCalibrationItems, useCalibrationOptions } from '@/services/calibration'
import { useDebounced } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'

const PAGE = 50

/** The plan's columns in Excel, as the register heads them. */
const PLAN_COLUMNS: { label: string; value: (i: CalibrationItem) => string | number | null }[] = [
  { label: 'القسم / Department', value: (i) => i.departmentName },
  { label: 'اسم الجهاز / Instrument', value: (i) => i.name },
  { label: 'كود الجهاز / Device code', value: (i) => i.deviceCode },
  { label: 'الفئة / Category', value: (i) => i.categoryName },
  { label: 'مستلم الجهاز / Holder', value: (i) => i.holder },
  { label: 'تاريخ الاستلام / Received on', value: (i) => i.receivedOn },
  { label: 'نوع المعايرة / Kind', value: (i) => CALIBRATION_KIND_NAMES[i.kind] },
  { label: 'كود المعايرة / Calibration code', value: (i) => i.calibrationCode },
  { label: 'تاريخ اخر معايرة / Last calibration', value: (i) => i.lastCalibratedOn },
  { label: 'الفترة / Interval', value: (i) => intervalLabel(i.intervalMonths) },
  { label: 'تاريخ المعايرة القادمة / Next calibration', value: (i) => i.nextDueOn },
  { label: 'KPI / Status', value: (i) => CALIBRATION_STATUS_NAMES[i.status] },
  { label: 'Days left', value: (i) => i.daysLeft },
  { label: 'Certificates', value: (i) => i.certificates },
  { label: 'Notes', value: (i) => i.notes },
]
/** The scrap log's columns, as F-Q-05-03 heads them. */
const SCRAP_COLUMNS: { label: string; value: (i: CalibrationItem) => string | number | null }[] = [
  { label: 'القسم / Department', value: (i) => i.departmentName },
  { label: 'اسم الجهاز / Instrument', value: (i) => i.name },
  { label: 'كود الجهاز / Device code', value: (i) => i.deviceCode },
  { label: 'كود المعايرة / Calibration code', value: (i) => i.calibrationCode },
  { label: 'مستلم الجهاز / Holder', value: (i) => i.holder },
  { label: 'تاريخ الإستلام / Received on', value: (i) => i.receivedOn },
  { label: 'تاريخ التكهين / Scrapped on', value: (i) => i.scrap?.scrappedOn ?? null },
  { label: 'أيام العمل / Days in use', value: (i) => i.workingDays },
  { label: 'السبب / Reason', value: (i) => i.scrap?.reason ?? '' },
  { label: 'التفاصيل / Details', value: (i) => i.scrap?.details ?? '' },
  { label: 'Recorded by', value: (i) => i.scrap?.byName ?? '' },
]

/** A status's count, as a card that filters the plan by it. */
function StatusCard({ status, count, active, onClick, hint }: { status: CalibrationStatus; count: number; active: boolean; onClick: () => void; hint: string }) {
  const tone = STATUS_TONE[status]
  const ring: Record<string, string> = {
    red: 'ring-danger-300 dark:ring-danger-500/50', amber: 'ring-warning-300 dark:ring-warning-500/50', green: 'ring-success-300 dark:ring-success-500/50',
    neutral: 'ring-slate-300 dark:ring-slate-600', violet: 'ring-violet-300 dark:ring-violet-500/50',
  }
  const text: Record<string, string> = {
    red: 'text-danger-700 dark:text-danger-400', amber: 'text-warning-800 dark:text-warning-400', green: 'text-success-700 dark:text-success-400', neutral: 'text-slate-700 dark:text-slate-200', violet: 'text-violet-700 dark:text-violet-300',
  }
  return <button type="button" onClick={onClick} aria-pressed={active}
    className={cn('min-w-0 rounded-2xl bg-white p-3 text-start ring-1 ring-slate-200 transition hover:ring-2 dark:bg-slate-900 dark:ring-slate-800 sm:p-4', active && cn('ring-2', ring[tone]))}>
    <span className="block truncate text-[11px] font-semibold uppercase tracking-wide text-muted sm:text-xs">{CALIBRATION_STATUS_NAMES[status]}</span>
    <span className={cn('mt-1 block text-2xl font-bold tabular-nums', count > 0 && text[tone])}>{count.toLocaleString()}</span>
    <span className="hidden truncate text-xs text-muted sm:block">{hint}</span>
  </button>
}

function InstrumentList({ view, options }: { view: 'plan' | 'scrap'; options: CalibrationOptions }) {
  const { can } = useAuth()
  const { toast } = useApp()
  const [search, setSearch] = useState('')
  const [categoryId, setCategory] = useState('')
  const [departmentId, setDepartment] = useState('')
  const [status, setStatus] = useState('')
  const [kind, setKind] = useState('')
  const [dueFrom, setDueFrom] = useState('')
  const [dueTo, setDueTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [adding, setAdding] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const plan = view === 'plan'
  const query: CalibrationItemListQuery = {
    view, q: useDebounced(search, 250) || undefined, categoryId: categoryId || undefined, departmentId: departmentId || undefined, status: plan ? status || undefined : undefined,
    kind: kind || undefined, dueFrom: plan ? dueFrom || undefined : undefined, dueTo: plan ? dueTo || undefined : undefined,
  }
  const list = useCalibrationItems({ ...query, offset, limit: PAGE })
  const change = (setter: (v: string) => void) => (v: string) => { setter(v); setOffset(0) }
  const reset = () => { setSearch(''); setCategory(''); setDepartment(''); setStatus(''); setKind(''); setDueFrom(''); setDueTo(''); setOffset(0) }
  const nameOf = (id: string, of: { id: string; name: string }[]) => of.find((x) => x.id === id)?.name ?? ''
  const chips = [
    ...(categoryId ? [{ key: 'category', label: nameOf(categoryId, options.categories), onRemove: () => change(setCategory)('') }] : []),
    ...(departmentId ? [{ key: 'department', label: nameOf(departmentId, options.departments), onRemove: () => change(setDepartment)('') }] : []),
    ...(status ? [{ key: 'status', label: CALIBRATION_STATUS_NAMES[status as CalibrationStatus], onRemove: () => change(setStatus)('') }] : []),
    ...(kind ? [{ key: 'kind', label: CALIBRATION_KIND_NAMES[kind as 'internal'], onRemove: () => change(setKind)('') }] : []),
    ...(dueFrom ? [{ key: 'from', label: `Due from ${calDay(dueFrom)}`, onRemove: () => change(setDueFrom)('') }] : []),
    ...(dueTo ? [{ key: 'to', label: `Due by ${calDay(dueTo)}`, onRemove: () => change(setDueTo)('') }] : []),
  ]
  const counts = list.data?.counts

  async function exportList() {
    setExporting(true)
    try {
      const all = await fetchAllCalibrationItems(query)
      const columns = plan ? PLAN_COLUMNS : SCRAP_COLUMNS
      const form = plan ? CALIBRATION_FORMS.register : CALIBRATION_FORMS.scrap
      downloadWorkbook(`${form.code} ${plan ? 'Calibration plan' : 'Scrapped instruments'} ${options.today}`, [{ name: plan ? 'Plan' : 'Scrapped', header: columns.map((c) => c.label), rows: all.items.map((i) => columns.map((c) => c.value(i))) }])
      if (all.total > all.items.length) toast(`The first ${all.items.length.toLocaleString()} of ${all.total.toLocaleString()} were exported: narrow the filters for the rest.`, 'info')
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not export.', 'error') }
    finally { setExporting(false) }
  }

  const th = 'whitespace-nowrap px-3 py-2.5'
  const td = 'px-3 py-2.5'
  return <div className="space-y-3">
    {plan && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
      {(['overdue', 'due-soon', 'valid', 'no-date'] as const).map((s) => <StatusCard key={s} status={s} count={counts?.[s] ?? 0} active={status === s} onClick={() => change(setStatus)(status === s ? '' : s)}
        hint={s === 'overdue' ? 'Past their date' : s === 'due-soon' ? `Within ${DUE_SOON_DAYS} days` : s === 'valid' ? 'Calibrated and in date' : 'Never calibrated'} />)}
      <div className="col-span-2 rounded-2xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800 sm:col-span-4 sm:p-4 lg:col-span-1">
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted sm:text-xs">In service</span>
        <span className="mt-1 block text-2xl font-bold tabular-nums">{(counts?.inService ?? 0).toLocaleString()}</span>
        <span className="block text-xs text-muted">{(counts?.scrapped ?? 0).toLocaleString()} scrapped · {counts && counts.inService ? Math.round(((counts.valid + counts['due-soon']) / counts.inService) * 100) : 0}% in date</span>
      </div>
    </div>}
    <FilterBar search={{ value: search, onChange: change(setSearch), placeholder: 'Code, instrument, serial, holder…', label: plan ? 'Search the calibration plan' : 'Search the scrapped instruments' }}
      filters={<>
        <FilterSelect label="Category" value={categoryId} onChange={change(setCategory)}><option value="">All categories</option>{options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</FilterSelect>
        <FilterSelect label="Department" value={departmentId} onChange={change(setDepartment)}><option value="">All departments</option>{options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</FilterSelect>
        {plan && <FilterSelect label="Status" value={status} onChange={change(setStatus)}><option value="">In service</option>{CALIBRATION_STATUSES.map((s) => <option key={s} value={s}>{CALIBRATION_STATUS_NAMES[s]}</option>)}</FilterSelect>}
      </>}
      more={<>
        <Field label="Calibration kind"><select className="input" value={kind} onChange={(e) => change(setKind)(e.target.value)}><option value="">Internal and external</option>{CALIBRATION_KINDS.map((k) => <option key={k} value={k}>{CALIBRATION_KIND_NAMES[k]}</option>)}</select></Field>
        {plan && <><Field label="Next calibration from"><Input type="date" value={dueFrom} onChange={(e) => change(setDueFrom)(e.target.value)} /></Field><Field label="Next calibration by"><Input type="date" value={dueTo} onChange={(e) => change(setDueTo)(e.target.value)} /></Field></>}
      </>}
      moreCount={Number(!!kind) + Number(!!dueFrom) + Number(!!dueTo)} chips={chips} onReset={reset} canReset={!!(search || chips.length)}
      actions={<>
        <ExportMenu busy={exporting} items={[{ label: 'Export to Excel', onClick: () => void exportList(), disabled: !list.data?.total }]} />
        {plan && can(CALIBRATION_PERMISSIONS.record) && <Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add instrument</Button>}
      </>} />
    {list.isPending ? <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
      : list.isError ? <p role="alert" className="py-10 text-center text-sm text-danger-600">{list.error.message} <button type="button" className="underline" onClick={() => void list.refetch()}>Retry</button></p>
      : !list.data.items.length ? <EmptyState icon={plan ? <Gauge className="h-10 w-10" /> : <Ban className="h-10 w-10" />} title={plan ? 'No instruments found' : 'No scrapped instruments found'}
        hint={plan && !chips.length && !search ? 'Add an instrument, or import the register under Setup.' : undefined} />
      : <Card className="overflow-hidden"><ScrollX label={plan ? 'Calibration plan' : 'Scrapped instruments'}>
        {plan ? <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-muted dark:bg-slate-800/60"><tr>
            {['Calibration code', 'Instrument', 'Device code', 'Department', 'Holder', 'Kind', 'Last', 'Interval', 'Next calibration', 'Status'].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.items.map((i) => <tr key={i.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setOpened(i.id)}>
            <td className={cn(td, 'whitespace-nowrap font-semibold')}><button type="button" dir="ltr" className="text-start hover:underline focus-visible:underline" onClick={(e) => { e.stopPropagation(); setOpened(i.id) }}>{i.calibrationCode || <span className="text-muted">No code</span>}</button></td>
            <td className={td}><span dir="auto" className="line-clamp-2 min-w-[12rem]">{i.name}</span>{i.categoryName && <span className="block text-xs text-muted" dir="auto">{i.categoryName}</span>}</td>
            <td dir="auto" className={cn(td, 'whitespace-nowrap')}>{i.deviceCode || '—'}</td>
            <td dir="auto" className={cn(td, 'whitespace-nowrap')}>{i.departmentName || '—'}</td>
            <td dir="auto" className={cn(td, 'max-w-48 truncate')} title={i.holder}>{i.holder || '—'}</td>
            <td className={td}><KindBadge kind={i.kind} /></td>
            <td className={cn(td, 'whitespace-nowrap tabular-nums')}>{calDay(i.lastCalibratedOn)}</td>
            <td className={cn(td, 'whitespace-nowrap')}>{intervalLabel(i.intervalMonths)}</td>
            <td className={cn(td, 'whitespace-nowrap')}><span className="font-semibold tabular-nums">{calDay(i.nextDueOn)}</span><span className={cn('block text-xs', i.status === 'overdue' ? 'font-semibold text-danger-700 dark:text-danger-400' : 'text-muted')}>{daysText(i)}</span></td>
            <td className={td}><StatusBadge status={i.status} /></td>
          </tr>)}</tbody>
        </table>
        : <table className="w-full min-w-[1000px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-muted dark:bg-slate-800/60"><tr>
            {['Department', 'Instrument', 'Calibration code', 'Holder', 'Received on', 'Scrapped on', 'Days in use', 'Reason'].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.items.map((i) => <tr key={i.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setOpened(i.id)}>
            <td dir="auto" className={cn(td, 'whitespace-nowrap')}>{i.departmentName || '—'}</td>
            <td className={td}><button type="button" dir="auto" className="line-clamp-2 min-w-[12rem] text-start font-semibold hover:underline focus-visible:underline" onClick={(e) => { e.stopPropagation(); setOpened(i.id) }}>{i.name}</button>{i.deviceCode && <span className="block text-xs text-muted" dir="auto">{i.deviceCode}</span>}</td>
            <td dir="ltr" className={cn(td, 'whitespace-nowrap text-start')}>{i.calibrationCode || '—'}</td>
            <td dir="auto" className={cn(td, 'max-w-48 truncate')} title={i.holder}>{i.holder || '—'}</td>
            <td className={cn(td, 'whitespace-nowrap tabular-nums')}>{calDay(i.receivedOn)}</td>
            <td className={cn(td, 'whitespace-nowrap font-semibold tabular-nums')}>{calDay(i.scrap?.scrappedOn)}</td>
            <td className={cn(td, 'tabular-nums')}>{i.workingDays === null ? '—' : i.workingDays.toLocaleString()}</td>
            <td dir="auto" className={cn(td, 'max-w-64')}><span className="line-clamp-2">{i.scrap?.reason}{i.scrap?.details ? ` — ${i.scrap.details}` : ''}</span></td>
          </tr>)}</tbody>
        </table>}
      </ScrollX></Card>}
    {list.data && <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted"><span>{list.data.total.toLocaleString()} {plan ? 'instruments' : 'scrapped'}</span><div className="flex gap-2"><Button disabled={!offset || list.isFetching} onClick={() => setOffset((x) => Math.max(0, x - PAGE))}>Previous</Button><Button disabled={!list.data.hasMore || list.isFetching} onClick={() => setOffset((x) => x + PAGE)}>Next</Button></div></div>}
    {adding && <ItemDialog options={options} onClose={() => setAdding(false)} onSaved={(i) => { setAdding(false); setOpened(i.id) }} />}
    {opened && !adding && <ItemView id={opened} options={options} onClose={() => setOpened(null)} />}
  </div>
}

export function CalibrationPage() {
  const { can } = useAuth()
  const options = useCalibrationOptions()
  const [stored, setTab] = usePersistedState<'plan' | 'scrap' | 'setup'>('qc-calibration:tab', 'plan')
  const setup = can(CALIBRATION_PERMISSIONS.setup)
  const tab = stored === 'setup' && !setup ? 'plan' : stored
  return <div className="space-y-3">
    <Segmented value={tab} onChange={setTab} label="Calibration" options={[
      { value: 'plan', label: 'Calibration plan', icon: <CalendarClock className="h-4 w-4" /> },
      { value: 'scrap', label: 'Scrap log', icon: <Ban className="h-4 w-4" /> },
      ...(setup ? [{ value: 'setup' as const, label: 'Setup', icon: <Settings2 className="h-4 w-4" /> }] : []),
    ]} />
    {tab === 'setup' ? <CalibrationSetup />
      : options.isError ? <p role="alert" className="py-10 text-center text-sm text-danger-600">Could not load calibration’s configuration. <button type="button" className="underline" onClick={() => void options.refetch()}>Retry</button></p>
      : !options.data ? <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
      : <InstrumentList key={tab} view={tab} options={options.data} />}
  </div>
}
