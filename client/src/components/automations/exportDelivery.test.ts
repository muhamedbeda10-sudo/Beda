import { describe, expect, it } from 'vitest'
import { aiStamp } from '@/components/ai/exportAiResult'
import { deliveryFilename } from './exportDelivery'

describe('a delivered report to Excel', () => {
  it('names the file after the automation and the moment it ran', () => {
    const ranAt = '2026-10-10T05:00:00Z'
    expect(deliveryFilename({ automationName: 'Daily rejects', ranAt })).toBe(`QC-Report-Daily-rejects-${aiStamp(ranAt).replace(' ', '-').replace(':', '')}.xlsx`)
  })
})
