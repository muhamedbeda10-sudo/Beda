// ============================================================================
// §24 — the ERP's production task record ("Production Task Record" in Access):
// the production written against the order sheet. The order sheet is the
// master, planning's table: one row per ORDER LINE with its Order ID. This
// record hangs off it: its ID column is that same Order ID, repeated on every
// row of the line, one per day's work on it (a shift, or a stage; two may
// share a day) — what the machine made of it that day, who stood at it, in
// which shift, the hours planned and taken, the weights and lengths. An
// administrator imports the export (CSV or .xlsx) like the order sheet; the
// assistant reads it, and nothing in the app writes to it.
//
// The columns are read by name, as the export writes them, so the file maps
// itself. Each field below carries the names the ERP gives its column.
// ============================================================================

import type { OrderImportField } from './orderImport'

export type ProductionRecordField = OrderImportField

/**
 * The export's columns. `kind: 'text'` for the day on purpose: a date read in
 * the browser would shift with its time zone; the API reads the day itself.
 * "Productivity" is not among them: the ERP writes 0 on every row.
 */
export const PRODUCTION_RECORD_FIELDS: readonly ProductionRecordField[] = [
  // The order line's Order ID, as the order sheet's import names it: the column the two tables are joined on.
  { key: 'lineKey', label: 'Order ID', kind: 'text', aliases: ['id', 'order id', 'orderid', 'line id', 'line key', 'task id'], sample: '490226' },
  { key: 'erpRecordId', label: 'Record ID', kind: 'text', aliases: ['record id', 'record', 'recordid'], sample: '113290' },
  { key: 'week', label: 'Week', kind: 'text', aliases: ['pivot', 'week', 'wk'], sample: '01/2026' },
  { key: 'orderNumber', label: 'Order number', kind: 'text', aliases: ['order', 'order no', 'order number'], sample: '19383-Ph1.7-SGR' },
  { key: 'item', label: 'Item', kind: 'text', aliases: ['item', 'item name', 'description'], sample: 'Shuttle Rail : 218-RO-SP : 10800-LH-T1 : 27' },
  { key: 'colour', label: 'Colour', kind: 'text', aliases: ['color', 'colour', 'ral'], sample: 'ZC' },
  { key: 'producedQty', label: 'Produced qty', kind: 'number', aliases: ['qty', 'quantity', 'produced', 'produced qty'], sample: '132' },
  { key: 'worker1', label: 'Worker 1', kind: 'text', aliases: ['worker1', 'worker 1', 'worker'], sample: 'مصطفى محمود' },
  { key: 'worker2', label: 'Worker 2', kind: 'text', aliases: ['worker2', 'worker 2'], sample: '' },
  { key: 'worker3', label: 'Worker 3', kind: 'text', aliases: ['worker3', 'worker 3'], sample: '' },
  { key: 'worker4', label: 'Worker 4', kind: 'text', aliases: ['worker4', 'worker 4'], sample: '' },
  { key: 'dayNo', label: 'Day no.', kind: 'text', aliases: ['dayno', 'day no', 'day number'], sample: 'Day1' },
  { key: 'workDay', label: 'Day', kind: 'text', aliases: ['day', 'date', 'work day'], sample: '2026-01-05' },
  { key: 'workCenterCode', label: 'Machine code', kind: 'text', aliases: ['work center', 'work centre', 'wc', 'machine', 'machine code'], sample: '40' },
  { key: 'durationHours', label: 'Duration (h)', kind: 'number', aliases: ['duration'], sample: '1.76' },
  { key: 'stageNo', label: 'Stage no.', kind: 'number', aliases: ['stage n', 'stage (n)', 'stage'], sample: '' },
  { key: 'stageQty', label: 'Stage qty', kind: 'number', aliases: ['stage qty', 'stage (qty)'], sample: '0' },
  { key: 'remarks', label: 'Remarks', kind: 'text', aliases: ['remark', 'notes', 'comment'], sample: '' },
  { key: 'lengthMm', label: 'Length (mm)', kind: 'number', aliases: ['l mm', 'l (mm)', 'length', 'l'], sample: '10800' },
  { key: 'widthMm', label: 'Width (mm)', kind: 'number', aliases: ['w mm', 'w (mm)', 'width', 'w'], sample: '347' },
  { key: 'thicknessMm', label: 'Thickness (mm)', kind: 'number', aliases: ['t mm', 't (mm)', 'thickness', 't'], sample: '3' },
  { key: 'requiredQty', label: 'Required qty', kind: 'number', aliases: ['req q', 'req_q', 'required', 'required qty'], sample: '132' },
  { key: 'actualHours', label: 'Actual time (h)', kind: 'number', aliases: ['actual time', 'actual'], sample: '2' },
  { key: 'plannedHours', label: 'Planned time (h)', kind: 'number', aliases: ['planned time', 'planned'], sample: '1.76' },
  { key: 'shift', label: 'Shift', kind: 'text', aliases: ['shift category', 'shift'], sample: 'وردية صباحية 8 ساعات' },
  { key: 'resource', label: 'Resource', kind: 'text', aliases: ['resource', 'line', 'machine name'], sample: 'Roll Forming Line C2792015' },
  { key: 'weightKg', label: 'Weight (kg)', kind: 'number', aliases: ['weight kg', 'weight (kg)', 'weight'], sample: '10485' },
  { key: 'producedWeightKg', label: 'Produced weight (kg)', kind: 'number', aliases: ['produced weight kg', 'produced weight (kg)', 'produced weight'], sample: '10485' },
  { key: 'producedLengthM', label: 'Produced length (m)', kind: 'number', aliases: ['produced length meter', 'produced length (meter)', 'produced length'], sample: '1425.6' },
]

/** The fields that together name a record: the ERP's record id repeats across order lines, the pair does not. */
export const PRODUCTION_RECORD_KEYS: readonly string[] = ['lineKey', 'erpRecordId']

/**
 * An actual time the ERP could not record: it writes a tiny placeholder so
 * the row is accepted. Anything under this is "not recorded", kept as null.
 */
export const ACTUAL_HOURS_NOT_RECORDED_BELOW = 0.001

/** The actual hours as stored: the ERP's placeholder for "not recorded" becomes null. */
export function actualHoursOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return value < ACTUAL_HOURS_NOT_RECORDED_BELOW ? null : value
}

/** "Day1" → 1, "day 12" → 12, "3" → 3; anything else is not a day number. */
export function parseDayNo(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  const m = /^\s*(?:day)?\s*(\d{1,4})\s*$/i.exec(value)
  return m ? Number(m[1]) : null
}

/** "01/2026" → { week: 1, year: 2026 }; the ERP's week-of-year with its year. Anything else is not a week. */
export function parseWeek(value: string | null | undefined): { week: number; year: number } | null {
  if (!value) return null
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{4})\s*$/.exec(value)
  if (!m) return null
  const week = Number(m[1])
  return week >= 1 && week <= 53 ? { week, year: Number(m[2]) } : null
}

const isRealDay = (y: number, mo: number, d: number): boolean => {
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}
const ymd = (y: number, mo: number, d: number): string => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/**
 * The day a record is for, as the export writes it: ISO ("2026-01-05", with
 * or without a time), or the day-first form Access and Excel write in Egypt
 * ("05/01/2026", "5-1-2026"). The day only; no time zone is applied.
 */
export function parseWorkDay(value: string | null | undefined): string | null {
  if (!value) return null
  const s = value.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return isRealDay(y, mo, d) ? ymd(y, mo, d) : null
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ].*)?$/.exec(s)
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return isRealDay(y, mo, d) ? ymd(y, mo, d) : null
  }
  return null
}

/** The people on the machine that day, in their columns' order, blanks left out and a name once. */
export function workersOf(names: readonly (string | null | undefined)[]): string[] {
  const out: string[] = []
  for (const n of names) {
    const name = (n ?? '').replace(/\s+/g, ' ').trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}
