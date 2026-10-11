// §18 — every release note, newest first, for reading again at leisure. Listed
// under Administration, so it sits in the same frame as the other admin pages:
// the sidebar on a desktop, the menu's Administration group elsewhere.

import { unseenReleases } from '@qc/shared/releases'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { Card } from '@/components/ui'
import { ReleaseList } from '@/components/releases/WhatsNew'
import { useReleaseState } from '@/services/queries'

export function WhatsNewPage() {
  const { data } = useReleaseState(true)
  const unseen = new Set(data ? unseenReleases(data.lastSeenReleaseId).map((r) => r.id) : [])
  return (
    <AdminLayout title="What's new" needs="manage-admin-data">
      <div className="space-y-4">
        <p className="text-sm text-muted">Every update that reached the application, newest first. A highlighted one is still to be read.</p>
        <Card className="p-4 sm:p-5">
          <ReleaseList unseenIds={unseen} />
        </Card>
      </div>
    </AdminLayout>
  )
}
