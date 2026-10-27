// ============================================================================
// §20 — what the assistant can do, as cards: in an empty conversation, and
// behind the sparkles of the question box. Each card is something the
// assistant really does for this person — its tools (reports, charts, Excel,
// diagrams, tasks, automations, the planning module's what-ifs and dates)
// over the data the owner gave them. A card needing data or a permission
// they lack is not offered: /ai/me says both. A tap puts the card's question
// in the box to send as it is or finish first; the questions ask the
// assistant to ask back what they leave open (an order, a period), so each
// works sent as it is. The assistant only reads the record: the paper-sheet
// card reads a photo and checks it against the record, it writes nothing.
// ============================================================================

import type { AiDomain, AiMeResponse } from '@qc/shared/ai'

export type AiCapabilityId = 'report' | 'chart' | 'excel' | 'what-if' | 'deadline' | 'briefing' | 'wrong' | 'why' | 'scan' | 'diagram' | 'task' | 'automation'

/** The colour of a card's icon: one per card, as in a palette, in both themes. */
export type AiCapabilityTone = 'emerald' | 'blue' | 'orange' | 'violet' | 'amber' | 'pink' | 'teal' | 'rose' | 'green' | 'sky' | 'indigo' | 'cyan'

export interface AiCapability {
  id: AiCapabilityId
  title: string
  /** What it does, in a line. */
  hint: string
  /** Put in the question box. */
  question: string
  tone: AiCapabilityTone
  /** Offered only to a person given at least one of these domains; any domain when absent. */
  domains?: readonly AiDomain[]
  /** Offered only to a person with this permission on /ai/me. */
  needs?: 'excel' | 'automations'
  /** The card picks a photo to go with the question (the camera, on a phone). */
  photo?: boolean
}

export const AI_CAPABILITIES: readonly AiCapability[] = [
  {
    id: 'report',
    title: 'Build a report',
    hint: 'A tracker to open again with other orders, weeks or machines',
    question: 'Build me a report I can open again with other values (orders, a planning week or a machine). Ask me first what it should cover.',
    tone: 'emerald',
  },
  {
    id: 'chart',
    title: 'Draw a chart',
    hint: 'Output, rejects, efficiency or the plan, as a picture',
    question: 'Draw me a chart. Ask me what it should show (output, rejects, efficiency or the plan) and for which period.',
    tone: 'blue',
  },
  {
    id: 'excel',
    title: 'Excel file',
    hint: 'Any data you can read, filtered and split into sheets',
    question: 'Make me an Excel file. Ask me which data, which period, and how to split it into sheets.',
    tone: 'orange',
    needs: 'excel',
  },
  {
    id: 'what-if',
    title: 'What if…',
    hint: 'A machine stops, a rush order, a shift added: see the deliveries',
    question: 'What if something changes: a machine stops, a rush order comes in, or a shift is added? Ask me which, then show what it does to the deliveries.',
    tone: 'violet',
    domains: ['planning'],
  },
  {
    id: 'deadline',
    title: 'Plan to a deadline',
    hint: 'When an order could be delivered on the plan',
    question: 'When can we deliver an order? Ask me the items and quantities, then tell me when it would be done on the current plan, and what holds it back.',
    tone: 'amber',
    domains: ['planning'],
  },
  {
    id: 'briefing',
    title: 'Morning briefing',
    hint: 'Yesterday against the plan, the risks, today’s top 3',
    question: 'Give me a morning briefing: yesterday against the plan (or against the due dates where there is no plan), the risks to watch, and the three things that matter most today.',
    tone: 'pink',
    domains: ['production', 'inspection', 'orders', 'planning'],
  },
  {
    id: 'wrong',
    title: 'What looks wrong',
    hint: 'Data gaps and stuck work, with the fix',
    question: 'What looks wrong in the record I can see right now? Look for gaps in the data and for stuck or overdue work, and say how to fix each.',
    tone: 'teal',
  },
  {
    id: 'why',
    title: 'Why did it change?',
    hint: 'The causes behind a move in rejects or output',
    question: 'Why did it change? Ask me which figure (the reject rate, the output or the efficiency) and which period, then find the causes behind the move.',
    tone: 'rose',
    domains: ['inspection', 'production'],
  },
  {
    id: 'scan',
    title: 'Read a paper sheet',
    hint: 'A photo of a handwritten sheet, read and checked against the record',
    question: 'Read the attached photo of a paper sheet: write out what it says, then check it against the record and tell me what differs.',
    tone: 'green',
    photo: true,
  },
  {
    id: 'diagram',
    title: 'Draw a diagram',
    hint: 'A fishbone, 5 whys or a process map',
    question: 'Draw me a diagram: a fishbone, 5 whys or a process map. Ask me the problem or the process first.',
    tone: 'indigo',
  },
  {
    id: 'task',
    title: 'Send a task',
    hint: 'Ask someone to check or fix something, by a date',
    question: 'Send a task to someone. Ask me who, what is to be done, and by when.',
    tone: 'cyan',
  },
  {
    id: 'automation',
    title: 'New automation',
    hint: 'Watch for something, and message people',
    question: 'Set up an automation that watches for something and messages people when it happens. Ask me what to watch for and whom to tell.',
    tone: 'sky',
    needs: 'automations',
  },
]

/**
 * The cards this person is offered: those whose data and permission they have. Before /ai/me has come back,
 * only the cards that need neither.
 */
export function capabilitiesFor(me: Pick<AiMeResponse, 'domains' | 'excel' | 'automations'> | null | undefined): AiCapability[] {
  return AI_CAPABILITIES.filter((c) => {
    if (c.needs && !me?.[c.needs]) return false
    if (c.domains && !c.domains.some((d) => me?.domains.includes(d))) return false
    return true
  })
}

/** The icon's square, by tone: a light tint with dark ink, and a dim one with light ink in the dark theme (AA both ways). */
export const AI_CAPABILITY_TONE: Readonly<Record<AiCapabilityTone, string>> = {
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  orange: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  pink: 'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
  teal: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  rose: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  green: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  cyan: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300',
}
