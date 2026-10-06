// §18 — every release note, newest first, for reading again at leisure.

import { Sparkles } from 'lucide-react'
import { unseenReleases } from '@qc/shared/releases'
import { Card } from '@/components/ui'
import { ReleaseList } from '@/components/releases/WhatsNew'
import { useReleaseState } from '@/services/queries'

export function WhatsNewPage() {
  const { data } = useReleaseState(true)
  const unseen = new Set(data ? unseenReleases(data.lastSeenReleaseId).map((r) => r.id) : [])
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-brand-600 text-white">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">What's new</h1>
          <p className="text-sm text-muted">Every update that reached the application, newest first. A highlighted one is still to be read.</p>
        </div>
      </div>
      <Card className="p-4 sm:p-5">
        <ReleaseList unseenIds={unseen} />
      </Card>
    </div>
  )
}
