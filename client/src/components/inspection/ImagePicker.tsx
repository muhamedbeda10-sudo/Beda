import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, ImagePlus, Trash2, Loader2, AlertCircle } from 'lucide-react'
import { uploadImage, resolveImageUrl } from '@/services/uploadImage'
import { ImageRejected } from '@/services/imageStore'
import { useApp } from '@/store/AppContext'
import { useImages } from '@/services/queries'
import { Lightbox } from '@/components/ui/Lightbox'
import { ApiError } from '@/lib/api'
import type { ImageAsset } from '@qc/shared/types'

/**
 * Capture or pick photos. Uploads immediately (§9.5) and hands back the stored
 * image ids, so the record that references them is only ever written after the
 * bytes are safe.
 *
 * Lists render the small preview; full resolution is fetched only in the zoom
 * viewer, so a history page with 50 photos does not stall on a phone (§10.7).
 */
export function ImagePicker({
  imageIds,
  onChange,
  sessionId,
  orderId,
  readOnly,
}: {
  imageIds: string[]
  onChange: (ids: string[]) => void
  sessionId?: string
  orderId?: string
  readOnly?: boolean
}) {
  const { toast } = useApp()
  // Only the photos this record references, fetched by id.
  const { data: attached = [] } = useImages(imageIds)
  const camRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(0)
  const [viewer, setViewer] = useState<number | null>(null)
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({})
  // Photos uploaded in this session render at once, before the query refetches.
  const [justUploaded, setJustUploaded] = useState<Record<string, ImageAsset>>({})

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
          <div key={a.id} className="group relative h-20 w-20 overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-slate-700">
            <img src={a.thumbnailDataUrl} alt={a.originalFilename} className="h-full w-full cursor-zoom-in object-cover" onClick={() => setViewer(i)} />
            {!readOnly && (
              <button
                onClick={() => onChange(imageIds.filter((id) => id !== a.id))}
                className="absolute right-1 top-1 rounded bg-black/50 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={`Remove ${a.originalFilename}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}

        {busy > 0 && (
          <div className="grid h-20 w-20 place-items-center rounded-xl bg-slate-100 dark:bg-slate-800">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        )}

        {!readOnly && (
          <>
            <button
              type="button"
              onClick={() => camRef.current?.click()}
              className="grid h-20 w-20 place-items-center gap-1 rounded-xl border-2 border-dashed border-slate-300 text-muted transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-slate-700"
              aria-label="Take a photo"
            >
              <Camera className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="grid h-20 w-20 place-items-center rounded-xl border-2 border-dashed border-slate-300 text-muted transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-slate-700"
              aria-label="Upload from gallery"
            >
              <ImagePlus className="h-6 w-6" />
            </button>
          </>
        )}
      </div>

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
        />
      )}
    </div>
  )
}
