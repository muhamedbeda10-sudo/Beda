// ============================================================================
// A part of the app that failed to draw — most often a lazily loaded piece
// whose file could not be fetched (a new version deployed since the page
// opened, a dropped connection) — shows a word and a way out in its place,
// instead of taking the whole page down with it.
// ============================================================================

import { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui'

export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * What stands in for a piece that could not be loaded. Only a reload tries
 * again: React keeps a failed lazy import, and after a deploy the file the
 * page asks for no longer exists — the reloaded page asks for the new one.
 */
export function LoadFailed({ what, action }: { what: string; action?: ReactNode }) {
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
    </div>
  )
}
