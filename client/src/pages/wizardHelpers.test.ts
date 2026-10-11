import { describe, expect, it } from 'vitest'
import { validateSample } from '@qc/shared/rules'
import { isBlankLength, keptLengths, keyboardLikelyOpen, opensKeyboard, renumberLengthIssues } from './wizardHelpers'

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
