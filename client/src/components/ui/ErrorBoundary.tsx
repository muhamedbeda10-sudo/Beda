// ============================================================================
// A part of the app that failed to draw — most often a lazily loaded piece
// whose file could not be fetched (a new version deployed since the page
// opened, a dropped connection) — shows a word and a way out in its place,
// instead of taking the whole page down with it.
//
// A file that no longer exists after a deploy is mended by itself: the page
// reloads once and asks for the new one (not again within a minute, so a
// file that is truly missing cannot set it reloading for ever). Anything
// else is written to the console with where it happened, and its message is
// kept under "Technical details" on the screen, so a screenshot says what
// broke. A `resetKey` that changes (the place the person went to next) draws
// the part again.
// ============================================================================

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui'

/** A script or stylesheet of the app that could not be fetched: after a deploy, one the page still asks for by its old name. */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError|Loading chunk \S+ failed/i.test(message)
}

const RELOADED_AT = 'qc:stale-chunk-reload-at'
/** At most one reload a minute for a missing file: one that is truly gone shows the word instead. */
const RELOAD_GAP_MS = 60_000

/** Whether the page may reload now for a missing file; marks that it did. */
export function mayReloadForStaleChunk(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0)
    if (now - last < RELOAD_GAP_MS) return false
    sessionStorage.setItem(RELOADED_AT, String(now))
    return true
  } catch {
    // No storage (a private window that refuses it): no reload, so it can never loop.
    return false
  }
}

interface BoundaryProps {
  fallback: ReactNode | ((error: Error) => ReactNode)
  children: ReactNode
  /** Changes when the person goes elsewhere: a failed part is drawn again there. */
  resetKey?: unknown
}

export class ErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[ui] a part of the app failed to draw:', error, info.componentStack)
    if (isStaleChunkError(error) && mayReloadForStaleChunk()) window.location.reload()
  }

  componentDidUpdate(prev: BoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return typeof this.props.fallback === 'function' ? this.props.fallback(error) : this.props.fallback
  }
}

/**
 * What stands in for a piece that could not be loaded. A reload tries again:
 * React keeps a failed lazy import, and after a deploy the file the page asks
 * for no longer exists — the reloaded page asks for the new one. With the
 * error, its message is kept under "Technical details".
 */
export function LoadFailed({ what, action, error }: { what: string; action?: ReactNode; error?: Error }) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <AlertTriangle aria-hidden className="h-7 w-7 text-amber-500" />
      <div>
        <p className="font-semibold text-slate-700 dark:text-slate-200">{what} could not be loaded.</p>
        <p className="mt-1 text-sm text-muted">The connection may have dropped, or a new version of the app is out. Reloading the page fixes either.</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" className="min-h-[44px]" onClick={() => window.location.reload()}>
          <RotateCw className="h-4 w-4" /> Reload
        </Button>
        {action}
      </div>
      {error && (
        <details className="max-w-full text-start text-xs text-muted">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <p dir="ltr" className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono">
            {`${error.name}: ${error.message}`.slice(0, 600)}
          </p>
        </details>
      )}
    </div>
  )
}
