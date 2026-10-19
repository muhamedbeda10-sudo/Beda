import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, draftIsUntouched, listDrafts, loadDraft, saveDraft, type SampleDraft } from './draftStore'

const base: SampleDraft = {
  userId: 'u-amal',
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

/** localStorage as the browser has it, with its keys in order. */
function storage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    get length() {
      return m.size
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  }
}

describe('a draft on a shared tablet', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is resumed only by the person who typed it', () => {
    vi.stubGlobal('localStorage', storage())
    const typed = { ...base, sampleQty: '5' }
    saveDraft(typed)
    expect(loadDraft('u-amal', 's1')?.sampleQty).toBe('5')
    // The next inspector to open the same session on this tablet starts their own sample.
    expect(loadDraft('u-omar', 's1')).toBeNull()
    expect(listDrafts('u-omar')).toEqual([])
    expect(listDrafts('u-amal').map((d) => d.sampleQty)).toEqual(['5'])
    // Their own draft of it is kept apart, and clearing one leaves the other.
    saveDraft({ ...typed, userId: 'u-omar', sampleQty: '7' })
    clearDraft('u-amal', 's1')
    expect(loadDraft('u-amal', 's1')).toBeNull()
    expect(loadDraft('u-omar', 's1')?.sampleQty).toBe('7')
  })

  it('keeps no draft without an owner, and never resumes one from before drafts had owners', () => {
    const legacy = { ...base, userId: undefined, sampleQty: '9' }
    const store = storage({ 'qc-draft-v3:s1': JSON.stringify(legacy), 'qc-other': 'kept' })
    vi.stubGlobal('localStorage', store)
    saveDraft({ ...base, userId: '' })
    expect(store.keys()).toEqual(['qc-draft-v3:s1', 'qc-other'])
    // Whose it is cannot be shown, so nobody gets it — it is dropped from the device.
    expect(loadDraft('u-amal', 's1')).toBeNull()
    expect(loadDraft('', 's1')).toBeNull()
    expect(store.keys()).toEqual(['qc-other'])
  })

  it('refuses a draft stored under one person’s key that names another', () => {
    const store = storage({ 'qc-draft-v4:u-amal:s1': JSON.stringify({ ...base, userId: 'u-omar' }) })
    vi.stubGlobal('localStorage', store)
    expect(loadDraft('u-amal', 's1')).toBeNull()
  })
})
