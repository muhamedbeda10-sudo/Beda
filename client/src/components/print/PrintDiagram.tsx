// ============================================================================
// A diagram the assistant drew, on paper: its kind and title, the drawing
// scaled to the page's width, what a fishbone's marks mean, and its notes.
// ============================================================================

import { AI_DIAGRAM_NAMES, type AiDiagramPart } from '@qc/shared/aiDiagram'
import { DiagramDrawing, FishboneKey } from '@/components/ai/AiDiagram'

export function PrintDiagram({ part }: { part: AiDiagramPart }) {
  const { diagram } = part
  return (
    <section className="space-y-1.5">
      <h2 dir="auto" className="print-keep-with-next text-[13px] font-bold">
        {AI_DIAGRAM_NAMES[diagram.kind]}: {diagram.title}
      </h2>
      <div dir="ltr" className="print-keep">
        <DiagramDrawing diagram={diagram} fit />
      </div>
      {diagram.kind === 'fishbone' && (
        <p className="text-[10px] text-slate-600">
          <FishboneKey />
        </p>
      )}
      {diagram.notes && (
        <p dir="auto" className="text-[10px] text-slate-600">
          {diagram.notes}
        </p>
      )}
    </section>
  )
}
