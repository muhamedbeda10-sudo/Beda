// ============================================================================
// §27 — What the calibration screens share: a day as the plan writes it, an
// instrument's status as a badge (the words always with the colour), and the
// days left.
// ============================================================================

import { CALIBRATION_KIND_NAMES, CALIBRATION_STATUS_NAMES, CERTIFICATE_RESULT_NAMES, type CalibrationItem, type CalibrationKind, type CalibrationStatus, type CertificateResult } from '@qc/shared/calibration'
import { Badge, type BadgeTone } from '@/components/ui'

const DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

/** A calendar day with its year, whatever the year: a plan spans several (16 Sep 2026). */
export function calDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '—'
  return DAY.format(new Date(`${day}T00:00:00`))
}

export const STATUS_TONE: Record<CalibrationStatus, BadgeTone> = { overdue: 'red', 'due-soon': 'amber', valid: 'green', 'no-date': 'neutral', scrapped: 'violet' }
export const RESULT_TONE: Record<CertificateResult, BadgeTone> = { pass: 'green', fail: 'red', 'no-tolerance': 'neutral', 'no-readings': 'neutral' }

export function StatusBadge({ status }: { status: CalibrationStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{CALIBRATION_STATUS_NAMES[status]}</Badge>
}
export function ResultBadge({ result }: { result: CertificateResult }) {
  return <Badge tone={RESULT_TONE[result]}>{CERTIFICATE_RESULT_NAMES[result]}</Badge>
}
export function KindBadge({ kind }: { kind: CalibrationKind }) {
  return <Badge tone={kind === 'external' ? 'blue' : 'neutral'}>{CALIBRATION_KIND_NAMES[kind]}</Badge>
}

/** "12 days left", "3 days overdue", "Due today". */
export function daysText(i: Pick<CalibrationItem, 'daysLeft' | 'status'>): string {
  if (i.status === 'scrapped' || i.daysLeft === null) return ''
  if (i.daysLeft === 0) return 'Due today'
  const n = Math.abs(i.daysLeft)
  return i.daysLeft < 0 ? `${n.toLocaleString()} day${n === 1 ? '' : 's'} overdue` : `${n.toLocaleString()} day${n === 1 ? '' : 's'} left`
}

/** A number as typed: "" for none, the number otherwise ("0,02" read as 0.02). */
export function parseNumber(raw: string): number | null | undefined {
  const t = raw.trim().replace(',', '.')
  if (!t) return null
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined
  return Number(t)
}
export const numberText = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
