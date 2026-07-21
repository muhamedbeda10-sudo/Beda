import { useRef, useState } from 'react'
import { Camera, ImagePlus, Trash2, Maximize2 } from 'lucide-react'
import type { InspectionImage, ImageOwnerKind } from '@/types'
import { actions } from '@/store/db'
import { useApp } from '@/store/AppContext'
import { Lightbox } from '@/components/ui/Lightbox'

export function ImageStrip({
  images,
  ownerKind,
  ownerId,
  sessionId,
  compact,
}: {
  images: InspectionImage[]
  ownerKind: ImageOwnerKind
  ownerId: string
  sessionId: string
  compact?: boolean
}) {
  const { toast } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [viewer, setViewer] = useState<number | null>(null)

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    setBusy(true)
    try {
      let count = 0
      for (const file of Array.from(list)) {
        if (!file.type.startsWith('image/')) continue
        await actions.addImageFromFile(file, { ownerKind, ownerId, sessionId })
        count++
      }
      if (count) toast(`${count} image(s) added`, 'success')
    } catch {
      toast('Could not upload image', 'error')
    } finally {
      setBusy(false)
    }
  }

  const size = compact ? 'h-14 w-14' : 'h-20 w-20'

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {images.map((im, i) => (
          <div key={im.id} className={`group relative ${size} overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-slate-700`}>
            <img src={im.dataUrl} alt={im.caption || ''} className="h-full w-full cursor-zoom-in object-cover" onClick={() => setViewer(i)} />
            <div className="absolute inset-x-0 bottom-0 flex justify-between bg-gradient-to-t from-black/60 to-transparent p-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button onClick={() => setViewer(i)} className="rounded bg-white/20 p-1 text-white hover:bg-white/30" aria-label="View">
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => actions.deleteImage(im.id)}
                className="rounded bg-white/20 p-1 text-white hover:bg-rose-500"
                aria-label="Delete image"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}

        <button
          type="button"
          disabled={busy}
          onClick={() => camRef.current?.click()}
          className={`grid ${size} place-items-center rounded-xl border-2 border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-slate-700`}
          aria-label="Capture photo"
        >
          <Camera className="h-5 w-5" />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className={`grid ${size} place-items-center rounded-xl border-2 border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:text-brand-500 dark:border-slate-700`}
          aria-label="Upload image"
        >
          <ImagePlus className="h-5 w-5" />
        </button>
      </div>

      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFiles(e.target.files)} />
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />

      {viewer !== null && <Lightbox images={images} startIndex={viewer} onClose={() => setViewer(null)} />}
    </div>
  )
}
