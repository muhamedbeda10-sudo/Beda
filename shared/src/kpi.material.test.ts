import { describe, it, expect } from 'vitest'
import { materialOfGrade } from './kpi'

describe('§15 — black or galvanized, from the grade', () => {
  it('reads a zinc coating written on the grade as galvanized', () => {
    for (const g of ['DX51D+Z', 'DX51D+Z275', 'S350GD+Z275MAC', 'S280GD + ZM120', 'S250GD+AZ150', 'dx51d+z100']) expect(materialOfGrade(g)).toBe('galvanized')
  })
  it('reads a grade made for coating, or GI, as galvanized', () => {
    for (const g of ['DX51D', 'DX53D', 'S350GD', 'GI', 'GALV 1.5']) expect(materialOfGrade(g)).toBe('galvanized')
  })
  it('reads every other grade as black', () => {
    for (const g of ['S235JR', 'S355JR', 'ST52-3', 'E355', 'HR', 'SPHC', 'S275J0']) expect(materialOfGrade(g)).toBe('black')
  })
  it('has no kind without a grade', () => {
    expect(materialOfGrade('')).toBe('unknown')
    expect(materialOfGrade('  ')).toBe('unknown')
    expect(materialOfGrade(null)).toBe('unknown')
  })
})
