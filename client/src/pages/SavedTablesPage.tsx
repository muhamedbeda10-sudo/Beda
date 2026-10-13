// ============================================================================
// The assistant's saved tables: what it keeps to build on. Each table leads
// with its title, a sentence or two on what it shows, and its first rows,
// with a line on how many rows it has and when they were computed; whether
// its last computation failed, when it did. The full account (what a row is,
// where the rows come from, the rules applied), its columns, who may read it,
// who made it and its query wait under Details. Anyone who may read a table
// may compute it again now, and whoever made it, or the assistant's owner,
// may remove it. The assistant makes and replaces them in a conversation.
// Opened from the table icon in the assistant's header, and from a
// saved-table card in an answer.
// ============================================================================

import '@fontsource/ibm-plex-sans-arabic/arabic-400.css'
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, Loader2, RefreshCw, Search, Table2, Trash2 } from 'lucide-react'
import { AI_DOMAINS, type AiQueryPart } from '@qc/shared/ai'
import { SAVED_TABLE_REFRESH_LABEL, type SavedTable } from '@qc/shared/savedTables'
import { Button, Card, Modal } from '@/components/ui'
import { PreviewTable } from '@/components/ai/AiResultTable'
import { ApiError } from '@/lib/api'
import { formatDateTime, formatFullTimestamp } from '@/lib/utils'
import { refreshSavedTable, removeSavedTable, useSavedTableRows, useSavedTables } from '@/services/savedTables'
import { useApp } from '@/store/AppContext'

/** Who may read a table, in the words of the assistant's settings. */
export function savedTableReaders(t: Pick<SavedTable, 'domains'>): string {
  if (t.domains.length === 0) return 'Everyone given the assistant'
  return `People who may read ${t.domains.map((d) => AI_DOMAINS.find((x) => x.id === d)?.name ?? d).join(' and ')}`
}

/** A table matches a search by its title, name, summary, description or columns. */
export function matchesSavedTable(t: SavedTable, search: string): boolean {
  const q = search.trim().toLowerCase()
  if (!q) return true
  return [t.title, t.name, t.summary, t.description, ...t.columns.map((c) => c.name)].some((s) => s.toLowerCase().includes(q))
}

/** A fallback summary at most, in characters: about two lines on a phone. */
const FALLBACK_SUMMARY_MAX = 180

/**
 * What the card says of a table under its title: its summary, or for a table
 * saved before summaries, the first sentence of its description, cut at a
 * word when it runs long. Null when it has neither.
 */
export function savedTableSummary(t: Pick<SavedTable, 'summary' | 'description'>): string | null {
  const summary = t.summary.trim()
  if (summary) return summary
  const description = t.description.replace(/\s+/g, ' ').trim()
  if (!description) return null
  // A sentence ends at . ! ? or ؟ before a space or the end, so ai.views and 2025-01-01 stay whole.
  const end = description.search(/[.!?؟](\s|$)/)
  const first = end === -1 ? description : description.slice(0, end + 1)
  if (first.length <= FALLBACK_SUMMARY_MAX) return first
  const cut = first.slice(0, FALLBACK_SUMMARY_MAX)
  const space = cut.lastIndexOf(' ')
  return `${(space > FALLBACK_SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}…`
}

/** The rows and how the table is kept, in one line. */
export function savedTableFacts(t: Pick<SavedTable, 'rowCount' | 'source' | 'refresh'>): string {
  const rows = t.rowCount === null ? null : `${t.rowCount.toLocaleString('en-US')} ${t.rowCount === 1 ? 'row' : 'rows'}`
  return [rows, t.source === 'rows' ? 'Written out' : SAVED_TABLE_REFRESH_LABEL[t.refresh]].filter(Boolean).join(' · ')
}

/**
 * Whether the element has come near the screen yet, and stays true once it
 * has: a table's rows are read when its card is about to be seen, not all at
 * once for a long list. Without IntersectionObserver, at once.
 */
function useSeen<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen || !ref.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true)
    }, { rootMargin: '300px 0px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [seen])
  return [ref, seen]
}

export function SavedTablesPage() {
  const { data, isLoading, isError, refetch } = useSavedTables()
  const [search, setSearch] = useState('')
  const tables = useMemo(() => (data?.tables ?? []).filter((t) => matchesSavedTable(t, search)), [data, search])
  const all = data?.tables.length ?? 0

  return (
    <div className="ai-type mx-auto w-full max-w-4xl space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
          <Table2 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold tracking-tight">Saved tables</h1>
          <p className="text-13 text-muted">What the AI assistant keeps to build on{data ? ` · ${all} ${all === 1 ? 'table' : 'tables'}` : ''}</p>
        </div>
      </header>

      <Card className="p-3 text-13 text-slate-600 dark:text-slate-300">
        Ask the assistant for an analysis to keep — a routing from the production history, a normal range per item — and it saves it here as a table. Questions, reports and automations then build on it; a table drawn from the record is computed again by itself.
      </Card>

      {all > 3 && (
        <label className="relative block">
          <span className="sr-only">Search the saved tables</span>
          <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input dir="auto" value={search} onChange={(e) => setSearch(e.target.value)} className="input ps-9" placeholder="Search by title, name or column" />
        </label>
      )}

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the saved tables…
        </p>
      )}
      {isError && !data && (
        <Card className="p-4 text-sm text-rose-700 dark:text-rose-300">
          The saved tables could not be loaded.{' '}
          <button type="button" onClick={() => void refetch()} className="font-semibold underline">
            Try again
          </button>
        </Card>
      )}
      {data && all === 0 && <Card className="px-4 py-6 text-center text-13 text-muted">No saved tables yet.</Card>}
      {data && all > 0 && tables.length === 0 && <Card className="px-4 py-6 text-center text-13 text-muted">No table matches “{search.trim()}”.</Card>}
      {tables.map((t) => (
        <TableCard key={t.id} table={t} />
      ))}
    </div>
  )
}

function TableCard({ table: t }: { table: SavedTable }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [rowsRef, seen] = useSeen<HTMLDivElement>()
  const summary = savedTableSummary(t)
  const [busy, setBusy] = useState<'refresh' | 'remove' | null>(null)
  const [confirming, setConfirming] = useState(false)

  const refresh = async () => {
    setBusy('refresh')
    try {
      const after = await refreshSavedTable(qc, t.id)
      toast(`Computed again: ${(after.rowCount ?? 0).toLocaleString('en-US')} rows.`, 'success')
      void qc.invalidateQueries({ queryKey: ['ai', 'saved-tables', t.id, 'rows'] })
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'It could not be computed. Try again.', 'error')
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    setBusy('remove')
    try {
      await removeSavedTable(qc, t.id)
      toast('The table was removed.', 'success')
      setConfirming(false)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'It could not be removed. Try again.', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3">
        {/* Narrow, the buttons go under the title rather than squeezing it. */}
        <div className="min-w-[14rem] flex-1">
          <h2 dir="auto" className="break-words text-sm font-bold text-slate-800 dark:text-slate-100">
            {t.title}
          </h2>
          {summary && (
            <p dir="auto" className="mt-0.5 break-words text-13 text-slate-600 dark:text-slate-300">
              {summary}
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            {savedTableFacts(t)}
            {t.refreshedAt && (
              <>
                {' · Computed '}
                <time dateTime={t.refreshedAt} data-tip={formatFullTimestamp(t.refreshedAt)}>
                  {formatDateTime(t.refreshedAt)}
                </time>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {t.mayRefresh && (
            <Button onClick={() => void refresh()} disabled={busy !== null} className="min-h-[40px] touch:min-h-[44px]" data-tip="Compute it again from its query now">
              {busy === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Compute now
            </Button>
          )}
          {t.mayRemove && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy !== null}
              className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 dark:hover:bg-rose-500/10 dark:hover:text-rose-300 touch:h-11 touch:w-11"
              aria-label="Remove"
              data-tip="Remove"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {t.lastError && (
        <p role="status" className="mx-4 mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            The last computation failed{t.lastErrorAt ? ` (${formatDateTime(t.lastErrorAt)})` : ''}, so the rows are the ones before it: {t.lastError}
          </span>
        </p>
      )}

      <div ref={rowsRef} className="px-4 py-3">
        {seen ? <TableRows table={t} /> : <div className="h-24" aria-hidden />}
      </div>

      <details className="group/details border-t border-slate-100 dark:border-slate-800">
        <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-1 px-4 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px] [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden className="h-4 w-4 transition-transform group-open/details:rotate-180" /> Details
        </summary>
        <div className="space-y-3 px-4 pb-3 text-xs">
          {t.description && (
            <p dir="auto" className="whitespace-pre-wrap break-words text-13 text-slate-600 dark:text-slate-300">
              {t.description}
            </p>
          )}
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
            <Fact label="Name in questions and automations">
              <span className="break-all font-mono text-[11px]">ai_saved.{t.name}</span>
            </Fact>
            <Fact label="Made by">{t.createdByName}</Fact>
            <div className="min-w-0 sm:col-span-2">
              <Fact label="Who may read it">{savedTableReaders(t)}</Fact>
            </div>
          </dl>
          {t.columns.length > 0 && (
            <div>
              <p className="text-muted">Columns</p>
              <ul className="mt-1 space-y-0.5">
                {t.columns.map((c) => (
                  <li key={c.name} className="break-words">
                    <span className="font-mono text-[11px] text-slate-700 dark:text-slate-200">{c.name}</span>
                    {c.note && (
                      <span dir="auto" className="text-muted">
                        {' '}— {c.note}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {t.sql && (
            <details>
              <summary className="cursor-pointer py-1 font-semibold text-muted">How it is computed</summary>
              <pre dir="ltr" className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-700 dark:bg-slate-900 dark:text-slate-200">
                {t.sql}
              </pre>
            </details>
          )}
        </div>
      </details>

      {confirming && (
        <Modal
          open
          onClose={() => busy === null && setConfirming(false)}
          size="sm"
          title="Remove this table?"
          footer={
            <>
              <Button onClick={() => setConfirming(false)} disabled={busy !== null}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy !== null}>
                {busy === 'remove' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove
              </Button>
            </>
          }
        >
          <p dir="auto" className="break-words text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t.title}
          </p>
          <p className="mt-2 text-xs text-muted">Questions, reports and automations that read ai_saved.{t.name} stop working. The assistant can build it again when asked.</p>
        </Modal>
      )}
    </Card>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-slate-700 dark:text-slate-200">{children}</dd>
    </div>
  )
}

function TableRows({ table: t }: { table: SavedTable }) {
  const { data, isLoading, isError, refetch } = useSavedTableRows(t.id, true)
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 py-2 text-13 text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading the rows…
      </p>
    )
  }
  if (isError || !data) {
    return (
      <p className="py-2 text-13 text-rose-700 dark:text-rose-300">
        The rows could not be read.{' '}
        <button type="button" onClick={() => void refetch()} className="font-semibold underline">
          Try again
        </button>
      </p>
    )
  }
  const part: AiQueryPart = { type: 'query', queryId: t.id, purpose: t.title, sql: '', ok: true, columns: data.columns, rows: data.rows, rowCount: data.rows.length, truncated: data.truncated, ms: 0 }
  return (
    <div className="py-2">
      <PreviewTable part={part} />
    </div>
  )
}
