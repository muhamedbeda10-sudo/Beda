import { AdminLayout } from '@/components/admin/AdminLayout'
import { UsersPanel } from '@/components/admin/UsersPanel'

export function UsersPage() {
  return (
    <AdminLayout title="Users" description="Who can sign in, and what each person may do." needs="manage-users">
      <UsersPanel />
    </AdminLayout>
  )
}
