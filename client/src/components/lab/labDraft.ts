// What the lab's form holds while it is filled: the report's numbers as typed
// (a comma or a trailing point is fine until it is saved), and the working
// the report shows as the cells are filled — the test standard, the grade's
// limits for the thickness, the averages and whether each result meets them.

import {
  LAB_SPECIMEN_ROWS, SPECIMEN_INFO, gradeFor, gradeRows, judge, limitsOf, sizeThickness,
  type LabGrade, type LabJudgement, type LabLimits, type LabOptions, type LabSpecimenResult, type LabTest, type LabTestData,
} from '@qc/shared/lab'
import { buildGradeIndex } from '@qc/shared/rules'
import { isDecimalOrBlank, parseDecimal } from '@/lib/decimal'

type NumberKey = 'hardness' | 'mtcTensile' | 'mtcYield' | 'mtcElongation'
export const DRAFT_NUMBERS: readonly NumberKey[] = ['hardness', 'mtcTensile', 'mtcYield', 'mtcElongation']

export interface SpecimenDraft { tensile: string; yield: string; elongation: string }
export type LabDraft = Omit<LabTestData, NumberKey | 'specimens'> & Record<NumberKey, string> & { specimens: SpecimenDraft[] }

const text = (v: number | null) => (v === null || v === undefined ? '' : String(v))

export function toDraft(d: LabTestData): LabDraft {
  const rows = d.specimens.length ? d.specimens : []
  const specimens = Array.from({ length: Math.max(LAB_SPECIMEN_ROWS, rows.length) }, (_, i) => ({
    tensile: text(rows[i]?.tensile ?? null), yield: text(rows[i]?.yield ?? null), elongation: text(rows[i]?.elongation ?? null),
  }))
  return { ...d, hardness: text(d.hardness), mtcTensile: text(d.mtcTensile), mtcYield: text(d.mtcYield), mtcElongation: text(d.mtcElongation), specimens }
}

export function fromDraft(d: LabDraft): LabTestData {
  const specimens: LabSpecimenResult[] = d.specimens.map((s) => ({ tensile: parseDecimal(s.tensile), yield: parseDecimal(s.yield), elongation: parseDecimal(s.elongation) }))
  // The rows after the last one filled are not kept: a report of one bolt is one row.
  while (specimens.length && specimens[specimens.length - 1].tensile === null && specimens[specimens.length - 1].yield === null && specimens[specimens.length - 1].elongation === null) specimens.pop()
  return { ...d, hardness: parseDecimal(d.hardness), mtcTensile: parseDecimal(d.mtcTensile), mtcYield: parseDecimal(d.mtcYield), mtcElongation: parseDecimal(d.mtcElongation), specimens }
}

/** The numbers typed that are not numbers: their cells, to say so beside them. */
export function draftProblems(d: LabDraft): string[] {
  const bad: string[] = []
  d.specimens.forEach((s, i) => (['tensile', 'yield', 'elongation'] as const).forEach((k) => { if (!isDecimalOrBlank(s[k])) bad.push(`Sample ${i + 1} ${k}`) }))
  for (const k of DRAFT_NUMBERS) if (!isDecimalOrBlank(d[k])) bad.push(k)
  return bad
}

/** What the report works out from what is entered. */
export interface LabWorking {
  sizeLabel: string
  testStandard: string
  materialStandard: string
  thickness: number | null
  grade: LabGrade | null
  limits: LabLimits
  hardnessSpec: string
  judgement: LabJudgement
}

export function workDraft(d: LabTestData, options: Pick<LabOptions, 'grades' | 'gradeMappings'>): LabWorking {
  const info = SPECIMEN_INFO[d.specimenType]
  const thickness = sizeThickness(d.specimenType, d.size)
  const grade = gradeFor(gradeRows(options.grades, info.family, d.grade, buildGradeIndex(options.gradeMappings)), thickness)
  const limits = limitsOf(grade)
  return { sizeLabel: info.sizeLabel, testStandard: info.testStandard, materialStandard: grade?.standard ?? '', thickness, grade, limits, hardnessSpec: grade?.hardness ?? '', judgement: judge(d.specimens, limits) }
}

/** A saved test as its report shows it: the limits it was judged by, whatever the grade's are now. */
export function workSaved(t: LabTest): LabWorking {
  const { tensileAvg, yieldAvg, elongationAvg, tensileOk, yieldOk, elongationOk, result } = t
  return {
    sizeLabel: SPECIMEN_INFO[t.specimenType].sizeLabel, testStandard: t.testStandard, materialStandard: t.materialStandard, thickness: t.thickness,
    grade: null, limits: t.limits, hardnessSpec: t.hardnessSpec, judgement: { tensileAvg, yieldAvg, elongationAvg, tensileOk, yieldOk, elongationOk, result },
  }
}
