import { describe, expect, it } from 'vitest'
import { MTC_REGISTERS, type MtcStandard } from '@qc/shared/mtc'
import { fieldText, isJudged, judgedTip } from './cells'

const field = (key: string) => MTC_REGISTERS.coils.fields.find((f) => f.key === key)!
const std: MtcStandard = { grade: 'S420MC', standard: 'EN 10149-2', yieldMin: 420, yieldMax: null, tensileMin: 480, tensileMax: 620, elongationMin: 16 }

describe('a coil register value as people read it', () => {
  it('names the type as the factory does, and keeps any other code as written', () => {
    expect(fieldText(field('smType'), 'HR')).toBe('Black')
    expect(fieldText(field('smType'), 'GI')).toBe('Galvanized')
    expect(fieldText(field('smType'), 'PP')).toBe('P.P')
    expect(fieldText(field('smType'), 'CR')).toBe('CR')
    expect(fieldText(field('thickness'), undefined)).toBe('')
    expect(fieldText(field('yield'), 433)).toBe('433')
  })

  it('says in the tooltip whether a strength is within its grade, and by which limit', () => {
    expect(isJudged('yield') && isJudged('tensile') && isJudged('elongation')).toBe(true)
    expect(isJudged('width')).toBe(false)
    expect(judgedTip(field('yield'), std, 433)).toBe('Within S420MC: ≥ 420 MPa')
    expect(judgedTip(field('tensile'), std, 650)).toBe('Outside S420MC: 480–620 MPa')
    expect(judgedTip(field('elongation'), std, undefined)).toBe('S420MC: ≥ 16 %')
    expect(judgedTip(field('yield'), undefined, 433)).toBeUndefined()
    expect(judgedTip(field('tensile'), { ...std, tensileMin: null, tensileMax: null }, 500)).toBe('S420MC sets no tensile limit')
  })
})
