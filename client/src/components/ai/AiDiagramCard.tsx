// ============================================================================
// §20 — a diagram the assistant drew, as a card in its answer: what kind it
// is and its title, the drawing at its own size (a wide one scrolls across
// the card, and Enlarge opens it over the page), what a fishbone's marks
// mean, and the notes under it (the period, what the causes were checked
// against). Printed with the answer (reportPrints), scaled to the page.
// ============================================================================

import { memo, useState } from 'react'
import { Fish, ListOrdered, Maximize2, Network, Workflow } from 'lucide-react'
import { AI_DIAGRAM_NAMES, type AiDiagramKind, type AiDiagramPart } from '@qc/shared/aiDiagram'
import { Modal } from '@/components/ui'
import { DiagramDrawing, FishboneKey } from './AiDiagram'
import { TableTool } from './AiTable'

const ICON: Record<AiDiagramKind, typeof Fish> = {
  fishbone: Fish,
  'five-whys': ListOrdered,
  flowchart: Workflow,
  'mind-map': Network,
}

export const AiDiagramCard = memo(function AiDiagramCard({ part }: { part: AiDiagramPart }) {
  const { diagram } = part
  const [open, setOpen] = useState(false)
  const Icon = ICON[diagram.kind]
  const name = AI_DIAGRAM_NAMES[diagram.kind]
  // The 5 Whys wraps to the card on its own: nothing to enlarge.
  const drawn = diagram.kind !== 'five-whys'
  return (
    <figure aria-label={`${name}: ${diagram.title}`} className="my-3 rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
      <header className="flex items-start gap-2.5 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <span aria-hidden className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-600 text-white">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{name}</p>
          <p dir="auto" className="break-words text-13 font-semibold text-slate-800 dark:text-slate-100">
            {diagram.title}
          </p>
        </div>
        {drawn && (
          <TableTool onClick={() => setOpen(true)} icon={<Maximize2 className="h-3.5 w-3.5" />}>
            Enlarge
          </TableTool>
        )}
      </header>
      {/* A wide drawing scrolls across the card, read left to right as the charts are. */}
      <div dir="ltr" className="overflow-x-auto overscroll-x-contain px-3 py-3">
        <DiagramDrawing diagram={diagram} />
      </div>
      {(diagram.kind === 'fishbone' || diagram.notes) && (
        <figcaption className="space-y-1 border-t border-slate-100 px-3 py-2 text-xs text-muted dark:border-slate-800">
          {diagram.kind === 'fishbone' && <FishboneKey />}
          {diagram.notes && (
            <p dir="auto" className="break-words">
              {diagram.notes}
            </p>
          )}
        </figcaption>
      )}
      {open && (
        <Modal open onClose={() => setOpen(false)} size="xl" icon={<Icon className="h-5 w-5" />} title={<span className="ai-type">{diagram.title}</span>}>
          <div dir="ltr" className="ai-type overflow-auto overscroll-contain">
            <DiagramDrawing diagram={diagram} />
          </div>
          {diagram.kind === 'fishbone' && (
            <p className="ai-type mt-2 text-xs text-muted">
              <FishboneKey />
            </p>
          )}
        </Modal>
      )}
    </figure>
  )
})
