import { describe, expect, it } from 'vitest'
import { captionText, photoColumn, photoCount, queryPhotos } from './photos'

// §20 — a result that holds photos (a column named photo_id) is drawn as the
// photos, each captioned by its row's other columns.

const A = '0B0C3C1E-6D2A-4C1E-9A43-0F6B3C2D1E01'
const B = '0b0c3c1e-6d2a-4c1e-9a43-0f6b3c2d1e02'

describe('a result of photos', () => {
  it('is one with a photo_id column; each photo once, in order, captioned by the other columns but the ids', () => {
    const part = {
      ok: true,
      columns: ['defect_name', 'Photo_ID', 'defect_id', 'order_number', 'recorded_at', 'pieces'],
      rows: [
        ['Scratch', A, 'x', '20619-Ph3.3', '2026-09-27 11:29:28.034+03', 3],
        ['Dent', B, 'y', null, '2026-09-30', 1.5],
        ['Scratch again', A.toLowerCase(), 'x', '20619-Ph3.3', null, 3],
        ['Not a photo', 'not-an-id', 'z', '1', null, null],
      ],
    }
    expect(photoColumn(part.columns)).toBe(1)
    expect(queryPhotos(part)).toEqual([
      { id: A.toLowerCase(), title: 'Scratch', details: ['20619-Ph3.3', '2026-09-27 11:29', '3'] },
      { id: B, title: 'Dent', details: ['2026-09-30', '1.5'] },
    ])
  })

  it('is none without the column or when the query failed; a result of photos that found none is empty', () => {
    expect(queryPhotos({ columns: ['machine', 'pieces'], rows: [['24', 3]] })).toBeNull()
    expect(queryPhotos({ ok: false, columns: ['photo_id'], rows: [] })).toBeNull()
    expect(queryPhotos({ ok: true, columns: ['photo_id', 'defect_name'], rows: [] })).toEqual([])
  })

  it('writes a caption’s values as a report does', () => {
    expect(captionText(null)).toBe('')
    expect(captionText(true)).toBe('Yes')
    expect(captionText('2026-10-03T13:00:34.297+03:00')).toBe('2026-10-03 13:00')
    expect(captionText('  Long\n name ')).toBe('Long name')
    expect(captionText(0.1 + 0.2)).toBe('0.3')
    expect(photoCount(1)).toBe('1 photo')
    expect(photoCount(1200)).toBe('1,200 photos')
  })
})
