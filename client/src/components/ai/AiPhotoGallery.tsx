// ============================================================================
// §20 — photos the assistant found (./photos), shown as photos: a grid of
// even tiles, each with what it is of under it (the defect, the order, the
// machine, when), the first two dozen at once and the rest on request. A
// tile opens the photo viewer over all of them, each fetched in full as it
// comes on screen; the grid shows the stored thumbnails. A photo no longer
// there (deleted since) says so in its place.
//
// On paper (PrintPhotos) they are three to a row at one size, each whole on
// a white ground (never cropped: a photo is evidence), fetched in full; the
// sheet waits for them before the browser prints (usePrint's pending mark).
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Camera, ImageOff } from 'lucide-react'
import type { ImageAsset } from '@qc/shared/types'
import { Lightbox } from '@/components/ui/Lightbox'
import { PRINT_PENDING_ATTR } from '@/components/print/usePrint'
import { useImages } from '@/services/queries'
import { loadImageBlob, resolveImageUrl } from '@/services/uploadImage'
import { cn } from '@/lib/utils'
import { photoCount, type AiPhoto } from './photos'

/** Shown at once; the rest behind "Show all". */
export const GALLERY_FIRST = 24

const caption = (p: AiPhoto) => [p.title, ...p.details].filter(Boolean).join(' · ')

export const AiPhotoGallery = memo(function AiPhotoGallery({ photos, className }: { photos: readonly AiPhoto[]; className?: string }) {
  const ids = useMemo(() => photos.map((p) => p.id), [photos])
  const { data: assets, isLoading } = useImages(ids)
  const byId = useMemo(() => new Map((assets ?? []).map((a) => [a.id.toLowerCase(), a])), [assets])
  const [all, setAll] = useState(false)
  const shown = all ? photos : photos.slice(0, GALLERY_FIRST)
  const [viewer, setViewer] = useState<{ start: number; at: number } | null>(null)
  const [full, setFull] = useState<Record<string, string>>({})

  // The photo on screen in the viewer, in full.
  const onScreen = viewer ? byId.get(photos[viewer.at]?.id ?? '') : undefined
  useEffect(() => {
    if (!onScreen || full[onScreen.id]) return
    let cancelled = false
    resolveImageUrl(onScreen)
      .then((url) => !cancelled && url && setFull((m) => ({ ...m, [onScreen.id]: url })))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [onScreen, full])
  const onIndexChange = useCallback((at: number) => setViewer((v) => (v && v.at !== at ? { ...v, at } : v)), [])

  if (photos.length === 0) return <p className={cn('text-13 text-muted', className)}>No photos were found.</p>
  // The viewer goes through the photos that are there.
  const viewable = photos.filter((p) => byId.has(p.id))

  return (
    <div className={cn('space-y-2', className)}>
      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4" aria-label={photoCount(photos.length)}>
        {shown.map((p) => {
          const a = byId.get(p.id)
          const words = caption(p)
          return (
            <li key={p.id} className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
              {a ? (
                <button
                  type="button"
                  onClick={() => {
                    const i = viewable.findIndex((v) => v.id === p.id)
                    setViewer({ start: i, at: i })
                  }}
                  className="block aspect-[4/3] w-full bg-slate-100 dark:bg-slate-800"
                  aria-label={`Open the photo${words ? `: ${words}` : ''}`}
                >
                  {a.thumbnailDataUrl ? (
                    <img src={a.thumbnailDataUrl} alt={words} className="h-full w-full cursor-zoom-in object-cover" loading="lazy" />
                  ) : (
                    <span className="grid h-full w-full place-items-center text-slate-300">
                      <Camera className="h-6 w-6" />
                    </span>
                  )}
                </button>
              ) : (
                <span className="grid aspect-[4/3] w-full place-items-center bg-slate-100 text-center text-[11px] text-muted dark:bg-slate-800">
                  {isLoading ? (
                    <span className="skeleton h-full w-full" />
                  ) : (
                    <span className="flex flex-col items-center gap-1 px-2">
                      <ImageOff className="h-5 w-5" /> No longer available
                    </span>
                  )}
                </span>
              )}
              {words && (
                <div className="space-y-0.5 px-2 py-1.5">
                  {p.title && (
                    <p dir="auto" className="line-clamp-2 break-words text-xs font-semibold leading-snug text-slate-800 dark:text-slate-100">
                      {p.title}
                    </p>
                  )}
                  {p.details.length > 0 && (
                    <p className="line-clamp-2 break-words text-[11px] leading-snug text-muted">
                      {p.details.map((d, i) => (
                        <span key={i}>
                          {i > 0 && ' · '}
                          <bdi>{d}</bdi>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {photos.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
          Show all {photoCount(photos.length)}
        </button>
      )}
      {viewer && viewable.length > 0 && (
        <Lightbox
          images={viewable.map((p) => {
            const a: ImageAsset = byId.get(p.id)!
            return { id: p.id, dataUrl: full[a.id] ?? a.thumbnailDataUrl ?? '', caption: caption(p), save: { name: caption(p).replace(/ · /g, ' - '), load: () => loadImageBlob(a.id) } }
          })}
          startIndex={Math.max(0, viewer.start)}
          onIndexChange={onIndexChange}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
})

/** One photo on paper, in full: the sheet waits (PRINT_PENDING_ATTR) until it has come or cannot. */
function PrintPhoto({ photo, asset, known }: { photo: AiPhoto; asset: ImageAsset | undefined; known: boolean }) {
  const [url, setUrl] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!asset) {
      if (known) setSettled(true)
      return
    }
    let cancelled = false
    resolveImageUrl(asset)
      .then((u) => {
        if (cancelled) return
        if (u) setUrl(u)
        else setSettled(true)
      })
      .catch(() => !cancelled && setSettled(true))
    return () => {
      cancelled = true
    }
  }, [asset, known])
  const words = caption(photo)
  return (
    <figure className="print-keep print-photo" {...(settled ? {} : { [PRINT_PENDING_ATTR]: '' })}>
      <div className="print-photo-frame">
        {url ? (
          <img src={url} alt={words} onLoad={() => setSettled(true)} onError={() => setSettled(true)} />
        ) : (
          settled && <span className="text-[9px] text-slate-500">Photo no longer available</span>
        )}
      </div>
      {words && (
        // Each line in its own direction: an Arabic defect's name over an order number and a date reads right in both.
        <figcaption className="mt-1 text-[9px] leading-snug text-slate-700">
          {photo.title && (
            <span dir="auto" className="block text-start font-semibold text-slate-900">
              {photo.title}
            </span>
          )}
          {photo.details.length > 0 && (
            <span dir="ltr" className="block text-start">
              {photo.details.map((d, i) => (
                <span key={i}>
                  {i > 0 && ' · '}
                  <bdi>{d}</bdi>
                </span>
              ))}
            </span>
          )}
        </figcaption>
      )}
    </figure>
  )
}

/** The photos on paper: three to a row, each whole at one size, with its caption. */
export function PrintPhotos({ photos }: { photos: readonly AiPhoto[] }) {
  const ids = useMemo(() => photos.map((p) => p.id), [photos])
  const { data: assets, isFetched } = useImages(ids)
  const byId = useMemo(() => new Map((assets ?? []).map((a) => [a.id.toLowerCase(), a])), [assets])
  if (photos.length === 0) return <p className="text-[11px] text-slate-600">No photos were found.</p>
  return (
    <div className="print-photos" {...(isFetched ? {} : { [PRINT_PENDING_ATTR]: '' })}>
      {photos.map((p) => (
        <PrintPhoto key={p.id} photo={p} asset={byId.get(p.id)} known={isFetched} />
      ))}
    </div>
  )
}
