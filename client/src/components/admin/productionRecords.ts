// ============================================================================
// §24 — the production record in words, for the import page: what is stored
// now, in one line. Pure, so it is tested without a browser.
// ============================================================================

import type { ProductionRecordsSummary } from '@qc/shared/api'
import { formatDate, formatDateTime } from '@/lib/utils'

const COUNT = new Intl.NumberFormat('en-US')

/** A count with its noun: "1 record", "42,143 records". */
export function countOf(n: number, noun: string): string {
  return `${COUNT.format(n)} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * A working day (YYYY-MM-DD) as the app writes days. Read as a local
 * midnight, not as UTC: the record names a factory day, and a device west of
 * Greenwich must not show the day before.
 */
export function formatWorkDay(day: string): string {
  return formatDate(`${day}T00:00:00`)
}

/** The span of days the record covers: "Jan 22, 2020 – Oct 4", or one day when it is one. */
export function describeDays(firstDay: string, lastDay: string): string {
  return firstDay === lastDay ? formatWorkDay(firstDay) : `${formatWorkDay(firstDay)} – ${formatWorkDay(lastDay)}`
}

/**
 * The one line above the importer: "42,143 records · 29,901 order lines
 * (28,100 on the order sheet) · Jan 22, 2020 – Oct 4 · last import Oct 10,
 * 21:05". The record is the child of the order sheet, so the line says how
 * many of its order lines the sheet knows now. Without a record, it says so.
 */
export function describeProductionRecords(s: ProductionRecordsSummary): string {
  if (s.rows === 0) return 'No production records yet.'
  const known = s.linesKnown === 0 ? 'none on the order sheet' : `${COUNT.format(s.linesKnown)} on the order sheet`
  const parts = [countOf(s.rows, 'record'), `${countOf(s.lines, 'order line')} (${known})`]
  if (s.firstDay && s.lastDay) parts.push(describeDays(s.firstDay, s.lastDay))
  if (s.lastImportAt) parts.push(`last import ${formatDateTime(s.lastImportAt)}`)
  return parts.join(' · ')
}
