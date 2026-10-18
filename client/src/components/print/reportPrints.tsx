// ============================================================================
// What is printed (./usePrint, laid out by ./PrintSheet), each a report to
// hand on: an answer of the assistant — under the title the assistant gave
// it (never the question as typed), its headline figures, its text, then
// each diagram it drew, each chart it drew (the chart alone) and each set of
// photos it showed — and a report, saved or delivered: the lines that place
// it, its summary, then each section. The workings (an answer's other
// queries, the SQL, the suggestions under it) stay off. An answer prints in
// the company's default style; a report in its own (else the default).
// ============================================================================

import type { AiKpi, AiQueryPart } from '@qc/shared/ai'
import type { ResolvedReportStyle } from '@qc/shared/reportStyles'
import { DiagramPrint } from '@/components/ai/AiDiagramCard'
import { AiMarkdown } from '@/components/ai/AiMarkdown'
import type { LivePart } from '@/components/ai/liveTurn'
import { queryPhotos } from '@/components/ai/photos'
import { PrintKpis, PrintSection, PrintSheet, paperWhen, type PrintPart } from './PrintSheet'

/** A title in a line: a long one is cut where a title stops. */
const MAX_TITLE = 200
export const printTitle = (text: string | undefined, fallback: string) => {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line
}

/** The queries of an answer that drew a chart, in order: what it showed. */
export const chartedQueries = (parts: readonly LivePart[]): AiQueryPart[] => parts.filter((p): p is AiQueryPart => p.type === 'query' && p.ok && !!p.chart)

/** The queries of an answer it showed: each that drew a chart or found photos, in order. */
export const shownQueries = (parts: readonly LivePart[]): AiQueryPart[] =>
  parts.filter((p): p is AiQueryPart => p.type === 'query' && p.ok && (!!p.chart || queryPhotos(p) !== null))

export function AnswerPrint({ title, at, parts, kpis, style }: { title: string; at: string; parts: readonly LivePart[]; kpis: readonly AiKpi[]; style?: ResolvedReportStyle | null }) {
  const texts = parts.filter((p): p is Extract<LivePart, { type: 'text' }> => p.type === 'text' && p.text.trim() !== '')
  const shown = shownQueries(parts)
  return (
    <PrintSheet kind="AI assistant report" title={printTitle(title, 'Quality report')} lines={[`Prepared ${paperWhen(at)}`]} style={style}>
      <PrintKpis kpis={kpis} />
      {texts.map((t, i) => (
        <div key={i} className="ai-prose">
          <AiMarkdown text={t.text} links="app" />
        </div>
      ))}
      {parts.map((p) => (p.type === 'diagram' ? <DiagramPrint key={p.diagramId} part={p} /> : null))}
      {shown.map((q, i) => (
        <PrintSection key={q.queryId} part={q} number={shown.length > 1 ? i + 1 : undefined} />
      ))}
    </PrintSheet>
  )
}

export function ReportPrint({
  kind,
  title,
  lines,
  summary,
  sections,
  style,
}: {
  kind: string
  title: string
  lines: readonly string[]
  summary?: string
  sections: readonly PrintPart[]
  style?: ResolvedReportStyle | null
}) {
  return (
    <PrintSheet kind={kind} title={printTitle(title, 'Report')} lines={lines} style={style}>
      {summary && (
        <div className="ai-prose">
          {/* Its links stay words: paper has nothing to press. */}
          <AiMarkdown text={summary} links="app" />
        </div>
      )}
      {sections.map((s, i) => (
        <PrintSection key={i} part={s.part} display={s.display} number={sections.length > 1 ? i + 1 : undefined} />
      ))}
    </PrintSheet>
  )
}
