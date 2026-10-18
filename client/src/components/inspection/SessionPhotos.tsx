// ============================================================================
// §10.8 — every photo of a session on one screen, grouped by what it shows:
// defects, paint, PT, notes. Each thumbnail says which sample it came from
// and what it is of; tapping it opens the viewer over the whole group, and
// the sample number opens that sample. Nothing here is edited.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Camera, Droplets, FlaskConical, MessageSquareText, TriangleAlert } from 'lucide-react'
import type { SessionImageGroup, SessionImageItem, SessionImageKind } from '@qc/shared/api'
import type { ImageAsset } from '@qc/shared/types'
import { Lightbox } from '@/components/ui/Lightbox'
import { useImages, useSessionImages } from '@/services/queries'
import { loadImageBlob, resolveImageUrl } from '@/services/uploadImage'
import { cn } from '@/lib/utils'

const KIND: Record<SessionImageKind, { title: string; icon: typeof Camera; tone: string }> = {
  defect: { title: 'Defects', icon: TriangleAlert, tone: 'text-rose-600 dark:text-rose-400' },
  paint: { title: 'Paint', icon: Droplets, tone: 'text-sky-600 dark:text-sky-400' },
  pt: { title: 'PT / weld', icon: FlaskConical, tone: 'text-violet-600 dark:text-violet-400' },
  note: { title: 'Notes', icon: MessageSquareText, tone: 'text-slate-600 dark:text-slate-300' },
}

export function SessionPhotos({
  sessionId,
  sessionSeq,
  onOpenSample,
  className,
}: {
  sessionId: string
  sessionSeq: number
  /** Opens the sample a photo came from, when the caller has somewhere to open it. */
  onOpenSample?: (sampleId: string) => void
  className?: string
}) {
  const { data, isLoading } = useSessionImages(sessionId)
  const groups = useMemo(() => data?.groups ?? [], [data])
  const ids = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.imageId)), [groups])
  const { data: assets = [] } = useImages(ids)
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
  const [viewer, setViewer] = useState<{ group: SessionImageGroup; index: number } | null>(null)
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({})
  const onViewerMove = useCallback((index: number) => setViewer((v) => (v && v.index !== index ? { ...v, index } : v)), [])

  // Full-resolution content only for the photo on screen in the viewer.
  useEffect(() => {
    if (!viewer) return
    const item = viewer.group.items[viewer.index]
    const asset = item && byId.get(item.imageId)
    if (!asset || fullUrls[asset.id]) return
    let cancelled = false
    resolveImageUrl(asset)
      .then((url) => !cancelled && setFullUrls((m) => ({ ...m, [asset.id]: url })))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [viewer, byId, fullUrls])

  if (isLoading) return <p className={cn('text-sm text-muted', className)}>Loading the photos…</p>
  if (groups.length === 0) return <p className={cn('text-sm text-muted', className)}>No photo was taken in this session.</p>

  const sampleLabel = (item: SessionImageItem) => (item.sampleIndex === null ? 'Session' : `${sessionSeq}-${item.sampleIndex}`)

  return (
    <div className={cn('space-y-4', className)}>
      {groups.map((g) => {
        const meta = KIND[g.kind]
        return (
          <section key={g.kind}>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">
              <meta.icon className={cn('h-3.5 w-3.5', meta.tone)} /> {meta.title}
              <span className="rounded-full bg-slate-100 px-1.5 text-[10px] tabular-nums text-muted dark:bg-slate-800">{g.items.length}</span>
            </p>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {g.items.map((item, i) => {
                const a = byId.get(item.imageId)
                return (
                  <li key={`${item.imageId}-${i}`} className="overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
                    <button type="button" onClick={() => setViewer({ group: g, index: i })} className="block aspect-square w-full" aria-label={`Open photo: ${item.label}, sample ${sampleLabel(item)}`}>
                      {a?.thumbnailDataUrl ? (
                        <img src={a.thumbnailDataUrl} alt={item.label} className="h-full w-full cursor-zoom-in object-cover" />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-slate-300">
                          <Camera className="h-6 w-6" />
                        </span>
                      )}
                    </button>
                    <div className="flex items-center gap-1 px-1.5 py-1">
                      {item.sampleId && onOpenSample ? (
                        <button type="button" onClick={() => onOpenSample(item.sampleId!)} className="shrink-0 rounded-md bg-brand-50 px-1.5 text-[11px] font-bold tabular-nums text-brand-700 hover:bg-brand-100 dark:bg-brand-500/15 dark:text-brand-300" data-tip="Open this sample">
                          {sampleLabel(item)}
                        </button>
                      ) : (
                        <span className="shrink-0 rounded-md bg-slate-200 px-1.5 text-[11px] font-bold tabular-nums text-slate-600 dark:bg-slate-700 dark:text-slate-300">{sampleLabel(item)}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted" data-tip={item.label}>
                        {item.label}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
      {viewer && (
        <Lightbox
          images={viewer.group.items.map((item) => {
            const a: ImageAsset | undefined = byId.get(item.imageId)
            return {
              id: `${item.imageId}`,
              dataUrl: (a && (fullUrls[a.id] ?? a.thumbnailDataUrl)) ?? '',
              caption: `${KIND[viewer.group.kind].title} · sample ${sampleLabel(item)} · ${item.label}`,
              save: { name: `${KIND[viewer.group.kind].title} - sample ${sampleLabel(item)} - ${item.label}`, load: () => loadImageBlob(item.imageId) },
            }
          })}
          startIndex={viewer.index}
          // The photo on screen is the one fetched in full, as the viewer moves from one to the next.
          onIndexChange={onViewerMove}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
}
