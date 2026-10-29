// ============================================================================
// QA — the quality registers under one tab, their parts as icons across the
// top as Planning's are. Each part shows to whoever may open it; a person who
// may open none has no QA tab (navItems). A new QA screen is one more entry in
// QA_PARTS, its address /qa/<key>, and its permission in the QA tab's needsAny.
// ============================================================================

import { Navigate, useParams } from 'react-router-dom'
import { ClipboardX, MessageSquareWarning } from 'lucide-react'
import type { Permission } from '@qc/shared/permissions'
import { SectionTabs, type SectionTab } from '@/components/layout/SectionTabs'
import { QualityRegisterPage } from '@/pages/QualityRegisterPage'
import { useAuth } from '@/store/AuthContext'

interface Part extends SectionTab {
  needs: Permission
  render: () => JSX.Element
}

export const QA_PARTS: readonly Part[] = [
  {
    key: 'customer-complaints',
    label: 'Customer Complaints',
    icon: MessageSquareWarning,
    hint: 'Customer complaints, product details and supporting photos',
    needs: 'view-customer-complaints',
    render: () => <QualityRegisterPage key="complaint" kind="customer-complaint" />,
  },
  {
    key: 'ncr',
    label: 'NCR',
    icon: ClipboardX,
    hint: 'Non-conformity reports, corrective actions and their effectiveness',
    needs: 'view-ncr',
    render: () => <QualityRegisterPage key="ncr" kind="ncr" />,
  },
]

const pathOf = (key: string) => `/qa/${key}`

export function QaPage() {
  const { section } = useParams()
  const { can } = useAuth()
  const parts = QA_PARTS.filter((p) => can(p.needs))
  const current = parts.find((p) => p.key === section)
  // Opened bare, or at a part this person may not open, QA opens their first part; with none, home.
  if (!current) return <Navigate to={parts.length ? pathOf(parts[0].key) : '/'} replace />
  return (
    <div className="space-y-3">
      <SectionTabs name="QA" tabs={parts} current={current} pathOf={pathOf} />
      <div key={current.key} className="animate-page-in">
        {current.render()}
      </div>
    </div>
  )
}
