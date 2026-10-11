import { describe, expect, it } from 'vitest'
import { discardWords } from './NewPdiDialog'

describe('what closing a PDI would throw away', () => {
  it('names each part once, in one sentence', () => {
    expect(discardWords(['order 20480 with 3 items ticked', 'the notes', '2 photos'])).toBe('Order 20480 with 3 items ticked, the notes and 2 photos will not be saved. Nothing of this PDI is recorded until you save it.')
    expect(discardWords(['', 'the notes', '1 photo'])).toBe('The notes and 1 photo will not be saved. Nothing of this PDI is recorded until you save it.')
    expect(discardWords(['', '', '1 photo'])).toBe('1 photo will not be saved. Nothing of this PDI is recorded until you save it.')
  })

  it('still reads as a sentence with nothing named', () => {
    expect(discardWords(['', ''])).toBe('This PDI will not be saved. Nothing of this PDI is recorded until you save it.')
  })
})
