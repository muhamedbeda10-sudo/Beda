// ============================================================================
// §26 — The lab: tensile (and hardness) tests of the material that comes in —
// coils of black and galvanized sheet, bolts and wire. Each test is recorded
// on the company's Material Testing Report (form F-Q-02-20), field for field
// as the paper and its workbook have it, and is a row of the tensile testing
// machine's log at the same time: one entry, never written twice.
//
//   • What is chosen from a list comes from the lab's own lists, kept on the
//     Lab tab's Setup: the specimen type decides which size list and which
//     grade list apply (a sheet's thickness and the sheet grades; a bolt's
//     size and the bolt grades; a wire's thickness and the wire grades, or
//     any grade typed when Setup lists none).
//   • A grade's limits (minimum yield, the tensile range, minimum elongation)
//     may depend on the thickness (EN 10025-2, EN 10149-2): the band that
//     holds the specimen's thickness applies. They are copied onto the test
//     when it is saved, so a later change to the list never rewrites a test.
//   • A sheet's specimen code is its coil number: the coil register (the MTC
//     tab's coils) gives the grade, thickness, supplier and the certificate's
//     yield, and the coil's page shows its lab tests.
//   • Every specimen must meet the limits: a test passes when every specimen
//     does, fails when one does not (the database works the same out, so a
//     filter and a screen always agree).
// ============================================================================

import type { Permission } from './permissions'
import { normaliseGrade } from './rules'

export const LAB_SPECIMENS = ['Black Sheet', 'Galvanized Sheet', 'Bolt', 'Wire'] as const
export type LabSpecimen = (typeof LAB_SPECIMENS)[number]
export const isLabSpecimen = (v: unknown): v is LabSpecimen => typeof v === 'string' && (LAB_SPECIMENS as readonly string[]).includes(v)

export type LabFamily = 'sheet' | 'bolt' | 'wire'
export const LAB_FAMILIES: readonly LabFamily[] = ['sheet', 'bolt', 'wire']
export const LAB_FAMILY_NAMES: Record<LabFamily, string> = { sheet: 'Sheet', bolt: 'Bolt', wire: 'Wire' }

/** The lab's lists, edited on Setup. */
export const LAB_LISTS = ['sheet-thickness', 'bolt-size', 'wire-thickness', 'indenter', 'scale', 'machine'] as const
export type LabList = (typeof LAB_LISTS)[number]
export const LAB_LIST_NAMES: Record<LabList, string> = {
  'sheet-thickness': 'Sheet thickness',
  'bolt-size': 'Bolt size',
  'wire-thickness': 'Wire thickness',
  indenter: 'Indenter',
  scale: 'Rockwell scale',
  machine: 'Testing machine',
}

/** What the report's cells read for each kind of specimen (the workbook's formulas, as rules). */
export const SPECIMEN_INFO: Record<LabSpecimen, { family: LabFamily; sizeLabel: string; sizeList: LabList; testStandard: string }> = {
  'Black Sheet': { family: 'sheet', sizeLabel: 'Material Thickness', sizeList: 'sheet-thickness', testStandard: 'EN 10002-1' },
  'Galvanized Sheet': { family: 'sheet', sizeLabel: 'Material Thickness', sizeList: 'sheet-thickness', testStandard: 'EN 10002-1' },
  Bolt: { family: 'bolt', sizeLabel: 'Bolt size', sizeList: 'bolt-size', testStandard: 'ISO 898-1' },
  Wire: { family: 'wire', sizeLabel: 'Wire Thickness', sizeList: 'wire-thickness', testStandard: '' },
}

export const LAB_TEST_TYPE = 'Tensile'
export const HARDNESS_STANDARD = 'EN-ISO 6508'
/** Rows of the report's Test Results: three, as the form has them; a bolt or wire test may fill fewer. */
export const LAB_SPECIMEN_ROWS = 3
export const LAB_MAX_SPECIMENS = 10

export interface LabFormReference { code: string; issue: string; issueDate: string }
/** The paper's document control (the form's foot). */
export const LAB_FORM: LabFormReference = { code: 'F-Q-02-20', issue: '1', issueDate: '2024-12-23' }

export const LAB_PERMISSIONS: { view: Permission; record: Permission; setup: Permission } = { view: 'view-lab', record: 'record-lab-test', setup: 'manage-lab-setup' }

// ---- Master data ----------------------------------------------------------------

/** A grade's limits, for one thickness band (or every thickness, with no band). */
export interface LabGrade {
  id: string
  family: LabFamily
  grade: string
  standard: string
  /** The band: from (inclusive) and to (exclusive), in mm; null is open. */
  thicknessFrom: number | null
  thicknessTo: number | null
  yieldMin: number | null
  yieldMax: number | null
  tensileMin: number | null
  tensileMax: number | null
  elongationMin: number | null
  /** The hardness the grade expects, as its standard writes it (shown, not judged: the scale varies). */
  hardness: string
  position: number
}
export type LabGradeInput = Omit<LabGrade, 'id' | 'position'>

export interface LabListValue { id: string; list: LabList; value: string; position: number }

/** The limits a test is judged by: copied from its grade's band at the save. */
export interface LabLimits {
  yieldMin: number | null
  yieldMax: number | null
  tensileMin: number | null
  tensileMax: number | null
  elongationMin: number | null
}
export const NO_LIMITS: LabLimits = { yieldMin: null, yieldMax: null, tensileMin: null, tensileMax: null, elongationMin: null }

// ---- A test -------------------------------------------------------------------------

export interface LabSpecimenResult {
  /** N/mm². */
  tensile: number | null
  /** N/mm². */
  yield: number | null
  /** %. */
  elongation: number | null
}

export type LabVerdict = 'pass' | 'fail' | 'no-limits' | 'no-results'
export const LAB_VERDICT_NAMES: Record<LabVerdict, string> = { pass: 'Pass', fail: 'Fail', 'no-limits': 'No limits', 'no-results': 'No results' }

/** What is entered on the report, and on its row of the machine log. */
export interface LabTestData {
  reference: string
  testDate: string
  specimenType: LabSpecimen
  /** The coil number for a sheet; the batch for a bolt or wire. */
  specimenCode: string
  /** The thickness, bolt size or wire thickness, as listed ("2.4 mm", "M12"). */
  size: string
  grade: string
  machine: string
  specimens: LabSpecimenResult[]
  indenter: string
  hardnessScale: string
  hardness: number | null
  /** From the coil register when the coil is there. */
  supplier: string
  /** The supplier's mill test certificate (the log's "certificate"). */
  certificate: string
  /** The log's "CUS No.". */
  cusNo: string
  /** The supplier certificate's own results (the log's "MTC Results"). */
  mtcTensile: number | null
  mtcYield: number | null
  mtcElongation: number | null
  testedBy: string
  notes: string
  /** The curve the machine drew, and any other photo. */
  imageIds: string[]
}

export interface LabTest extends LabTestData {
  id: string
  /** Worked out at the save, as the report shows them. */
  testStandard: string
  materialStandard: string
  thickness: number | null
  limits: LabLimits
  hardnessSpec: string
  hardnessStandard: string
  tensileAvg: number | null
  yieldAvg: number | null
  elongationAvg: number | null
  tensileOk: boolean | null
  yieldOk: boolean | null
  elongationOk: boolean | null
  result: LabVerdict
  /** The coil register knows this specimen code. */
  coilFound: boolean
  source: 'app' | 'log-import'
  form: LabFormReference
  version: number
  createdAt: string
  createdByName: string
  updatedAt: string
  updatedByName: string
}

export interface SaveLabTestRequest extends LabTestData {
  submissionId?: string
  version?: number
}

export interface LabTestListQuery { q?: string; specimenType?: string; result?: string; from?: string; to?: string; offset?: number; limit?: number }
export interface LabTestList { tests: LabTest[]; total: number; hasMore: boolean }

export interface LabOptions {
  grades: LabGrade[]
  lists: LabListValue[]
  /** The configuration's grade equivalences, so a coil's grade finds its lab grade. */
  gradeMappings: { gradeA: string; gradeB: string }[]
  /** The reference the next test would get. */
  nextReference: string
}

/** GET /api/lab/coil — what the coil register knows of a specimen code. */
export interface LabCoilLookup {
  coil: {
    coilNumber: string
    grade: string
    supplier: string
    thickness: number | null
    /** The certificate's own results, as the MTC tab registered them. */
    yield: number | null
    tensile: number | null
    elongation: number | null
    /** The certificate's number ('' when not registered). */
    mtcNumber: string
    notes: string
  } | null
  tests: { id: string; reference: string; testDate: string; result: LabVerdict }[]
}

/** GET /api/lab/by-coils — a coil's tests on Coil search (coilNumber in lower case). */
export interface LabCoilTest { coilNumber: string; id: string; reference: string; testDate: string; result: LabVerdict }

/** A row of the machine log (the workbook), read for import. */
export interface LabLogRow {
  reference: string
  testDate: string
  specimenType: LabSpecimen
  specimenCode: string
  size: string
  grade: string
  tensile: number | null
  yield: number | null
  elongation: number | null
  hardness: number | null
  certificate: string
  cusNo: string
  testedBy: string
  notes: string
  mtcTensile: number | null
  mtcYield: number | null
  mtcElongation: number | null
}
export interface LabImportResult { created: number; existing: number }
export const LAB_IMPORT_CHUNK = 200

// ---- Rules ---------------------------------------------------------------------------

/** The first number in a size ("2.4 mm" → 2.4, "wire -Ø 4.3" → 4.3); a bolt's size has none that is a thickness. */
export function sizeThickness(specimen: LabSpecimen, size: string): number | null {
  if (SPECIMEN_INFO[specimen].family === 'bolt') return null
  const m = /(\d+(?:[.,]\d+)?)/.exec(size ?? '')
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  // A size is millimetres: a larger first number is not a thickness (a length, a count).
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null
}

/** A grade compared without case, spaces, - _ . and a coating ("S350GD+Z275" is S350GD). */
export function labGradeKey(g: string): string {
  return String(g ?? '')
    .toLowerCase()
    .replace(/\+.*$/, '')
    .replace(/[\s\-_.]/g, '')
}

/**
 * The grade rows a grade name finds in a family: the same name, else one the
 * configuration's grade equivalences link it to (an equivalence index of
 * normalised names, as shared/rules buildGradeIndex makes it).
 */
export function gradeRows(grades: readonly LabGrade[], family: LabFamily, grade: string, equivalence?: Map<string, string>): LabGrade[] {
  const key = labGradeKey(grade)
  if (!key) return []
  const inFamily = grades.filter((g) => g.family === family)
  const same = inFamily.filter((g) => labGradeKey(g.grade) === key)
  if (same.length || !equivalence) return same
  const roots = (g: string) => new Set([normaliseGrade(g), labGradeKey(g)].map((k) => equivalence.get(k) ?? k))
  const wanted = roots(grade)
  return inFamily.filter((g) => [...roots(g.grade)].some((r) => wanted.has(r)))
}

const inBand = (g: LabGrade, t: number | null) => (g.thicknessFrom === null && g.thicknessTo === null) || (t !== null && (g.thicknessFrom === null || t >= g.thicknessFrom) && (g.thicknessTo === null || t < g.thicknessTo))

/** The row whose band holds the thickness; the only row when there is one, whatever the thickness. */
export function gradeFor(rows: readonly LabGrade[], thickness: number | null): LabGrade | null {
  if (rows.length === 1) return rows[0]
  return rows.find((g) => inBand(g, thickness)) ?? null
}

export const limitsOf = (g: LabGrade | null): LabLimits =>
  g ? { yieldMin: g.yieldMin, yieldMax: g.yieldMax, tensileMin: g.tensileMin, tensileMax: g.tensileMax, elongationMin: g.elongationMin } : NO_LIMITS

const fmt = (n: number) => String(Number(n.toFixed(3)))
/** A limit as the report writes it: "480-620", "420", "≥ 360", "≤ 280"; empty for none. */
export function rangeText(min: number | null, max: number | null, minOnly = false): string {
  if (min !== null && max !== null) return `${fmt(min)}-${fmt(max)}`
  if (min !== null) return minOnly ? fmt(min) : `≥ ${fmt(min)}`
  if (max !== null) return `≤ ${fmt(max)}`
  return ''
}

/** Whether a value lies within limits; null when there is no value or no limit. */
export function withinLimits(value: number | null, min: number | null, max: number | null): boolean | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (min === null && max === null) return null
  return (min === null || value >= min) && (max === null || value <= max)
}

const present = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/** The mean of the values entered, to 0.01; null for none. */
export function average(values: readonly (number | null)[]): number | null {
  const xs = values.filter(present)
  if (!xs.length) return null
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100
}

/** Every specimen's value judged: false when one fails, true when all that were judged pass, null when none was. */
export function allWithin(values: readonly (number | null)[], min: number | null, max: number | null): boolean | null {
  const checks = values.map((v) => withinLimits(v, min, max)).filter((c): c is boolean => c !== null)
  if (!checks.length) return null
  return checks.every(Boolean)
}

export interface LabJudgement {
  tensileAvg: number | null
  yieldAvg: number | null
  elongationAvg: number | null
  tensileOk: boolean | null
  yieldOk: boolean | null
  elongationOk: boolean | null
  result: LabVerdict
}

/** A test's averages and verdict, as the database works them out (lab_tests' generated columns). */
export function judge(specimens: readonly LabSpecimenResult[], limits: LabLimits): LabJudgement {
  const rows = specimens.filter((s) => present(s.tensile) || present(s.yield) || present(s.elongation))
  const col = (k: keyof LabSpecimenResult) => rows.map((s) => s[k])
  const tensileOk = allWithin(col('tensile'), limits.tensileMin, limits.tensileMax)
  const yieldOk = allWithin(col('yield'), limits.yieldMin, limits.yieldMax)
  const elongationOk = allWithin(col('elongation'), limits.elongationMin, null)
  const checks = [tensileOk, yieldOk, elongationOk]
  const result: LabVerdict = !rows.length ? 'no-results' : checks.includes(false) ? 'fail' : checks.includes(true) ? 'pass' : 'no-limits'
  return { tensileAvg: average(col('tensile')), yieldAvg: average(col('yield')), elongationAvg: average(col('elongation')), tensileOk, yieldOk, elongationOk, result }
}

/** Ours less the supplier certificate's: the log's variance columns. */
export function variance(ours: number | null, mtc: number | null): number | null {
  return present(ours) && present(mtc) ? Math.round((ours - mtc) * 100) / 100 : null
}

/** A reference the lab numbers itself: "93-26" — the test's number in its year, then the year's last two digits. */
export function parseLabReference(reference: string): { number: number; year: number } | null {
  const m = /^\s*0*(\d{1,6})\s*-\s*(\d{2})\s*$/.exec(reference ?? '')
  return m ? { number: Number(m[1]), year: 2000 + Number(m[2]) } : null
}
export const labReference = (n: number, year: number) => `${n}-${String(year % 100).padStart(2, '0')}`

export function emptyLabTest(today: string, testedBy: string, machine = ''): LabTestData {
  return {
    reference: '', testDate: today, specimenType: 'Black Sheet', specimenCode: '', size: '', grade: '', machine,
    specimens: Array.from({ length: LAB_SPECIMEN_ROWS }, () => ({ tensile: null, yield: null, elongation: null })),
    indenter: '', hardnessScale: '', hardness: null, supplier: '', certificate: '', cusNo: '',
    mtcTensile: null, mtcYield: null, mtcElongation: null, testedBy, notes: '', imageIds: [],
  }
}

// ---- The machine log workbook ---------------------------------------------------------------

/** "Sheet", "Glavanized Sheet", "Tube 50*50": the log's own words, as a specimen type; null for a row that is not a test. */
export function logSpecimen(raw: string, grade: string): LabSpecimen | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return null
  const g = grade.replace(/\s/g, '')
  const galvanized = /(^z\.?c|gd|dx5|\+z)/i.test(g)
  // The log's type column was copied down by formula: a "bolt" of a sheet grade (S420, DC01, Z.C) is a sheet.
  if (s.includes('bolt')) return /^(s\d|dc\d|dx\d|hc\d|z\.?c|black)/i.test(g) ? (galvanized ? 'Galvanized Sheet' : 'Black Sheet') : 'Bolt'
  if (s.includes('wire')) return 'Wire'
  if (s.includes('galv') || s.includes('glav')) return 'Galvanized Sheet'
  if (s.includes('black')) return 'Black Sheet'
  // "Sheet": galvanized when its grade says so (Z.C, DX51D, S…GD), else black.
  if (s.includes('sheet')) return galvanized ? 'Galvanized Sheet' : 'Black Sheet'
  return null
}

const num = (raw: string): number | null => {
  const t = (raw ?? '').trim().replace(',', '.')
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null
  return Number(t)
}

/** An Excel day serial, or text a Date reads, as YYYY-MM-DD; '' when it is neither. */
function logDay(raw: string): string {
  const t = (raw ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  if (/^\d{5}(\.\d+)?$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000).toISOString().slice(0, 10)
  return ''
}

/**
 * The tensile testing machine's log (sheet 1 of its workbook, read as text
 * grids: shared/xlsx on the client), as tests to import. Its columns: No.,
 * Date, Name, Bolt/Sheet, Grade, Dimensions, Batch No., the average Rm, ReH
 * and A, Hardness, certificate, CUS No., REPORT, Tested by, Notes, then the
 * certificate's Rm, ReH and A. A row with no date, no type or no result is a
 * number kept for later, not a test. A certificate written as a date serial
 * (45714) reads as that day.
 */
export function parseLabLog(rows: readonly (readonly string[])[]): { tests: LabLogRow[]; skipped: number } {
  const tests: LabLogRow[] = []
  let skipped = 0
  const seen = new Map<string, number>()
  for (const row of rows) {
    const c = (i: number) => String(row[i] ?? '').trim()
    const testDate = logDay(c(1))
    const grade = c(4)
    const specimenType = logSpecimen(c(3), grade)
    const tensile = num(c(7)), yieldValue = num(c(8)), elongation = num(c(9))
    if (!testDate || !specimenType || (tensile === null && yieldValue === null && elongation === null)) {
      if (testDate || c(3)) skipped++
      continue
    }
    let reference = c(2) || c(13) || `${c(0)}-${testDate.slice(2, 4)}`
    // The log wrote early 2026 year first ("26-3"): turned round when its first part is the test's year and its last is not.
    const yy = testDate.slice(2, 4)
    const parts = /^\s*(\d{1,6})\s*-\s*(\d{1,6})\s*$/.exec(reference)
    if (parts && Number(parts[2]) !== Number(yy) && Number(parts[1]) === Number(yy)) reference = `${parts[2]}-${yy}`
    const parsed = parseLabReference(reference)
    if (parsed) reference = labReference(parsed.number, parsed.year)
    // The log repeats a name now and then: the second is its own test.
    const n = (seen.get(reference.toLowerCase()) ?? 0) + 1
    seen.set(reference.toLowerCase(), n)
    if (n > 1) reference = `${reference} (${n})`
    const certificate = c(11) === 'N/A' || c(11) === '0' ? '' : /^\d{5}$/.test(c(11)) ? logDay(c(11)) : c(11)
    const hardnessText = c(10)
    const hardness = num(hardnessText)
    const notes = [c(15), hardness === null && hardnessText ? `Hardness ${hardnessText}` : ''].filter(Boolean).join(' · ')
    tests.push({
      reference, testDate, specimenType, specimenCode: c(6), size: c(5), grade, tensile, yield: yieldValue, elongation, hardness,
      certificate, cusNo: c(12).trim(), testedBy: c(14) === '#REF!' ? '' : c(14), notes,
      mtcTensile: num(c(16)), mtcYield: num(c(17)), mtcElongation: num(c(18)),
    })
  }
  return { tests, skipped }
}

/** Search text for a list of tests, the way the log is searched. */
export const labTestText = (t: Pick<LabTest, 'reference' | 'specimenCode' | 'grade' | 'size' | 'supplier' | 'certificate' | 'notes'>) =>
  [t.reference, t.specimenCode, t.grade, t.size, t.supplier, t.certificate, t.notes].join(' ')
