import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { InspectionsPage } from '@/pages/InspectionsPage'
import { SessionPage } from '@/pages/SessionPage'
import { OrderSummaryPage } from '@/pages/OrderSummaryPage'
import { AnalyticsPage } from '@/pages/AnalyticsPage'
import { HistoryPage } from '@/pages/HistoryPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { AuditPage } from '@/pages/AuditPage'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<InspectionsPage />} />
        <Route path="/session/:id" element={<SessionPage />} />
        <Route path="/orders" element={<OrderSummaryPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
