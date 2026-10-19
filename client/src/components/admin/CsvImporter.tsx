// ============================================================================
// §7.7 — the bulk importer: load a CSV or .xlsx, map its columns, preview
// new-vs-update, then import in batches. Nothing is written until Import.
// Where the API compares (orders, the production record), the preview also
// tells the rows that would change nothing, and only the rest are sent: the
// same file imported twice writes nothing the second time.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, FileDown, FileSpreadsheet, Info, Loader2, Pause, Play, Plus, RotateCcw, UploadCloud } from 'lucide-react'
import { Badge, Button, Card, Field, Select, Stat } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { compareImportRows, existingKeys, importRows, refreshAfterImport } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { PHONE, useMediaQuery } from '@/lib/media'
import { cn, downloadText, parseCSV } from '@/lib/utils'
import { isLegacyExcelFile, isZipFile, readWorkbook, WorkbookReadError, type WorkbookSheet } from '@/lib/xlsx'
import { useAuth } from '@/store/AuthContext'
import { BATCH_SIZE, coerceCell, csvCell, normaliseHeader, normaliseKeyPart, type CellValue, type ImportField, type Importer } from '@/components/admin/importers'

interface PlannedRow {
  rowNumber: number
  /** The business key as the API spells it back: normalised parts joined by '||'. */
  key: string
  values: Record<string, CellValue>
  /** 'same': matched a stored record and would change nothing in it (known only where the API compares). */
  mode: 'new' | 'update' | 'same'
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

/** The plan as the preview shows it and Import sends it: where the API compares, the unchanged rows are told apart and left out. */
interface View extends Plan {
  sameCount: number
  /** What Import sends: every valid row, or (comparing) only those that change something. */
  toSend: PlannedRow[]
}

/** The API's answer for a plan, as it comes in batch by batch. */
interface Comparison {
  plan: Plan
  done: number
  fresh: Set<string>
  changed: Set<string>
  error: string | null
  complete: boolean
}

type RunStatus = 'idle' | 'running' | 'paused' | 'done'

export function CsvImporter({ importer }: { importer: Importer }) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const { factoryTimeZone } = useAuth()
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
  /** The mapping laid out field by field. Folded to one line when every column matched by name, as the ERP's export
   *  does: seventeen selects were three screens of a phone before the preview. Opened by hand, or by a column missing. */
  const [mappingOpen, setMappingOpen] = useState(false)
  // On a phone the preview rows are cards (the row, what happens to it, its first fields); from 640 px the table.
  const phone = useMediaQuery(PHONE)

  const [status, setStatus] = useState<RunStatus>('idle')
  const [written, setWritten] = useState(0)
  const [runTotal, setRunTotal] = useState(0)
  const [runError, setRunError] = useState<string | null>(null)
  const [runResult, setRunResult] = useState({ inserted: 0, updated: 0, unchanged: 0 })
  const batchSize = importer.batchSize ?? BATCH_SIZE

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
    setRunResult({ inserted: 0, updated: 0, unchanged: 0 })
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
      const mapped = autoMap(cols)
      setHeaders(cols)
      setDataRows(rest)
      setMapping(mapped)
      setMappingOpen(importer.fields.some((f) => mapped[f.key] < 0))
      if (rest.length === 0) setParseError('The header row was found but there are no data rows under it.')
    },
    [autoMap, importer.fields],
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
        if (raw === '') {
          // Left out, the stored value stays; null clears it (the ERP removed it).
          if (f.clearsWhenEmpty) values[f.key] = null
          continue
        }
        const cell = coerceCell(f, raw, factoryTimeZone)
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
      valid.push({ rowNumber, key, values: derived, mode })
    })

    return { valid, errors, newCount, updateCount }
  }, [headers, dataRows, mapping, missingKeys, importer, keyParts, existing, resolvedFor, lookupSignature, factoryTimeZone])

  // Where the API compares: the plan's rows sent to /import/compare in batches (nothing is written), so the preview
  // knows which rows change nothing. A new plan (another file, sheet or mapping) starts again.
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [compareToken, setCompareToken] = useState(0)
  useEffect(() => {
    if (!importer.compares || !plan || plan.valid.length === 0) {
      setComparison(null)
      return
    }
    let cancelled = false
    const fresh = new Set<string>()
    const changed = new Set<string>()
    setComparison({ plan, done: 0, fresh, changed, error: null, complete: false })
    void (async () => {
      try {
        for (let i = 0; i < plan.valid.length; i += batchSize) {
          const answer = await compareImportRows(
            importer.target,
            plan.valid.slice(i, i + batchSize).map((p) => p.values),
          )
          if (cancelled) return
          for (const k of answer.new) fresh.add(k)
          for (const k of answer.changed) changed.add(k)
          setComparison({ plan, done: Math.min(plan.valid.length, i + batchSize), fresh, changed, error: null, complete: false })
        }
        if (!cancelled) setComparison({ plan, done: plan.valid.length, fresh, changed, error: null, complete: true })
      } catch (e) {
        if (cancelled) return
        setComparison({
          plan,
          done: 0,
          fresh,
          changed,
          error: e instanceof Error ? `Could not compare the file with what is stored: ${e.message}` : 'Could not compare the file with what is stored.',
          complete: false,
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [plan, importer, batchSize, compareToken])
  const comparing = !!importer.compares && !!plan && plan.valid.length > 0 && !(comparison?.plan === plan && (comparison.complete || comparison.error))
  const compareError = importer.compares && comparison?.plan === plan ? comparison.error : null

  /** What the preview shows and Import sends. Held back while the comparison runs: a preview that guesses is worse than none. */
  const view = useMemo<View | null>(() => {
    if (!plan) return null
    if (!importer.compares || plan.valid.length === 0) return { ...plan, sameCount: 0, toSend: plan.valid }
    if (comparison?.plan !== plan || !comparison.complete) return null
    let newCount = 0
    let updateCount = 0
    let sameCount = 0
    const valid = plan.valid.map((p): PlannedRow => {
      const mode = comparison.fresh.has(p.key) ? 'new' : comparison.changed.has(p.key) ? 'update' : 'same'
      if (mode === 'new') newCount += 1
      else if (mode === 'update') updateCount += 1
      else sameCount += 1
      return { ...p, mode }
    })
    return { valid, errors: plan.errors, newCount, updateCount, sameCount, toSend: valid.filter((p) => p.mode !== 'same') }
  }, [plan, importer.compares, comparison])

  const mappedFields = useMemo(() => importer.fields.filter((f) => (mapping[f.key] ?? -1) >= 0), [importer.fields, mapping])
  /** The template's header for a field: the ERP's own column name where the importer has one (templateHeaders), else the key. */
  const templateHeader = (f: ImportField) => importer.templateHeaders?.[f.key] ?? f.key

  /**
   * Send in batches, from the cursor onwards. Pausing leaves the cursor where
   * it is, so resuming continues from the next unsent row; a batch that
   * already landed is never sent again.
   */
  async function run() {
    const source = status === 'paused' ? runPlanRef.current : view?.toSend
    if (!source || source.length === 0) return

    if (status !== 'paused') {
      runPlanRef.current = source
      cursorRef.current = 0
      setWritten(0)
      setRunTotal(source.length)
      setRunResult({ inserted: 0, updated: 0, unchanged: 0 })
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
        const chunk = rows.slice(cursorRef.current, cursorRef.current + batchSize)
        const result = await importRows(
          importer.target,
          chunk.map((p) => p.values),
        )
        setRunResult((r) => ({ inserted: r.inserted + result.inserted, updated: r.updated + result.updated, unchanged: r.unchanged + (result.unchanged ?? 0) }))
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
    } finally {
      // Once, whether it finished, paused or stopped: the lists and figures show what was written.
      void refreshAfterImport(queryClient, importer.target)
    }
  }

  function downloadTemplate() {
    const head = importer.fields.map((f) => csvCell(templateHeader(f))).join(',')
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
    setMappingOpen(false)
    setParseError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const progressPct = runTotal > 0 ? Math.round((written / runTotal) * 100) : 0
  const hasFile = headers.length > 0 && dataRows.length > 0

  return (
    <div className="space-y-4">
      {/* ---- Source file ---- */}
      <Card className="space-y-4 p-4 sm:p-5">
        {/* The template beside what it is for, however long the description: the text takes the room left. */}
        <div className="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold">{importer.title}</h3>
            <p className="mt-0.5 max-w-4xl text-sm text-muted">{importer.description}</p>
          </div>
          <Button className="min-h-[48px] shrink-0" onClick={downloadTemplate}>
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
          <p className="mt-0.5 text-xs text-muted">
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-bold">
                {mappingOpen ? 'Match your columns' : `Columns matched: ${mappedFields.length}/${importer.fields.length}`}
              </h3>
              <p className="mt-0.5 text-sm text-muted">
                {mappingOpen
                  ? "Columns whose names matched are already selected. The sample under each one comes from the first data row, so you can confirm the mapping is right before importing. Anything you don't need can be skipped — a skipped column leaves the stored value alone."
                  : 'Every column was found by its name. Open the mapping to check a sample of each, or to skip one.'}
              </p>
            </div>
            <Button className="min-h-[44px]" onClick={() => setMappingOpen((o) => !o)} aria-expanded={mappingOpen}>
              <ChevronDown className={cn('h-4 w-4 transition-transform', mappingOpen && 'rotate-180')} /> {mappingOpen ? 'Fold' : 'Change'}
            </Button>
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

          {mappingOpen && (
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
          )}
        </Card>
      )}

      {/* ---- Looking up only the keys in the file ---- */}
      {hasFile && resolving && (
        <Card className="space-y-3 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-brand-600 dark:text-brand-400" />
            <div className="min-w-0">
              <h3 className="text-base font-bold">Checking which records already exist</h3>
              <p className="mt-0.5 text-sm text-muted">
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

      {/* ---- Comparing the file with what is stored (orders, the production record) ---- */}
      {hasFile && comparing && !compareError && (
        <Card className="space-y-3 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-brand-600 dark:text-brand-400" />
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold">Comparing the file with what is stored</h3>
              <p className="mt-0.5 text-sm text-muted">
                {(comparison?.plan === plan ? comparison.done : 0).toLocaleString('en-US')} of {(plan?.valid.length ?? 0).toLocaleString('en-US')} rows
                checked. Nothing is written: only the rows that change something will be sent.
              </p>
            </div>
          </div>
        </Card>
      )}

      {hasFile && compareError && (
        <Card className="space-y-3 p-4 sm:p-5">
          <p className="flex items-start gap-2 rounded-2xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{compareError} Nothing has been written.</span>
          </p>
          <Button variant="primary" className="min-h-[48px]" onClick={() => setCompareToken((t) => t + 1)}>
            <RotateCcw className="h-4 w-4" /> Try again
          </Button>
        </Card>
      )}

      {/* ---- Dry run + import ---- */}
      {view && (
        <Card className="space-y-4 p-4 sm:p-5">
          <div>
            <h3 className="text-base font-bold">Preview — nothing has been written yet</h3>
            <p className="mt-0.5 text-sm text-muted">This is exactly what pressing Import would do.</p>
          </div>

          <div className={cn('grid gap-2 sm:gap-3', importer.compares ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3')}>
            <Stat compact label="New" value={view.newCount} icon={<Plus className="h-5 w-5" />} tone="green" />
            <Stat
              compact
              label="Updated"
              value={view.updateCount}
              sub={importer.compares ? 'Something in them changed' : 'Matched on the business key'}
              icon={<RotateCcw className="h-5 w-5" />}
              tone="blue"
            />
            {importer.compares && (
              <Stat compact label="Unchanged" value={view.sameCount} sub="Already as in the file: not sent" icon={<CheckCircle2 className="h-5 w-5" />} tone="neutral" />
            )}
            <Stat
              compact
              label="Skipped"
              value={view.errors.length}
              sub={view.errors.length > 0 ? 'Listed below with the reason' : 'No problems found'}
              icon={<AlertTriangle className="h-5 w-5" />}
              tone={view.errors.length > 0 ? 'amber' : 'neutral'}
            />
          </div>

          {view.valid.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
                First {Math.min(5, view.valid.length)} of {view.valid.length} mapped rows
              </p>
              {phone ? (
                <ul className="space-y-2">
                  {view.valid.slice(0, 5).map((p) => (
                    <li key={p.rowNumber} className="rounded-2xl p-3 ring-1 ring-slate-200 dark:ring-slate-800">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-muted">Row {p.rowNumber}</span>
                        <ModeBadge mode={p.mode} />
                      </div>
                      <dl className="mt-1.5 space-y-0.5 text-sm">
                        {mappedFields.slice(0, 4).map((f) => (
                          <div key={f.key} className="flex gap-2">
                            <dt className="w-[7rem] shrink-0 truncate text-xs leading-5 text-muted">{f.label}</dt>
                            <dd dir="auto" className="min-w-0 flex-1 break-words">
                              {p.values[f.key] == null ? '—' : String(p.values[f.key])}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {mappedFields.length > 4 && <p className="mt-1 text-xs text-muted">and {mappedFields.length - 4} more columns</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <ScrollX className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800" innerClassName="rounded-2xl" label="Preview rows">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
                      <tr>
                        <th className="px-3 py-2.5 font-bold">Row</th>
                        <th className="px-3 py-2.5 font-bold">Action</th>
                        {mappedFields.map((f) => (
                          <th key={f.key} className="whitespace-nowrap px-3 py-2.5 font-bold">
                            {f.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {view.valid.slice(0, 5).map((p) => (
                        <tr key={p.rowNumber}>
                          <td className="px-3 py-2.5 tabular-nums text-muted">{p.rowNumber}</td>
                          <td className="px-3 py-2.5">
                            <ModeBadge mode={p.mode} />
                          </td>
                          {mappedFields.map((f) => (
                            <td key={f.key} dir="auto" className="whitespace-nowrap px-3 py-2.5">
                              {p.values[f.key] == null ? '—' : String(p.values[f.key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollX>
              )}
            </div>
          )}

          {view.errors.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Rows that will be skipped</p>
              <ul className="max-h-60 space-y-1 overflow-y-auto rounded-2xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-300">
                {view.errors.slice(0, 25).map((e) => (
                  <li key={e.rowNumber} className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span dir="auto">
                      Row {e.rowNumber}: {e.message}
                    </span>
                  </li>
                ))}
                {view.errors.length > 25 && <li className="pl-6 text-xs opacity-80">…and {view.errors.length - 25} more. Every other row still imports.</li>}
              </ul>
            </div>
          )}

          {/* Sticky at the foot of the window while the card is on screen: Import is reachable without scrolling past
              the preview and the skipped rows. The card's rounding is kept by the negative margins and the bar's own. */}
          <div className="sticky bottom-0 -mx-4 -mb-4 space-y-3 rounded-b-2xl border-t border-slate-100 bg-white/95 px-4 pb-4 pt-3 backdrop-blur safe-bottom sm:-mx-5 sm:-mb-5 sm:px-5 sm:pb-5 dark:border-slate-800 dark:bg-slate-900/95">
            {status !== 'idle' && (
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-semibold text-muted">
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
                  {runResult.inserted} new, {runResult.updated} updated
                  {view.sameCount + runResult.unchanged > 0 ? `, ${view.sameCount + runResult.unchanged} unchanged` : ''}. Importing this same file
                  again would update these records rather than duplicate them.
                </span>
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {status === 'idle' && (
                view.toSend.length === 0 && view.valid.length > 0 ? (
                  <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-4 w-4" /> Nothing to import: every row is already as in the file.
                  </p>
                ) : (
                  <Button variant="primary" className="min-h-[48px]" onClick={() => void run()} disabled={view.toSend.length === 0}>
                    <Play className="h-4 w-4" /> Import {view.toSend.length} row{view.toSend.length === 1 ? '' : 's'}
                  </Button>
                )
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
                  <span className="inline-flex items-center gap-2 text-sm text-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Sending in batches of {batchSize}…
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
          <p className="flex items-start gap-2 text-sm text-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            Map {missingKeys.join(' and ')} above to see what this file would change.
          </p>
        </Card>
      )}
    </div>
  )
}

/** What Import does with a row: adds it, changes it, or (comparing) leaves it as it is. */
function ModeBadge({ mode }: { mode: PlannedRow['mode'] }) {
  if (mode === 'new') return <Badge tone="green">New</Badge>
  if (mode === 'update') return <Badge tone="blue">Update</Badge>
  return <Badge tone="neutral">Unchanged</Badge>
}
