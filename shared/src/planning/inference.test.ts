import { describe, expect, it } from 'vitest'
import { inferErpDurationMeaning, inferMachineStats, inferProcessOrder, inferRates, inferRoutes, type RecordRow } from './inference'
import { DEFAULT_PROCESS_RANK } from './types'
import { addDays } from './time'

const row = (over: Partial<RecordRow>): RecordRow => ({
  lineKey: 'L',
  machineKey: '1',
  itemCode: 'IC',
  itemFamily: 'XL',
  workDay: '2026-10-01',
  producedQty: 100,
  actualHours: 10,
  plannedHours: 8,
  durationHours: 20,
  requiredQty: 200,
  stageNo: null,
  shift: 'صباحي',
  ...over,
})

describe('§25 learning from the production record', () => {
  it('reads a machine’s pace by item, family and machine as the median, from enough rows', () => {
    const rows = [row({ producedQty: 100 }), row({ producedQty: 200 }), row({ producedQty: 1000 }), row({ itemCode: 'OTHER', producedQty: 50 }), row({ stageNo: 2, producedQty: 9999 })]
    const rates = inferRates(rows)
    expect(rates.find((r) => r.itemCode === 'ic')).toMatchObject({ piecesPerHour: 20, samples: 3 })
    // One row of OTHER is too few for an item's own pace.
    expect(rates.find((r) => r.itemCode === 'other')).toBeUndefined()
    expect(rates.find((r) => r.itemFamily === 'xl')).toMatchObject({ piecesPerHour: 15, samples: 4 })
    expect(rates.find((r) => r.itemCode === '' && r.itemFamily === '')).toMatchObject({ samples: 4 })
  })

  it('reads a machine’s working day from its days: hours added up per day, the median, efficiency and Fridays', () => {
    const today = '2026-10-20'
    const rows: RecordRow[] = []
    for (let i = 1; i <= 30; i++) {
      const day = addDays(today, -i)
      rows.push(row({ workDay: day, actualHours: 8, plannedHours: 6 }), row({ workDay: day, actualHours: 8, plannedHours: 6, shift: 'مسائي' }))
    }
    const [s] = inferMachineStats(rows, today)
    expect(s).toMatchObject({ machineKey: '1', hoursPerDay: 16, hoursFrom: 'actual', daysObserved: 30, efficiency: 0.75, worksFridays: true, fridaysWorked: 4 })
    expect(s.shifts).toEqual(['صباحي', 'مسائي'])
    const few = inferMachineStats(rows.slice(0, 4), today)[0]
    expect(few.hoursPerDay).toBeNull()
  })

  it('learns the order processes follow only where the record clearly says so', () => {
    const days = []
    for (let i = 0; i < 4; i++) {
      days.push({ orderNumber: `O${i}`, itemCode: 'B', process: 'forming' as const, firstDay: '2026-01-01' })
      days.push({ orderNumber: `O${i}`, itemCode: 'B', process: 'welding' as const, firstDay: '2026-01-03' })
      days.push({ orderNumber: `O${i}`, itemCode: 'B', process: 'paint' as const, firstDay: '2026-01-05' })
    }
    const learnt = inferProcessOrder(days)
    expect(learnt.learnt).toBe(true)
    expect(learnt.rank).toMatchObject({ forming: 1, welding: 2, paint: 3 })
    expect(inferProcessOrder(days.slice(0, 3))).toMatchObject({ learnt: false, rank: DEFAULT_PROCESS_RANK })
  })

  it('reads each item’s way through the factory and how usual it is', () => {
    const routes = inferRoutes(
      [
        { orderNumber: 'A', itemCode: 'B1', item: 'Beam', machineKey: '1', process: 'forming' },
        { orderNumber: 'A', itemCode: 'B1', item: 'Beam', machineKey: '9', process: 'paint' },
        { orderNumber: 'A', itemCode: 'B1', item: 'Beam', machineKey: '5', process: 'welding' },
        { orderNumber: 'B', itemCode: 'b1', item: 'Beam', machineKey: '2', process: 'forming' },
      ],
      DEFAULT_PROCESS_RANK,
    )
    expect(routes).toHaveLength(1)
    expect(routes[0].steps.map((s) => s.process)).toEqual(['forming', 'welding', 'paint'])
    expect(routes[0].steps[0].machines.map((m) => m.machineKey).sort()).toEqual(['1', '2'])
    expect(routes[0]).toMatchObject({ orders: 2, confidencePct: 50 })
  })

  it('tells whether the ERP’s part duration is the line’s hours or one piece’s', () => {
    const asLine = Array.from({ length: 6 }, () => ({ erpHours: 20, requiredQty: 200, taskDurationHours: 20, actualHours: null }))
    expect(inferErpDurationMeaning(asLine)).toMatchObject({ meaning: 'line', lineVotes: 6 })
    const asPiece = Array.from({ length: 6 }, () => ({ erpHours: 0.1, requiredQty: 200, taskDurationHours: null, actualHours: 22 }))
    expect(inferErpDurationMeaning(asPiece)).toMatchObject({ meaning: 'piece', pieceVotes: 6 })
    expect(inferErpDurationMeaning(asLine.slice(0, 2)).meaning).toBeNull()
  })
})
