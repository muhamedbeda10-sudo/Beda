import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, ImagePlus, Trash2, Loader2, AlertCircle } from 'lucide-react'
import { loadImageBlob, uploadImage, resolveImageUrl } from '@/services/uploadImage'
import { ImageRejected } from '@/services/imageStore'
import { useApp } from '@/store/AppContext'
import { useImages } from '@/services/queries'
import { Lightbox } from '@/components/ui/Lightbox'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { UndoStrip, useUndo } from './UndoStrip'
import { appendIds, intakeRefusal, putBackId, removeId, uploadEach, type ImageIdsEdit } from './imageUploads'
import type { ImageAsset } from '@qc/shared/types'

/**
 * The box each photo and each add button takes. `sm` for the photos of a
 * record; `lg` for reference photos, which are compared with the part on the
 * table at arm's length.
 */
const BOX = {
  sm: 'h-20 w-20',
  lg: 'h-32 w-32 sm:h-40 sm:w-48',
} as const

/**
 * Capture or pick photos. Uploads immediately (§9.5) and hands back the stored
 * image ids, so the record that references them is only ever written after the
 * bytes are safe. What it hands back is an edit to apply to the list as it
 * stands (imageUploads.ts): photos taken one after another, or one removed
 * while another uploads, all end up as the person left them. `onUploading`
 * says when uploads start and finish, so the record's Save can wait for them.
 * While the record is being saved (`lockedReason`) no photo is added or
 * removed — one would land after the record was written and be lost without a
 * word — and the reason is said where the buttons are.
 *
 * Lists render the small preview; full resolution is fetched only in the zoom
 * viewer, so a history page with 50 photos does not stall on a phone (§10.7).
 *
 * A photo is removed with the button on its corner — always shown on a touch
 * screen, which cannot hover, and on hover or keyboard focus under a mouse —
 * or from the viewer. Either way the row says "Photo removed" with an Undo for
 * a few seconds.
 */
export function ImagePicker({
  imageIds,
  onChange,
  onUploading,
  lockedReason,
  sessionId,
  orderId,
  readOnly,
  size = 'sm',
  max,
  addLabel,
}: {
  imageIds: string[]
  /** Applies the edit to the record's list as it stands then (a functional state update). */
  onChange: (edit: ImageIdsEdit) => void
  /** Told true as a batch of uploads starts and false as it ends — once each, even if the picker is gone by then. */
  onUploading?: (uploading: boolean) => void
  /** Set while the record is being saved: photos can be neither added nor removed, and this says why. */
  lockedReason?: string
  sessionId?: string
  orderId?: string
  readOnly?: boolean
  /** How large each photo is drawn: `sm` (the default) for a record's photos, `lg` for reference photos. */
  size?: keyof typeof BOX
  /** The most photos the record takes (a scrap card: one). Once reached, the add buttons step aside. */
  max?: number
  /** Names what the add buttons add, for a screen reader ("scrap card photo"). */
  addLabel?: string
}) {
  const { toast } = useApp()
  // Only the photos this record references, fetched by id.
  const { data: attached = [] } = useImages(imageIds)
  const camRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(0)
  const [viewer, setViewer] = useState<number | null>(null)
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({})
  // Photos uploaded in this session — and a photo put back with Undo — render at once, before the query refetches.
  const [justUploaded, setJustUploaded] = useState<Record<string, ImageAsset>>({})
  const undo = useUndo<ImageAsset>()
  // Files arrive from the camera or the gallery later than the tap that asked for them: by then the record may be
  // being saved, or saved and gone. What holds at that moment decides (imageUploads.intakeRefusal).
  const locked = useRef(lockedReason)
  locked.current = lockedReason
  const open = useRef(true)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])
  const editable = !readOnly && !lockedReason

  // Kept in the order the record lists them, not the order they arrive.
  const assets = useMemo(() => {
    const byId = new Map<string, ImageAsset>()
    for (const a of attached) byId.set(a.id, a)
    for (const a of Object.values(justUploaded)) if (!byId.has(a.id)) byId.set(a.id, a)
    return imageIds.map((id) => byId.get(id)).filter((a): a is ImageAsset => Boolean(a))
  }, [imageIds, attached, justUploaded])

  // Resolve full-resolution content only while the viewer is open.
  useEffect(() => {
    if (viewer === null) return
    const asset = assets[viewer]
    if (!asset || fullUrls[asset.id]) return
    let cancelled = false
    resolveImageUrl(asset)
      .then((url) => !cancelled && setFullUrls((m) => ({ ...m, [asset.id]: url })))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [viewer, assets, fullUrls])

  /** Takes the photo off the record, and offers it back for a few seconds. */
  function remove(asset: ImageAsset) {
    const index = imageIds.indexOf(asset.id)
    if (index < 0 || locked.current) return
    onChange(removeId(asset.id))
    undo.offer('Photo removed', asset, index)
  }

  function putBack() {
    const r = undo.removed
    if (!r || locked.current) return
    undo.clear()
    setJustUploaded((m) => ({ ...m, [r.item.id]: r.item }))
    const back = putBackId(r.item.id, r.index)
    // With a limit, the photo put back takes the place of the one taken since: Undo means "this photo again".
    onChange(max === undefined ? back : (ids) => {
      const next = back(ids)
      return next.length <= max ? next : [r.item.id, ...next.filter((id) => id !== r.item.id)].slice(0, max)
    })
  }

  const box = BOX[size]

  async function handleFiles(list: FileList | null) {
    if (!list?.length) return
    const room = max === undefined ? Infinity : Math.max(0, max - imageIds.length - busy)
    const files = Array.from(list).slice(0, room)
    if (files.length === 0) return
    const refused = intakeRefusal(locked.current, open.current)
    if (refused) {
      toast(`${files.length === 1 ? 'Photo' : 'Photos'} not added. ${refused}`, 'error')
      return
    }
    // Added to what is already uploading: a second photo taken before the first is stored is a second spinner's worth.
    setBusy((n) => n + files.length)
    onUploading?.(true)
    try {
      const added = await uploadEach(
        files,
        (file) => uploadImage(file, { sessionId, orderId }),
        (asset) => {
          setBusy((n) => Math.max(0, n - 1))
          setJustUploaded((m) => ({ ...m, [asset.id]: asset }))
          // On the record as soon as its bytes are safe, at the end of the list as it is now.
          onChange(appendIds([asset.id]))
        },
        (file, e) => {
          setBusy((n) => Math.max(0, n - 1))
          // Tell the user exactly why this file was rejected (§10.5).
          toast(e instanceof ImageRejected || e instanceof ApiError ? e.message : `Could not upload ${file.name}.`, 'error')
        },
      )
      if (added) toast(`${added} photo${added === 1 ? '' : 's'} added.`, 'success')
    } finally {
      onUploading?.(false)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {assets.map((a, i) => (
          // Not clipped itself (the photo is rounded instead), so the remove button's hit area may reach past the corner.
          <div key={a.id} className={cn('group relative shrink-0 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700', box)}>
            <img src={a.thumbnailDataUrl} alt={a.originalFilename} className="h-full w-full cursor-zoom-in rounded-xl object-cover" onClick={() => setViewer(i)} />
            {editable && (
              // A tab in the corner, 32 px drawn and 44 px to a finger (the ::before reaches 6 px past each side, out
              // over the edge), so the middle of the photo still opens it. A screen that cannot hover always shows
              // it; under a mouse it comes up on hover or keyboard focus, as before.
              <button
                type="button"
                onClick={() => remove(a)}
                className="absolute right-0 top-0 grid h-8 w-8 place-items-center rounded-bl-xl rounded-tr-xl bg-black/55 text-white opacity-100 transition-opacity before:absolute before:-inset-1.5 hover:bg-black/70 focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                aria-label={`Remove ${a.originalFilename}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}

        {busy > 0 && (
          <div className={cn('grid place-items-center rounded-xl bg-slate-100 dark:bg-slate-800', box)}>
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        )}

        {!readOnly && (max === undefined || imageIds.length + busy < max) && (
          <>
            <button
              type="button"
              onClick={() => camRef.current?.click()}
              disabled={!!lockedReason}
              className={cn('grid place-items-center gap-1 rounded-xl border-2 border-dashed border-slate-300 text-muted transition-colors hover:border-brand-400 hover:text-brand-500 disabled:pointer-events-none disabled:opacity-40 dark:border-slate-700', box)}
              aria-label={addLabel ? `Take a ${addLabel}` : 'Take a photo'}
            >
              <Camera className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!!lockedReason}
              className={cn('grid place-items-center rounded-xl border-2 border-dashed border-slate-300 text-muted transition-colors hover:border-brand-400 hover:text-brand-500 disabled:pointer-events-none disabled:opacity-40 dark:border-slate-700', box)}
              aria-label={addLabel ? `Upload a ${addLabel} from the gallery` : 'Upload from gallery'}
            >
              <ImagePlus className="h-6 w-6" />
            </button>
          </>
        )}
      </div>

      {!readOnly && lockedReason && (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> {lockedReason}
        </p>
      )}

      {undo.removed && !lockedReason && (
        <div className="mt-2 max-w-sm">
          <UndoStrip key={undo.removed.id} label={undo.removed.label} onUndo={putBack} />
        </div>
      )}

      {readOnly && assets.length === 0 && (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-slate-200 px-3 py-3 text-sm text-muted dark:border-slate-700">
          <AlertCircle className="h-4 w-4" /> No photos attached.
        </p>
      )}

      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => handleFiles(e.target.files)} />
      <input ref={fileRef} type="file" accept="image/*" multiple={max === undefined || max > 1} hidden onChange={(e) => handleFiles(e.target.files)} />

      {viewer !== null && assets[viewer] && (
        <Lightbox
          images={assets.map((a) => ({
            id: a.id,
            dataUrl: fullUrls[a.id] ?? a.thumbnailDataUrl ?? '',
            caption: `${a.originalFilename} · ${(a.byteSize / 1024).toFixed(0)} KB · sha256 ${a.sha256.slice(0, 12)}…`,
            save: { name: a.originalFilename, load: () => loadImageBlob(a.id) },
          }))}
          startIndex={viewer}
          // The photo on screen is the one fetched in full, as the viewer moves from one to the next.
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
          // Removed from the viewer, the photo leaves it at once: the row behind then shows it gone, with the Undo.
          onRemove={
            !editable
              ? undefined
              : (index) => {
                  const asset = assets[index]
                  setViewer(null)
                  if (asset) remove(asset)
                }
          }
        />
      )}
    </div>
  )
}
