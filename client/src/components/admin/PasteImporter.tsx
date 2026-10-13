import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ClipboardPaste, Eraser, Loader2, Plus, Trash2, UploadCloud, CheckCircle2 } from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { existingKeys, importRows } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { BATCH_SIZE, coerceCell, normaliseHeader, normaliseKeyPart, type CellValue, type ImportField, type Importer } from '@/components/admin/importers'

/**
 * §7.7 — an Excel-like grid with the importer's columns already in place.
 * Copy the cells in the spreadsheet, click the grid, paste: the rows land
 * under the right headings with nothing to map. Rows can also be typed or
 * corrected in place. Import is the same idempotent upsert the file importer
 * uses, in the same batches, so a grid of five rows and one of five hundred
 * behave identically.
 */
export function PasteImporter({ importer }: { importer: Importer }) {
  const queryClient = useQueryClient()
  const { toast } = useApp()
  const fields = importer.fields
  const [rows, setRows] = useState<string[][]>([])
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [written, setWritten] = useState(0)
  const [result, setResult] = useState({ inserted: 0, updated: 0 })
  const [runError, setRunError] = useState<string | null>(null)
  const [existing, setExisting] = useState<Set<string>>(new Set())
  const [resolvedFor, setResolvedFor] = useState<string>('')
  const [lookupError, setLookupError] = useState<string | null>(null)
  const gridRef = useRef<HTMLTableElement>(null)

  const keyParts = useMemo(() => [...importer.businessKeys, ...(importer.optionalKeys ?? [])], [importer])

  /** The rows as the API will receive them, with their problems. */
  const plan = useMemo(() => planRows(rows, importer, keyParts, existing), [rows, importer, keyParts, existing])

  const lookupKeys = useMemo(() => Array.from(new Set(plan.valid.map((r) => r.key))), [plan.valid])
  const lookupSignature = `${importer.target}|${lookupKeys.join('')}`

  // Ask the API which keys exist so the preview says new-vs-update truthfully.
  useEffect(() => {
    if (lookupKeys.length === 0) {
      setExisting(new Set())
      setResolvedFor(lookupSignature)
      return
    }
    let cancelled = false
    setLookupError(null)
    void (async () => {
      try {
        const found = await existingKeys(importer.target, lookupKeys)
        if (cancelled) return
        setExisting(found)
        setResolvedFor(lookupSignature)
      } catch (e) {
        if (cancelled) return
        setLookupError(e instanceof Error ? e.message : 'Could not check which rows already exist.')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupSignature])

  const resolved = resolvedFor === lookupSignature && lookupError === null
  const newCount = plan.valid.filter((r) => r.mode === 'new').length
  const updateCount = plan.valid.length - newCount

  function setCell(r: number, c: number, value: string) {
    setRows((cur) => {
      const next = cur.map((row) => [...row])
      while (next.length <= r) next.push(fields.map(() => ''))
      next[r][c] = value
      return next
    })
    if (status === 'done') setStatus('idle')
  }

  /** Paste starting at the focused cell, or below everything when none is focused. */
  function onPaste(e: ClipboardEvent<HTMLElement>) {
    const text = e.clipboardData.getData('text/plain')
    if (!text.includes('\n') && !text.includes('\t')) return // a single cell: let the input take it
    e.preventDefault()
    let grid = parseClipboardGrid(text)
    if (grid.length > 0 && looksLikeHeader(grid[0], fields)) grid = grid.slice(1)
    if (grid.length === 0) return
    const target = e.target as HTMLElement
    const startRow = Number(target.dataset?.row ?? NaN)
    const startCol = Number(target.dataset?.col ?? NaN)
    setRows((cur) => {
      const next = cur.map((row) => [...row])
      const r0 = Number.isFinite(startRow) ? startRow : next.length
      const c0 = Number.isFinite(startCol) ? startCol : 0
      grid.forEach((line, i) => {
        const r = r0 + i
        while (next.length <= r) next.push(fields.map(() => ''))
        line.forEach((cell, j) => {
          const c = c0 + j
          if (c < fields.length) next[r][c] = cell
        })
      })
      return next
    })
    setStatus('idle')
    setRunError(null)
  }

  async function run() {
    if (plan.valid.length === 0) return
    setStatus('running')
    setWritten(0)
    setResult({ inserted: 0, updated: 0 })
    setRunError(null)
    try {
      const all = plan.valid.map((r) => r.values)
      for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const chunk = all.slice(i, i + BATCH_SIZE)
        const res = await importRows(queryClient, importer.target, chunk)
        setResult((r) => ({ inserted: r.inserted + res.inserted, updated: r.updated + res.updated }))
        setWritten(Math.min(all.length, i + chunk.length))
      }
      setStatus('done')
      toast(`Imported ${all.length} row${all.length === 1 ? '' : 's'}.`, 'success')
      setRows([])
    } catch (e) {
      // Every batch that landed is in; the same rows can be imported again
      // safely because the upsert matches on the business key.
      setStatus('idle')
      setRunError(e instanceof Error ? e.message : 'The import stopped unexpectedly. The rows already written are in; press Import to continue.')
    }
  }

  const visibleRows = rows.length === 0 ? [fields.map(() => '')] : [...rows, fields.map(() => '')]
  const busy = status === 'running'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-start gap-2 text-sm text-muted">
          <ClipboardPaste className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
          <span>Copy the cells in Excel, click a cell below, and paste. A pasted header row is recognised and skipped.</span>
        </p>
        <div className="flex gap-2">
          <Button className="min-h-[40px]" disabled={busy} onClick={() => setRows((cur) => [...cur, fields.map(() => '')])}>
            <Plus className="h-4 w-4" /> Row
          </Button>
          <Button className="min-h-[40px]" disabled={busy || rows.length === 0} onClick={() => setRows([])}>
            <Eraser className="h-4 w-4" /> Clear
          </Button>
        </div>
      </div>

      <ScrollX className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800" innerClassName="rounded-2xl">
        <table ref={gridRef} onPaste={onPaste} className="w-full min-w-[40rem] border-collapse text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
            <tr>
              <th className="w-10 px-2 py-2 text-center font-bold text-muted">#</th>
              {fields.map((f) => (
                <th key={f.key} className="px-2 py-2 font-bold">
                  {f.label}
                  {importer.businessKeys.includes(f.key) && <span className="text-rose-500"> *</span>}
                </th>
              ))}
              <th className="w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {visibleRows.map((row, r) => {
              const problems = plan.problems.get(r)
              const isGhost = r >= rows.length
              return (
                <tr key={r} className={cn(problems && 'bg-rose-50/60 dark:bg-rose-500/5', isGhost && 'opacity-70')}>
                  <td className="px-2 py-1 text-center text-xs tabular-nums text-muted">{isGhost ? '+' : r + 1}</td>
                  {fields.map((f, c) => (
                    <td key={f.key} className="p-0.5">
                      <input
                        data-row={r}
                        data-col={c}
                        value={row[c] ?? ''}
                        disabled={busy}
                        placeholder={isGhost ? f.sample || '' : ''}
                        inputMode={f.kind === 'number' ? 'decimal' : undefined}
                        onChange={(e) => setCell(r, c, e.target.value)}
                        // A cell is 38 px tall under a mouse and 44 px under a finger.
                        className={cn(
                          'w-full min-w-[7rem] rounded-lg border border-transparent bg-transparent px-2 py-2 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/25 dark:focus:bg-slate-800 touch:min-h-[44px]',
                          problems?.cols.has(f.key) && 'border-rose-300 bg-rose-50 dark:bg-rose-500/10',
                        )}
                        aria-label={`${f.label}, row ${r + 1}`}
                      />
                    </td>
                  ))}
                  <td className="px-1 text-center">
                    {!isGhost && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setRows((cur) => cur.filter((_, i) => i !== r))}
                        className="grid h-10 w-10 place-items-center rounded-lg text-slate-300 hover:text-rose-500"
                        aria-label={`Remove row ${r + 1}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </ScrollX>

      {plan.problems.size > 0 && (
        <p className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {plan.problems.size} row{plan.problems.size === 1 ? '' : 's'} will be skipped:{' '}
            {Array.from(plan.problems.entries())
              .slice(0, 3)
              .map(([r, p]) => `row ${r + 1} — ${p.messages.join('; ')}`)
              .join(' · ')}
            {plan.problems.size > 3 ? ' · …' : ''}
          </span>
        </p>
      )}
      {lookupError && <p className="text-sm text-rose-600">{lookupError}</p>}
      {runError && <p className="text-sm text-rose-600">{runError}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" className="min-h-[48px]" disabled={busy || plan.valid.length === 0 || !resolved} onClick={() => void run()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
          {busy ? `Importing ${written} / ${plan.valid.length}…` : `Import ${plan.valid.length} row${plan.valid.length === 1 ? '' : 's'}`}
        </Button>
        {plan.valid.length > 0 && resolved && (
          <span className="flex items-center gap-2 text-sm">
            <Badge tone="green">{newCount} new</Badge>
            <Badge tone="blue">{updateCount} update</Badge>
          </span>
        )}
        {plan.valid.length > 0 && !resolved && !lookupError && <span className="text-sm text-muted">Checking which rows already exist…</span>}
        {status === 'done' && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> {result.inserted} inserted, {result.updated} updated.
          </span>
        )}
      </div>
    </div>
  )
}

// ---- Pure helpers, tested on their own --------------------------------------

/** Excel and Google Sheets put tab-separated lines on the clipboard. */
export function parseClipboardGrid(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.map((line) => line.split('\t').map((cell) => cell.trim()))
}

/** True when most non-empty cells of the row are column names rather than data. */
export function looksLikeHeader(row: string[], fields: ImportField[]): boolean {
  const names = new Set(fields.flatMap((f) => [f.key, f.label, ...(f.aliases ?? [])].map(normaliseHeader)))
  const cells = row.filter((c) => c.trim() !== '')
  if (cells.length === 0) return false
  const hits = cells.filter((c) => names.has(normaliseHeader(c))).length
  return hits >= Math.ceil(cells.length / 2)
}

interface PlannedRow {
  values: Record<string, CellValue>
  key: string
  mode: 'new' | 'update'
}

/** Which rows can go, which are skipped and why — the same rules as the file importer. */
export function planRows(
  rows: string[][],
  importer: Importer,
  keyParts: string[],
  existing: Set<string>,
): { valid: PlannedRow[]; problems: Map<number, { cols: Set<string>; messages: string[] }> } {
  const valid: PlannedRow[] = []
  const problems = new Map<number, { cols: Set<string>; messages: string[] }>()
  const seen = new Set<string>()
  rows.forEach((row, r) => {
    if (row.every((c) => c.trim() === '')) return // an untouched blank line
    const values: Record<string, CellValue> = {}
    const cols = new Set<string>()
    const messages: string[] = []
    importer.fields.forEach((f, c) => {
      const raw = (row[c] ?? '').trim()
      if (raw === '') {
        if (f.clearsWhenEmpty) values[f.key] = null
        return
      }
      const cell = coerceCell(f, raw)
      if ('error' in cell) {
        cols.add(f.key)
        messages.push(cell.error)
        return
      }
      values[f.key] = cell.value
    })
    const derived = importer.derive ? importer.derive(values) : values
    for (const k of importer.businessKeys) {
      if (derived[k] === undefined || String(derived[k]).trim() === '') {
        cols.add(k)
        messages.push(`${importer.fields.find((f) => f.key === k)?.label ?? k} is empty`)
      }
    }
    if (messages.length > 0) {
      problems.set(r, { cols, messages })
      return
    }
    const key = keyParts.map((k) => normaliseKeyPart(derived[k])).join('||')
    const mode: 'new' | 'update' = existing.has(key) || seen.has(key) ? 'update' : 'new'
    seen.add(key)
    valid.push({ values: derived, key, mode })
  })
  return { valid, problems }
}
