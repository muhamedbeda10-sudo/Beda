// ============================================================================
// §7.7 — the bulk importer: load a CSV or .xlsx, map its columns, preview
// new-vs-update, then import in batches. Nothing is written until Import.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, CheckCircle2, FileDown, FileSpreadsheet, Info, Loader2, Pause, Play, Plus, RotateCcw, UploadCloud } from 'lucide-react'
import { Badge, Button, Card, Field, Select, Stat } from '@/components/ui'
import { existingKeys, importRows } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain'
import { cn, downloadText, parseCSV } from '@/lib/utils'
import { isLegacyExcelFile, isZipFile, readWorkbook, WorkbookReadError, type WorkbookSheet } from '@/lib/xlsx'
import { BATCH_SIZE, coerceCell, csvCell, normaliseHeader, normaliseKeyPart, type CellValue, type Importer } from '@/components/admin/importers'

interface PlannedRow {
  rowNumber: number
  values: Record<string, CellValue>
  mode: 'new' | 'update'
}

interface RowError {
  rowNumber: number
  message: string
}

interface Plan {
  valid: PlannedRow[]
  errors: RowError[]
  newCount: number
  updateCount: number
}

type RunStatus = 'idle' | 'running' | 'paused' | 'done'

export function CsvImporter({ importer }: { importer: Importer }) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)

  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  /** The worksheets of an Excel file; empty for a CSV. */
  const [sheets, setSheets] = useState<WorkbookSheet[]>([])
  const [sheetIndex, setSheetIndex] = useState(0)
  const [headers, setHeaders] = useState<string[]>([])
  const [dataRows, setDataRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Record<string, number>>({})
  const [parseError, setParseError] = useState<string | null>(null)

  const [status, setStatus] = useState<RunStatus>('idle')
  const [written, setWritten] = useState(0)
  const [runTotal, setRunTotal] = useState(0)
  const [runError, setRunError] = useState<string | null>(null)
  const [runResult, setRunResult] = useState({ inserted: 0, updated: 0 })

  /** The business keys that already exist — only ever the keys present in the
   *  file, never the whole table. */
  const [existing, setExisting] = useState<Set<string>>(new Set())
  /** Which lookup the set above answers, so a stale set is never used. */
  const [resolvedFor, setResolvedFor] = useState<string | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const pausedRef = useRef(false)
  const cursorRef = useRef(0)
  const runPlanRef = useRef<PlannedRow[]>([])

  const locked = status === 'running' || status === 'paused'

  const resetRun = useCallback(() => {
    pausedRef.current = false
    cursorRef.current = 0
    runPlanRef.current = []
    setStatus('idle')
    setWritten(0)
    setRunTotal(0)
    setRunError(null)
    setRunResult({ inserted: 0, updated: 0 })
  }, [])

  const autoMap = useCallback(
    (cols: string[]) => {
      const byNorm = new Map<string, number>()
      cols.forEach((c, i) => {
        const n = normaliseHeader(c)
        if (n && !byNorm.has(n)) byNorm.set(n, i)
      })
      const next: Record<string, number> = {}
      for (const f of importer.fields) {
        const candidates = [f.key, f.label, ...(f.aliases ?? [])].map(normaliseHeader)
        const hit = candidates.map((c) => byNorm.get(c)).find((i) => i !== undefined)
        next[f.key] = hit ?? -1
      }
      return next
    },
    [importer],
  )

  /** Takes a header row plus data rows and prepares the column mapping. */
  const applyGrid = useCallback(
    (grid: string[][], emptyMessage: string) => {
      if (grid.length === 0) {
        setHeaders([])
        setDataRows([])
        setMapping({})
        setParseError(emptyMessage)
        return
      }
      const cols = grid[0].map((h) => h.trim())
      const rest = grid.slice(1)
      setHeaders(cols)
      setDataRows(rest)
      setMapping(autoMap(cols))
      if (rest.length === 0) setParseError('The header row was found but there are no data rows under it.')
    },
    [autoMap],
  )

  const loadFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return
      resetRun()
      setParseError(null)
      setSheets([])
      setSheetIndex(0)
      setFileName(file.name)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (isLegacyExcelFile(bytes)) {
          setHeaders([])
          setDataRows([])
          setMapping({})
          setParseError(
            'This is an old binary Excel file (.xls). In Excel choose File → Save As → "Excel Workbook (*.xlsx)" or "CSV UTF-8", then load that file.',
          )
          return
        }
        if (isZipFile(bytes)) {
          // Excel workbook: every worksheet is read; the first one is shown.
          const workbook = readWorkbook(bytes)
          setSheets(workbook.sheets)
          applyGrid(workbook.sheets[0].rows, `The worksheet "${workbook.sheets[0].name}" is empty.`)
          return
        }
        // CSV. Excel writes a byte-order mark at the start of a UTF-8 CSV.
        const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
        applyGrid(parseCSV(text), 'That file has no rows in it.')
      } catch (e) {
        setHeaders([])
        setDataRows([])
        setMapping({})
        setParseError(
          e instanceof WorkbookReadError ? e.message : 'That file could not be read. Save it as CSV UTF-8 or as an .xlsx workbook and try again.',
        )
      }
    },
    [applyGrid, resetRun],
  )

  /** Switches to another worksheet of the loaded workbook. */
  const chooseSheet = useCallback(
    (index: number) => {
      const sheet = sheets[index]
      if (!sheet) return
      resetRun()
      setParseError(null)
      setSheetIndex(index)
      applyGrid(sheet.rows, `The worksheet "${sheet.name}" is empty.`)
    },
    [sheets, applyGrid, resetRun],
  )

  const missingKeys = useMemo(() => importer.businessKeys.filter((k) => (mapping[k] ?? -1) < 0), [importer.businessKeys, mapping])

  /** All parts of the business key, required ones first. */
  const keyParts = useMemo(() => [...importer.businessKeys, ...(importer.optionalKeys ?? [])], [importer.businessKeys, importer.optionalKeys])

  /** The distinct business keys in this file — the only keys the API is asked about. */
  const lookupKeys = useMemo(() => {
    if (missingKeys.length > 0 || dataRows.length === 0) return []
    const seen = new Set<string>()
    for (const row of dataRows) {
      const required = importer.businessKeys.map((k) => (row[mapping[k]] ?? '').trim())
      if (required.some((p) => p === '')) continue
      const optional = (importer.optionalKeys ?? []).map((k) => ((mapping[k] ?? -1) >= 0 ? (row[mapping[k]] ?? '').trim() : ''))
      seen.add([...required, ...optional].join('||'))
    }
    return Array.from(seen)
  }, [dataRows, mapping, importer.businessKeys, importer.optionalKeys, missingKeys])

  /** Identifies one lookup exactly, so the resolved set can never be read
   *  against a different file, mapping or target. */
  const lookupSignature = useMemo(() => `${importer.target}|${lookupKeys.join('')}`, [importer.target, lookupKeys])

  const lookupNeeded = lookupKeys.length > 0
  const resolving = lookupNeeded && lookupError === null && resolvedFor !== lookupSignature

  useEffect(() => {
    if (!lookupNeeded) {
      setExisting(new Set())
      setLookupError(null)
      setResolvedFor(lookupSignature)
      return
    }
    let cancelled = false
    setLookupError(null)
    setResolvedFor(null)
    void (async () => {
      try {
        const found = await existingKeys(importer.target, lookupKeys)
        if (cancelled) return
        setExisting(found)
        setResolvedFor(lookupSignature)
      } catch (e) {
        if (cancelled) return
        // Reporting every row as new would be a lie that duplicates records.
        setExisting(new Set())
        setLookupError(
          e instanceof Error ? `Could not check which records already exist: ${e.message}` : 'Could not check which records already exist.',
        )
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupSignature, lookupNeeded, retryToken])

  /** The dry run. Pure: it computes what WOULD be sent and never writes. */
  const plan = useMemo<Plan | null>(() => {
    if (headers.length === 0 || dataRows.length === 0) return null
    if (missingKeys.length > 0) return null
    // Until the lookup lands, insert-vs-update is unknown — and a preview that
    // guesses is worse than no preview.
    if (resolvedFor !== lookupSignature) return null

    const seenKeys = new Set<string>()
    const valid: PlannedRow[] = []
    const errors: RowError[] = []
    let newCount = 0
    let updateCount = 0

    dataRows.forEach((row, i) => {
      // The header is line 1, so data row i is the line the user sees in their
      // spreadsheet at i + 2. Errors have to point at that line, not at an index.
      const rowNumber = i + 2
      const values: Record<string, CellValue> = {}
      const problems: string[] = []

      for (const f of importer.fields) {
        const col = mapping[f.key] ?? -1
        if (col < 0) continue
        const raw = (row[col] ?? '').trim()
        if (raw === '') continue
        const cell = coerceCell(f, raw)
        if ('error' in cell) problems.push(cell.error)
        else values[f.key] = cell.value
      }

      const derived = importer.derive ? importer.derive(values) : values

      for (const k of importer.businessKeys) {
        if (derived[k] === undefined || String(derived[k]).trim() === '') problems.push(`${k} is empty`)
      }

      if (problems.length > 0) {
        errors.push({ rowNumber, message: problems.join('; ') })
        return
      }

      const key = keyParts.map((k) => normaliseKeyPart(derived[k])).join('||')
      const mode: 'new' | 'update' = existing.has(key) || seenKeys.has(key) ? 'update' : 'new'
      seenKeys.add(key)
      if (mode === 'new') newCount += 1
      else updateCount += 1
      valid.push({ rowNumber, values: derived, mode })
    })

    return { valid, errors, newCount, updateCount }
  }, [headers, dataRows, mapping, missingKeys, importer, keyParts, existing, resolvedFor, lookupSignature])

  const mappedFields = useMemo(() => importer.fields.filter((f) => (mapping[f.key] ?? -1) >= 0), [importer.fields, mapping])

  /**
   * Send in batches, from the cursor onwards. Pausing leaves the cursor where
   * it is, so resuming continues from the next unsent row; a batch that
   * already landed is never sent again.
   */
  async function run() {
    const source = status === 'paused' ? runPlanRef.current : plan?.valid
    if (!source || source.length === 0) return

    if (status !== 'paused') {
      runPlanRef.current = source
      cursorRef.current = 0
      setWritten(0)
      setRunTotal(source.length)
      setRunResult({ inserted: 0, updated: 0 })
    }

    pausedRef.current = false
    setRunError(null)
    setStatus('running')

    try {
      const rows = runPlanRef.current
      while (cursorRef.current < rows.length) {
        if (pausedRef.current) {
          setStatus('paused')
          return
        }
        const chunk = rows.slice(cursorRef.current, cursorRef.current + BATCH_SIZE)
        const result = await importRows(
          queryClient,
          importer.target,
          chunk.map((p) => p.values),
        )
        setRunResult((r) => ({ inserted: r.inserted + result.inserted, updated: r.updated + result.updated }))
        cursorRef.current += chunk.length
        setWritten(cursorRef.current)
      }
      setStatus('done')
      toast(`Imported ${rows.length} row${rows.length === 1 ? '' : 's'}.`, 'success')
    } catch (e) {
      setStatus('paused')
      const done = cursorRef.current
      setRunError(
        `${e instanceof Error ? e.message : 'The import stopped unexpectedly.'} ${done} row${done === 1 ? '' : 's'} already imported — resume to continue from there.`,
      )
    }
  }

  function downloadTemplate() {
    const head = importer.fields.map((f) => csvCell(f.key)).join(',')
    const sample = importer.fields.map((f) => csvCell(f.sample)).join(',')
    downloadText(importer.templateFile, `${head}\n${sample}\n`)
  }

  function clearFile() {
    resetRun()
    setFileName(null)
    setSheets([])
    setSheetIndex(0)
    setHeaders([])
    setDataRows([])
    setMapping({})
    setParseError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const progressPct = runTotal > 0 ? Math.round((written / runTotal) * 100) : 0
  const hasFile = headers.length > 0 && dataRows.length > 0

  return (
    <div className="space-y-4">
      {/* ---- Source file ---- */}
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold">{importer.title}</h3>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{importer.description}</p>
          </div>
          <Button className="min-h-[48px]" onClick={downloadTemplate}>
            <FileDown className="h-4 w-4" /> Download CSV template
          </Button>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!locked) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (locked) return
            void loadFile(e.dataTransfer.files?.[0])
          }}
          className={cn(
            'rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors',
            dragging ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-slate-300 dark:border-slate-700',
            locked && 'opacity-60',
          )}
        >
          <FileSpreadsheet className="mx-auto h-8 w-8 text-slate-300 dark:text-slate-600" />
          <p className="mt-2 text-sm font-semibold">{fileName ?? 'Drop a .csv or .xlsx file here'}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {fileName
              ? [
                  sheets.length > 0 ? `Sheet "${sheets[sheetIndex]?.name ?? ''}"` : null,
                  `${dataRows.length} data row${dataRows.length === 1 ? '' : 's'}`,
                  `${headers.length} column${headers.length === 1 ? '' : 's'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'The first row must contain the column headers.'}
          </p>
          {sheets.length > 1 && (
            <div className="mx-auto mt-3 max-w-xs text-left">
              <Field label="Worksheet" hint="Only the selected worksheet is imported.">
                <Select className="min-h-[48px]" value={String(sheetIndex)} disabled={locked} onChange={(e) => chooseSheet(Number(e.target.value))}>
                  {sheets.map((sh, i) => (
                    <option key={i} value={i}>
                      {sh.name} ({Math.max(0, sh.rows.length - 1)} rows)
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button variant="primary" className="min-h-[48px]" onClick={() => fileRef.current?.click()} disabled={locked}>
              <UploadCloud className="h-4 w-4" /> Browse files
            </Button>
            {fileName && (
              <Button className="min-h-[48px]" onClick={clearFile} disabled={status === 'running'}>
                <RotateCcw className="h-4 w-4" /> Start over
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => {
              void loadFile(e.target.files?.[0])
            }}
          />
        </div>

        {parseError && (
          <p className="flex items-start gap-2 rounded-2xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {parseError}
          </p>
        )}
      </Card>

      {/* ---- Column mapping ---- */}
      {hasFile && (
        <Card className="space-y-4 p-4 sm:p-5">
          <div>
            <h3 className="text-base font-bold">Match your columns</h3>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Columns whose names matched are already selected. The sample under each one comes from the first data row, so you can confirm
              the mapping is right before importing. Anything you don't need can be skipped — a skipped column leaves the stored value alone.
            </p>
          </div>

          {missingKeys.length > 0 && (
            <p className="flex items-start gap-2 rounded-2xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {missingKeys.join(' and ')} {missingKeys.length === 1 ? 'is' : 'are'} how existing records are matched, so{' '}
                {missingKeys.length === 1 ? 'it' : 'they'} must be mapped before this file can be imported.
              </span>
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {importer.fields.map((f) => {
              const col = mapping[f.key] ?? -1
              const isKey = importer.businessKeys.includes(f.key)
              const sample = col >= 0 ? (dataRows[0]?.[col] ?? '').trim() : ''
              return (
                <div key={f.key}>
                  <Field label={isKey ? `${f.label} *` : f.label} hint={col >= 0 ? `Sample: ${sample === '' ? '(empty)' : sample}` : undefined}>
                    <Select
                      className="min-h-[48px]"
                      value={String(col)}
                      disabled={status === 'running'}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        setMapping((m) => ({ ...m, [f.key]: next }))
                        resetRun()
                      }}
                    >
                      <option value="-1">— skip —</option>
                      {headers.map((h, i) => (
                        <option key={`${i}-${h}`} value={String(i)}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {isKey && col < 0 && <p className="mt-1 text-xs font-semibold text-amber-600 dark:text-amber-400">Required — records are matched on this.</p>}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* ---- Looking up only the keys in the file ---- */}
      {hasFile && resolving && (
        <Card className="space-y-3 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-brand-600 dark:text-brand-400" />
            <div className="min-w-0">
              <h3 className="text-base font-bold">Checking which records already exist</h3>
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                Only the {lookupKeys.length} {lookupKeys.length === 1 ? 'key' : 'keys'} in this file are looked up — the rest of the table is
                never read.
              </p>
            </div>
          </div>
        </Card>
      )}

      {hasFile && lookupError && (
        <Card className="space-y-3 p-4 sm:p-5">
          <p className="flex items-start gap-2 rounded-2xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{lookupError} Nothing has been written. Without that check the preview would be wrong, so it is held back until it succeeds.</span>
          </p>
          <Button variant="primary" className="min-h-[48px]" onClick={() => setRetryToken((t) => t + 1)}>
            <RotateCcw className="h-4 w-4" /> Try again
          </Button>
        </Card>
      )}

      {/* ---- Dry run + import ---- */}
      {plan && (
        <Card className="space-y-4 p-4 sm:p-5">
          <div>
            <h3 className="text-base font-bold">Preview — nothing has been written yet</h3>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">This is exactly what pressing Import would do.</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="New records" value={plan.newCount} icon={<Plus className="h-5 w-5" />} tone="green" />
            <Stat label="Would be updated" value={plan.updateCount} sub="Matched on the business key" icon={<RotateCcw className="h-5 w-5" />} tone="blue" />
            <Stat
              label="Rows skipped"
              value={plan.errors.length}
              sub={plan.errors.length > 0 ? 'Listed below with the reason' : 'No problems found'}
              icon={<AlertTriangle className="h-5 w-5" />}
              tone={plan.errors.length > 0 ? 'amber' : 'neutral'}
            />
          </div>

          {plan.valid.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                First {Math.min(5, plan.valid.length)} of {plan.valid.length} mapped rows
              </p>
              <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2.5 font-bold">Row</th>
                      <th className="px-3 py-2.5 font-bold">Action</th>
                      {mappedFields.map((f) => (
                        <th key={f.key} className="px-3 py-2.5 font-bold">
                          {f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {plan.valid.slice(0, 5).map((p) => (
                      <tr key={p.rowNumber}>
                        <td className="px-3 py-2.5 tabular-nums text-slate-400">{p.rowNumber}</td>
                        <td className="px-3 py-2.5">
                          <Badge tone={p.mode === 'new' ? 'green' : 'blue'}>{p.mode === 'new' ? 'New' : 'Update'}</Badge>
                        </td>
                        {mappedFields.map((f) => (
                          <td key={f.key} dir="auto" className="whitespace-nowrap px-3 py-2.5">
                            {p.values[f.key] === undefined ? '—' : String(p.values[f.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {plan.errors.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Rows that will be skipped</p>
              <ul className="max-h-60 space-y-1 overflow-y-auto rounded-2xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-300">
                {plan.errors.slice(0, 25).map((e) => (
                  <li key={e.rowNumber} className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span dir="auto">
                      Row {e.rowNumber}: {e.message}
                    </span>
                  </li>
                ))}
                {plan.errors.length > 25 && <li className="pl-6 text-xs opacity-80">…and {plan.errors.length - 25} more. Every other row still imports.</li>}
              </ul>
            </div>
          )}

          <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            {status !== 'idle' && (
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  <span>
                    {status === 'done' ? 'Import complete' : status === 'paused' ? 'Paused — rows already written will not be written again' : 'Importing…'}
                  </span>
                  <span className="tabular-nums">
                    {written} / {runTotal} ({progressPct}%)
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div
                    role="progressbar"
                    aria-valuenow={progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className={cn('h-full rounded-full transition-all', status === 'done' ? 'bg-emerald-500' : 'bg-brand-600')}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {runError && (
              <p className="flex items-start gap-2 rounded-2xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {runError}
              </p>
            )}

            {status === 'done' && (
              <p className="flex items-start gap-2 rounded-2xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {runResult.inserted} new, {runResult.updated} updated. Importing this same file again would update these records rather than
                  duplicate them.
                </span>
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {status === 'idle' && (
                <Button variant="primary" className="min-h-[48px]" onClick={() => void run()} disabled={plan.valid.length === 0}>
                  <Play className="h-4 w-4" /> Import {plan.valid.length} row{plan.valid.length === 1 ? '' : 's'}
                </Button>
              )}

              {status === 'running' && (
                <>
                  <Button
                    className="min-h-[48px]"
                    onClick={() => {
                      pausedRef.current = true
                    }}
                  >
                    <Pause className="h-4 w-4" /> Pause
                  </Button>
                  <span className="inline-flex items-center gap-2 text-sm text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" /> Sending in batches of {BATCH_SIZE}…
                  </span>
                </>
              )}

              {status === 'paused' && (
                <>
                  <Button variant="primary" className="min-h-[48px]" onClick={() => void run()}>
                    <Play className="h-4 w-4" /> Resume from row {written + 1}
                  </Button>
                  <Button className="min-h-[48px]" onClick={resetRun}>
                    <RotateCcw className="h-4 w-4" /> Discard the rest
                  </Button>
                </>
              )}

              {status === 'done' && (
                <Button className="min-h-[48px]" onClick={clearFile}>
                  <UploadCloud className="h-4 w-4" /> Import another file
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {hasFile && !plan && missingKeys.length > 0 && (
        <Card className="p-5">
          <p className="flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            Map {missingKeys.join(' and ')} above to see what this file would change.
          </p>
        </Card>
      )}
    </div>
  )
}
