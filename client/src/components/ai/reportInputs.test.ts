import { describe, expect, it } from 'vitest'
import type { AiReportInput } from '@qc/shared/aiReportInputs'
import { inputDrafts, inputsKey, inputsLine, localDay, readDrafts, runsOnOpen, sectionFigures, treeAsTable, treeRows } from './reportInputs'

const ORDERS: AiReportInput = { name: 'orders', label: 'Orders', kind: 'list', required: true }
const WEEK: AiReportInput = { name: 'week', label: 'Week', kind: 'number', required: true, dynamicDefault: 'this_week' }
const LEAVE: AiReportInput = { name: 'exclude', label: 'Leave out', kind: 'list', required: false }

describe('the form of a report', () => {
  it('starts from the values the run used, else each default of the day', () => {
    expect(inputDrafts([WEEK, LEAVE], null, '2026-10-15')).toEqual({ week: '42', exclude: '' })
    expect(inputDrafts([WEEK, LEAVE], { week: 26, exclude: ['20332', '20333'] }, '2026-10-15')).toEqual({ week: '26', exclude: '20332, 20333' })
  })

  it('runs at once only when every required input has a default', () => {
    expect(runsOnOpen([WEEK, LEAVE], '2026-10-15')).toBe(true)
    expect(runsOnOpen([ORDERS], '2026-10-15')).toBe(false)
  })

  it('checks what is typed as the server does', () => {
    expect(readDrafts([ORDERS, WEEK], { orders: '20332 20333', week: ' 26 ' }, '2026-10-15')).toEqual({ values: { orders: ['20332', '20333'], week: 26 } })
    expect(readDrafts([ORDERS, WEEK], { orders: '', week: 'x' }, '2026-10-15')).toEqual({ problems: ['Orders: required.', 'Week: a number.'] })
  })

  it('keys a run by its values, whatever their order, and says them in a line', () => {
    expect(inputsKey(null)).toBe('')
    expect(inputsKey({ week: 26, orders: ['1'] })).toBe(inputsKey({ orders: ['1'], week: 26 }))
    expect(inputsLine([ORDERS, WEEK, LEAVE], { orders: ['20332'], week: 26, exclude: null })).toBe('Orders: 20332 · Week: 26')
  })

  it('knows today on this device', () => {
    expect(localDay(new Date(2026, 9, 5, 23, 30))).toBe('2026-10-05')
  })
})

describe('how a section shows its rows', () => {
  it('takes the first row as the figures', () => {
    expect(sectionFigures(['Orders', 'Done %'], [[3, 91.5]])).toEqual([
      { label: 'Orders', value: 3 },
      { label: 'Done %', value: 91.5 },
    ])
    expect(sectionFigures(['Orders'], [])).toEqual([])
  })

  const columns = ['key', 'parent', 'Level', 'Item']
  const rows = [
    ['P:1', 'M:1', 'Part', 'Beam'],
    ['M:1', null, 'Main', 'Frame'],
    ['L:2', 'P:1', 'Machine', 'Beam on 31'],
    ['L:1', 'M:1', 'Machine', 'Frame on 58'],
    ['X', 'nowhere', 'Main', 'Orphan'],
  ]

  it('nests each row under its parent, keeping the order given, and leaves out the key and parent', () => {
    const tree = treeRows(columns, rows, { key: 'key', parent: 'parent' })!
    expect(tree.shown).toEqual([2, 3])
    expect(tree.rows.map((r) => [rows[r.index][3], r.depth, r.childCount, r.path])).toEqual([
      ['Frame', 0, 2, []],
      ['Beam', 1, 1, ['M:1']],
      ['Beam on 31', 2, 0, ['M:1', 'P:1']],
      ['Frame on 58', 1, 0, ['M:1']],
      // A parent that names no row: at the top.
      ['Orphan', 0, 0, []],
    ])
    expect(treeRows(columns, rows, { key: 'id', parent: 'parent' })).toBeNull()
  })

  it('shows a loop of parents once, at the top, and loses no row', () => {
    const loop = treeRows(['k', 'p'], [['a', 'b'], ['b', 'a']], { key: 'k', parent: 'p' })!
    expect(loop.rows.map((r) => r.index).sort()).toEqual([0, 1])
  })

  it('prints a tree as a table, stepped in', () => {
    const flat = treeAsTable(columns, rows, { key: 'key', parent: 'parent' })!
    expect(flat.columns).toEqual(['Level', 'Item'])
    expect(flat.rows.slice(0, 3)).toEqual([
      ['Main', 'Frame'],
      [' Part', 'Beam'],
      ['  Machine', 'Beam on 31'],
    ])
  })
})
