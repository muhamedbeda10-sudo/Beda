import { describe, expect, it } from 'vitest'
import { changeoverMinutes, maintenanceEvents } from './maintenance'

describe('§25 changeovers and maintenance', () => {
  it('takes the most specific changeover rule, and none between the same family', () => {
    const rules = [
      { id: 'a', machineKey: null, process: null, fromFamily: '', toFamily: '', minutes: 20 },
      { id: 'b', machineKey: null, process: 'forming' as const, fromFamily: '', toFamily: '', minutes: 45 },
      { id: 'c', machineKey: '1', process: null, fromFamily: '', toFamily: '', minutes: 60 },
      { id: 'd', machineKey: '1', process: null, fromFamily: 'XL', toFamily: 'S', minutes: 90 },
      { id: 'e', machineKey: null, process: 'forming' as const, fromFamily: '', toFamily: 's', minutes: 50 },
    ]
    expect(changeoverMinutes(rules, '9', 'welding', 'XL', 'S')).toBe(20)
    expect(changeoverMinutes(rules, '9', 'forming', 'XL', 'M')).toBe(45)
    expect(changeoverMinutes(rules, '9', 'forming', 'XL', 'S')).toBe(50)
    expect(changeoverMinutes(rules, '1', 'forming', 'M', 'S')).toBe(60)
    expect(changeoverMinutes(rules, '1', 'forming', 'xl', 'S')).toBe(90)
    expect(changeoverMinutes(rules, '1', 'forming', 'S', 'S')).toBe(0)
    expect(changeoverMinutes([], '1', 'forming', 'XL', 'S')).toBe(0)
  })

  it('turns maintenance rules into stops over the horizon, one due before today done today', () => {
    const rules = [
      { id: 'oil', machineKey: '1', name: 'Oil change', everyDays: 7, everyRunHours: null, durationHours: 4, lastDone: '2026-10-20' },
      { id: 'belt', machineKey: '2', name: 'Belts', everyDays: null, everyRunHours: 160, durationHours: 2, lastDone: null, startTime: '14:00' },
      { id: 'old', machineKey: '3', name: 'Overdue', everyDays: 30, everyRunHours: null, durationHours: 8, lastDone: '2026-01-01' },
      { id: 'none', machineKey: '4', name: 'Never', everyDays: null, everyRunHours: null, durationHours: 8, lastDone: null },
    ]
    const ev = maintenanceEvents(rules, '2026-10-24', 21, () => 16)
    const of = (id: string) => ev.filter((e) => e.id.startsWith(`maint:${id}:`)).map((e) => (e.type === 'machine-down' ? `${e.from} → ${e.to}` : ''))
    expect(of('oil')).toEqual(['2026-10-27 08:00 → 2026-10-27 12:00', '2026-11-03 08:00 → 2026-11-03 12:00', '2026-11-10 08:00 → 2026-11-10 12:00'])
    // 160 running hours at 16 h a day = every 10 days, from today.
    expect(of('belt')).toEqual(['2026-11-03 14:00 → 2026-11-03 16:00', '2026-11-13 14:00 → 2026-11-13 16:00'])
    expect(of('old')[0]).toBe('2026-10-24 08:00 → 2026-10-24 16:00')
    expect(of('none')).toEqual([])
    expect(ev.every((e) => e.type === 'machine-down' && e.note)).toBe(true)
  })
})
