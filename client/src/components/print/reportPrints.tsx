// ============================================================================
// What is printed (./usePrint, laid out by ./PrintSheet): an answer of the
// assistant — the question as its title, its headline figures, its text,
// then each diagram it drew, then each chart it drew with its rows — and a report, saved or delivered:
// the lines that place it, its summary, then each section with its chart and
// its rows. The workings (an answer's other queries, the SQL) stay off.
// ============================================================================

import type { AiKpi, AiQueryPart } from '@qc/shared/ai'
import { DiagramPrint } from '@/components/ai/AiDiagramCard'
import { AiMarkdown } from '@/components/ai/AiMarkdown'
import type { LivePart } from '@/components/ai/liveTurn'
import { formatFullTimestamp } from '@/lib/utils'
import { PrintKpis, PrintSection, PrintSheet } from './PrintSheet'

/** A title in a line: a long question is cut where a title stops. */
const MAX_TITLE = 200
export const printTitle = (text: string | undefined, fallback: string) => {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line
}

/** The queries of an answer that drew a chart, in order: what it showed. */
export const chartedQueries = (parts: readonly LivePart[]): AiQueryPart[] => parts.filter((p): p is AiQueryPart => p.type === 'query' && p.ok && !!p.chart)

export function AnswerPrint({ question, at, parts, kpis }: { question?: string; at: string; parts: readonly LivePart[]; kpis: readonly AiKpi[] }) {
  const texts = parts.filter((p): p is Extract<LivePart, { type: 'text' }> => p.type === 'text' && p.text.trim() !== '')
  return (
    <PrintSheet kind="AI assistant" title={printTitle(question, 'Answer')} lines={[`Answered ${formatFullTimestamp(at)}`]}>
      <PrintKpis kpis={kpis} />
      {texts.map((t, i) => (
        <div key={i} className="ai-prose">
          <AiMarkdown text={t.text} />
        </div>
      ))}
      {parts.map((p) => (p.type === 'diagram' ? <DiagramPrint key={p.diagramId} part={p} /> : null))}
      {chartedQueries(parts).map((q) => (
        <PrintSection key={q.queryId} part={q} />
      ))}
    </PrintSheet>
  )
}

export function ReportPrint({ kind, title, lines, summary, parts }: { kind: string; title: string; lines: readonly string[]; summary?: string; parts: readonly AiQueryPart[] }) {
  return (
    <PrintSheet kind={kind} title={printTitle(title, 'Report')} lines={lines}>
      {summary && (
        <div className="ai-prose">
          {/* Its links stay words: paper has nothing to press. */}
          <AiMarkdown text={summary} links="app" />
        </div>
      )}
      {parts.map((p, i) => (
        <PrintSection key={i} part={p} />
      ))}
    </PrintSheet>
  )
}
