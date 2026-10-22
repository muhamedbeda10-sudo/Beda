import { describe, expect, it } from 'vitest'
import { isConcessionGrantor } from '../src/modules/concessionPeople'

describe('the three requested concession grantors', () => {
  it('uses their registered Arabic names, including diacritics and name variants', () => {
    for (const name of ['محمود جعفر', 'مَحْمُود جَعْفَر', 'م. طاهر محمد', 'محمد مجدى', 'محمد مجدي']) expect(isConcessionGrantor(name), name).toBe(true)
  })
  it('recognises the common English spellings without replacing the registered name', () => {
    for (const name of ['Mahmoud Gaafar', 'Mahmoud Gafar', 'Mahmoud Jaafar', 'Taher', 'Eng. Tahir Mohamed', 'Mohamed Magdy', 'Mohammed Magdi', 'Muhammad Magdy']) expect(isConcessionGrantor(name), name).toBe(true)
  })
  it('does not offer the other registered users', () => {
    for (const name of ['Administrator', 'Ayman Rafat', 'Mahmoud Ahmed', 'Mohamed Hassan', 'Mohamed Gaafar', 'Mahmoud Magdy', 'QC Automations']) expect(isConcessionGrantor(name), name).toBe(false)
  })
})
