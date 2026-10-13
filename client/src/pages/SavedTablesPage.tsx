// ============================================================================
// The assistant's saved tables: what it keeps to build on. Each table says
// what it holds, where its rows come from and how often they are computed
// again, when they last were (and why not, when that failed), who may read
// it and who made it. Its first rows open under it; anyone who may read a
// table may compute it again now, and whoever made it, or the assistant's
// owner, may remove it. The assistant makes and replaces them in a
// conversation. Opened from the table icon in the assistant's header, and
// from a saved-table card in an answer.
// ============================================================================

import '@fontsource/ibm-plex-sans-arabic/arabic-400.css'
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css'
import { useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, Loader2, RefreshCw, Search, Table2, Trash2 } from 'lucide-react'
import { AI_DOMAINS, type AiQueryPart } from '@qc/shared/ai'
import { SAVED_TABLE_REFRESH_LABEL, type SavedTable } from '@qc/shared/savedTables'
import { Button, Card, Modal } from '@/components/ui'
import { PreviewTable } from '@/components/ai/AiResultTable'
import { ApiError } from '@/lib/api'
import { cn, formatDateTime, formatFullTimestamp } from '@/lib/utils'
import { refreshSavedTable, removeSavedTable, useSavedTableRows, useSavedTables } from '@/services/savedTables'
import { useApp } from '@/store/AppContext'

/** Who may read a table, in the words of the assistant's settings. */
export function savedTableReaders(t: Pick<SavedTable, 'domains'>): string {
  if (t.domains.length === 0) return 'Everyone given the assistant'
  return `People who may read ${t.domains.map((d) => AI_DOMAINS.find((x) => x.id === d)?.name ?? d).join(' and ')}`
}

/** A table matches a search by its title, name, description or columns. */
export function matchesSavedTable(t: SavedTable, search: string): boolean {
  const q = search.trim().toLowerCase()
  if (!q) return true
  return [t.title, t.name, t.description, ...t.columns.map((c) => c.name)].some((s) => s.toLowerCase().includes(q))
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
  const [open, setOpen] = useState(false)
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
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
        {/* Narrow, the buttons go under the title rather than squeezing it. */}
        <div className="min-w-[14rem] flex-1">
          <h2 dir="auto" className="break-words text-sm font-bold text-slate-800 dark:text-slate-100">
            {t.title}
          </h2>
          <p className="break-all font-mono text-[11px] text-muted">ai_saved.{t.name}</p>
          {t.description && (
            <p dir="auto" className="mt-1 whitespace-pre-wrap break-words text-13 text-slate-600 dark:text-slate-300">
              {t.description}
            </p>
          )}
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

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-100 px-4 py-3 text-xs dark:border-slate-800 sm:grid-cols-4">
        <Fact label="Rows">{t.rowCount === null ? '—' : t.rowCount.toLocaleString('en-US')}</Fact>
        <Fact label="Kept">{t.source === 'rows' ? 'Written out' : SAVED_TABLE_REFRESH_LABEL[t.refresh]}</Fact>
        <Fact label="Computed">
          {t.refreshedAt ? (
            <time dateTime={t.refreshedAt} data-tip={formatFullTimestamp(t.refreshedAt)}>
              {formatDateTime(t.refreshedAt)}
            </time>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label="Made by">{t.createdByName}</Fact>
        <div className="col-span-2 sm:col-span-4">
          <dt className="text-muted">Who may read it</dt>
          <dd className="font-medium text-slate-700 dark:text-slate-200">{savedTableReaders(t)}</dd>
        </div>
      </dl>

      {t.lastError && (
        <p role="status" className="flex items-start gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            The last computation failed{t.lastErrorAt ? ` (${formatDateTime(t.lastErrorAt)})` : ''}, so the rows are the ones before it: {t.lastError}
          </span>
        </p>
      )}

      <div className="border-t border-slate-100 px-4 py-2 dark:border-slate-800">
        <p className="flex flex-wrap gap-1 py-1">
          {t.columns.map((c) => (
            <span key={c.name} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200" data-tip={[c.type, c.note].filter(Boolean).join(' · ')}>
              {c.name}
            </span>
          ))}
        </p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex min-h-[40px] items-center gap-1 text-13 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} /> {open ? 'Hide the rows' : 'Show the first rows'}
        </button>
        {open && <TableRows table={t} />}
        {t.sql && (
          <details className="pb-2 text-xs">
            <summary className="cursor-pointer py-1 font-semibold text-muted">How it is computed</summary>
            <pre dir="ltr" className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-700 dark:bg-slate-900 dark:text-slate-200">
              {t.sql}
            </pre>
          </details>
        )}
      </div>

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
      <dd className="truncate font-medium text-slate-700 dark:text-slate-200">{children}</dd>
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
