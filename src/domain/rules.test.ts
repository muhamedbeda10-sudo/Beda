import { describe, it, expect } from 'vitest'
import {
  deriveShift,
  shiftStartDate,
  dimensionStatus,
  stepsForWorkCenter,
  isPaintWorkCenter,
  isPTWorkCenter,
  normaliseWorkCenter,
  normaliseGrade,
  buildGradeIndex,
  gradesEquivalent,
  findGradeMismatches,
  validateSample,
  resolveDimensions,
  can,
} from './rules'

// Local time is what the factory clock shows, so build dates in local time.
const at = (h: number, m = 0, day = 15) => new Date(2026, 5, day, h, m, 0, 0)

describe('§8.1 shift derivation', () => {
  it('maps morning hours to A', () => {
    expect(deriveShift(at(8, 0))).toBe('A')
    expect(deriveShift(at(12, 30))).toBe('A')
    expect(deriveShift(at(15, 59))).toBe('A')
  })

  it('maps afternoon hours to B', () => {
    expect(deriveShift(at(16, 0))).toBe('B')
    expect(deriveShift(at(18, 59))).toBe('B')
  })

  it('maps evening and early-morning hours to C', () => {
    expect(deriveShift(at(19, 0))).toBe('C')
    expect(deriveShift(at(23, 59))).toBe('C')
    expect(deriveShift(at(0, 0))).toBe('C')
    expect(deriveShift(at(7, 59))).toBe('C')
  })

  it('switches exactly on the boundaries', () => {
    expect(deriveShift(at(7, 59))).toBe('C')
    expect(deriveShift(at(8, 0))).toBe('A')
    expect(deriveShift(at(15, 59))).toBe('A')
    expect(deriveShift(at(16, 0))).toBe('B')
    expect(deriveShift(at(18, 59))).toBe('B')
    expect(deriveShift(at(19, 0))).toBe('C')
  })

  // The boundary the spec insists on testing explicitly.
  it('attributes a 02:00 sample to the night shift that began the previous evening', () => {
    expect(deriveShift(at(2, 0, 16))).toBe('C')
    expect(shiftStartDate(at(2, 0, 16))).toBe('2026-06-15')
    // ...the same night as a 21:00 sample taken the evening before
    expect(shiftStartDate(at(21, 0, 15))).toBe('2026-06-15')
  })

  it('keeps day-shift samples on their own calendar date', () => {
    expect(shiftStartDate(at(9, 0, 16))).toBe('2026-06-16')
    expect(shiftStartDate(at(23, 0, 16))).toBe('2026-06-16')
  })

  it('rolls the month back correctly at a month boundary', () => {
    expect(shiftStartDate(new Date(2026, 6, 1, 3, 0))).toBe('2026-06-30')
  })
})

describe('§8.2 dimension status', () => {
  const spec = { nominal: 100, tolPlus: 1, tolMinus: 1 }

  it('is Pending with no measurement', () => {
    expect(dimensionStatus({ ...spec, actual: null })).toBe('Pending')
    expect(dimensionStatus({ ...spec, actual: NaN })).toBe('Pending')
  })

  it('passes comfortably inside tolerance', () => {
    expect(dimensionStatus({ ...spec, actual: 100 })).toBe('Pass')
    expect(dimensionStatus({ ...spec, actual: 100.5 })).toBe('Pass')
    expect(dimensionStatus({ ...spec, actual: 99.5 })).toBe('Pass')
  })

  it('fails outside tolerance', () => {
    expect(dimensionStatus({ ...spec, actual: 101.01 })).toBe('Fail')
    expect(dimensionStatus({ ...spec, actual: 98.99 })).toBe('Fail')
  })

  it('warns within the outer 10% of the tolerance', () => {
    expect(dimensionStatus({ ...spec, actual: 100.91 })).toBe('Warning')
    expect(dimensionStatus({ ...spec, actual: 99.09 })).toBe('Warning')
    // exactly on the limit is still inside, and inside the warning band
    expect(dimensionStatus({ ...spec, actual: 101 })).toBe('Warning')
    expect(dimensionStatus({ ...spec, actual: 99 })).toBe('Warning')
  })

  it('applies the band per side for asymmetric tolerances', () => {
    const asym = { nominal: 10, tolPlus: 1, tolMinus: 0.1 }
    // 10.5 is mid-way on the wide side -> Pass
    expect(dimensionStatus({ ...asym, actual: 10.5 })).toBe('Pass')
    // 9.91 is within 10% of the tight lower limit -> Warning
    expect(dimensionStatus({ ...asym, actual: 9.905 })).toBe('Warning')
    expect(dimensionStatus({ ...asym, actual: 9.89 })).toBe('Fail')
  })

  it('treats a zero tolerance side as pass-or-fail only', () => {
    const exact = { nominal: 5, tolPlus: 0, tolMinus: 0 }
    expect(dimensionStatus({ ...exact, actual: 5 })).toBe('Pass')
    expect(dimensionStatus({ ...exact, actual: 5.01 })).toBe('Fail')
  })
})

describe('§5.1 work-center step gating', () => {
  it('gives paint work centers the paint step and no PT step', () => {
    for (const wc of ['7', '11', '48']) {
      const steps = stepsForWorkCenter(wc)
      expect(steps).toContain('paint')
      expect(steps).not.toContain('pt')
      expect(isPaintWorkCenter(wc)).toBe(true)
    }
  })

  it('gives weld work centers the PT step and no paint step', () => {
    for (const wc of ['22', '58']) {
      const steps = stepsForWorkCenter(wc)
      expect(steps).toContain('pt')
      expect(steps).not.toContain('paint')
      expect(isPTWorkCenter(wc)).toBe(true)
    }
  })

  it('gives other work centers neither', () => {
    const steps = stepsForWorkCenter('31')
    expect(steps).not.toContain('paint')
    expect(steps).not.toContain('pt')
    expect(steps).toEqual(['setup', 'dimensions', 'defects', 'review'])
  })

  it('always keeps review last', () => {
    for (const wc of ['7', '22', '31', '48', '58']) {
      const steps = stepsForWorkCenter(wc)
      expect(steps[steps.length - 1]).toBe('review')
      expect(steps[0]).toBe('setup')
    }
  })

  it('reads the code out of decorated work-center names', () => {
    expect(normaliseWorkCenter('58-A. Welding Line-LM4')).toBe('58')
    expect(normaliseWorkCenter('48-Painting Line-LM4')).toBe('48')
    expect(isPTWorkCenter('58-A. Welding Line-LM4')).toBe(true)
    expect(isPaintWorkCenter('48-Painting Line-LM4')).toBe(true)
  })
})

describe('§8.4 grade equivalence', () => {
  it('normalises case, spaces, hyphens, underscores and dots', () => {
    expect(normaliseGrade('S 355-JR')).toBe('s355jr')
    expect(normaliseGrade('s355_j.r')).toBe('s355jr')
  })

  it('treats identical grades as equivalent without any mapping', () => {
    const idx = buildGradeIndex([])
    expect(gradesEquivalent('S355JR', 's355 jr', idx)).toBe(true)
  })

  it('treats unrelated grades as not equivalent', () => {
    const idx = buildGradeIndex([])
    expect(gradesEquivalent('S355JR', 'DX51D', idx)).toBe(false)
  })

  it('links grades through a direct mapping', () => {
    const idx = buildGradeIndex([{ gradeA: 'S355JR', gradeB: 'ST52-3' }])
    expect(gradesEquivalent('s355jr', 'st523', idx)).toBe(true)
  })

  it('links grades transitively: A≡B and B≡C implies A≡C', () => {
    const idx = buildGradeIndex([
      { gradeA: 'A', gradeB: 'B' },
      { gradeA: 'B', gradeB: 'C' },
    ])
    expect(gradesEquivalent('A', 'C', idx)).toBe(true)
  })

  it('closes a longer chain regardless of the order pairs were entered', () => {
    const idx = buildGradeIndex([
      { gradeA: 'C', gradeB: 'D' },
      { gradeA: 'A', gradeB: 'B' },
      { gradeA: 'B', gradeB: 'C' },
    ])
    expect(gradesEquivalent('A', 'D', idx)).toBe(true)
    expect(gradesEquivalent('D', 'A', idx)).toBe(true)
  })

  it('keeps separate chains apart', () => {
    const idx = buildGradeIndex([
      { gradeA: 'A', gradeB: 'B' },
      { gradeA: 'X', gradeB: 'Y' },
    ])
    expect(gradesEquivalent('A', 'X', idx)).toBe(false)
  })

  it('reports the coils whose grade does not match the order', () => {
    const idx = buildGradeIndex([{ gradeA: 'S355JR', gradeB: 'ST52-3' }])
    const mismatches = findGradeMismatches(
      'S355JR',
      [
        { coilNumber: 'C1', grade: 'ST52-3' }, // equivalent
        { coilNumber: 'C2', grade: 'DX51D' }, // mismatch
        { coilNumber: 'C3' }, // no grade recorded — nothing to compare
      ],
      idx,
    )
    expect(mismatches).toEqual([{ coilNumber: 'C2', coilGrade: 'DX51D' }])
  })

  it('does not flag anything when the order has no expected grade', () => {
    const idx = buildGradeIndex([])
    expect(findGradeMismatches('', [{ coilNumber: 'C1', grade: 'DX51D' }], idx)).toEqual([])
  })
})

describe('save-time validation', () => {
  const base = {
    workCenterCode: '31',
    sampleQty: 1,
    drawing: 'DWG-1',
    coils: [],
    defects: [],
  }

  it('accepts a minimal valid sample', () => {
    expect(validateSample(base)).toEqual([])
  })

  it('blocks a defect with no disposition and names it', () => {
    const issues = validateSample({
      ...base,
      defects: [{ defectName: 'Scratch', disposition: null, qty: 2 }],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].step).toBe('defects')
    expect(issues[0].message).toContain('Scratch')
  })

  it('accepts a defect once a disposition is chosen', () => {
    expect(
      validateSample({
        ...base,
        defects: [{ defectName: 'Scratch', disposition: 'Hold', qty: 2 }],
      }),
    ).toEqual([])
  })

  it('requires at least one coil on PT work centers', () => {
    const issues = validateSample({ ...base, workCenterCode: '58', coils: [], pt: ptOk() })
    expect(issues.some((i) => i.message.includes('coil'))).toBe(true)
  })

  it('does not require coils on non-PT work centers', () => {
    expect(validateSample({ ...base, workCenterCode: '48', coils: [] })).toEqual([])
  })

  it('requires PT test frequency to be greater than 5%', () => {
    const withFreq = (pct: number) =>
      validateSample({
        ...base,
        workCenterCode: '22',
        coils: [{ coilNumber: 'C1' }],
        pt: { ...ptOk(), testFrequencyPct: pct },
      })
    expect(withFreq(5).some((i) => i.ref === 'testFrequencyPct')).toBe(true)
    expect(withFreq(4).some((i) => i.ref === 'testFrequencyPct')).toBe(true)
    expect(withFreq(5.1).some((i) => i.ref === 'testFrequencyPct')).toBe(false)
  })

  it('requires every consumable lot number', () => {
    const issues = validateSample({
      ...base,
      workCenterCode: '22',
      coils: [{ coilNumber: 'C1' }],
      pt: { testFrequencyPct: 10, consumableLots: { Cleaner: 'L1' } },
    })
    expect(issues.some((i) => i.ref === 'Penetrant')).toBe(true)
    expect(issues.some((i) => i.ref === 'Developer')).toBe(true)
    expect(issues.some((i) => i.ref === 'Cleaner')).toBe(false)
  })

  it('collects every problem in one pass rather than one per attempt', () => {
    const issues = validateSample({
      workCenterCode: '58',
      sampleQty: 0,
      drawing: '',
      coils: [],
      defects: [{ defectName: 'Dent', disposition: null, qty: 1 }],
    })
    expect(issues.length).toBeGreaterThanOrEqual(4)
  })

  function ptOk() {
    return {
      testFrequencyPct: 10,
      consumableLots: { Cleaner: 'L1', Penetrant: 'L2', Developer: 'L3' },
    }
  }
})

describe('§8.3 dimension resolution', () => {
  const order = [
    { item: 'Beam', dimensionName: 'Length', sequence: 2, nominal: 2500, tolPlus: 2, tolMinus: 2, unit: 'mm' },
    { item: 'Beam', dimensionName: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' },
  ]
  const master = [
    { item: 'Beam', dimensionName: 'Thickness', nominal: 2.5, tolPlus: 0.1, tolMinus: 0.1, unit: 'mm' },
    { item: 'Beam', dimensionName: 'Length', nominal: 9999, tolPlus: 9, tolMinus: 9, unit: 'mm' },
  ]
  const previous = [{ name: 'Hole pitch', nominal: 40, tolPlus: 0.3, tolMinus: 0.3, unit: 'mm' }]

  it('orders by the configured sequence', () => {
    const rows = resolveDimensions({ item: 'Beam', order, master: [], previous: [] })
    expect(rows.map((r) => r.name)).toEqual(['Width', 'Length'])
  })

  it('prefers the item order entry over the master record', () => {
    const rows = resolveDimensions({ item: 'Beam', order, master, previous: [] })
    const length = rows.find((r) => r.name === 'Length')!
    expect(length.nominal).toBe(2500)
    expect(length.source).toBe('item-order')
  })

  it('falls back to master, then carry-forward', () => {
    const rows = resolveDimensions({ item: 'Beam', order, master, previous })
    expect(rows.find((r) => r.name === 'Thickness')!.source).toBe('item-master')
    expect(rows.find((r) => r.name === 'Hole pitch')!.source).toBe('carry-forward')
  })

  it('returns nothing for an item with no configuration at all', () => {
    expect(resolveDimensions({ item: 'Unknown', order, master, previous: [] })).toEqual([])
  })

  it('filters to the allowed names on paint work centers', () => {
    const rows = resolveDimensions({
      item: 'Beam',
      order,
      master,
      previous,
      allowedNames: ['Width'],
    })
    expect(rows.map((r) => r.name)).toEqual(['Width'])
  })
})

describe('§14 q2 permissions', () => {
  it('lets inspectors record but not edit closed sessions', () => {
    expect(can('inspector', 'record-inspection')).toBe(true)
    expect(can('inspector', 'edit-closed-session')).toBe(false)
    expect(can('inspector', 'override-grade-mismatch')).toBe(false)
    expect(can('inspector', 'purge-audit-logs')).toBe(false)
  })

  it('lets supervisors correct closed sessions and override grade mismatches', () => {
    expect(can('supervisor', 'edit-closed-session')).toBe(true)
    expect(can('supervisor', 'override-grade-mismatch')).toBe(true)
    expect(can('supervisor', 'delete-defect')).toBe(true)
    expect(can('supervisor', 'purge-audit-logs')).toBe(false)
    expect(can('supervisor', 'manage-admin-data')).toBe(false)
  })

  it('gives admins everything including audit purging', () => {
    expect(can('admin', 'manage-admin-data')).toBe(true)
    expect(can('admin', 'purge-audit-logs')).toBe(true)
  })

  it('denies everything to an unknown role', () => {
    expect(can(undefined, 'record-inspection')).toBe(false)
  })
})

describe('§8.2 measurements with no specification', () => {
  it('is Pending when there is no nominal to judge against', () => {
    // Real legacy shape: "Paint Thickness" recorded 88 with no nominal or
    // tolerance. Calling that a Pass would invent a conformance decision.
    expect(dimensionStatus({ nominal: null, tolPlus: null, tolMinus: null, actual: 88 })).toBe('Pending')
  })

  it('is Pending when a tolerance side is missing', () => {
    expect(dimensionStatus({ nominal: 10, tolPlus: null, tolMinus: 0.1, actual: 10 })).toBe('Pending')
  })
})
