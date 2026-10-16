// ============================================================================
// §20 — a result that holds photos. The assistant shows the floor's photos
// by returning a column named photo_id (ai.inspection_photos, ai.pdi_photos):
// such a result is drawn as the photos themselves, each captioned by its
// row's other columns — its first as the photo's title, the rest under it —
// in an answer, a saved or scheduled report, and on paper. Ids are no caption:
// a column ending in _id is left out of it.
// ============================================================================

import { AI_PHOTO_COLUMN, parseChartDate, type AiCell } from '@qc/shared/ai'
import { cellText } from './tables'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A column that holds an id (defect_id, sample_id…): never part of a caption. */
const ID_COLUMN = /(?:^|_)id$/i

export interface AiPhoto {
  /** The stored image (/api/images/:id). */
  id: string
  /** The first caption column's value: what the photo is of. */
  title: string
  /** The other caption columns' values, in order. */
  details: string[]
}

/** Where a result's photo column is: -1 when it has none. */
export function photoColumn(columns: readonly string[]): number {
  return columns.findIndex((c) => c.trim().toLowerCase() === AI_PHOTO_COLUMN)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A value as a caption shows it: a date or a time as the wall clock reads it (no seconds, no offset), Yes / No, a figure as a table writes it. */
export function captionText(v: AiCell): string {
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const at = parseChartDate(v)
  if (at) {
    const d = new Date(at.ms)
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    return at.dateOnly ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  }
  return cellText(v).replace(/\s+/g, ' ').trim()
}

/**
 * The photos a result holds, in its order, each once; null when it is no
 * result of photos (it failed, or has no photo column). An empty list is a
 * result of photos that found none.
 */
export function queryPhotos(part: { ok?: boolean; columns: readonly string[]; rows: readonly (readonly AiCell[])[] }): AiPhoto[] | null {
  if (part.ok === false) return null
  const at = photoColumn(part.columns)
  if (at < 0) return null
  const captions = part.columns.map((c, i) => i).filter((i) => i !== at && !ID_COLUMN.test(part.columns[i].trim()))
  const seen = new Set<string>()
  const photos: AiPhoto[] = []
  for (const row of part.rows) {
    const id = row[at]
    if (typeof id !== 'string' || !UUID.test(id) || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    const words = captions.map((i) => captionText(row[i] ?? null)).filter((w) => w !== '')
    photos.push({ id: id.toLowerCase(), title: words[0] ?? '', details: words.slice(1) })
  }
  return photos
}

/** "12 photos", "1 photo". */
export const photoCount = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'photo' : 'photos'}`
