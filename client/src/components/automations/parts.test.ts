import { describe, expect, it } from 'vitest'
import { idColumnsLast } from './parts'

describe('the columns of a run’s rows', () => {
  it('puts the ids last — by name, or by holding nothing but UUIDs — and keeps every other order', () => {
    const columns = ['SAMPLE_ID', 'session', 'MACHINE', 'id', 'DEFECT_PIECES', 'order_ref']
    const rows = [
      ['2f1c0d4e-7b3a-4c5d-9e8f-0a1b2c3d4e5f', '3a9b8c7d-6e5f-4a3b-8c7d-6e5f4a3b2c1d', 'LM4', 'x1', 12, 'SO-1001'],
      ['6e5f4a3b-2c1d-4e5f-8a9b-0c1d2e3f4a5b', null, 'LM5', 'x2', 7, 'SO-1002'],
    ]
    expect(idColumnsLast(columns, rows)).toEqual([2, 4, 5, 0, 1, 3])
  })

  it('leaves a column of mixed text, or of nothing, where it is', () => {
    const rows = [
      ['2f1c0d4e-7b3a-4c5d-9e8f-0a1b2c3d4e5f', null, 'a note'],
      ['not a uuid', null, '3a9b8c7d-6e5f-4a3b-8c7d-6e5f4a3b2c1d'],
    ]
    expect(idColumnsLast(['ref', 'empty', 'note'], rows)).toEqual([0, 1, 2])
    expect(idColumnsLast([], [])).toEqual([])
  })
})
