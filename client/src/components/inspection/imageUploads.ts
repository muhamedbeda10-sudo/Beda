// ============================================================================
// A record's list of photos, changed while uploads are still arriving.
//
// An upload takes seconds on factory WiFi, and the inspector does not wait:
// they take the next photo, or remove the one before. So the picker never
// hands its owner a whole list worked out from the photos it saw when an
// upload began — that list is stale by the time the upload lands, and writing
// it back loses the photo taken meanwhile (evidence gone) or brings back the
// one removed. It hands an edit instead, which the owner applies to its list
// as it stands then, the way React's functional state update does.
// ============================================================================

import { useCallback, useState } from 'react'
import type { ImageAsset } from '@qc/shared/types'
import { insertAt } from './UndoStrip'

/** A change to a list of image ids, applied to the list as it stands when it lands. */
export type ImageIdsEdit = (ids: string[]) => string[]

/** Adds the photos at the end, each once. */
export const appendIds =
  (added: readonly string[]): ImageIdsEdit =>
  (ids) => [...ids, ...added.filter((id, i) => !ids.includes(id) && added.indexOf(id) === i)]

/** Takes one photo off the list. */
export const removeId =
  (id: string): ImageIdsEdit =>
  (ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids)

/** Puts a removed photo back where it stood (Undo); a photo already on the list stays as it is. */
export const putBackId =
  (id: string, index: number): ImageIdsEdit =>
  (ids) => (ids.includes(id) ? ids : insertAt(ids, id, index))

/**
 * Uploads the files one after another, telling `onUploaded` as each is stored
 * — so a photo is on the record the moment its bytes are safe, whatever
 * happens to the rest — and `onFailed` for each that is refused. Resolves to
 * how many were stored.
 */
export async function uploadEach(
  files: readonly File[],
  upload: (file: File) => Promise<ImageAsset>,
  onUploaded: (asset: ImageAsset) => void,
  onFailed: (file: File, error: unknown) => void,
): Promise<number> {
  let stored = 0
  for (const file of files) {
    try {
      onUploaded(await upload(file))
      stored++
    } catch (e) {
      onFailed(file, e)
    }
  }
  return stored
}

/**
 * How many batches of photos are uploading for a record, and the
 * `onUploading` to give each of its pickers: the record's Save waits while it
 * is above nought. Counted here, not in the picker, so a picker on a step
 * left before its upload finished still counts until it does.
 */
export function useUploadsInFlight(): [number, (uploading: boolean) => void] {
  const [count, setCount] = useState(0)
  const onUploading = useCallback((uploading: boolean) => setCount((n) => nextUploadCount(n, uploading)), [])
  return [count, onUploading]
}

/** What the person is told when photos are picked while the record is being saved, or after it was. */
export const SAVED_AND_CLOSED = 'This record was saved and closed: open it again to add more photos.'

/**
 * Why photos picked now are not added, or null when they may be. Not while the
 * record is being saved (`lockedReason`): the photo would land after the record
 * was written and be lost from it. Not once the screen holding the record is
 * gone (`open` false): there is no record left to put it on. Either way the
 * person is told, rather than shown "added" for a photo that never is.
 */
export function intakeRefusal(lockedReason: string | undefined, open: boolean): string | null {
  if (!open) return SAVED_AND_CLOSED
  if (lockedReason) return lockedReason
  return null
}

/** The number of batches uploading, after one starts (true) or ends (false). */
export function nextUploadCount(count: number, uploading: boolean): number {
  return Math.max(0, count + (uploading ? 1 : -1))
}
