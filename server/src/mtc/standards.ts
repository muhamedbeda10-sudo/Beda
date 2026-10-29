// ============================================================================
// The lab's grades (Lab → Setup) as the coil register judges its certificates
// by them: each coil's grade and thickness find their band (shared/lab
// gradeRows, gradeFor — as a lab test of the coil is judged), whose limits are
// copied onto the coil; the database generates yield_ok, tensile_ok and
// elongation_ok from them (the MTC tab's green and red).
//
// Worked out again whenever something it depends on changes: a coil saved
// from a certificate or an import, a grade's limits, a grade equivalence.
// Only coils whose limits move are written.
// ============================================================================

import type { LabGrade } from '@qc/shared/lab'
import { gradeFor, gradeRows } from '@qc/shared/lab'
import { buildGradeIndex } from '@qc/shared/rules'
import type { Queryable } from '../db/pool'

const n = (c: string) => `${c}::float8`

export const GRADE_SELECT = `id, family, grade, standard, ${n('thickness_from')} AS "thicknessFrom", ${n('thickness_to')} AS "thicknessTo",
  ${n('yield_min')} AS "yieldMin", ${n('yield_max')} AS "yieldMax", ${n('tensile_min')} AS "tensileMin", ${n('tensile_max')} AS "tensileMax",
  ${n('elongation_min')} AS "elongationMin", hardness, position`

export async function loadGrades(q: Queryable): Promise<LabGrade[]> {
  return (await q.query<LabGrade>(`SELECT ${GRADE_SELECT} FROM lab_grades WHERE deleted_at IS NULL ORDER BY family, position, lower(grade), thickness_from NULLS FIRST`)).rows
}

export async function loadEquivalence(q: Queryable) {
  const { rows } = await q.query<{ gradeA: string; gradeB: string }>(`SELECT grade_a AS "gradeA", grade_b AS "gradeB" FROM grade_mappings WHERE deleted_at IS NULL`)
  return { mappings: rows, index: buildGradeIndex(rows) }
}

/**
 * Judge the coils again — these, or every live one — against the lab's
 * grades as they are now. Returns how many coils' limits changed.
 */
export async function judgeCoils(q: Queryable, coilIds?: readonly string[]): Promise<number> {
  if (coilIds && coilIds.length === 0) return 0
  const [grades, { index }] = await Promise.all([loadGrades(q), loadEquivalence(q)])
  const coils = await q.query<{ id: string; grade: string | null; thickness: number | null }>(
    `SELECT id, grade, thickness::float8 AS thickness FROM coils WHERE deleted_at IS NULL ${coilIds ? 'AND id = ANY($1::uuid[])' : ''}`,
    coilIds ? [coilIds] : [],
  )
  if (coils.rows.length === 0) return 0
  const judged = coils.rows.map((c) => {
    const g = c.grade ? gradeFor(gradeRows(grades, 'sheet', c.grade, index), c.thickness) : null
    return {
      id: c.id,
      std_grade: g?.grade ?? null,
      std_standard: g ? g.standard || null : null,
      yield_min: g?.yieldMin ?? null,
      yield_max: g?.yieldMax ?? null,
      tensile_min: g?.tensileMin ?? null,
      tensile_max: g?.tensileMax ?? null,
      elongation_min: g?.elongationMin ?? null,
    }
  })
  const res = await q.query(
    `UPDATE coils c SET std_grade = j.std_grade, std_standard = j.std_standard, yield_min = j.yield_min, yield_max = j.yield_max,
            tensile_min = j.tensile_min, tensile_max = j.tensile_max, elongation_min = j.elongation_min
       FROM jsonb_to_recordset($1::jsonb) AS j(id uuid, std_grade text, std_standard text, yield_min numeric, yield_max numeric,
                                               tensile_min numeric, tensile_max numeric, elongation_min numeric)
      WHERE c.id = j.id
        AND (c.std_grade, c.std_standard, c.yield_min, c.yield_max, c.tensile_min, c.tensile_max, c.elongation_min)
            IS DISTINCT FROM (j.std_grade, j.std_standard, j.yield_min::numeric(10, 2), j.yield_max::numeric(10, 2),
                              j.tensile_min::numeric(10, 2), j.tensile_max::numeric(10, 2), j.elongation_min::numeric(6, 2))`,
    [JSON.stringify(judged)],
  )
  return res.rowCount ?? 0
}
