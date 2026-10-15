// ============================================================================
// §18 — What's new. The notes ship with the build (shared/releases). An
// administrator sees the ones newer than the last they dismissed, once, when
// the application opens on a page where nothing is being recorded; the full
// list stays under the gear.
// ============================================================================

import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Search, Sparkles } from 'lucide-react'
import { RELEASES, latestReleaseId, unseenReleases, type Release } from '@qc/shared/releases'
import { Button, Modal } from '@/components/ui'
import { useReleaseState } from '@/services/queries'
import { markReleaseSeen } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
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

/** Notes open at first on the archive page: the newest few; the rest are their titles until opened. */
const OPEN_AT_FIRST = 3

/**
 * The archive: every note, newest first, under its day, searchable; the newest few and any still to be read
 * open, the others one line each (their title) that opens on a tap — a long history stays a page you can scan.
 */
export function ReleaseArchive({ unseenIds = new Set<string>() }: { unseenIds?: Set<string> }) {
  const [term, setTerm] = useState('')
  const [opened, setOpened] = useState<Set<string>>(() => new Set(RELEASES.slice(0, OPEN_AT_FIRST).map((r) => r.id)))
  const needle = term.trim().toLowerCase()
  const shown = needle ? RELEASES.filter((r) => [r.title, ...r.items.map((i) => i.text)].some((t) => t.toLowerCase().includes(needle))) : RELEASES
  const days = new Map<string, Release[]>()
  for (const r of shown) days.set(r.date, [...(days.get(r.date) ?? []), r])
  const toggle = (id: string) =>
    setOpened((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search the updates…" aria-label="Search the updates" className="input h-10 pl-9 text-sm touch:h-11" />
        </div>
        <Button className="h-10 min-h-0 px-3 py-0 text-13 touch:h-11" onClick={() => setOpened(new Set(shown.map((r) => r.id)))}>
          Open all
        </Button>
        <Button className="h-10 min-h-0 px-3 py-0 text-13 touch:h-11" onClick={() => setOpened(new Set())}>
          Fold all
        </Button>
        <span className="text-xs text-muted">{shown.length} of {RELEASES.length} updates</span>
      </div>
      {shown.length === 0 && <p className="py-8 text-center text-sm text-muted">No update mentions “{term.trim()}”.</p>}
      {[...days.entries()].map(([day, releases]) => (
        <section key={day} className="grid gap-2 lg:grid-cols-[9rem_1fr] lg:gap-4">
          <h2 className="pt-2 text-xs font-bold uppercase tracking-wide text-muted lg:sticky lg:top-[calc(5rem+env(safe-area-inset-top))] lg:self-start">
            <When iso={day} />
          </h2>
          <div className="space-y-2">
            {releases.map((r) => {
              const open = needle !== '' || opened.has(r.id) || unseenIds.has(r.id)
              return (
                <article key={r.id} className={cn('rounded-2xl ring-1', unseenIds.has(r.id) ? 'bg-brand-50/60 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'bg-white ring-slate-200 dark:bg-slate-900 dark:ring-slate-800')}>
                  <button type="button" onClick={() => toggle(r.id)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-start touch:min-h-[48px]">
                    <h3 className="min-w-0 flex-1 text-sm font-bold">{r.title}</h3>
                    {unseenIds.has(r.id) && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white">New</span>}
                    {open ? <ChevronUp aria-hidden className="h-4 w-4 shrink-0 text-muted" /> : <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-muted" />}
                  </button>
                  {open && (
                    <ul className="space-y-1.5 px-4 pb-4">
                      {r.items.map((item, i) => (
                        <li key={i} className="flex gap-2 text-sm text-slate-700 dark:text-slate-200">
                          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                          <span>{item.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              )
            })}
          </div>
        </section>
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
  const { profile, can } = useAuth()
  const admin = !!profile && can('view-release-notes')
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
