// ============================================================================
// §20 — an answer laid out as a brief, as data: the marks the model writes so
// the app can draw its sections and callouts (server/src/ai/prompt.ts, "Layout
// of an answer"). A heading that opens with one of a fixed set of emoji is a
// section of that kind: the emoji is taken out and the app draws its own icon
// in its place, the same on every device. A quote whose first line is
// [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION] (GitHub's alert
// syntax) — or that opens with ℹ️, 💡, ❗, ⚠️ or 🛑 — is a callout of that kind,
// the mark taken out. Anything else is left as written. Pure, so it is tested
// without a browser.
// ============================================================================

import type { HastNode } from './tables'

export type SectionIcon =
  | 'summary'
  | 'figures'
  | 'analysis'
  | 'rise'
  | 'fall'
  | 'risks'
  | 'ideas'
  | 'actions'
  | 'target'
  | 'production'
  | 'time'
  | 'maintenance'
  | 'people'
  | 'details'
  | 'period'
  | 'cost'

/** The emoji a section's heading may open with (as written without its variation selector), and the icon the app draws for it. */
export const SECTION_EMOJI: Readonly<Record<string, SectionIcon>> = {
  '📌': 'summary',
  '📊': 'figures',
  '🔍': 'analysis',
  '🔎': 'analysis',
  '📈': 'rise',
  '📉': 'fall',
  '⚠': 'risks',
  '💡': 'ideas',
  '✅': 'actions',
  '🎯': 'target',
  '🏭': 'production',
  '⏱': 'time',
  '🔧': 'maintenance',
  '👷': 'people',
  '📋': 'details',
  '📅': 'period',
  '🗓': 'period',
  '💰': 'cost',
}

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

const CALLOUT_EMOJI: Readonly<Record<string, CalloutKind>> = { 'ℹ': 'note', '💡': 'tip', '❗': 'important', '⚠': 'warning', '🛑': 'caution' }

/** The marks set on an element for the renderer, and the same as the attributes React hands its component. */
export const ICON_PROP = 'dataAiIcon'
export const CALLOUT_PROP = 'dataAiCallout'
export const STEPS_PROP = 'dataAiSteps'
export const ICON_ATTR = 'data-ai-icon'
export const CALLOUT_ATTR = 'data-ai-callout'
export const STEPS_ATTR = 'data-ai-steps'

const isEl = (n: HastNode | undefined, tag?: string): boolean => !!n && n.type === 'element' && (tag === undefined || n.tagName === tag)
const isBlank = (n: HastNode) => n.type === 'text' && !(n.value ?? '').trim()

/** The first text node of a block, through its leading inline elements (a heading's **bold** opening): where a mark is written. */
function leadingText(node: HastNode): HastNode | null {
  for (const child of node.children ?? []) {
    if (child.type === 'text') {
      if ((child.value ?? '').trim()) return child
      continue
    }
    if (isEl(child, 'strong') || isEl(child, 'em')) return leadingText(child)
    return null
  }
  return null
}

/** An emoji at the start of a text, with its variation selector and the space after it: the emoji (without the selector) and its length. */
function leadingEmoji(text: string): { emoji: string; length: number } | null {
  // A skin tone or a joined sign (👷‍♂️) belongs to the emoji, and goes with it.
  const m = /^\s*(\p{Extended_Pictographic})️?[\u{1F3FB}-\u{1F3FF}]?(?:‍\p{Extended_Pictographic}️?)*\s*/u.exec(text)
  return m ? { emoji: m[1], length: m[0].length } : null
}

const CALLOUT_MARK = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)?/i

/** Drops a block's emptied leading text and line break, so a callout's words start on its first line. */
function trimLeading(node: HastNode) {
  while (node.children && node.children.length > 0) {
    const first = node.children[0]
    if (first.type === 'text' && !(first.value ?? '').trim()) node.children.shift()
    else if (isEl(first, 'br')) node.children.shift()
    else break
  }
}

function markHeading(h: HastNode) {
  const text = leadingText(h)
  const lead = text && leadingEmoji(text.value ?? '')
  const icon = lead && SECTION_EMOJI[lead.emoji]
  if (!text || !lead || !icon) return
  text.value = (text.value ?? '').slice(lead.length)
  h.properties = { ...h.properties, [ICON_PROP]: icon }
}

function markQuote(q: HastNode) {
  const first = (q.children ?? []).find((c) => !isBlank(c))
  if (!first || !isEl(first, 'p')) return
  const text = leadingText(first)
  if (!text) return
  const value = text.value ?? ''
  let kind: CalloutKind | undefined
  let cut = 0
  const mark = CALLOUT_MARK.exec(value)
  if (mark && first.children?.[0] === text) {
    kind = mark[1].toLowerCase() as CalloutKind
    cut = mark[0].length
  } else {
    const lead = leadingEmoji(value)
    kind = lead ? CALLOUT_EMOJI[lead.emoji] : undefined
    cut = lead?.length ?? 0
  }
  if (!kind) return
  text.value = value.slice(cut)
  trimLeading(first)
  // A mark alone on its line leaves its paragraph empty: the callout's words are the paragraphs after it.
  if ((first.children ?? []).length === 0) q.children = (q.children ?? []).filter((c) => c !== first)
  q.properties = { ...q.properties, [CALLOUT_PROP]: kind }
}

/**
 * A rehype step over an answer's markdown: its sections' headings and its
 * callouts learn their kind (see the top of this file), and a numbered list
 * that is not inside another list is drawn as steps, each number in a badge.
 */
export function rehypeAiProse() {
  return (tree: HastNode) => {
    const visit = (n: HastNode, inList: boolean) => {
      if (isEl(n, 'h1') || isEl(n, 'h2') || isEl(n, 'h3')) markHeading(n)
      else if (isEl(n, 'blockquote')) markQuote(n)
      else if (isEl(n, 'ol') && !inList) n.properties = { ...n.properties, [STEPS_PROP]: 'true' }
      n.children?.forEach((c) => visit(c, inList || isEl(n, 'li')))
    }
    visit(tree, false)
  }
}
