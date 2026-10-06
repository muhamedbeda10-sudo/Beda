import { describe, expect, it } from 'vitest'
import { spreadLabels } from './labels'

describe('labels that never overlap', () => {
  it('leaves labels already apart where they are', () => {
    expect(spreadLabels([20, 60, 100], 11, 0, 200)).toEqual([20, 60, 100])
  })
  it('pushes a crowded label down just enough, keeping the order', () => {
    expect(spreadLabels([50, 48, 52], 11, 0, 200)).toEqual([59, 48, 70])
  })
  it('pushes the stack back up from the bottom edge', () => {
    expect(spreadLabels([195, 196], 11, 0, 200)).toEqual([189, 200])
  })
  it('keeps a label below the top edge', () => {
    expect(spreadLabels([-5], 11, 8, 200)).toEqual([8])
  })
})
