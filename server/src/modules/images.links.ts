import type { Queryable } from '../db/pool'
import { badRequest } from '../lib/errors'

/** Every referenced image must exist and be live before a record may point at it (§9.5). */
export async function assertImagesUsable(q: Queryable, imageIds: string[]): Promise<void> {
  const ids = Array.from(new Set(imageIds))
  if (ids.length === 0) return
  const { rows } = await q.query<{ id: string }>(`SELECT id FROM images WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids])
  if (rows.length !== ids.length) {
    throw badRequest('One of the photos is missing. Remove it and attach it again before saving.')
  }
}

/** Write an ordered image list into one of the junction tables. */
export async function linkImages(
  q: Queryable,
  table: 'defect_images' | 'paint_sample_images' | 'pt_record_images' | 'pdi_images' | 'session_note_images' | 'concession_images',
  ownerColumn: 'defect_id' | 'paint_sample_id' | 'pt_record_id' | 'pdi_id' | 'note_id' | 'concession_id',
  ownerId: string,
  imageIds: string[],
): Promise<void> {
  const unique = Array.from(new Set(imageIds))
  if (unique.length === 0) return
  const values = unique.map((_, i) => `($1, $${i + 2}, ${i})`).join(', ')
  await q.query(`INSERT INTO ${table} (${ownerColumn}, image_id, position) VALUES ${values}`, [ownerId, ...unique])
}
