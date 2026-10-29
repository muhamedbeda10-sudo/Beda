// ============================================================================
// §27 — Calibration: the measuring instruments the factory uses (verniers,
// tapes, micrometers, gauges…), when each was calibrated, when it is due
// again, its certificates, and the instruments taken out of use (scrapped).
// It replaces three paper forms and their workbooks:
//
//   • F-Q-05-01, the calibration plan and register of measuring instruments:
//     one row per instrument — its department, name, code, who holds it and
//     since when, internal or external calibration, its calibration code, the
//     last calibration and the next. The Calibration tab's main screen is this
//     plan, its due dates worked out.
//   • The calibration certificate (the certificates log's "الشهادة" sheet):
//     the instrument's data, the reference it was checked against, and the
//     readings at each nominal value with their error. An external
//     calibration's certificate is the outside laboratory's, kept as its PDF.
//   • F-Q-05-03, scrapping instruments (تكهين العدة): when one was taken out
//     of use, after how many days in use, and why.
//
// Rules:
//   • An instrument's next calibration is its last plus its interval in
//     months (a year, a year and a quarter, a year and a half…), worked out —
//     never typed — so the plan and the database always agree (the database
//     works it out the same way, migration 0088).
//   • Due soon: within DUE_SOON_DAYS days; overdue: the day has passed. A
//     scrapped instrument is out of the plan.
//   • A certificate moves its instrument on: the latest certificate gives the
//     instrument its last calibration, interval, kind and calibration code.
//   • A reading's error is the reading less the nominal value; within the
//     tolerance when its size is at most the tolerance.
//   • Categories are the configuration: each kind of instrument has its code
//     prefix (V for verniers), its usual interval and kind, and its
//     certificate's template (the groups of nominal values and the reference
//     it is checked against), which a new certificate starts from.
// ============================================================================

import type { Permission } from './permissions'

export const CALIBRATION_PERMISSIONS: { view: Permission; record: Permission; setup: Permission } = {
  view: 'view-calibration',
  record: 'record-calibration',
  setup: 'manage-calibration-setup',
}

export const CALIBRATION_KINDS = ['internal', 'external'] as const
export type CalibrationKind = (typeof CALIBRATION_KINDS)[number]
export const CALIBRATION_KIND_NAMES: Record<CalibrationKind, string> = { internal: 'Internal', external: 'External' }

export const CALIBRATION_STATUSES = ['overdue', 'due-soon', 'valid', 'no-date', 'scrapped'] as const
export type CalibrationStatus = (typeof CALIBRATION_STATUSES)[number]
export const CALIBRATION_STATUS_NAMES: Record<CalibrationStatus, string> = {
  overdue: 'Overdue',
  'due-soon': 'Due soon',
  valid: 'Valid',
  'no-date': 'No date',
  scrapped: 'Scrapped',
}
export const isCalibrationStatus = (v: unknown): v is CalibrationStatus => typeof v === 'string' && (CALIBRATION_STATUSES as readonly string[]).includes(v)

/** An instrument due within this many days is due soon. */
export const DUE_SOON_DAYS = 30
export const MAX_INTERVAL_MONTHS = 120

/** The intervals offered; any number of months may be typed. */
export const INTERVAL_PRESETS: readonly { months: number; label: string }[] = [
  { months: 1, label: '1 month' },
  { months: 2, label: '2 months' },
  { months: 3, label: '3 months' },
  { months: 4, label: '4 months' },
  { months: 6, label: '6 months' },
  { months: 12, label: '1 year' },
  { months: 15, label: '1¼ years (15 months)' },
  { months: 18, label: '1½ years (18 months)' },
  { months: 24, label: '2 years' },
]

export function intervalLabel(months: number | null | undefined): string {
  if (!months) return '—'
  const preset = INTERVAL_PRESETS.find((p) => p.months === months)
  if (preset) return preset.label
  return months % 12 === 0 ? `${months / 12} years` : `${months} months`
}

/** Why an instrument is scrapped: offered, and any reason may be typed. */
export const SCRAP_REASONS = ['Broken or damaged', 'Worn out', 'Out of tolerance and cannot be adjusted', 'Failed calibration', 'Lost', 'Replaced by a new instrument'] as const

/** The paper forms, for the printed copies and the Excel files. */
export const CALIBRATION_FORMS = {
  register: { code: 'F-Q-05-01', title: 'Calibration plan and register of measuring instruments' },
  scrap: { code: 'F-Q-05-03', title: 'Scrapping of measuring instruments' },
} as const

// ---- Days -------------------------------------------------------------------------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)

/**
 * A day some months later, as PostgreSQL's `date + interval 'n months'`: the
 * same day of the month, or the month's last when it has fewer days (31 Jan
 * and a month is 28 or 29 Feb).
 */
export function addMonths(day: string, months: number): string {
  const m = DAY.exec(day)
  if (!m) return ''
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + months
  const year = Math.floor(total / 12)
  const month = total - year * 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const date = Math.min(Number(m[3]), last)
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`
}

/** The next calibration: the last plus the interval; none without either. */
export function nextDueOn(last: string | null | undefined, months: number | null | undefined): string | null {
  if (!last || !isDay(last) || !months || months < 1) return null
  return addMonths(last, months)
}

/** Days from one day to another (negative when the second is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / 86_400_000)
}

/** Where an instrument stands on a day: out of use, without a date, overdue, due soon or valid. */
export function calibrationStatus(i: { nextDueOn: string | null; scrapped: boolean }, today: string): CalibrationStatus {
  if (i.scrapped) return 'scrapped'
  if (!i.nextDueOn) return 'no-date'
  const left = daysBetween(today, i.nextDueOn)
  if (left < 0) return 'overdue'
  if (left <= DUE_SOON_DAYS) return 'due-soon'
  return 'valid'
}

/** Days an instrument was in use before it was scrapped (the scrap form's أيام العمل). */
export function workingDays(receivedOn: string | null | undefined, scrappedOn: string | null | undefined): number | null {
  if (!receivedOn || !scrappedOn || !isDay(receivedOn) || !isDay(scrappedOn)) return null
  const d = daysBetween(receivedOn, scrappedOn)
  return d >= 0 ? d : null
}

// ---- Codes ------------------------------------------------------------------------

/** A calibration code as the plan writes them: prefix, number, department, its number (V.171.QC.02). */
const CODE = /^\s*([A-Za-z]{1,4})[.\-](\d{1,5})[.\-]([A-Za-z]{1,4}(?:[.\-]\d{1,3})?)\s*$/

/** The running number of a calibration code (171 of V.171.QC.02); null when it is not one (an external certificate's number). */
export function codeNumber(code: string): number | null {
  const m = CODE.exec(code)
  return m ? Number(m[2]) : null
}

/** The department part of a code (QC.02 of V.171.QC.02), as the plan writes it. */
export function codeDepartment(code: string): string | null {
  const m = CODE.exec(code)
  return m ? m[3].replace(/-/g, '.').toUpperCase() : null
}

/** The code a new instrument may take: its category's prefix, the next number, its department's code. */
export function suggestCode(prefix: string, number: number, departmentCode: string): string {
  const p = prefix.trim().toUpperCase()
  if (!p) return ''
  const n = String(number).padStart(2, '0')
  const d = departmentCode.trim().toUpperCase()
  return d ? `${p}.${n}.${d}` : `${p}.${n}`
}

// ---- Certificates ------------------------------------------------------------------

/** One reading: the reference's nominal value and what the instrument read. */
export interface CertificateReading {
  nominal: number | null
  reading: number | null
}
/** A group of readings (external, internal, depth measurements…). */
export interface CertificateGroup {
  name: string
  readings: CertificateReading[]
}
/** A category's certificate: its groups and their nominal values. */
export interface CertificateTemplateGroup {
  name: string
  nominals: number[]
}
/** The reference an instrument is checked against. */
export interface CalibrationReference {
  name: string
  manufacturer: string
  serial: string
  certificateNo: string
  body: string
}
export const EMPTY_REFERENCE: CalibrationReference = { name: '', manufacturer: '', serial: '', certificateNo: '', body: '' }

export const MAX_GROUPS = 8
export const MAX_READINGS = 20

export type CertificateResult = 'pass' | 'fail' | 'no-tolerance' | 'no-readings'
export const CERTIFICATE_RESULT_NAMES: Record<CertificateResult, string> = {
  pass: 'Within tolerance',
  fail: 'Out of tolerance',
  'no-tolerance': 'No tolerance set',
  'no-readings': 'No readings',
}

/** A reading's error, without the float noise of a subtraction (0.02, not 0.019999…). */
export function readingError(r: CertificateReading): number | null {
  if (r.nominal === null || r.reading === null) return null
  return Number((r.reading - r.nominal).toFixed(6))
}

/** Whether a reading is within the tolerance; null without one of them. */
export function readingOk(r: CertificateReading, tolerance: number | null): boolean | null {
  const e = readingError(r)
  if (e === null || tolerance === null) return null
  return Math.abs(e) <= tolerance + 1e-9
}

export interface CertificateJudgement {
  readings: number
  maxError: number | null
  result: CertificateResult
}

/** A certificate's verdict: out of tolerance when any reading is, within when all are. */
export function judgeCertificate(groups: readonly CertificateGroup[], tolerance: number | null): CertificateJudgement {
  const errors = groups.flatMap((g) => g.readings.map(readingError)).filter((e): e is number => e !== null)
  if (!errors.length) return { readings: 0, maxError: null, result: 'no-readings' }
  const maxError = errors.reduce((m, e) => (Math.abs(e) > Math.abs(m) ? e : m), 0)
  if (tolerance === null) return { readings: errors.length, maxError, result: 'no-tolerance' }
  return { readings: errors.length, maxError, result: errors.every((e) => Math.abs(e) <= tolerance + 1e-9) ? 'pass' : 'fail' }
}

/** A category's template as a certificate's empty groups. */
export const groupsFromTemplate = (template: readonly CertificateTemplateGroup[]): CertificateGroup[] =>
  template.map((g) => ({ name: g.name, readings: g.nominals.map((nominal) => ({ nominal, reading: null })) }))

// ---- Records ------------------------------------------------------------------------

export interface CalibrationCategory {
  id: string
  name: string
  codePrefix: string
  intervalMonths: number
  kind: CalibrationKind
  resolution: string
  tolerance: number | null
  unit: string
  template: CertificateTemplateGroup[]
  reference: CalibrationReference
  position: number
}
export type CalibrationCategoryInput = Omit<CalibrationCategory, 'id' | 'position'>

export interface CalibrationDepartment {
  id: string
  name: string
  code: string
  position: number
}
export type CalibrationDepartmentInput = Omit<CalibrationDepartment, 'id' | 'position'>

/** What is entered for an instrument. */
export interface CalibrationItemData {
  categoryId: string | null
  name: string
  deviceCode: string
  manufacturer: string
  range: string
  resolution: string
  tolerance: number | null
  unit: string
  departmentId: string | null
  holder: string
  receivedOn: string | null
  kind: CalibrationKind
  calibrationCode: string
  lastCalibratedOn: string | null
  intervalMonths: number
  notes: string
}

export interface CalibrationScrap {
  scrappedOn: string | null
  reason: string
  details: string
  byName: string
  at: string
}

export interface CalibrationItem extends CalibrationItemData {
  id: string
  categoryName: string
  departmentName: string
  /** The last calibration plus the interval (worked out, never typed). */
  nextDueOn: string | null
  status: CalibrationStatus
  /** Days to the next calibration: negative when overdue. */
  daysLeft: number | null
  scrap: CalibrationScrap | null
  workingDays: number | null
  certificates: number
  source: 'app' | 'import'
  version: number
  createdAt: string
  createdByName: string
  updatedAt: string
  updatedByName: string
}

export interface SaveCalibrationItemRequest extends CalibrationItemData {
  submissionId?: string
  version?: number
}

export interface ScrapCalibrationItemRequest {
  scrappedOn: string
  reason: string
  details: string
  version: number
}

/** A certificate as entered. */
export interface CalibrationCertificateData {
  itemId: string
  certificateNo: string
  kind: CalibrationKind
  calibratedOn: string
  intervalMonths: number
  /** Who calibrated it: the outside laboratory, for an external calibration. */
  body: string
  performedBy: string
  approvedBy: string
  resolution: string
  tolerance: number | null
  unit: string
  reference: CalibrationReference
  groups: CertificateGroup[]
  /** The outside laboratory's certificate as a PDF (POST /api/calibration/files). */
  fileId: string | null
  notes: string
}

export interface CalibrationCertificate extends CalibrationCertificateData {
  id: string
  nextDueOn: string
  readings: number
  maxError: number | null
  result: CertificateResult
  fileName: string | null
  /** The instrument as it is now, for the certificate's device data. */
  item: Pick<CalibrationItem, 'name' | 'deviceCode' | 'manufacturer' | 'range' | 'calibrationCode' | 'departmentName' | 'holder'>
  source: 'app' | 'import'
  version: number
  createdAt: string
  createdByName: string
  updatedAt: string
  updatedByName: string
}

export interface SaveCalibrationCertificateRequest extends CalibrationCertificateData {
  submissionId?: string
  version?: number
}

/** A change to an instrument, from the audit log. */
export interface CalibrationHistoryEntry {
  at: string
  userName: string
  action: string
  entity: string
  field: string | null
  oldValue: string | null
  newValue: string | null
  item: string | null
}

export interface CalibrationItemDetail {
  item: CalibrationItem
  certificates: CalibrationCertificate[]
  history: CalibrationHistoryEntry[]
}

export interface CalibrationItemListQuery {
  q?: string
  categoryId?: string
  departmentId?: string
  status?: string
  kind?: string
  /** Next calibration from / to (the plan of a month, a quarter…). */
  dueFrom?: string
  dueTo?: string
  /** 'scrap' — the scrap log: scrapped instruments, the latest first. */
  view?: 'plan' | 'scrap'
  offset?: number
  limit?: number
}

export type CalibrationCounts = Record<CalibrationStatus, number> & { total: number; inService: number }

export interface CalibrationItemList {
  items: CalibrationItem[]
  total: number
  hasMore: boolean
  /** Every instrument by status, whatever the status filter: the plan's cards. */
  counts: CalibrationCounts
}

export interface CalibrationOptions {
  categories: CalibrationCategory[]
  departments: CalibrationDepartment[]
  /** The next running number of a calibration code. */
  nextCodeNumber: number
  /** Who holds instruments now, for the holder field's suggestions. */
  holders: string[]
  today: string
}

export interface CalibrationFile {
  id: string
  fileName: string
  byteSize: number
}

// ---- The old workbooks ---------------------------------------------------------------

/** A row of the register (F-Q-05-01) to import. */
export interface CalibrationRegisterRow {
  department: string
  name: string
  deviceCode: string
  holder: string
  receivedOn: string | null
  kind: CalibrationKind
  calibrationCode: string
  lastCalibratedOn: string | null
  intervalMonths: number
  scrapped: boolean
  notes: string
}
/** A row of the certificates log: one internal certificate. */
export interface CalibrationCertificateLogRow {
  calibrationCode: string
  name: string
  manufacturer: string
  range: string
  resolution: string
  calibratedOn: string
  intervalMonths: number
  groups: CertificateGroup[]
}
/** A row of the scrap form (F-Q-05-03). */
export interface CalibrationScrapLogRow {
  department: string
  name: string
  holder: string
  receivedOn: string | null
  scrappedOn: string
}
export type CalibrationImport =
  | { kind: 'register'; rows: CalibrationRegisterRow[] }
  | { kind: 'certificates'; rows: CalibrationCertificateLogRow[] }
  | { kind: 'scrap'; rows: CalibrationScrapLogRow[] }
export interface CalibrationImportResult {
  created: number
  updated: number
  existing: number
  unmatched: number
}
export const CALIBRATION_IMPORT_CHUNK = 200

/** A name as it is compared: Arabic letters' variants made one, "ال" and spaces left out (تنايات = التنايات). */
export function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    // "ماكينةالسحب" written without its space is "ماكينة السحب".
    .replace(/(?<=[ةه])ال(?=..)/g, ' ')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .split(/\s+/)
    .map((w) => w.replace(/^ال(?=..)/, ''))
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

const cellDay = (raw: string | undefined): string | null => {
  const t = (raw ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(t) && isDay(t.slice(0, 10))) return t.slice(0, 10)
  if (/^\d{5}(\.\d+)?$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000).toISOString().slice(0, 10)
  return null
}
const cellNum = (raw: string | undefined): number | null => {
  const t = (raw ?? '').trim().replace(',', '.')
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null
  return Number(t)
}
const clean = (raw: string | undefined) => (raw ?? '').replace(/\s+/g, ' ').trim()

/** Whole months from one day to another, as the plan's two dates give the interval (12 for a year). */
export function monthsBetween(from: string, to: string): number | null {
  const a = DAY.exec(from), b = DAY.exec(to)
  if (!a || !b) return null
  let months = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]))
  if (Number(b[3]) - Number(a[3]) > 15) months++
  else if (Number(a[3]) - Number(b[3]) > 15) months--
  return months >= 1 && months <= MAX_INTERVAL_MONTHS ? months : null
}

/** The header row of a sheet: the first with all the given words (as nameKey compares them). */
function findHeader(rows: readonly (readonly string[])[], words: string[]): { index: number; col: (word: string) => number } | null {
  const keys = words.map(nameKey)
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map((c) => nameKey(String(c ?? '')))
    if (keys.every((k) => cells.some((c) => c.includes(k)))) {
      return { index: i, col: (word) => cells.findIndex((c) => c.includes(nameKey(word))) }
    }
  }
  return null
}

/**
 * The register (F-Q-05-01, its first sheet), read as text grids: found by its
 * header (القسم، اسم الجهاز، كود الجهاز، مستلم الجهاز، تاريخ الاستلام، نوع
 * المعايرة، كود المعايرة، تاريخ اخر معايرة، تاريخ المعايرة القادمة، KPI)
 * wherever its columns are. The interval is the months between its two
 * dates (twelve when it gives only the last); KPI هالك is scrapped; the
 * kind's number (داخلى 2) is kept in the notes.
 */
export function parseCalibrationRegister(rows: readonly (readonly string[])[]): { rows: CalibrationRegisterRow[]; skipped: number } {
  const header = findHeader(rows, ['اسم الجهاز', 'مستلم الجهاز', 'كود المعايرة'])
  if (!header) return { rows: [], skipped: 0 }
  const col = {
    department: header.col('القسم'),
    name: header.col('اسم الجهاز'),
    deviceCode: header.col('كود الجهاز') >= 0 ? header.col('كود الجهاز') : header.col('الرقم المسلسل'),
    holder: header.col('مستلم الجهاز'),
    received: header.col('تاريخ الاستلام'),
    kind: header.col('نوع المعايرة'),
    code: header.col('كود المعايرة'),
    last: header.col('اخر معايرة'),
    next: header.col('المعايرة القادمة'),
    kpi: header.col('KPI'),
  }
  const out: CalibrationRegisterRow[] = []
  let skipped = 0
  for (const row of rows.slice(header.index + 1)) {
    const c = (i: number) => (i >= 0 ? clean(row[i]) : '')
    const name = c(col.name)
    // The form's foot and its totals are not instruments.
    if (!name || /^(اسم الجهاز|Form Code|Prepared by|Approved by|Issue date)/i.test(name)) {
      if (c(col.department) || c(col.code)) skipped++
      continue
    }
    if (name.length > 200) { skipped++; continue }
    const last = cellDay(row[col.last])
    const next = cellDay(row[col.next])
    const kindText = c(col.kind)
    const kind: CalibrationKind = /خارج|external/i.test(kindText) ? 'external' : 'internal'
    out.push({
      department: c(col.department),
      name,
      deviceCode: c(col.deviceCode),
      holder: c(col.holder),
      receivedOn: cellDay(row[col.received]),
      kind,
      calibrationCode: c(col.code),
      lastCalibratedOn: last,
      intervalMonths: (last && next && monthsBetween(last, next)) || 12,
      scrapped: /هالك|scrap/i.test(c(col.kpi)),
      notes: kindText && /\d/.test(kindText) ? `Register type: ${kindText}` : '',
    })
  }
  return { rows: out, skipped }
}

/**
 * The certificates log (its first sheet): each row an internal certificate —
 * calibration code, instrument, manufacturer, range, resolution, calibration
 * and re-calibration days, then the readings in threes (nominal, reading,
 * error) under their group's heading (القياسات الخارجية، الداخلية، العمق).
 */
export function parseCalibrationCertificateLog(rows: readonly (readonly string[])[]): { rows: CalibrationCertificateLogRow[]; skipped: number } {
  const header = findHeader(rows, ['كود المعايرة', 'اسم الجهاز', 'تاريخ المعايرة'])
  if (!header) return { rows: [], skipped: 0 }
  const head = rows[header.index].map((c) => clean(c))
  const keys = head.map(nameKey)
  const find = (word: string, not?: string) => keys.findIndex((k) => k.includes(nameKey(word)) && (!not || !k.includes(nameKey(not))))
  const col = {
    code: find('كود المعايرة'),
    name: find('اسم الجهاز'),
    manufacturer: find('جهة الصنع'),
    range: find('المدى'),
    resolution: find('التدريجة'),
    date: find('تاريخ المعايرة', 'اعادة'),
    next: find('اعادة المعايرة'),
  }
  // The groups: each heading starts its threes, up to the next heading.
  const firstReading = Math.max(...Object.values(col)) + 1
  const starts = head.map((h, i) => ({ h, i })).filter((x) => x.i >= firstReading && x.h)
  const groups = starts.map((s, n) => ({ name: groupName(s.h), from: s.i, to: n + 1 < starts.length ? starts[n + 1].i : Number.MAX_SAFE_INTEGER }))
  const out: CalibrationCertificateLogRow[] = []
  let skipped = 0
  for (const row of rows.slice(header.index + 1)) {
    const c = (i: number) => (i >= 0 ? clean(row[i]) : '')
    const code = c(col.code)
    const calibratedOn = cellDay(row[col.date])
    if (!code || !calibratedOn) {
      if (code || c(col.name)) skipped++
      continue
    }
    const next = cellDay(row[col.next])
    const readGroups: CertificateGroup[] = []
    for (const g of groups) {
      const readings: CertificateReading[] = []
      for (let i = g.from; i + 1 < Math.min(g.to, row.length + 1); i += 3) {
        const nominal = cellNum(row[i]), reading = cellNum(row[i + 1])
        if (nominal !== null || reading !== null) readings.push({ nominal, reading })
      }
      if (readings.length) readGroups.push({ name: g.name, readings: readings.slice(0, MAX_READINGS) })
    }
    out.push({
      calibrationCode: code,
      name: c(col.name),
      manufacturer: c(col.manufacturer),
      range: c(col.range),
      resolution: c(col.resolution),
      calibratedOn,
      intervalMonths: (next && monthsBetween(calibratedOn, next)) || 12,
      groups: readGroups.slice(0, MAX_GROUPS),
    })
  }
  return { rows: out, skipped }
}

/** A group's heading as the certificate names it, in both languages. */
function groupName(heading: string): string {
  const k = nameKey(heading)
  if (k.includes(nameKey('الخارجية'))) return 'القياسات الخارجية / External Measurements'
  if (k.includes(nameKey('الداخلية'))) return 'القياسات الداخلية / Internal Measurements'
  if (k.includes(nameKey('العمق'))) return 'قياسات العمق / Depth Measurements'
  return heading
}

/**
 * The scrap form (F-Q-05-03): department, instrument, holder, received and
 * scrapped days. A row without a scrapped day is not a scrapping.
 */
export function parseCalibrationScrapLog(rows: readonly (readonly string[])[]): { rows: CalibrationScrapLogRow[]; skipped: number } {
  const header = findHeader(rows, ['اسم الجهاز', 'مستلم الجهاز', 'تاريخ التكهين'])
  if (!header) return { rows: [], skipped: 0 }
  const col = { department: header.col('القسم'), name: header.col('اسم الجهاز'), holder: header.col('مستلم الجهاز'), received: header.col('تاريخ الاستلام'), scrapped: header.col('تاريخ التكهين') }
  const out: CalibrationScrapLogRow[] = []
  let skipped = 0
  // The form leaves the department empty under the first row of each: it carries down.
  let department = ''
  for (const row of rows.slice(header.index + 1)) {
    const c = (i: number) => (i >= 0 ? clean(row[i]) : '')
    if (c(col.department)) department = c(col.department)
    const name = c(col.name)
    const scrappedOn = cellDay(row[col.scrapped])
    if (!name || !scrappedOn) {
      if (name) skipped++
      continue
    }
    out.push({ department, name: name.slice(0, 200), holder: c(col.holder), receivedOn: cellDay(row[col.received]), scrappedOn })
  }
  return { rows: out, skipped }
}
