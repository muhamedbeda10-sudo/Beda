// ============================================================================
// QA — the quality registers under one tab, their parts as icons across the
// top as Planning's are: what went wrong (customer complaints, NCRs), then the
// material (its certificates — MTC — and Receiving, what comes in and quality's
// decision on it, §27), then the measuring instruments' calibration. Each part shows to whoever may open it; a person who
// may open none has no QA tab (navItems). A new QA screen is one more entry in
// QA_PARTS, its address /qa/<key>, and its permission in the QA tab's needsAny.
// ============================================================================

import { Navigate, useParams } from 'react-router-dom'
import { ClipboardX, FileCheck2, Gauge, MessageSquareWarning, PackageCheck } from 'lucide-react'
import type { Permission } from '@qc/shared/permissions'
import { SectionTabs, type SectionTab } from '@/components/layout/SectionTabs'
import { CalibrationPage } from '@/pages/CalibrationPage'
import { MtcPage } from '@/pages/MtcPage'
import { ReceivingPage } from '@/pages/ReceivingPage'
import { QualityRegisterPage } from '@/pages/QualityRegisterPage'
import { useAuth } from '@/store/AuthContext'

type Group = 'records' | 'material' | 'instruments'

interface Part extends SectionTab {
  group: Group
  needs: Permission
  render: () => JSX.Element
}

export const QA_PARTS: readonly Part[] = [
  {
    key: 'customer-complaints',
    label: 'Customer Complaints',
    icon: MessageSquareWarning,
    hint: 'Customer complaints, product details and supporting photos',
    group: 'records',
    needs: 'view-customer-complaints',
    render: () => <QualityRegisterPage key="complaint" kind="customer-complaint" />,
  },
  {
    key: 'ncr',
    label: 'NCR',
    icon: ClipboardX,
    hint: 'Non-conformity reports, corrective actions and their effectiveness',
    group: 'records',
    needs: 'view-ncr',
    render: () => <QualityRegisterPage key="ncr" kind="ncr" />,
  },
  {
    key: 'mtc',
    label: 'MTC',
    icon: FileCheck2,
    hint: 'The material registers (coils, welding wire, mesh wire), and reading a mill test certificate into them',
    group: 'material',
    needs: 'view-mtc',
    render: () => <MtcPage />,
  },
  {
    key: 'receiving',
    label: 'Receiving',
    icon: PackageCheck,
    hint: 'What comes in: the warehouse’s delivery notes, quality’s decision on each item, the POs and the delivered coils against their MTC',
    group: 'material',
    needs: 'view-receiving',
    render: () => <ReceivingPage />,
  },
  {
    key: 'calibration',
    label: 'Calibration',
    icon: Gauge,
    hint: 'The measuring instruments’ calibration plan, their certificates and the scrapped',
    group: 'instruments',
    needs: 'view-calibration',
    render: () => <CalibrationPage />,
  },
]

const GROUPS: { id: Group; name: string }[] = [
  { id: 'records', name: 'Complaints and NCRs' },
  { id: 'material', name: 'Material' },
  { id: 'instruments', name: 'Instruments' },
]

const pathOf = (key: string) => `/qa/${key}`

export function QaPage() {
  const { section } = useParams()
  const { can } = useAuth()
  const parts = QA_PARTS.filter((p) => can(p.needs))
  const groups = GROUPS.filter((g) => parts.some((p) => p.group === g.id))
  const current = parts.find((p) => p.key === section)
  // Opened bare, or at a part this person may not open, QA opens their first part; with none, home.
  if (!current) return <Navigate to={parts.length ? pathOf(parts[0].key) : '/'} replace />
  return (
    <div className="space-y-3">
      <SectionTabs name="QA" tabs={parts} groups={groups} current={current} pathOf={pathOf} />
      <div key={current.key} className="animate-page-in">
        {current.render()}
      </div>
    </div>
  )
}
