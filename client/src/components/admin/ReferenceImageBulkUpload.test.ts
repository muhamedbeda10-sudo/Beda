import { describe, expect, it } from 'vitest'
import { itemCodeFromFilename } from './ReferenceImageBulkUpload'

describe('itemCodeFromFilename', () => {
  it('reads the item code the old export encoded before the double underscore', () => {
    expect(itemCodeFromFilename('XL_UP_NP__2026-04-07T13-07-01-220Z.PNG')).toBe('XL.UP.NP.')
    expect(itemCodeFromFilename('SH_DMT_RA_STP_BD__2026-04-07T13-13-11-534Z.PNG')).toBe('SH.DMT.RA.STP.BD.')
    expect(itemCodeFromFilename('XL_OKV_UP_RIC_NP__2026-04-02T12-31-03-847Z.png')).toBe('XL.OKV.UP.RIC.NP.')
  })

  it('falls back to the file stem for a plainly named photo', () => {
    expect(itemCodeFromFilename('XL_LB_.jpg')).toBe('XL.LB.')
    expect(itemCodeFromFilename('125185TA3.jpeg')).toBe('125185TA3')
    expect(itemCodeFromFilename('photo')).toBe('photo')
  })
})
