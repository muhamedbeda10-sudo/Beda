// §18 — every release note, newest first, for reading again at leisure. Listed
// under Administration, so it sits in the same frame as the other admin pages:
// the sidebar on a desktop, the menu's Administration group elsewhere. The
// newest few open, the rest a line each, so the history stays scannable.

import { unseenReleases } from '@qc/shared/releases'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { ReleaseArchive } from '@/components/releases/WhatsNew'
import { useReleaseState } from '@/services/queries'

export function WhatsNewPage() {
  const { data } = useReleaseState(true)
  const unseen = new Set(data ? unseenReleases(data.lastSeenReleaseId).map((r) => r.id) : [])
  return (
    <AdminLayout title="What's new" description="Every update that reached the application, newest first, under its day. The newest are open; a highlighted one is still to be read." needs="view-release-notes">
      <ReleaseArchive unseenIds={unseen} />
    </AdminLayout>
  )
}
