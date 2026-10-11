import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, ImagePlus, Trash2, Loader2, AlertCircle } from 'lucide-react'
import { uploadImage, resolveImageUrl } from '@/services/uploadImage'
import { ImageRejected } from '@/services/imageStore'
import { useApp } from '@/store/AppContext'
import { useImages } from '@/services/queries'
import { Lightbox } from '@/components/ui/Lightbox'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { UndoStrip, insertAt, useUndo } from './UndoStrip'
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
 * bytes are safe.
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
  sessionId,
  orderId,
  readOnly,
  size = 'sm',
}: {
  imageIds: string[]
  onChange: (ids: string[]) => void
  sessionId?: string
  orderId?: string
  readOnly?: boolean
  /** How large each photo is drawn: `sm` (the default) for a record's photos, `lg` for reference photos. */
  size?: keyof typeof BOX
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
    if (index < 0) return
    onChange(imageIds.filter((id) => id !== asset.id))
    undo.offer('Photo removed', asset, index)
  }

  function putBack() {
    const r = undo.removed
    if (!r) return
    undo.clear()
    if (imageIds.includes(r.item.id)) return
    setJustUploaded((m) => ({ ...m, [r.item.id]: r.item }))
    onChange(insertAt(imageIds, r.item.id, r.index))
  }

  const box = BOX[size]

  async function handleFiles(list: FileList | null) {
    if (!list?.length) return
    const files = Array.from(list)
    setBusy(files.length)
    const added: string[] = []
    for (const file of files) {
      try {
        const asset = await uploadImage(file, { sessionId, orderId })
        setJustUploaded((m) => ({ ...m, [asset.id]: asset }))
        added.push(asset.id)
      } catch (e) {
        // Tell the user exactly why this file was rejected (§10.5).
        toast(e instanceof ImageRejected || e instanceof ApiError ? e.message : `Could not upload ${file.name}.`, 'error')
      } finally {
        setBusy((n) => Math.max(0, n - 1))
      }
    }
    if (added.length) {
      onChange([...imageIds, ...added])
      toast(`${added.length} photo${added.length === 1 ? '' : 's'} added.`, 'success')
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {assets.map((a, i) => (
          // Not clipped itself (the photo is rounded instead), so the remove button's hit area may reach past the corner.
          <div key={a.id} className={cn('group relative shrink-0 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700', box)}>
            <img src={a.thumbnailDataUrl} alt={a.originalFilename} className="h-full w-full cursor-zoom-in rounded-xl object-cover" onClick={() => setViewer(i)} />
            {!readOnly && (
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

        {!readOnly && (
          <>
            <button
              type="button"
              onClick={() => camRef.current?.click()}
              className={cn('grid place-items-center gap-1 rounded-xl border-2 border-dashed border-slate-300 text-muted transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-slate-700', box)}
              aria-label="Take a photo"
            >
              <Camera className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={cn('grid place-items-center rounded-xl border-2 border-dashed border-slate-300 text-muted transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-slate-700', box)}
              aria-label="Upload from gallery"
            >
              <ImagePlus className="h-6 w-6" />
            </button>
          </>
        )}
      </div>

      {undo.removed && (
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
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />

      {viewer !== null && assets[viewer] && (
        <Lightbox
          images={assets.map((a) => ({
            id: a.id,
            dataUrl: fullUrls[a.id] ?? a.thumbnailDataUrl ?? '',
            caption: `${a.originalFilename} · ${(a.byteSize / 1024).toFixed(0)} KB · sha256 ${a.sha256.slice(0, 12)}…`,
          }))}
          startIndex={viewer}
          onClose={() => setViewer(null)}
          // Removed from the viewer, the photo leaves it at once: the row behind then shows it gone, with the Undo.
          onRemove={
            readOnly
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
