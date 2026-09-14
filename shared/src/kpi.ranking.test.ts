import { describe, it, expect } from 'vitest'
import { RANKING_WEIGHTS, rankInspectors, type KpiInspectorRaw } from './kpi'

/** A competent inspector, from which each case varies one thing. */
function inspector(over: Partial<KpiInspectorRaw> = {}): KpiInspectorRaw {
  return {
    inspectorId: over.inspectorId ?? 'a',
    name: over.name ?? 'Inspector A',
    factory: '',
    samples: 100,
    pieces: 1000,
    activeDays: 20,
    lines: 10,
    machines: 2,
    dimensionRows: 400,
    dimensionsMeasured: 400,
    coilsUsed: 50,
    coilsFromRegister: 50,
    sessionsClosed: 20,
    sessionsClosedWithFinalQty: 20,
    emptySessions: 0,
    sessionsOpened: 20,
    corrections: 0,
    reRecorded: 0,
    defectRecords: 30,
    detectionIndex: 1,
    ...over,
  }
}

describe('§16 — the inspector ranking scores the inspection, not the product', () => {
  it('places the more complete record above the emptier one, all else equal', () => {
    const { ranked } = rankInspectors(
      [
        inspector({ inspectorId: 'a', name: 'Complete', dimensionsMeasured: 400 }),
        inspector({ inspectorId: 'b', name: 'Half measured', dimensionsMeasured: 200 }),
      ],
      20,
    )
    expect(ranked.map((r) => r.name)).toEqual(['Complete', 'Half measured'])
    expect(ranked[0].dimensionCompletionPct).toBe(100)
    expect(ranked[1].dimensionCompletionPct).toBe(50)
    // The gap is the completeness weight over that one part of it, not more.
    // Scores are published to one decimal, so the gap is read to the same.
    expect(ranked[0].score - ranked[1].score).toBeCloseTo(50 * 0.45 * RANKING_WEIGHTS.completeness, 1)
  })

  it('never rewards finding fewer defects', () => {
    // Same work, same record; one finds twice what peers find, one finds none.
    const { ranked } = rankInspectors(
      [
        inspector({ inspectorId: 'a', name: 'Finds more', detectionIndex: 2, defectRecords: 60 }),
        inspector({ inspectorId: 'b', name: 'Finds none', detectionIndex: 0, defectRecords: 0 }),
      ],
      20,
    )
    expect(ranked[0].name).toBe('Finds more')
    expect(ranked[0].detectionScore).toBe(100)
    expect(ranked[1].detectionScore).toBe(0)
  })

  it('counts the work per day worked, so a shorter month is not a penalty', () => {
    const { ranked } = rankInspectors(
      [
        inspector({ inspectorId: 'a', name: 'Part month', samples: 50, activeDays: 5, pieces: 1000, lines: 10 }),
        inspector({ inspectorId: 'b', name: 'Whole month', samples: 100, activeDays: 20, pieces: 1000, lines: 10 }),
      ],
      20,
    )
    // 10 a day against 5 a day: the one who worked half the month leads.
    expect(ranked[0].name).toBe('Part month')
    expect(ranked[0].samplesPerActiveDay).toBe(10)
    expect(ranked[1].samplesPerActiveDay).toBe(5)
  })

  it('marks down a record that had to be corrected afterwards', () => {
    const { ranked } = rankInspectors(
      [
        inspector({ inspectorId: 'a', name: 'Clean', corrections: 0 }),
        inspector({ inspectorId: 'b', name: 'Corrected', corrections: 20 }),
      ],
      20,
    )
    expect(ranked[0].name).toBe('Clean')
    expect(ranked[0].accuracyScore).toBe(100)
    expect(ranked[1].correctionsPer100Samples).toBe(20)
    expect(ranked[1].accuracyScore).toBeLessThan(100)
  })

  it('does not mark down what does not apply', () => {
    // A machine whose samples carry no coil: the coil register cannot count.
    const { ranked } = rankInspectors([inspector({ coilsUsed: 0, coilsFromRegister: 0 })], 20)
    expect(ranked[0].coilFromRegisterPct).toBeNull()
    expect(ranked[0].completenessScore).toBe(100)
  })

  it('lists but does not place an inspector with too little work', () => {
    const group = rankInspectors(
      [inspector({ inspectorId: 'a', name: 'Regular', samples: 100 }), inspector({ inspectorId: 'b', name: 'One shift', samples: 4, activeDays: 1 })],
      20,
    )
    expect(group.ranked.map((r) => r.name)).toEqual(['Regular'])
    expect(group.unranked.map((r) => r.name)).toEqual(['One shift'])
    // And the unplaced one does not set the yardstick for the placed one:
    // four samples in one day is 4 a day, yet Regular still scores full.
    expect(group.ranked[0].coverageScore).toBe(100)
  })

  it('sits at parity when there is no peer to compare with', () => {
    const { ranked } = rankInspectors([inspector({ detectionIndex: null })], 20)
    expect(ranked[0].detectionScore).toBe(50)
  })

  it('orders by score, then by work done, and numbers the places', () => {
    const { ranked } = rankInspectors(
      [
        inspector({ inspectorId: 'a', name: 'Tied less work', samples: 50, pieces: 1000, activeDays: 10, lines: 10 }),
        inspector({ inspectorId: 'b', name: 'Tied more work', samples: 50, pieces: 1000, activeDays: 10, lines: 10 }),
        inspector({ inspectorId: 'c', name: 'Weaker', dimensionsMeasured: 100, samples: 50, pieces: 1000, activeDays: 10, lines: 10 }),
      ],
      20,
    )
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3])
    expect(ranked[2].name).toBe('Weaker')
    expect(ranked[0].score).toBe(ranked[1].score)
  })

  it('scores a lone inspector on what applies, not against an absent field', () => {
    const { ranked } = rankInspectors([inspector({ name: 'Only one' })], 20)
    expect(ranked[0].rank).toBe(1)
    // Coverage and accuracy are relative and have no one to lose to; detection
    // is at parity. 100·0.3 + 100·0.35 + 100·0.2 + 50·0.15.
    expect(ranked[0].score).toBe(92.5)
  })
})
