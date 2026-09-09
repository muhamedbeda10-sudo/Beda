import { describe, expect, it } from 'vitest'
import { draftIsUntouched, type SampleDraft } from './draftStore'

const base: SampleDraft = {
  sessionId: 's1',
  orderId: 'o1',
  workCenterCode: '24',
  process: 'forming',
  submissionId: '11111111-1111-4111-8111-111111111111',
  step: 'dimensions',
  drawing: 'D-1',
  sampleQty: '',
  coils: [],
  gradeAcknowledged: undefined,
  dimensions: [{ name: 'A', sequence: 1, nominal: '0', tolPlus: '1', tolMinus: '1', actual: '', unit: 'mm', source: 'item-order' }],
  defects: [],
  paint: { imageIds: [] },
  note: { text: '', imageIds: [] },
  pt: undefined,
  updatedAt: '2026-09-09T00:00:00Z',
}

describe('an untouched draft', () => {
  it('is one with nothing recorded, whatever step it was left on', () => {
    expect(draftIsUntouched(base)).toBe(true)
    expect(draftIsUntouched({ ...base, step: 'review', drawing: 'changed' })).toBe(true)
  })

  it('stops being untouched once anything is recorded', () => {
    expect(draftIsUntouched({ ...base, dimensions: [{ ...base.dimensions[0], actual: '1004.3' }] })).toBe(false)
    expect(draftIsUntouched({ ...base, sampleQty: '5' })).toBe(false)
    expect(draftIsUntouched({ ...base, defects: [{ key: 'k', defectName: 'Dent', disposition: 'Hold', qty: '1', notes: '', imageIds: [] }] })).toBe(false)
    expect(draftIsUntouched({ ...base, paint: { imageIds: ['img'] } })).toBe(false)
    expect(draftIsUntouched({ ...base, note: { text: 'coil cert missing', imageIds: [] } })).toBe(false)
    expect(draftIsUntouched({ ...base, editingSampleId: 'x' })).toBe(false)
  })
})
