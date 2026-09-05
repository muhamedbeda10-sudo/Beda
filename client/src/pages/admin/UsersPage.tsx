import { AdminLayout } from '@/components/admin/AdminLayout'
import { UsersPanel } from '@/components/admin/UsersPanel'

export function UsersPage() {
  return (
    <AdminLayout title="Users" needs="manage-admin-data">
      <UsersPanel />
    </AdminLayout>
  )
}
