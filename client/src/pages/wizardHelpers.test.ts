import { describe, expect, it } from 'vitest'
import { validateSample } from '@qc/shared/rules'
import { buildGradeIndex } from '@qc/shared/rules'
import { ApiError } from '@/lib/api'
import type { SampleDraft } from '@/services/draftStore'
import {
  coveringAcknowledgement,
  dimensionFigures,
  isBlankLength,
  keptLengths,
  keyboardLikelyOpen,
  opensKeyboard,
  previewStatus,
  renumberLengthIssues,
  withCoilRule,
  wizardLoadState,
} from './wizardHelpers'

describe('the tested lengths that go with a PT sample', () => {
  it('leaves out a row with neither a length nor a verdict, and nothing else', () => {
    expect(isBlankLength({ lengthMm: '', verdict: undefined })).toBe(true)
    expect(isBlankLength({ lengthMm: '   ' })).toBe(true)
    expect(isBlankLength({ lengthMm: '250' })).toBe(false)
    expect(isBlankLength({ lengthMm: '', verdict: 'Accept' })).toBe(false)
    expect(isBlankLength({ lengthMm: '0' })).toBe(false)
  })

  it('keeps the filled rows in order and remembers the row each stood on', () => {
    const rows = [
      { key: 'a', lengthMm: '250', verdict: 'Accept' as const },
      { key: 'b', lengthMm: '' },
      { key: 'c', lengthMm: '', verdict: 'Reject / Repair' as const },
      { key: 'd', lengthMm: '' },
    ]
    const { kept, rowOf } = keptLengths(rows)
    expect(kept.map((l) => l.key)).toEqual(['a', 'c'])
    expect(rowOf).toEqual([1, 3])
  })

  it('keeps nothing from a list of blank rows, so "at least one" still applies', () => {
    expect(keptLengths([{ lengthMm: '' }, { lengthMm: ' ' }]).kept).toEqual([])
  })
})

describe('an issue about a tested length is named by its row on the screen', () => {
  const ptIssues = (lengths: Array<{ lengthMm: string; verdict?: 'Accept' | 'Reject / Repair' }>) => {
    const { kept, rowOf } = keptLengths(lengths)
    const issues = validateSample({
      process: 'welding',
      sampleQty: 1,
      drawing: 'D-1',
      coils: [],
      defects: [],
      pt: {
        consumableLots: { Cleaner: 'C', Penetrant: 'P', Developer: 'D' },
        connectorCoilNumber: 'C10021',
        testedLengths: kept.map((l) => ({ lengthMm: Number(l.lengthMm), verdict: l.verdict ?? null })),
      },
    })
    return renumberLengthIssues(issues, rowOf)
  }

  it('says "3" for the third row when a blank second row was left out', () => {
    const issues = ptIssues([{ lengthMm: '250', verdict: 'Accept' }, { lengthMm: '' }, { lengthMm: '120' }])
    expect(issues.map((i) => i.message)).toEqual(['Choose Accept or Reject / Repair for tested length 3.'])
    expect(issues[0].ref).toBe('length-3')
  })

  it('renames both issues of a row, at the start of the sentence and inside it', () => {
    const issues = ptIssues([{ lengthMm: '' }, { lengthMm: '0' }])
    expect(issues.map((i) => i.message)).toEqual([
      'Tested length 2 must be greater than zero.',
      'Choose Accept or Reject / Repair for tested length 2.',
    ])
  })

  it('does not take row 1 for row 12', () => {
    const rowOf = [3]
    const [issue] = renumberLengthIssues([{ message: 'Tested length 1 must be greater than zero.', ref: 'length-1' }], rowOf)
    expect(issue.message).toBe('Tested length 3 must be greater than zero.')
    const [other] = renumberLengthIssues([{ message: 'Tested length 12 must be greater than zero.', ref: 'length-12' }], rowOf)
    expect(other.message).toBe('Tested length 12 must be greater than zero.')
  })

  it('passes every other issue through as it is', () => {
    const issues = [{ step: 'pt', message: 'Enter at least one tested weld length.', ref: 'testedLengths' }, { step: 'review', message: 'Sample quantity must be greater than zero.' }]
    expect(renumberLengthIssues(issues, [4])).toEqual(issues)
  })
})

describe('the on-screen keyboard', () => {
  it('is taken to be up when a finger is typing and the visible area lost more than a quarter', () => {
    expect(keyboardLikelyOpen({ visible: 464, tallest: 800, editing: true, coarse: true })).toBe(true)
    expect(keyboardLikelyOpen({ visible: 384, tallest: 768, editing: true, coarse: true })).toBe(true)
  })

  it('is not taken to be up for a browser bar sliding away, a mouse, or nothing being typed', () => {
    expect(keyboardLikelyOpen({ visible: 744, tallest: 800, editing: true, coarse: true })).toBe(false)
    expect(keyboardLikelyOpen({ visible: 400, tallest: 800, editing: true, coarse: false })).toBe(false)
    expect(keyboardLikelyOpen({ visible: 400, tallest: 800, editing: false, coarse: true })).toBe(false)
    expect(keyboardLikelyOpen({ visible: 400, tallest: 0, editing: true, coarse: true })).toBe(false)
  })

  it('comes up for text boxes and text areas, not for buttons, choices or files', () => {
    expect(opensKeyboard({ tagName: 'INPUT', type: 'number' })).toBe(true)
    expect(opensKeyboard({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(opensKeyboard({ tagName: 'INPUT' })).toBe(true)
    expect(opensKeyboard({ tagName: 'TEXTAREA' })).toBe(true)
    expect(opensKeyboard({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(opensKeyboard({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(opensKeyboard({ tagName: 'INPUT', type: 'file' })).toBe(false)
    expect(opensKeyboard({ tagName: 'INPUT', type: 'text', readOnly: true })).toBe(false)
    expect(opensKeyboard({ tagName: 'SELECT' })).toBe(false)
    expect(opensKeyboard({ tagName: 'BUTTON' })).toBe(false)
    expect(opensKeyboard(null)).toBe(false)
  })
})

describe('a dimension as the wizard reads it', () => {
  const row = (nominal: string, tolPlus: string, tolMinus: string, actual: string) => ({ nominal, tolPlus, tolMinus, actual })

  it('reads a comma, the Arabic decimal mark and Arabic digits as the number they are', () => {
    expect(dimensionFigures(row('0,5', '\u0660\u066B\u0661', '0.1', '\u0660\u066B\u0665'))).toEqual({ nominal: 0.5, tolPlus: 0.1, tolMinus: 0.1, actual: 0.5 })
    expect(previewStatus(row('0,5', '0,1', '0,1', '0,5'))).toBe('Pass')
    expect(previewStatus(row('0,5', '0,1', '0,1', '0,7'))).toBe('Fail')
  })

  it('previews a blank figure as the server stores it — Pending, not a Fail against 0', () => {
    expect(previewStatus(row('', '0.5', '0.5', '12'))).toBe('Pending')
    expect(previewStatus(row('12', '', '', '12.4'))).toBe('Pending')
    expect(previewStatus(row('12', '0.5', '0.5', ''))).toBe('Pending')
  })

  it('never shows a pass on a tolerance that is not a number', () => {
    expect(previewStatus(row('12', '0.5mm', '0.5', '30'))).toBe('Pending')
    expect(previewStatus(row('12', 'abc', 'abc', '12'))).toBe('Pending')
    expect(Number.isNaN(dimensionFigures(row('12', '0.5mm', '', '')).tolPlus)).toBe(true)
  })
})

describe('§8.4 the grade acknowledgement holds for exactly what was acknowledged', () => {
  const index = buildGradeIndex([])
  const coils = [
    { coilNumber: 'C1', grade: 'S235' },
    { coilNumber: 'C2', grade: 'DX51D' },
  ]
  const ack = { coilNumbers: ['C1'], expectedGrade: 'DX51D', foundGrades: ['S235'], at: '2026-10-19T08:00:00Z' }

  it('holds while the coils have the very mismatches it names', () => {
    expect(coveringAcknowledgement(ack, 'DX51D', coils, index)).toBe(ack)
    // Written another way, it is the same grade and the same coil.
    expect(coveringAcknowledgement({ ...ack, coilNumbers: [' c1 '], foundGrades: ['s-235'] }, 'dx51d', coils, index)).toBeDefined()
  })

  it('does not hold for a different mismatch, a further one, or another expected grade', () => {
    expect(coveringAcknowledgement(ack, 'DX51D', [{ coilNumber: 'C3', grade: 'S235' }], index)).toBeUndefined()
    expect(coveringAcknowledgement(ack, 'DX51D', [{ coilNumber: 'C1', grade: 'S355' }], index)).toBeUndefined()
    expect(coveringAcknowledgement(ack, 'DX51D', [...coils, { coilNumber: 'C3', grade: 'S355' }], index)).toBeUndefined()
    expect(coveringAcknowledgement(ack, 'DX53D', coils, index)).toBeUndefined()
  })

  it('sends none when nothing mismatches', () => {
    expect(coveringAcknowledgement(ack, 'DX51D', [{ coilNumber: 'C2', grade: 'DX51D' }], index)).toBeUndefined()
    expect(coveringAcknowledgement(undefined, 'DX51D', coils, index)).toBeUndefined()
  })

  it('is let go of when a coil is added, removed or edited, and kept otherwise', () => {
    const draft = { coils, gradeAcknowledged: ack, drawing: 'D-1' } as unknown as SampleDraft
    expect(withCoilRule(draft, { ...draft, drawing: 'D-2' }).gradeAcknowledged).toBe(ack)
    expect(withCoilRule(draft, { ...draft, coils: [...coils, { coilNumber: 'C3' }] }).gradeAcknowledged).toBeUndefined()
    expect(withCoilRule(draft, { ...draft, coils: coils.slice(1) }).gradeAcknowledged).toBeUndefined()
    expect(withCoilRule(draft, { ...draft, coils: [{ ...coils[0], grade: 'S355' }, coils[1]] }).gradeAcknowledged).toBeUndefined()
    // Given anew with the change, it is the new one that stands.
    const fresh = { ...ack, at: '2026-10-19T09:00:00Z' }
    expect(withCoilRule(draft, { ...draft, coils: [...coils], gradeAcknowledged: fresh }).gradeAcknowledged).toBe(fresh)
  })
})

describe('what the wizard shows when its session could not be loaded', () => {
  const offline = new ApiError(0, 'internal', 'Network error — check your connection.')
  const gone = new ApiError(404, 'not_found', 'Session not found.')

  it('keeps working from what was loaded when a later refresh fails', () => {
    expect(wizardLoadState(true, null)).toBe('ready')
    expect(wizardLoadState(true, offline)).toBe('stale')
    expect(wizardLoadState(true, new ApiError(500, 'internal', 'The server had a problem.'))).toBe('stale')
  })

  it('says not found only when the server says so, or nothing is there', () => {
    expect(wizardLoadState(true, gone)).toBe('not-found')
    expect(wizardLoadState(false, gone)).toBe('not-found')
    expect(wizardLoadState(false, null)).toBe('not-found')
    expect(wizardLoadState(false, offline)).toBe('failed')
  })
})
