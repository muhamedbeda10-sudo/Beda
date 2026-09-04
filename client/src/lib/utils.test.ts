import { describe, expect, it } from 'vitest'
import { chunk } from './utils'

describe('chunk', () => {
  it('slices a list into consecutive pieces of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]])
    expect(chunk([1, 2], 10)).toEqual([[1, 2]])
    expect(chunk([], 4)).toEqual([])
  })

  it('rejects a size that could never terminate', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError)
    expect(() => chunk([1], 1.5)).toThrow(RangeError)
  })
})
