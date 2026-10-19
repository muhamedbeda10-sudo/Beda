import { describe, expect, it } from 'vitest'
import { holdTile } from './holdTile'

describe('the On Hold now tile', () => {
  it('counts and sums every Hold, not the fifty listed', () => {
    expect(holdTile({ defects: 60, pieces: 120, amber: 0, red: 60 })).toEqual({ defects: 60, pieces: 120, tone: 'red' })
  })

  it('is amber, neutral or green by the oldest Hold of all', () => {
    expect(holdTile({ defects: 70, pieces: 140, amber: 1, red: 0 }).tone).toBe('amber')
    expect(holdTile({ defects: 3, pieces: 4.5, amber: 0, red: 0 })).toEqual({ defects: 3, pieces: 4.5, tone: 'neutral' })
    expect(holdTile({ defects: 0, pieces: 0, amber: 0, red: 0 }).tone).toBe('green')
  })
})
