// ============================================================================
// A style seen as it will print: the printed sheet itself (PrintSheet), with
// a made-up report on it — the letterhead, the title, headline figures, a
// numbered section with a table — drawn at the paper's width in the style's
// orientation, then scaled down to the box it sits in. What changes in the
// editor shows here at once.
// ============================================================================

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { ResolvedReportStyle } from '@qc/shared/reportStyles'
import { PrintKpis, PrintSectionTitle, PrintSheet, PrintTable } from '@/components/print/PrintSheet'
import { PRINT_WIDTH } from '@/components/print/printStyle'

/** Millimetres to CSS pixels (96 to the inch). */
const MM = 96 / 25.4
/** The paper's margin around the sheet in the preview, in millimetres. */
const MARGIN_MM = 10

const KPIS = [
  { label: 'Pieces inspected', value: '4,520' },
  { label: 'Defect rate', value: '1.8%' },
  { label: 'Worst machine', value: 'RF-02' },
]
const COLUMNS = ['Machine', 'Line', 'Pieces', 'Top defect']
const ROWS = [
  ['RF-01', 'Roll forming 1', 1240, 'Burr on edge'],
  ['RF-02', 'Roll forming 2', 1105, 'Scratch'],
  ['PN-03', 'Punching', 980, 'Hole position'],
  ['WL-01', 'Welding', 655, 'Porosity'],
  ['PT-02', 'Painting', 540, 'Thin coat'],
]

export function StylePreview({ style }: { style: ResolvedReportStyle }) {
  const box = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const widthMm = parseFloat(PRINT_WIDTH[style.spec.orientation]) + 2 * MARGIN_MM
  const [scale, setScale] = useState(0.5)
  const [height, setHeight] = useState(400)

  useLayoutEffect(() => {
    const outer = box.current
    const inner = sheet.current
    if (!outer || !inner) return
    const measure = () => {
      const s = Math.min(1, outer.clientWidth / (widthMm * MM))
      setScale(s)
      setHeight(inner.offsetHeight * s)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [widthMm])

  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800" style={{ height }} aria-label="Preview of the style" role="img">
      <div
        ref={sheet}
        className="print-root print-preview"
        style={{ width: `${widthMm}mm`, paddingInline: `${MARGIN_MM}mm`, transform: `scale(${scale})`, '--print-width': `${widthMm - 2 * MARGIN_MM}mm` } as CSSProperties}
      >
        <PrintSheet kind="Saved report" title="Defects by machine — last 7 days" lines={['Covers 11 Oct – 17 Oct 2026', 'Data read 18 Oct 2026, 09:12']} style={style}>
          <PrintKpis kpis={KPIS} />
          <section className="space-y-2">
            <PrintSectionTitle number={1}>Defects per machine</PrintSectionTitle>
            <PrintTable columns={COLUMNS} rows={ROWS} />
          </section>
        </PrintSheet>
      </div>
    </div>
  )
}
