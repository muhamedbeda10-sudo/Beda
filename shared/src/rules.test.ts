import { describe, it, expect } from 'vitest'
import {
  deriveShift,
  hourInTimeZone,
  calendarDay,
  factoryDay,
  factoryDayStart,
  factoryMonth,
  zonedInstant,
  storedUnits,
  FACTORY_DAY_START_HOUR,
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
  stagesProblem,
  orderLineProblems,
  takesConfiguredDimensions,
  topStageQty,
  ptRequiredFor,
  stockProductionOf, isStockMachine, normaliseMachineCode,
  drawingRequiredFor,
  isDrawing,
  orderDrawings,
  STOCK_ORDER_NUMBER,
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
    expect(factoryDay(at(2, 0, 16))).toBe('2026-06-15')
    // ...the same night as a 21:00 sample taken the evening before
    expect(factoryDay(at(21, 0, 15))).toBe('2026-06-15')
  })

  it('keeps day-shift samples on their own calendar date', () => {
    expect(factoryDay(at(9, 0, 16))).toBe('2026-06-16')
    expect(factoryDay(at(23, 0, 16))).toBe('2026-06-16')
  })

  it('rolls the month back correctly at a month boundary', () => {
    expect(factoryDay(new Date(2026, 6, 1, 3, 0))).toBe('2026-06-30')
    expect(factoryMonth(new Date(2026, 6, 1, 3, 0))).toBe('2026-06')
    expect(factoryDay(new Date(2027, 0, 1, 7, 59))).toBe('2026-12-31')
  })
})

describe('§8.1 the factory day: 08:00 to 08:00 where the factory sits', () => {
  const cairo = 'Africa/Cairo'

  it('starts at 08:00: a record at 02:00 on the 20th belongs to the 19th', () => {
    expect(FACTORY_DAY_START_HOUR).toBe(8)
    // Cairo is UTC+3 in October 2026 (summer time until the last Thursday).
    expect(factoryDay(new Date('2026-10-19T23:00:00Z'), cairo)).toBe('2026-10-19') // 02:00 on the 20th
    expect(factoryDay(new Date('2026-10-20T04:59:59Z'), cairo)).toBe('2026-10-19') // 07:59:59
    expect(factoryDay(new Date('2026-10-20T05:00:00Z'), cairo)).toBe('2026-10-20') // 08:00
    expect(calendarDay(new Date('2026-10-19T23:00:00Z'), cairo)).toBe('2026-10-20')
  })

  it('keeps the whole night shift on the day it started', () => {
    // 19:00 on the 19th to 07:59 on the 20th, Cairo winter time (UTC+2).
    for (const iso of ['2026-01-19T17:00:00Z', '2026-01-19T21:59:00Z', '2026-01-19T22:00:00Z', '2026-01-20T05:59:00Z']) {
      expect(deriveShift(new Date(iso), cairo)).toBe('C')
      expect(factoryDay(new Date(iso), cairo)).toBe('2026-01-19')
    }
  })

  it('reads the day in the zone given, never the clock the code runs on', () => {
    // 03:00 UTC is 05:00 in Cairo: still the factory day before, whatever the server's clock says.
    const t = new Date('2026-03-10T03:00:00Z')
    expect(factoryDay(t, cairo)).toBe('2026-03-09')
    expect(factoryDay(t, 'UTC')).toBe('2026-03-09')
    expect(factoryDay(new Date('2026-03-10T09:00:00Z'), 'Asia/Tokyo')).toBe('2026-03-10') // 18:00 there
    expect(factoryDay(new Date('2026-03-09T22:59:00Z'), 'Asia/Tokyo')).toBe('2026-03-09') // 07:59 on the 10th there
  })

  it('crosses months and years', () => {
    expect(factoryDay(new Date('2026-10-01T03:00:00Z'), cairo)).toBe('2026-09-30')
    expect(factoryMonth(new Date('2026-10-01T03:00:00Z'), cairo)).toBe('2026-09')
    expect(factoryDay(new Date('2027-01-01T05:00:00Z'), cairo)).toBe('2026-12-31') // 07:00 on New Year's Day
  })

  it('agrees with itself across the summer-time changes', () => {
    // Egypt: clocks go forward at 00:00 on the last Friday of April, back at 24:00 on the last Thursday of October.
    expect(factoryDay(new Date('2026-04-24T03:30:00Z'), cairo)).toBe('2026-04-23') // 06:30 summer time
    expect(factoryDay(new Date('2026-04-24T05:00:00Z'), cairo)).toBe('2026-04-24') // 08:00
    expect(factoryDay(new Date('2026-10-29T21:30:00Z'), cairo)).toBe('2026-10-29') // 23:30 winter time again, the 29th
    expect(factoryDay(new Date('2026-10-30T05:59:00Z'), cairo)).toBe('2026-10-29') // 07:59
  })

  it('starts each factory day at 08:00 factory time, summer or winter', () => {
    expect(factoryDayStart('2026-01-19', cairo).toISOString()).toBe('2026-01-19T06:00:00.000Z')
    expect(factoryDayStart('2026-07-19', cairo).toISOString()).toBe('2026-07-19T05:00:00.000Z')
    expect(factoryDayStart('2026-10-20', 'UTC').toISOString()).toBe('2026-10-20T08:00:00.000Z')
    // A moment is in the day that starts at or before it and ends at the next start.
    for (const day of ['2026-04-23', '2026-04-24', '2026-10-29', '2026-10-30', '2026-12-31']) {
      const start = factoryDayStart(day, cairo)
      expect(factoryDay(start, cairo)).toBe(day)
      expect(factoryDay(new Date(start.getTime() - 1000), cairo)).not.toBe(day)
    }
  })

  it('turns a wall-clock time in a zone into the moment it happens', () => {
    expect(zonedInstant(2026, 1, 31, 14, 30, 0, 0, cairo).toISOString()).toBe('2026-01-31T12:30:00.000Z')
    expect(zonedInstant(2026, 8, 1, 0, 0, 0, 0, cairo).toISOString()).toBe('2026-07-31T21:00:00.000Z')
    expect(zonedInstant(2026, 8, 1, 9, 15, 30, 250, 'UTC').toISOString()).toBe('2026-08-01T09:15:30.250Z')
    expect(zonedInstant(2026, 8, 1, 9, 15).getTime()).toBe(new Date(2026, 7, 1, 9, 15).getTime())
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

describe('§8.2 dimension status is decided in exact decimals', () => {
  // The cases floating point got wrong: the limit itself, and the edge of the band.
  it('keeps a reading on the limit inside tolerance', () => {
    expect(dimensionStatus({ nominal: 50.15, tolPlus: 0.05, tolMinus: 0.05, actual: 50.2 })).toBe('Warning')
    expect(dimensionStatus({ nominal: 50.15, tolPlus: 0.05, tolMinus: 0.05, actual: 50.1 })).toBe('Warning')
    expect(dimensionStatus({ nominal: 0.3, tolPlus: 0.1, tolMinus: 0.1, actual: 0.4 })).toBe('Warning')
    expect(dimensionStatus({ nominal: 1.1, tolPlus: 0.2, tolMinus: 0.2, actual: 1.3 })).toBe('Warning')
    expect(dimensionStatus({ nominal: 50.15, tolPlus: 0.05, tolMinus: 0.05, actual: 50.2001 })).toBe('Fail')
  })

  it('puts a reading on the edge of the warning band in the band', () => {
    expect(dimensionStatus({ nominal: 100, tolPlus: 0.3, tolMinus: 0.3, actual: 100.27 })).toBe('Warning')
    expect(dimensionStatus({ nominal: 100, tolPlus: 0.3, tolMinus: 0.3, actual: 99.73 })).toBe('Warning')
    expect(dimensionStatus({ nominal: 100, tolPlus: 0.3, tolMinus: 0.3, actual: 100.2699 })).toBe('Pass')
    expect(dimensionStatus({ nominal: 100, tolPlus: 0.3, tolMinus: 0.3, actual: 99.7301 })).toBe('Pass')
  })

  it('reads values at the stored precision, as numeric(14, 4) keeps them', () => {
    expect(storedUnits(50.15)).toBe(501500)
    expect(storedUnits(0.00005)).toBe(1)
    expect(storedUnits(-0.00005)).toBe(-1)
    expect(storedUnits(1.00004999)).toBe(10000)
    expect(storedUnits(5e-7)).toBe(0)
    expect(storedUnits(1234567890.1234)).toBe(12345678901234)
    expect(storedUnits(-12.3456)).toBe(-123456)
    // A reading typed with more decimals is judged as it is stored: 50.20004 is kept as 50.2000.
    expect(dimensionStatus({ nominal: 50.15, tolPlus: 0.05, tolMinus: 0.05, actual: 50.20004 })).toBe('Warning')
    expect(dimensionStatus({ nominal: 50.15, tolPlus: 0.05, tolMinus: 0.05, actual: 50.20005 })).toBe('Fail')
  })

  it('takes a tolerance typed negative as its size', () => {
    expect(dimensionStatus({ nominal: 50.15, tolPlus: 0.05, tolMinus: -0.05, actual: 50.1 })).toBe('Warning')
    expect(dimensionStatus({ nominal: -2.5, tolPlus: 0.1, tolMinus: 0.1, actual: -2.6 })).toBe('Warning')
    expect(dimensionStatus({ nominal: -2.5, tolPlus: 0.1, tolMinus: 0.1, actual: -2.6001 })).toBe('Fail')
  })

  /** The rule in whole units of 1/10⁴, on the units themselves: what the numbers mean, with no arithmetic on doubles. */
  function exact(n: number, plus: number, minus: number, a: number): string {
    if (a > n + plus || a < n - minus) return 'Fail'
    if (a >= n) return plus === 0 ? 'Pass' : (n + plus - a) * 10 <= plus ? 'Warning' : 'Pass'
    return minus === 0 ? 'Pass' : (a - (n - minus)) * 10 <= minus ? 'Warning' : 'Pass'
  }
  /** A whole number of 1/10⁴ units as the decimal a person types, read into a JavaScript number. */
  const typed = (units: number) => Number(`${units < 0 ? '-' : ''}${Math.floor(Math.abs(units) / 10000)}.${String(Math.abs(units) % 10000).padStart(4, '0')}`)

  it('agrees with the exact rule on every limit and band edge of a wide grid', () => {
    const nominals = [0, 3, 1500, 2550, 4000, 12345, 50150, 99999, 100000, 250005, 1234567, -25000]
    const tolerances = [0, 1, 3, 5, 7, 10, 25, 30, 50, 100, 150, 300, 333, 500, 1000, 2500, 10000]
    let checked = 0
    for (const n of nominals) {
      for (const plus of tolerances) {
        for (const minus of [plus, 5, 1000]) {
          // Each limit, each band edge (where a tenth of the side is whole), and a unit either side of each.
          const edges = [n + plus, n - minus, n + plus - plus / 10, n - minus + minus / 10, n].filter(Number.isInteger)
          for (const e of edges) {
            for (const a of [e - 1, e, e + 1]) {
              const got = dimensionStatus({ nominal: typed(n), tolPlus: typed(plus), tolMinus: typed(minus), actual: typed(a) })
              expect(got, `${typed(n)} +${typed(plus)}/-${typed(minus)} at ${typed(a)}`).toBe(exact(n, plus, minus, a))
              checked++
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(2000)
  })

  it('agrees with the exact rule on every reading across a tolerance band', () => {
    // 100 ±0.3, 50.15 ±0.05 and an asymmetric 12.345 +0.007/-0.013, reading by reading in steps of 0.0001.
    for (const [n, plus, minus] of [[1000000, 3000, 3000], [501500, 500, 500], [123450, 70, 130]]) {
      for (let a = n - minus - 20; a <= n + plus + 20; a++) {
        expect(dimensionStatus({ nominal: typed(n), tolPlus: typed(plus), tolMinus: typed(minus), actual: typed(a) })).toBe(exact(n, plus, minus, a))
      }
    }
  })
})

describe('§5.1 step gating by process', () => {
  it('gives paint machines photos, thickness readings and defects — no setup', () => {
    expect(stepsForProcess('paint')).toEqual(['paint', 'paintThickness', 'defects', 'review'])
  })

  it('gives welding machines setup, dimensions, VT defects and PT', () => {
    expect(stepsForProcess('welding')).toEqual(['setup', 'dimensions', 'defects', 'pt', 'review'])
  })

  it('gives forming and universal machines the plain flow', () => {
    expect(stepsForProcess('forming')).toEqual(['setup', 'dimensions', 'defects', 'review'])
    expect(stepsForProcess('universal')).toEqual(['setup', 'dimensions', 'defects', 'review'])
  })

  it('always keeps review last', () => {
    for (const p of ['forming', 'welding', 'paint', 'universal'] as const) {
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

  it('works the PT requirement out of the final quantity, whole pieces, rounded up', () => {
    expect(ptRequiredFor(100)).toBe(5)
    expect(ptRequiredFor(95)).toBe(5)
    expect(ptRequiredFor(20)).toBe(1)
    expect(ptRequiredFor(1)).toBe(1)
    expect(ptRequiredFor(0)).toBe(0)
    expect(ptRequiredFor(2176)).toBe(109)
    // No typed frequency is asked for any more; a record without one is complete.
    const { testFrequencyPct: _gone, ...untyped } = ptOk()
    expect(validateSample({ ...base, process: 'welding', coils: [], pt: untyped })).toEqual([])
  })

  it('requires the connector coil number on a welding sample, pointing at the setup step', () => {
    for (const missing of [undefined, '', '   ']) {
      const issues = validateSample({ ...base, process: 'welding', coils: [], pt: { ...ptOk(), connectorCoilNumber: missing } })
      expect(issues).toEqual([{ step: 'setup', message: 'Connector coil number is required.', ref: 'connectorCoil' }])
    }
    // Other processes have no welding wire at all.
    expect(validateSample({ ...base, coils: [] })).toEqual([])
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
      connectorCoilNumber: 'CC-1' as string | undefined,
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

describe('§4 — the stages of an item on a universal machine', () => {
  it('takes stages from 1 with no gap, each once, each with a quantity', () => {
    expect(stagesProblem([], [{ stage: 1, qty: 300 }])).toBeNull()
    // Two presses at once: stages 1 and 2 in one session.
    expect(stagesProblem([], [{ stage: 1, qty: 300 }, { stage: 2, qty: 300 }])).toBeNull()
    expect(stagesProblem([1], [{ stage: 2, qty: 280 }, { stage: 3, qty: 280 }])).toBeNull()
    expect(stagesProblem([1, 2], [{ stage: 1, qty: 50 }])).toBeNull()
    expect(stagesProblem([], [])).toMatch(/Choose/)
    expect(stagesProblem([], [{ stage: 2, qty: 10 }])).toMatch(/Stage 1 comes before stage 2/)
    expect(stagesProblem([1], [{ stage: 3, qty: 10 }])).toMatch(/Stage 2/)
    expect(stagesProblem([], [{ stage: 1, qty: 1 }, { stage: 1, qty: 2 }])).toMatch(/twice/)
    expect(stagesProblem([], [{ stage: 0, qty: 1 }])).toMatch(/whole number/)
    expect(stagesProblem([], [{ stage: 1, qty: -1 }])).toMatch(/quantity of stage 1/)
  })

  it("reads a staged session's quantity off its highest stage", () => {
    expect(topStageQty([{ stage: 1, qty: 300 }, { stage: 2, qty: 290 }])).toBe(290)
    expect(topStageQty([{ stage: 3, qty: 12 }])).toBe(12)
    expect(topStageQty([])).toBe(0)
  })
})

describe('order lines the sheet got wrong', () => {
  it('names an order numbered 0 and a line with no item at all', () => {
    expect(orderLineProblems({ orderNumber: '0', item: '', itemCode: '' })).toEqual(['The order number is "0".', 'The line has neither an item name nor an item code.'])
    expect(orderLineProblems({ orderNumber: ' 000 ', item: 'Beam', itemCode: '' })).toEqual(['The order number is "000".'])
  })
  it('leaves a sound line alone, and a line with a code but no name', () => {
    expect(orderLineProblems({ orderNumber: '20480-Ph3.4-SMA', item: 'Shuttle Beam', itemCode: 'LB406015' })).toEqual([])
    expect(orderLineProblems({ orderNumber: '20480', item: '', itemCode: 'LB406015' })).toEqual([])
    expect(orderLineProblems({ orderNumber: '100', item: 'Beam', itemCode: '' })).toEqual([])
  })
})

describe('where the wizard takes its dimensions from', () => {
  it('never from the configuration on a universal machine, whatever its switch says', () => {
    expect(takesConfiguredDimensions('universal', { usesItemDimensions: true })).toBe(false)
    expect(takesConfiguredDimensions('universal', null)).toBe(false)
  })
  it('from the configuration on the other machines unless switched off', () => {
    expect(takesConfiguredDimensions('forming', { usesItemDimensions: true })).toBe(true)
    expect(takesConfiguredDimensions('welding', null)).toBe(true)
    expect(takesConfiguredDimensions('forming', { usesItemDimensions: false })).toBe(false)
  })
})

describe('an order line’s drawings', () => {
  it('takes DWG2 when DWG1 is a placeholder the ERP writes, each drawing once, without outer spaces', () => {
    expect(orderDrawings({ drawing: '(V)', drawingAlt: 'CUS19350-23' })).toEqual(['CUS19350-23'])
    for (const placeholder of ['V', '(v)', '0', 'NA', 'X', ' - ', '', null, undefined]) {
      expect(orderDrawings({ drawing: placeholder, drawingAlt: 'CUS19350-18' })).toEqual(['CUS19350-18'])
    }
    expect(orderDrawings({ drawing: '', drawingAlt: 'BS9301 (CTL)  / Gasp.334 - MJ916 (RF) ' })).toEqual(['BS9301 (CTL)  / Gasp.334 - MJ916 (RF)'])
    expect(orderDrawings({ drawing: 'BS9251 (Weld), BS9314 (Non-Weld)', drawingAlt: 'BS9314' })).toEqual(['BS9251 (Weld), BS9314 (Non-Weld)', 'BS9314'])
    expect(orderDrawings({ drawing: 'SM240', drawingAlt: 'SM240 ' })).toEqual(['SM240'])
    expect(orderDrawings({ drawing: '(V)', drawingAlt: '0' })).toEqual([])
    expect(isDrawing('CFSM')).toBe(true)
  })

  it('asks a sample for a drawing only when the line has one to pick', () => {
    expect(drawingRequiredFor({ orderNumber: '20615-SGR', drawing: '(V)', drawingAlt: 'CUS19350-23' })).toBe(true)
    expect(drawingRequiredFor({ orderNumber: '20615-SGR', drawing: 'X', drawingAlt: '' })).toBe(false)
    expect(drawingRequiredFor({ orderNumber: STOCK_ORDER_NUMBER, drawing: 'SM240', drawingAlt: null })).toBe(false)
  })
})

describe('a machine that requires its coil', () => {
  const base = { process: 'forming' as const, sampleQty: 5, drawing: 'D-1', coils: [], defects: [], dimensions: [] }
  const coilIssue = (issues: ReturnType<typeof validateSample>) => issues.find((i) => i.ref === 'coil')?.message

  it('refuses a sample without a coil there, and only there', () => {
    expect(coilIssue(validateSample({ ...base, coilRequired: true }))).toBe('Add the coil this sample was made from: this machine requires it.')
    expect(coilIssue(validateSample({ ...base, coilRequired: true, process: 'universal' }))).toBe('Add the coil this sample was made from: this machine requires it.')
    expect(coilIssue(validateSample({ ...base, coilRequired: true, coils: [{ coilNumber: 'C10021' }] }))).toBeUndefined()
    expect(coilIssue(validateSample({ ...base, coilRequired: false }))).toBeUndefined()
    expect(coilIssue(validateSample(base))).toBeUndefined()
  })

  it('leaves welding to its connector coil, and paint (no coils) alone', () => {
    expect(coilIssue(validateSample({ ...base, coilRequired: true, process: 'welding' }))).toBeUndefined()
    expect(coilIssue(validateSample({ ...base, coilRequired: true, process: 'paint' }))).toBeUndefined()
  })
})
