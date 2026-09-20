import { describe, it, expect } from 'vitest'
import {
  deriveShift,
  hourInTimeZone,
  shiftStartDate,
  dimensionStatus,
  stepsForProcess,
  legacyProcessForCode,
  processForMachine,
  ptOverallVerdict,
  normaliseWorkCenter,
  normaliseGrade,
  buildGradeIndex,
  gradesEquivalent,
  findGradeMismatches,
  validateSample,
  resolveDimensions,
  sessionTone,
  can,
  stockProductionOf, isStockMachine, normaliseMachineCode,
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

describe('§5.1 step gating by process', () => {
  it('gives paint machines photos, thickness readings and defects — no setup', () => {
    expect(stepsForProcess('paint')).toEqual(['paint', 'paintThickness', 'defects', 'review'])
  })

  it('gives welding machines setup, dimensions, VT defects and PT', () => {
    expect(stepsForProcess('welding')).toEqual(['setup', 'dimensions', 'defects', 'pt', 'review'])
  })

  it('gives forming and other machines the plain flow', () => {
    expect(stepsForProcess('forming')).toEqual(['setup', 'dimensions', 'defects', 'review'])
    expect(stepsForProcess('other')).toEqual(['setup', 'dimensions', 'defects', 'review'])
  })

  it('always keeps review last', () => {
    for (const p of ['forming', 'welding', 'paint', 'other'] as const) {
      const steps = stepsForProcess(p)
      expect(steps[steps.length - 1]).toBe('review')
    }
  })

  it('takes the process from the register and falls back to the legacy work-centre numbers', () => {
    expect(processForMachine({ process: 'paint' }, '58')).toBe('paint')
    expect(processForMachine(null, '58')).toBe('welding')
    expect(processForMachine(undefined, '48-Painting Line-LM4')).toBe('paint')
    expect(legacyProcessForCode('31')).toBe('forming')
    expect(normaliseWorkCenter('58-A. Welding Line-LM4')).toBe('58')
  })

  it('rejects the PT record as soon as one tested length is rejected', () => {
    expect(ptOverallVerdict([])).toBeNull()
    expect(ptOverallVerdict([{ verdict: 'Accept' }, { verdict: null }])).toBeNull()
    expect(ptOverallVerdict([{ verdict: 'Accept' }, { verdict: 'Accept' }])).toBe('Accept')
    expect(ptOverallVerdict([{ verdict: 'Accept' }, { verdict: 'Reject / Repair' }])).toBe('Reject / Repair')
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
    process: 'forming' as const,
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

  it('requires a description for a defect recorded as Other', () => {
    const bare = validateSample({ ...base, defects: [{ defectName: 'Other', disposition: 'Hold', qty: 1 }] })
    expect(bare).toHaveLength(1)
    expect(bare[0].message).toMatch(/describe/i)
    expect(validateSample({ ...base, defects: [{ defectName: ' other ', disposition: 'Hold', qty: 1, notes: 'Paint run on the flange' }] })).toEqual([])
  })

  it('accepts a defect once a disposition is chosen', () => {
    expect(
      validateSample({
        ...base,
        defects: [{ defectName: 'Scratch', disposition: 'Hold', qty: 2 }],
      }),
    ).toEqual([])
  })

  it('never requires a coil: welding records a wire batch instead', () => {
    expect(validateSample({ ...base, process: 'welding', coils: [], pt: ptOk() })).toEqual([])
    expect(validateSample({ ...base, coils: [] })).toEqual([])
  })

  it('requires PT test frequency of at least 5%', () => {
    const withFreq = (pct: number) =>
      validateSample({
        ...base,
        process: 'welding',
        pt: { ...ptOk(), testFrequencyPct: pct },
      })
    // Exactly five is the floor, and passes; anything under it does not.
    expect(withFreq(5).some((i) => i.ref === 'testFrequencyPct')).toBe(false)
    expect(withFreq(4.9).some((i) => i.ref === 'testFrequencyPct')).toBe(true)
    expect(withFreq(0).some((i) => i.ref === 'testFrequencyPct')).toBe(true)
    expect(withFreq(10).some((i) => i.ref === 'testFrequencyPct')).toBe(false)
  })

  it('requires every consumable lot number', () => {
    const issues = validateSample({
      ...base,
      process: 'welding',
      pt: { ...ptOk(), consumableLots: { Cleaner: 'L1' } },
    })
    expect(issues.some((i) => i.ref === 'Penetrant')).toBe(true)
    expect(issues.some((i) => i.ref === 'Developer')).toBe(true)
    expect(issues.some((i) => i.ref === 'Cleaner')).toBe(false)
  })

  it('requires at least one tested weld length, each with a length and a verdict', () => {
    const none = validateSample({ ...base, process: 'welding', pt: { ...ptOk(), testedLengths: [] } })
    expect(none.some((i) => i.ref === 'testedLengths')).toBe(true)
    const bad = validateSample({
      ...base,
      process: 'welding',
      pt: { ...ptOk(), testedLengths: [{ lengthMm: 0, verdict: 'Accept' }, { lengthMm: 120, verdict: null }] },
    })
    expect(bad.filter((i) => i.ref === 'length-1')).toHaveLength(1)
    expect(bad.filter((i) => i.ref === 'length-2')).toHaveLength(1)
  })

  it('needs no drawing or nominal on a paint machine, but photos and three thickness readings', () => {
    const paint = { ...base, process: 'paint' as const, drawing: '' }
    const bare = validateSample(paint)
    expect(bare.map((i) => i.step)).toEqual(['paint', 'paintThickness'])
    const twoReadings = validateSample({
      ...paint,
      paint: { imageIds: ['img'] },
      dimensions: [
        { name: 'Paint thickness', nominal: 60, actual: 61 },
        { name: 'Paint thickness', nominal: 60, actual: 59 },
      ],
    })
    expect(twoReadings).toHaveLength(1)
    expect(twoReadings[0].step).toBe('paintThickness')
    const missingOne = validateSample({
      ...paint,
      paint: { imageIds: ['img'] },
      dimensions: [
        { name: 'paint thickness', nominal: 60, actual: 61 },
        { name: 'Paint thickness', nominal: 60, actual: null },
        { name: 'Paint thickness', nominal: null, actual: 62 },
      ],
    })
    // Readings are recorded as measured: a missing nominal is not a problem, a missing reading is.
    expect(missingOne.map((i) => i.ref)).toEqual(['reading-2'])
    // Readings added beyond the first three may be left empty; they are dropped, not flagged.
    const extras = validateSample({
      ...paint,
      paint: { imageIds: ['img'] },
      dimensions: [
        { name: 'Paint thickness', nominal: null, actual: 61 },
        { name: 'Paint thickness', nominal: null, actual: 60 },
        { name: 'Paint thickness', nominal: null, actual: 62 },
        { name: 'Paint thickness', nominal: null, actual: 63 },
        { name: 'Paint thickness', nominal: null, actual: null },
        { name: 'Paint thickness', nominal: null, actual: null },
      ],
    })
    expect(extras).toEqual([])
    expect(
      validateSample({
        ...paint,
        paint: { imageIds: ['img'] },
        dimensions: [1, 2, 3].map(() => ({ name: 'Paint thickness', nominal: 60, actual: 61 })),
      }),
    ).toEqual([])
  })

  it('collects every problem in one pass rather than one per attempt', () => {
    const issues = validateSample({
      process: 'welding',
      sampleQty: 0,
      drawing: '',
      coils: [],
      defects: [{ defectName: 'Dent', disposition: null, qty: 1 }],
    })
    expect(issues.length).toBeGreaterThanOrEqual(4)
  })

  it('points a missing sample quantity at the review step, where it is entered', () => {
    const issues = validateSample({ ...base, sampleQty: 0 })
    expect(issues).toEqual([{ step: 'review', message: 'Sample quantity must be greater than zero.' }])
  })

  function ptOk() {
    return {
      testFrequencyPct: 10,
      consumableLots: { Cleaner: 'L1', Penetrant: 'L2', Developer: 'L3' },
      testedLengths: [{ lengthMm: 150, verdict: 'Accept' as const }],
    }
  }
})

describe('§8.3 dimension resolution', () => {
  const order = [
    { itemCode: 'BM-1', dimensionName: 'Length', sequence: 2, nominal: 2500, tolPlus: 2, tolMinus: 2, unit: 'mm' },
    { itemCode: 'BM-1', dimensionName: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' },
  ]
  const previous = [{ name: 'Hole pitch', nominal: 40, tolPlus: 0.3, tolMinus: 0.3, unit: 'mm' }]
  const on58 = { itemCode: 'BM-1', workCenterCode: '58' }

  it('orders by the configured sequence', () => {
    const rows = resolveDimensions({ ...on58, order, previous: [] })
    expect(rows.map((r) => r.name)).toEqual(['Width', 'Length'])
  })

  it('marks configured rows as item-order and carried-forward ones as such', () => {
    const rows = resolveDimensions({ ...on58, order, previous })
    const length = rows.find((r) => r.name === 'Length')!
    expect(length.nominal).toBe(2500)
    expect(length.source).toBe('item-order')
    expect(rows.find((r) => r.name === 'Hole pitch')!.source).toBe('carry-forward')
  })

  it('takes the nominal typed on the previous sample when the configured one is 0 or missing', () => {
    // An ERP sheet writes 0 for "not set"; the inspector typed 1004 on the first sample.
    const zeroed = [
      { itemCode: 'UP-1', dimensionName: 'A', sequence: 1, nominal: 0, tolPlus: 1, tolMinus: 1, unit: 'mm' },
      { itemCode: 'UP-1', dimensionName: 'K', sequence: 2, nominal: null, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' },
      { itemCode: 'UP-1', dimensionName: 'B', sequence: 3, nominal: 80, tolPlus: 1, tolMinus: 1, unit: 'mm' },
    ]
    const typed = [
      { name: 'A', nominal: 1004, tolPlus: 1, tolMinus: 1, unit: 'mm' },
      { name: 'K', nominal: 42, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' },
      { name: 'B', nominal: 999, tolPlus: 1, tolMinus: 1, unit: 'mm' },
    ]
    const rows = resolveDimensions({ itemCode: 'UP-1', workCenterCode: '24', order: zeroed, previous: typed })
    expect(rows.map((r) => [r.name, r.nominal])).toEqual([
      ['A', 1004],
      ['K', 42],
      // A real configured nominal still wins over what was typed.
      ['B', 80],
    ])
    // With nothing typed yet, a 0 stays 0 so the inspector sees it is not set.
    expect(resolveDimensions({ itemCode: 'UP-1', workCenterCode: '24', order: zeroed, previous: [] }).map((r) => r.nominal)).toEqual([0, null, 80])
  })

  it('returns nothing for an item with no configuration at all', () => {
    expect(resolveDimensions({ itemCode: 'NOPE', workCenterCode: '58', order, previous: [] })).toEqual([])
  })

  it('matches item codes without regard to case or whitespace', () => {
    const rows = resolveDimensions({ itemCode: ' bm-1 ', workCenterCode: '58', order, previous: [] })
    expect(rows).toHaveLength(2)
  })

  it('lets a machine-specific row override the general row of the same name', () => {
    const withMachine = [
      ...order,
      { itemCode: 'BM-1', workCenterCode: '58', dimensionName: 'Width', sequence: 1, nominal: 130, tolPlus: 1, tolMinus: 1, unit: 'mm' },
      { itemCode: 'BM-1', workCenterCode: '48', dimensionName: 'Paint thickness', sequence: 1, nominal: 60, tolPlus: 10, tolMinus: 5, unit: 'µm' },
    ]
    const on58Rows = resolveDimensions({ ...on58, order: withMachine, previous: [] })
    expect(on58Rows.map((r) => [r.name, r.nominal])).toEqual([
      ['Width', 130],
      ['Length', 2500],
    ])
    const on48Rows = resolveDimensions({ itemCode: 'BM-1', workCenterCode: '48', order: withMachine, previous: [] })
    expect(on48Rows.map((r) => [r.name, r.nominal])).toEqual([
      ['Paint thickness', 60],
      ['Width', 125],
      ['Length', 2500],
    ])
    // A machine with no rows of its own gets the general set unchanged.
    const on22Rows = resolveDimensions({ itemCode: 'BM-1', workCenterCode: '22', order: withMachine, previous: [] })
    expect(on22Rows.map((r) => r.nominal)).toEqual([125, 2500])
  })

  it('takes the nominal the previous sample saved for a configured row that has none', () => {
    const unconfiguredNominal = [
      { itemCode: 'BM-1', dimensionName: 'Length', sequence: 2, nominal: null, tolPlus: 2, tolMinus: 2, unit: 'mm' },
      { itemCode: 'BM-1', dimensionName: 'Width', sequence: 1, nominal: 125, tolPlus: 0.5, tolMinus: 0.5, unit: 'mm' },
    ]
    const remembered = [
      { name: ' length ', nominal: 2498, tolPlus: 1, tolMinus: 1, unit: 'mm' },
      { name: 'Width', nominal: 130, tolPlus: 1, tolMinus: 1, unit: 'mm' },
    ]
    const rows = resolveDimensions({ ...on58, order: unconfiguredNominal, previous: remembered })
    const length = rows.find((r) => r.name === 'Length')!
    // The remembered nominal, the configured tolerance, still a configured row.
    expect(length.nominal).toBe(2498)
    expect(length.tolPlus).toBe(2)
    expect(length.source).toBe('item-order')
    // A configured nominal is never overridden by what was typed before.
    expect(rows.find((r) => r.name === 'Width')!.nominal).toBe(125)
  })

  it('filters to the allowed names on paint work centers', () => {
    const rows = resolveDimensions({
      ...on58,
      order,
      previous,
      allowedNames: ['Width'],
    })
    expect(rows.map((r) => r.name)).toEqual(['Width'])
  })
})

describe('session colouring', () => {
  it('ranks hold above defects above prior defects elsewhere', () => {
    expect(sessionTone({ defectCount: 2, holdCount: 1, priorDefectsElsewhere: true })).toBe('hold')
    expect(sessionTone({ defectCount: 2, holdCount: 0, priorDefectsElsewhere: true })).toBe('defect')
    expect(sessionTone({ defectCount: 0, holdCount: 0, priorDefectsElsewhere: true })).toBe('prior')
    expect(sessionTone({ defectCount: 0, holdCount: 0, priorDefectsElsewhere: false })).toBeNull()
    expect(sessionTone({})).toBeNull()
  })
})

describe('§14 q2 permissions', () => {
  it('lets inspectors record but not edit closed sessions', () => {
    expect(can('inspector', 'record-inspection')).toBe(true)
    expect(can('inspector', 'view-all-sessions')).toBe(false)
    expect(can('inspector', 'edit-closed-session')).toBe(false)
    expect(can('inspector', 'override-grade-mismatch')).toBe(false)
    expect(can('inspector', 'purge-audit-logs')).toBe(false)
  })

  it('lets supervisors correct closed sessions and override grade mismatches', () => {
    expect(can('supervisor', 'edit-closed-session')).toBe(true)
    expect(can('supervisor', 'view-all-sessions')).toBe(true)
    expect(can('admin', 'view-all-sessions')).toBe(true)
    expect(can('supervisor', 'override-grade-mismatch')).toBe(true)
    expect(can('supervisor', 'delete-defect')).toBe(true)
    expect(can('supervisor', 'delete-session')).toBe(false)
    expect(can('supervisor', 'delete-sample')).toBe(false)
    expect(can('supervisor', 'purge-audit-logs')).toBe(false)
    expect(can('supervisor', 'manage-admin-data')).toBe(false)
  })

  it('gives admins everything including audit purging', () => {
    expect(can('admin', 'manage-admin-data')).toBe(true)
    expect(can('admin', 'purge-audit-logs')).toBe(true)
    expect(can('admin', 'delete-session')).toBe(true)
    expect(can('admin', 'delete-sample')).toBe(true)
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

describe('deriveShift in a named time zone', () => {
  it('judges the hour in the factory zone, not the server zone', () => {
    // 06:30 UTC is 08:30 in Cairo in winter (UTC+2): morning shift there,
    // night shift for a server clock left on UTC.
    const at = new Date('2026-01-15T06:30:00Z')
    expect(deriveShift(at, 'Africa/Cairo')).toBe('A')
    expect(deriveShift(at, 'UTC')).toBe('C')
  })
  it('handles the summer offset', () => {
    // Cairo observes DST (UTC+3) in July: 15:30 UTC is 18:30 local → afternoon.
    expect(deriveShift(new Date('2026-07-15T15:30:00Z'), 'Africa/Cairo')).toBe('B')
  })
  it('hourInTimeZone returns 0..23', () => {
    expect(hourInTimeZone(new Date('2026-01-15T23:30:00Z'), 'UTC')).toBe(23)
    expect(hourInTimeZone(new Date('2026-01-15T00:10:00Z'), 'UTC')).toBe(0)
  })
})

describe('the make-to-stock press', () => {
  it('is found by its code however the register spells it', () => {
    for (const code of ['21', ' 21 ', '021', '٢١', '۲۱']) {
      expect(stockProductionOf(code)?.item).toBe('Connector (right + left)')
      expect(isStockMachine(code)).toBe(true)
    }
    expect(stockProductionOf('58')).toBeNull()
    expect(stockProductionOf('')).toBeNull()
    expect(stockProductionOf(null)).toBeNull()
    expect(normaliseMachineCode('٠٥٨')).toBe('58')
    expect(normaliseMachineCode('LM-4 ')).toBe('lm-4')
  })
})

describe('roles', () => {
  it('a viewer reads and never writes, and is outside the chat and the notices', () => {
    expect(can('viewer', 'view-all-sessions')).toBe(true)
    expect(can('viewer', 'view-dashboard')).toBe(true)
    expect(can('viewer', 'view-order-sheet')).toBe(true)
    expect(can('inspector', 'view-order-sheet')).toBe(false)
    expect(can('supervisor', 'view-order-sheet')).toBe(true)
    for (const cap of ['record-inspection', 'edit-open-session', 'edit-closed-session', 'delete-session', 'delete-sample', 'delete-note', 'delete-defect', 'manage-admin-data', 'purge-audit-logs', 'override-grade-mismatch', 'use-chat', 'read-notices'] as const) {
      expect(can('viewer', cap)).toBe(false)
    }
  })
  it('everyone who records is in the chat and receives notices', () => {
    for (const role of ['inspector', 'supervisor', 'admin'] as const) {
      expect(can(role, 'record-inspection')).toBe(true)
      expect(can(role, 'use-chat')).toBe(true)
      expect(can(role, 'read-notices')).toBe(true)
    }
    expect(can(undefined, 'view-all-sessions')).toBe(false)
  })
})
