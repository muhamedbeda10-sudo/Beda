// ============================================================================
// §26 — The Lab: the tensile testing machine's log, newest first, with each
// test's report behind it; New test for whoever records them; Setup (the
// grades and their limits, the lists, importing the old log) for whoever
// sets the lab up.
// ============================================================================

import { useState } from 'react'
import { FlaskConical, Loader2, Plus, Settings2, Table2 } from 'lucide-react'
import { LAB_PERMISSIONS, LAB_SPECIMENS, LAB_VERDICT_NAMES, variance, type LabTest, type LabTestListQuery, type LabVerdict } from '@qc/shared/lab'
import { Badge, Button, Card, EmptyState, Field, Input } from '@/components/ui'
import { ExportMenu, FilterBar, FilterSelect, Segmented } from '@/components/ui/PageShell'
import { ScrollX } from '@/components/ui/ScrollX'
import { LabTestDialog, verdictTone } from '@/components/lab/LabTestDialog'
import { LabTestView } from '@/components/lab/LabTestView'
import { LabSetup } from '@/components/lab/LabSetup'
import { OutMark, sheetDay } from '@/components/lab/LabSheet'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { usePersistedState } from '@/lib/usePersistedState'
import { fetchAllLabTests, useLabTests } from '@/services/lab'
import { useDebounced } from '@/services/queries'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'

const PAGE = 50
/** A figure as the log shows it: one decimal, as the workbook did. */
const n = (v: number | null) => (v === null ? '' : String(Number(v.toFixed(1))))

/** The log's columns, as the workbook heads them. */
const COLUMNS: { label: string; value: (t: LabTest) => string | number | null; numeric?: boolean }[] = [
  { label: 'No.', value: (t) => t.reference },
  { label: 'Date', value: (t) => t.testDate },
  { label: 'Bolt/Sheet', value: (t) => t.specimenType },
  { label: 'Grade', value: (t) => t.grade },
  { label: 'Dimensions', value: (t) => t.size },
  { label: 'Batch No.', value: (t) => t.specimenCode },
  { label: 'RM N/mm²', value: (t) => t.tensileAvg, numeric: true },
  { label: 'REH N/mm²', value: (t) => t.yieldAvg, numeric: true },
  { label: 'A %', value: (t) => t.elongationAvg, numeric: true },
  { label: 'Hardness', value: (t) => t.hardness, numeric: true },
  { label: 'Certificate', value: (t) => t.certificate },
  { label: 'CUS No.', value: (t) => t.cusNo },
  { label: 'Supplier', value: (t) => t.supplier },
  { label: 'Tested by', value: (t) => t.testedBy },
  { label: 'MTC RM', value: (t) => t.mtcTensile, numeric: true },
  { label: 'MTC REH', value: (t) => t.mtcYield, numeric: true },
  { label: 'MTC A', value: (t) => t.mtcElongation, numeric: true },
  { label: 'RM Variance', value: (t) => variance(t.tensileAvg, t.mtcTensile), numeric: true },
  { label: 'Yield Variance', value: (t) => variance(t.yieldAvg, t.mtcYield), numeric: true },
  { label: 'Elongation Variance', value: (t) => variance(t.elongationAvg, t.mtcElongation), numeric: true },
  { label: 'Result', value: (t) => LAB_VERDICT_NAMES[t.result] },
  { label: 'Notes', value: (t) => t.notes },
]

function LabLog() {
  const { can } = useAuth()
  const { toast } = useApp()
  const [search, setSearch] = useState('')
  const [specimenType, setSpecimenType] = useState('')
  const [result, setResult] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState<LabTest | 'new' | null>(null)
  const [openedId, setOpenedId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const query: LabTestListQuery = { q: useDebounced(search, 250) || undefined, specimenType: specimenType || undefined, result: result || undefined, from: from || undefined, to: to || undefined }
  const list = useLabTests({ ...query, offset, limit: PAGE })
  const change = (setter: (v: string) => void) => (v: string) => { setter(v); setOffset(0) }
  const reset = () => { setSearch(''); setSpecimenType(''); setResult(''); setFrom(''); setTo(''); setOffset(0) }
  const chips = [
    ...(specimenType ? [{ key: 'type', label: specimenType, onRemove: () => change(setSpecimenType)('') }] : []),
    ...(result ? [{ key: 'result', label: LAB_VERDICT_NAMES[result as LabVerdict], onRemove: () => change(setResult)('') }] : []),
    ...(from ? [{ key: 'from', label: `From: ${from}`, onRemove: () => change(setFrom)('') }] : []),
    ...(to ? [{ key: 'to', label: `To: ${to}`, onRemove: () => change(setTo)('') }] : []),
  ]

  async function exportLog() {
    setExporting(true)
    try {
      const all = await fetchAllLabTests(query)
      downloadWorkbook(`Tensile Test Machine Log ${new Date().toISOString().slice(0, 10)}`, [{ name: 'Log', header: COLUMNS.map((c) => c.label), rows: all.tests.map((t) => COLUMNS.map((c) => c.value(t))) }])
      if (all.total > all.tests.length) toast(`The first ${all.tests.length.toLocaleString()} of ${all.total.toLocaleString()} tests were exported: narrow the dates for the rest.`, 'info')
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not export.', 'error') }
    finally { setExporting(false) }
  }

  return <div className="space-y-3">
    <FilterBar search={{ value: search, onChange: change(setSearch), placeholder: 'Number, coil or batch, grade, certificate…', label: 'Search the lab log' }}
      filters={<>
        <FilterSelect label="Specimen" value={specimenType} onChange={change(setSpecimenType)}><option value="">All specimens</option>{LAB_SPECIMENS.map((s) => <option key={s}>{s}</option>)}</FilterSelect>
        <FilterSelect label="Result" value={result} onChange={change(setResult)}><option value="">All results</option>{(Object.keys(LAB_VERDICT_NAMES) as LabVerdict[]).map((r) => <option key={r} value={r}>{LAB_VERDICT_NAMES[r]}</option>)}</FilterSelect>
      </>}
      more={<><Field label="From date"><Input type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} /></Field><Field label="To date"><Input type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} /></Field></>}
      moreCount={Number(!!from) + Number(!!to)} chips={chips} onReset={reset} canReset={!!(search || chips.length)}
      actions={<>
        <ExportMenu busy={exporting} items={[{ label: 'Export to Excel', onClick: () => void exportLog(), disabled: !list.data?.total }]} />
        {can(LAB_PERMISSIONS.record) && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />New test</Button>}
      </>} />
    {list.isPending ? <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
      : list.isError ? <p role="alert" className="py-10 text-center text-sm text-danger-600">{list.error.message} <button type="button" className="underline" onClick={() => void list.refetch()}>Retry</button></p>
      : !list.data.tests.length ? <EmptyState icon={<FlaskConical className="h-10 w-10" />} title="No tests found" />
      : <Card className="overflow-hidden"><ScrollX label="Tensile testing machine log"><table className="w-full min-w-[1100px] text-left text-sm">
        <thead className="bg-yellow-300 text-xs font-bold text-slate-900"><tr>
          {['No.', 'Date', 'Bolt/Sheet', 'Grade', 'Dimensions', 'Batch No.', 'RM', 'REH', 'A %', 'Hardness', 'Certificate', 'MTC RM / REH / A', 'Variance', 'Result', ''].map((label, i) =>
            <th key={i} scope="col" className="whitespace-nowrap px-3 py-2.5">{label || <span className="sr-only">Open the report</span>}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{list.data.tests.map((t) => {
          const v = [variance(t.tensileAvg, t.mtcTensile), variance(t.yieldAvg, t.mtcYield), variance(t.elongationAvg, t.mtcElongation)]
          const cellTone = (ok: boolean | null) => cn('whitespace-nowrap px-3 py-2.5 text-right tabular-nums', ok === false && 'font-semibold text-danger-700 dark:text-danger-400')
          return <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
            <td className="whitespace-nowrap px-3 py-2.5 font-semibold">{t.reference}</td>
            <td className="whitespace-nowrap px-3 py-2.5">{sheetDay(t.testDate)}</td>
            <td className="whitespace-nowrap px-3 py-2.5">{t.specimenType}</td>
            <td dir="auto" className="whitespace-nowrap px-3 py-2.5">{t.grade || '—'}</td>
            <td dir="auto" className="whitespace-nowrap px-3 py-2.5">{t.size || '—'}</td>
            <td dir="auto" className="whitespace-nowrap px-3 py-2.5">{t.specimenCode || '—'}{t.coilFound && <span className="ms-1 text-xs text-muted">(coil)</span>}</td>
            <td className={cellTone(t.tensileOk)}>{n(t.tensileAvg)}<OutMark ok={t.tensileOk} /></td>
            <td className={cellTone(t.yieldOk)}>{n(t.yieldAvg)}<OutMark ok={t.yieldOk} /></td>
            <td className={cellTone(t.elongationOk)}>{n(t.elongationAvg)}<OutMark ok={t.elongationOk} /></td>
            <td className="px-3 py-2.5 text-right tabular-nums">{n(t.hardness)}</td>
            <td dir="auto" className="max-w-48 truncate px-3 py-2.5" title={t.certificate}>{t.certificate || '—'}</td>
            <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{[t.mtcTensile, t.mtcYield, t.mtcElongation].some((x) => x !== null) ? [t.mtcTensile, t.mtcYield, t.mtcElongation].map((x) => n(x) || '—').join(' / ') : '—'}</td>
            <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{v.some((x) => x !== null) ? v.map((x) => (x === null ? '—' : `${x > 0 ? '+' : ''}${n(x)}`)).join(' / ') : '—'}</td>
            <td className="px-3 py-2.5"><Badge tone={verdictTone(t.result)}>{LAB_VERDICT_NAMES[t.result]}</Badge></td>
            <td className="px-3 py-2.5"><Button aria-label={`Open test ${t.reference}`} onClick={() => setOpenedId(t.id)}>Open</Button></td>
          </tr>
        })}</tbody>
      </table></ScrollX></Card>}
    {list.data && <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted"><span>{list.data.total.toLocaleString()} tests</span><div className="flex gap-2"><Button disabled={!offset || list.isFetching} onClick={() => setOffset((x) => Math.max(0, x - PAGE))}>Previous</Button><Button disabled={!list.data.hasMore || list.isFetching} onClick={() => setOffset((x) => x + PAGE)}>Next</Button></div></div>}
    {editing && <LabTestDialog key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`} test={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(t) => { setEditing(null); setOpenedId(t.id); setOffset(0) }} />}
    {openedId && !editing && <LabTestView id={openedId} onClose={() => setOpenedId(null)} onEdit={setEditing} />}
  </div>
}

export function LabPage() {
  const { can } = useAuth()
  const [stored, setTab] = usePersistedState<'log' | 'setup'>('qc-lab:tab', 'log')
  const setup = can(LAB_PERMISSIONS.setup)
  const tab = setup ? stored : 'log'
  return <div className="space-y-3">
    {setup && <Segmented value={tab} onChange={setTab} label="Lab" options={[{ value: 'log', label: 'Machine log', icon: <Table2 className="h-4 w-4" /> }, { value: 'setup', label: 'Setup', icon: <Settings2 className="h-4 w-4" /> }]} />}
    {tab === 'setup' ? <LabSetup /> : <LabLog />}
  </div>
}
