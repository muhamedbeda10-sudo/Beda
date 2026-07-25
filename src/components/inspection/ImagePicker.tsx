import { useEffect, useRef, useState } from 'react'
import { Camera, ImagePlus, Trash2, Loader2, AlertCircle } from 'lucide-react'
import { uploadImage } from '@/services/uploadImage'
import { resolveImageUrl } from '@/services/uploadImage'
import { ImageRejected } from '@/services/imageStore'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { useAll } from '@/services/useCollection'
import { COL } from '@/services/repository'
import { Lightbox } from '@/components/ui/Lightbox'
import type { ImageAsset } from '@/domain/types'

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
  const { profile } = useAuth()
  const { toast } = useApp()
  const { rows: allImages } = useAll<ImageAsset>(COL.images)
  const camRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(0)
  const [viewer, setViewer] = useState<number | null>(null)
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({})

  const assets = imageIds
    .map((id) => allImages.find((a) => a.id === id))
    .filter((a): a is ImageAsset => Boolean(a))

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
    if (!list?.length || !profile) return
    const files = Array.from(list)
    setBusy(files.length)
    const added: string[] = []
    for (const file of files) {
      try {
        const asset = await uploadImage(file, {
          uploadedByUid: profile.uid,
          uploadedByName: profile.name,
          sessionId,
          orderId,
        })
        added.push(asset.id)
      } catch (e) {
        // Tell the user exactly why this file was rejected (§10.5).
        toast(
          e instanceof ImageRejected ? e.message : `Could not upload ${file.name}.`,
          'error',
        )
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
          <div
            key={a.id}
            className="group relative h-20 w-20 overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-slate-700"
          >
            <img
              src={a.thumbnailDataUrl}
              alt={a.originalFilename}
              className="h-full w-full cursor-zoom-in object-cover"
              onClick={() => setViewer(i)}
            />
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
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
          </div>
        )}

        {!readOnly && (
          <>
            <button
              type="button"
              onClick={() => camRef.current?.click()}
              className="grid h-20 w-20 place-items-center gap-1 rounded-xl border-2 border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-slate-700"
              aria-label="Take a photo"
            >
              <Camera className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="grid h-20 w-20 place-items-center rounded-xl border-2 border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-slate-700"
              aria-label="Upload from gallery"
            >
              <ImagePlus className="h-6 w-6" />
            </button>
          </>
        )}
      </div>

      {readOnly && assets.length === 0 && (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-slate-200 px-3 py-3 text-sm text-slate-400 dark:border-slate-700">
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
