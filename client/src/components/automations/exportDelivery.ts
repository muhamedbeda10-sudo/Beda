// ============================================================================
// §21 — the name a delivered scheduled report's workbook (or one of its
// saved report's forms, filled) is saved under. The workbook is made by the
// server from what was delivered, in its style: it shows what the
// recipients were sent, never run again.
// ============================================================================

import type { AutomationDelivery } from '@qc/shared/automation'
import { aiReportFilename } from '@/components/ai/exportAiReport'

/** QC-Report-Daily-rejects-2026-10-10-0800.xlsx: the automation's name, and when it ran. */
export const deliveryFilename = (d: Pick<AutomationDelivery, 'automationName' | 'ranAt'>): string => aiReportFilename(d.automationName, d.ranAt)
