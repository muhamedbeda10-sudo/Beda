// ============================================================================
// §20 — the files a question carried, on its bubble: photos as previews that
// open full size in the photo viewer, PDFs as chips that open in the PDF
// viewer, spreadsheets as chips with their outline.
// ============================================================================

import { memo, useState } from 'react'
import { FileSpreadsheet, FileText, Loader2 } from 'lucide-react'
import type { AiAttachment } from '@qc/shared/ai'
import { apiBlob } from '@/lib/api'
import { useApp } from '@/store/AppContext'
import { cachedBlob } from '@/services/mediaCache'
import { Lightbox, type ViewableImage } from '@/components/ui/Lightbox'
import { PdfViewer } from '@/components/documents/WorkInstructionViewer'
import { formatBytes } from './attachments'

const contentPath = (a: AiAttachment) => `/ai/attachments/${a.id}/content`

/** A photo's full bytes as an object URL, fetched with the access token once per device: a sent file never changes. */
const fullUrls = new Map<string, string>()
async function fullUrl(a: AiAttachment): Promise<string> {
  const known = fullUrls.get(a.id)
  if (known) return known
  const blob = await cachedBlob(contentPath(a), () => apiBlob(contentPath(a)))
  const url = URL.createObjectURL(blob)
  fullUrls.set(a.id, url)
  return url
}

export const AiAttachmentList = memo(function AiAttachmentList({ attachments }: { attachments: readonly AiAttachment[] }) {
  const { toast } = useApp()
  const photos = attachments.filter((a) => a.kind === 'image')
  const files = attachments.filter((a) => a.kind !== 'image')
  const [viewing, setViewing] = useState<{ images: ViewableImage[]; index: number } | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [pdf, setPdf] = useState<AiAttachment | null>(null)

  const openPhoto = async (index: number) => {
    setOpening(photos[index].id)
    try {
      const urls = await Promise.all(photos.map(fullUrl))
      setViewing({
        images: photos.map((p, i) => ({ id: p.id, dataUrl: urls[i], caption: p.name, save: { name: p.name, load: () => cachedBlob(contentPath(p), () => apiBlob(contentPath(p))) } })),
        index,
      })
    } catch {
      toast('The photo could not be opened.', 'error')
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="mb-1.5 space-y-1.5">
      {photos.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {photos.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void openPhoto(i)}
              className="relative h-20 w-20 overflow-hidden rounded-xl bg-white/20 ring-1 ring-white/40 transition hover:ring-white"
              aria-label={`Open the photo ${p.name}`}
              title={p.name}
            >
              {p.thumbnailDataUrl ? <img src={p.thumbnailDataUrl} alt="" className="h-full w-full object-cover" /> : <span className="text-[10px]">{p.name}</span>}
              {opening === p.id && (
                <span className="absolute inset-0 grid place-items-center bg-black/30">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {files.map((f) => {
        const Icon = f.kind === 'pdf' ? FileText : FileSpreadsheet
        const body = (
          <>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/20">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 text-start">
              <span dir="auto" className="block truncate text-xs font-semibold">
                {f.name}
              </span>
              <span className="block truncate text-[11px] text-white/75">{f.summary ?? formatBytes(f.byteSize)}</span>
            </span>
          </>
        )
        return f.kind === 'pdf' ? (
          <button key={f.id} type="button" onClick={() => setPdf(f)} className="flex w-full max-w-[16rem] items-center gap-2 rounded-xl bg-white/10 p-1.5 ring-1 ring-white/30 transition hover:bg-white/20" title={`Open ${f.name}`}>
            {body}
          </button>
        ) : (
          <div key={f.id} className="flex w-full max-w-[16rem] items-center gap-2 rounded-xl bg-white/10 p-1.5 ring-1 ring-white/30" title={f.name}>
            {body}
          </div>
        )
      })}
      {viewing && <Lightbox images={viewing.images} startIndex={viewing.index} onClose={() => setViewing(null)} />}
      {pdf && <PdfViewer path={contentPath(pdf)} title={pdf.name} subtitle={formatBytes(pdf.byteSize)} onClose={() => setPdf(null)} />}
    </div>
  )
})
