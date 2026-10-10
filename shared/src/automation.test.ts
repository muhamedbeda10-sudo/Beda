import { describe, expect, it } from 'vitest'
import {
  describeSchedule,
  describeWatchInterval,
  isAutomationTime,
  isAutomationWeekday,
  renderAutomationTemplate,
  templatePlaceholders,
} from './automation'

describe('describeWatchInterval', () => {
  it('reads minutes, hours and a day', () => {
    expect(describeWatchInterval(5)).toBe('Every 5 minutes')
    expect(describeWatchInterval(1)).toBe('Every 1 minute')
    expect(describeWatchInterval(60)).toBe('Every hour')
    expect(describeWatchInterval(120)).toBe('Every 2 hours')
    expect(describeWatchInterval(90)).toBe('Every 1 hour 30 minutes')
    expect(describeWatchInterval(150)).toBe('Every 2 hours 30 minutes')
    expect(describeWatchInterval(1440)).toBe('Once a day')
  })
})

describe('describeSchedule', () => {
  it('daily, every day or no days given', () => {
    expect(describeSchedule({ cadence: 'daily', time: '08:00' })).toBe('Every day at 08:00')
    expect(describeSchedule({ cadence: 'daily', time: '08:00', weekdays: [] })).toBe('Every day at 08:00')
    expect(describeSchedule({ cadence: 'daily', time: '08:00', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every day at 08:00')
  })

  it('a range of days, wrapping past Saturday', () => {
    // Saturday to Thursday: every day but Friday.
    expect(describeSchedule({ cadence: 'daily', time: '07:30', weekdays: [6, 0, 1, 2, 3, 4] })).toBe('Saturday to Thursday at 07:30')
    expect(describeSchedule({ cadence: 'daily', time: '07:30', weekdays: [1, 2, 3, 4, 5] })).toBe('Monday to Friday at 07:30')
  })

  it('a list of days that is not a range, one day, and duplicates', () => {
    expect(describeSchedule({ cadence: 'daily', time: '09:00', weekdays: [0, 2, 4] })).toBe('Sunday, Tuesday, Thursday at 09:00')
    expect(describeSchedule({ cadence: 'daily', time: '09:00', weekdays: [5, 6] })).toBe('Friday, Saturday at 09:00')
    expect(describeSchedule({ cadence: 'daily', time: '09:00', weekdays: [3, 3] })).toBe('Every Wednesday at 09:00')
  })

  it('weekly and monthly', () => {
    expect(describeSchedule({ cadence: 'weekly', time: '09:00', weekday: 6 })).toBe('Every Saturday at 09:00')
    expect(describeSchedule({ cadence: 'monthly', time: '08:00', monthDay: 1 })).toBe('On the 1st of every month at 08:00')
    expect(describeSchedule({ cadence: 'monthly', time: '08:00', monthDay: 2 })).toBe('On the 2nd of every month at 08:00')
    expect(describeSchedule({ cadence: 'monthly', time: '08:00', monthDay: 3 })).toBe('On the 3rd of every month at 08:00')
    expect(describeSchedule({ cadence: 'monthly', time: '08:00', monthDay: 11 })).toBe('On the 11th of every month at 08:00')
    expect(describeSchedule({ cadence: 'monthly', time: '08:00', monthDay: 21 })).toBe('On the 21st of every month at 08:00')
    expect(describeSchedule({ cadence: 'monthly', time: '08:00', monthDay: 28 })).toBe('On the 28th of every month at 08:00')
  })
})

describe('isAutomationTime / isAutomationWeekday', () => {
  it('accepts HH:MM in 24 hours only', () => {
    expect(isAutomationTime('00:00')).toBe(true)
    expect(isAutomationTime('23:59')).toBe(true)
    expect(isAutomationTime('24:00')).toBe(false)
    expect(isAutomationTime('8:00')).toBe(false)
    expect(isAutomationTime('08:60')).toBe(false)
    expect(isAutomationTime('08:00:00')).toBe(false)
  })
  it('weekdays are integers 0–6', () => {
    expect(isAutomationWeekday(0)).toBe(true)
    expect(isAutomationWeekday(6)).toBe(true)
    expect(isAutomationWeekday(7)).toBe(false)
    expect(isAutomationWeekday(1.5)).toBe(false)
    expect(isAutomationWeekday('1')).toBe(false)
  })
})

describe('templates', () => {
  it('lists placeholders once each, in order, trimming spaces', () => {
    expect(templatePlaceholders('Sample {{ sample_no }} on {{machine}}: {{defect}} ({{machine}})')).toEqual(['sample_no', 'machine', 'defect'])
    expect(templatePlaceholders('No placeholders')).toEqual([])
    expect(templatePlaceholders('عينة {{رقم}}')).toEqual(['رقم'])
  })

  it('fills from a row; null is empty; an unknown column stays as written', () => {
    const columns = ['sample_no', 'machine', 'defect', 'pieces']
    expect(renderAutomationTemplate('Sample {{sample_no}} on {{ machine }}: {{defect}} × {{pieces}}', columns, [12, 'RF-03', null, 4])).toBe('Sample 12 on RF-03:  × 4')
    expect(renderAutomationTemplate('{{missing}} stays', columns, [1, 'a', 'b', 2])).toBe('{{missing}} stays')
    expect(renderAutomationTemplate('{{pieces}}', columns, [1, 'a', 'b', false])).toBe('false')
  })

  it('does not re-expand placeholders that a value contains', () => {
    expect(renderAutomationTemplate('{{a}} {{b}}', ['a', 'b'], ['{{b}}', 'x'])).toBe('{{b}} x')
  })
})
