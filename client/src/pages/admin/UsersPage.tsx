import { AdminLayout } from '@/components/admin/AdminLayout'
import { UsersPanel } from '@/components/admin/UsersPanel'

export function UsersPage() {
  return (
    <AdminLayout title="Users" description="Accounts and roles. An account is deactivated, never deleted, so its history stays attributable." needs="manage-admin-data">
      <UsersPanel />
    </AdminLayout>
  )
}
