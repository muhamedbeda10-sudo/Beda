// ============================================================================
// §18 — What's new. The notes ship with the build (shared/releases). An
// administrator sees the ones newer than the last they dismissed, once, when
// the application opens on a page where nothing is being recorded; the full
// list stays under the gear.
// ============================================================================

import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { RELEASES, latestReleaseId, unseenReleases, type Release } from '@qc/shared/releases'
import { Button, Modal } from '@/components/ui'
import { useReleaseState } from '@/services/queries'
import { markReleaseSeen } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { can } from '@qc/shared/rules'
import { cn } from '@/lib/utils'
import { When } from '@/components/ui/Tooltip'

export function ReleaseCard({ release, fresh = false }: { release: Release; fresh?: boolean }) {
  return (
    <article className={cn('rounded-2xl p-4 ring-1', fresh ? 'bg-brand-50/60 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'ring-slate-200 dark:ring-slate-800')}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-bold">{release.title}</h3>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted"><When iso={release.date} /></span>
      </header>
      <ul className="mt-2 space-y-1.5">
        {release.items.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm text-slate-700 dark:text-slate-200">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </article>
  )
}

/** Every note, newest first. */
export function ReleaseList({ unseenIds = new Set<string>() }: { unseenIds?: Set<string> }) {
  return (
    <div className="space-y-3">
      {RELEASES.map((r) => (
        <ReleaseCard key={r.id} release={r} fresh={unseenIds.has(r.id)} />
      ))}
    </div>
  )
}

/** Pages where a person is mid-record: the prompt waits until they are done. */
const QUIET_PATHS = [/^\/wizard\//]

/**
 * Mounted once in the shell. Shows the unseen notes to an administrator and
 * marks the newest one seen on any close, so the prompt is once per person.
 */
export function WhatsNewPrompt() {
  const { role, profile } = useAuth()
  const admin = !!profile && can(role, 'manage-admin-data')
  const { data } = useReleaseState(admin)
  const location = useLocation()
  const qc = useQueryClient()
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const unseen = data ? unseenReleases(data.lastSeenReleaseId) : []
  const quiet = QUIET_PATHS.some((re) => re.test(location.pathname))
  const open = admin && !dismissed && unseen.length > 0 && !quiet

  // A fresh sign-in: the prompt may show again for whatever is still unseen.
  useEffect(() => setDismissed(false), [profile?.id])

  const close = async () => {
    setDismissed(true)
    const newest = latestReleaseId(unseen)
    if (!newest || busy) return
    setBusy(true)
    try {
      await markReleaseSeen(qc, newest)
    } catch {
      // The note shows again next time; nothing else to do here.
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  return (
    <Modal
      open
      onClose={() => void close()}
      size="lg"
      icon={<Sparkles className="h-5 w-5" />}
      title={unseen.length === 1 ? "What's new" : `What's new · ${unseen.length} updates`}
      footer={
        <Button variant="primary" onClick={() => void close()} disabled={busy}>
          Got it
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted">The application was updated since you last looked. Here is what changed; the full list stays under the gear menu → What's new.</p>
      <div className="space-y-3">
        {unseen.map((r) => (
          <ReleaseCard key={r.id} release={r} fresh />
        ))}
      </div>
    </Modal>
  )
}
