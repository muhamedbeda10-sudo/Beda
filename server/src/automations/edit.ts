// ============================================================================
// §21 — change_automation: a change of part of an automation, written as the
// change alone. The model names what it changes (a piece of text in a query
// replaced, a value set, a section removed) and the app applies that to the
// definition as it is now — of the automation, or of a card of this
// conversation — and goes on as propose_automation does with the whole
// result: checked, run once, kept as a proposal and shown as a card that
// changes nothing until Activate. A request to add one word to four reports
// is then four short calls, not four reports written out again.
//
// An edit that cannot be applied (a path that is not there, a text not found
// or found twice) leaves no card: the model is told exactly what to fix.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { AutomationDraft } from '@qc/shared/automation'
import type { Queryable } from '../db/pool'
import { cutChars } from '../ai/blocks'
import { describeIssues } from './draft'
import { isUuid } from './people'
import { AUTOMATION_COLUMNS, AUTOMATION_FROM, draftOf, type AutomationRow } from './views'

export const CHANGE_AUTOMATION_TOOL_NAME = 'change_automation'

/** Edits one call may make. */
export const MAX_EDITS = 30
/** The fields of a definition a change may touch: what it is (kind) and what it changes are not its to set. */
const EDITABLE_ROOTS = ['name', 'description', 'language', 'watch', 'schedule', 'recipients', 'channels', 'actions'] as const

export const CHANGE_AUTOMATION_TOOL: Anthropic.Beta.BetaTool = {
  name: CHANGE_AUTOMATION_TOOL_NAME,
  description:
    'Change part of an automation of this person, or of an automation card of this conversation, by naming only what changes: the app applies the edits to its definition as it is now, then checks the result and runs it once as propose_automation does, and shows it as a card with Activate. ' +
    'Use it for every change that keeps most of the definition (a word added to a query, a time, a recipient, a section added or removed); write the whole draft with propose_automation only for a new automation or one rewritten from the ground up. ' +
    'Call it only after the person agreed to the change, passing their words of agreement as confirmation. Read the definition first (my_automations, or the card you proposed) so each find is copied exactly.',
  // Not strict, as propose_automation: a value may be any part of a definition. edit.ts reads the input with zod.
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      confirmation: {
        type: 'string',
        description:
          "The person's words of agreement to the change, copied exactly as they wrote them in their latest message (for example \"yes\", or the change they asked for). Call this tool only after they agreed.",
      },
      automationId: { type: 'string', description: 'The automation to change: its id from my_automations. Give this or proposalId.' },
      proposalId: {
        type: 'string',
        description:
          'Or an automation card of this conversation: its proposalId. One still waiting is replaced by the new version; one that did not pass is fixed; one activated changes the automation it became.',
      },
      edits: {
        type: 'array',
        description: `1 to ${MAX_EDITS} edits, applied in order. Paths name a field of the definition as my_automations shows it, dot by dot, list items by their position from 0: name, schedule.time, schedule.sections.2.sql, schedule.sections.0.chart, watch.titleTemplate, recipients.`,
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['replace', 'set', 'remove'],
              description:
                'replace: replace text inside a text field (find → with). set: give a field, or a list item, a new value (a position one past the last adds an item). remove: take a field or a list item out.',
            },
            path: { type: 'string', description: 'Where, for example schedule.sections.1.sql.' },
            find: { type: 'string', description: 'replace only: the text to replace, copied exactly from the field; it must appear there once (or set all).' },
            with: { type: 'string', description: 'replace only: the text to put in its place (empty to delete it).' },
            all: { type: 'boolean', description: 'replace only, optional: replace every place find appears, not just one.' },
            value: { description: 'set only: the new value, as the definition holds it (text, number, true/false, an object or a list).' },
          },
          required: ['op', 'path'],
          additionalProperties: false,
        },
      },
    },
    required: ['confirmation', 'edits'],
    additionalProperties: false,
  },
}

const editInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace'), path: z.string(), find: z.string(), with: z.string(), all: z.boolean().nullish() }).strict(),
  z.object({ op: z.literal('set'), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal('remove'), path: z.string() }).strict(),
])
export type AutomationEdit = z.infer<typeof editInput>

const changeInput = z
  .object({
    confirmation: z.string().nullish(),
    automationId: z.string().nullish(),
    proposalId: z.string().nullish(),
    edits: z.array(editInput).min(1).max(MAX_EDITS),
  })
  .strict()

export interface ChangeRequest {
  automationId: string | null
  proposalId: string | null
  edits: AutomationEdit[]
}

/** The call, read: which definition and which edits; or what is wrong with its shape. */
export function readChange(input: unknown): ChangeRequest | { errors: string[] } {
  const parsed = changeInput.safeParse(input)
  if (!parsed.success) return { errors: describeIssues(parsed.error) }
  const automationId = parsed.data.automationId?.trim() || null
  const proposalId = parsed.data.proposalId?.trim() || null
  if (!automationId === !proposalId) return { errors: ['Give automationId or proposalId: one of them, not both.'] }
  return { automationId, proposalId, edits: parsed.data.edits }
}

const quotedId = (s: string) => `"${cutChars(s, 60, true)}"`

/** What a change starts from: the definition, and what the new version replaces or revises. */
export type ChangeBase = { draft: AutomationDraft; from: 'automation' | 'activated-card' | 'card' } | { error: string }

/**
 * The definition a change applies to, as it is now:
 *   • an automation of the person: its definition, changed by the new version (replacesAutomationId);
 *   • a card of this conversation, activated: the automation it became, as it is now (the person may have edited it);
 *   • a card still waiting (or replaced, or discarded): its draft, which the new version revises;
 *   • a card that did not pass: its draft, fixed — the new version revises what that one revised, so a waiting card
 *     it was to replace is replaced once a version passes.
 */
export async function loadChangeBase(q: Queryable, req: ChangeRequest, ctx: { userId: string; conversationId: string }): Promise<ChangeBase> {
  if (req.automationId) {
    if (!isUuid(req.automationId)) return { error: `automationId: ${quotedId(req.automationId)} is not an automation id.` }
    const automation = await ownAutomation(q, req.automationId, ctx.userId)
    if (!automation) return { error: "automationId: none of this person's automations has that id (my_automations lists them)." }
    return { draft: { ...draftOf(automation), replacesAutomationId: automation.id }, from: 'automation' }
  }
  const proposalId = req.proposalId!
  if (!isUuid(proposalId)) return { error: `proposalId: ${quotedId(proposalId)} is not a proposal id.` }
  const { rows } = await q.query<{ id: string; ok: boolean; state: string; draft: AutomationDraft | null; automationId: string | null }>(
    `SELECT id, ok, state, draft, automation_id AS "automationId" FROM ai_automation_proposals WHERE id = $1 AND conversation_id = $2 AND user_id = $3`,
    [proposalId, ctx.conversationId, ctx.userId],
  )
  const card = rows[0]
  if (!card) return { error: 'proposalId: no automation card of this conversation has that id (each propose_automation and change_automation result names its proposalId).' }
  if (card.state === 'activated') {
    const automation = card.automationId ? await ownAutomation(q, card.automationId, ctx.userId) : null
    if (!automation) return { error: 'proposalId: that card was activated, and the automation it became has since been deleted. Propose it as a new automation with propose_automation.' }
    return { draft: { ...draftOf(automation), replacesAutomationId: automation.id }, from: 'activated-card' }
  }
  if (!card.draft) return { error: 'proposalId: that card has no definition to change (its call could not be read). Propose it whole with propose_automation.' }
  const { revisesProposalId: earlier, ...draft } = card.draft
  const revises = card.ok ? card.id : earlier
  return { draft: revises ? { ...draft, revisesProposalId: revises } : draft, from: 'card' }
}

async function ownAutomation(q: Queryable, id: string, userId: string): Promise<AutomationRow | null> {
  const { rows } = await q.query<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM ${AUTOMATION_FROM} WHERE a.id = $1 AND a.creator_id = $2 AND a.deleted_at IS NULL`, [id, userId])
  return rows[0] ?? null
}

type Container = Record<string, unknown> | unknown[]

const isContainer = (v: unknown): v is Container => typeof v === 'object' && v !== null
/** Names that reach an object's prototype, never a field of a definition. */
const UNSAFE_STEPS = new Set(['__proto__', 'prototype', 'constructor'])
const isIndex = (s: string) => /^(0|[1-9]\d{0,3})$/.test(s)

/** Where a path leads: the container holding its last step, and that step; or why it leads nowhere. */
function locate(root: Record<string, unknown>, path: string): { parent: Container; key: string } | { error: string } {
  const steps = path.trim().split('.')
  if (steps.some((s) => s === '' || UNSAFE_STEPS.has(s))) return { error: 'is not a path (fields joined by dots, for example schedule.sections.1.sql).' }
  if (!(EDITABLE_ROOTS as readonly string[]).includes(steps[0])) return { error: `cannot be changed: a change may touch ${EDITABLE_ROOTS.join(', ')}.` }
  let node: unknown = root
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i]
    const next = Array.isArray(node) ? (isIndex(step) ? node[Number(step)] : undefined) : isContainer(node) ? (node as Record<string, unknown>)[step] : undefined
    if (!isContainer(next)) return { error: `leads nowhere: ${steps.slice(0, i + 1).join('.')} ${next === undefined ? 'is not there' : 'holds no fields'}.` }
    node = next
  }
  return { parent: node as Container, key: steps[steps.length - 1] }
}

const occurrences = (text: string, find: string) => text.split(find).length - 1

/**
 * The definition with the edits made, in order; or what is wrong with each that could not be made. What the result
 * means (its shape, its queries, its people) is checked after, as any draft is.
 */
export function applyEdits(base: AutomationDraft, edits: readonly AutomationEdit[]): { result: Record<string, unknown> } | { errors: string[] } {
  const root = structuredClone(base) as unknown as Record<string, unknown>
  const errors: string[] = []
  edits.forEach((edit, i) => {
    const where = `edits[${i}] (${edit.op} ${cutChars(edit.path, 80, true)})`
    const at = locate(root, edit.path)
    if ('error' in at) {
      errors.push(`${where}: the path ${at.error}`)
      return
    }
    const { parent, key } = at
    if (Array.isArray(parent) && !isIndex(key)) {
      errors.push(`${where}: ${key} is not a position in that list (0 is the first).`)
      return
    }
    const list = Array.isArray(parent) ? parent : null
    const index = list ? Number(key) : -1
    const current = list ? list[index] : (parent as Record<string, unknown>)[key]
    if (edit.op === 'replace') {
      if (typeof current !== 'string') {
        errors.push(`${where}: that field holds no text to replace in${current === undefined ? ' (it is not there)' : ''}. Use set to give it a value.`)
        return
      }
      if (edit.find === '') {
        errors.push(`${where}: find is empty. Copy the text to replace from the field.`)
        return
      }
      const found = occurrences(current, edit.find)
      if (found === 0) {
        errors.push(`${where}: find was not found in the field. Copy it exactly from the definition as it is now (my_automations, or the card's), spaces and line breaks included.`)
        return
      }
      if (found > 1 && !edit.all) {
        errors.push(`${where}: find appears ${found} times in the field. Give more of the text around the place to change, or set all to replace every one.`)
        return
      }
      const changed = edit.all ? current.split(edit.find).join(edit.with) : current.replace(edit.find, () => edit.with)
      if (list) list[index] = changed
      else (parent as Record<string, unknown>)[key] = changed
      return
    }
    if (edit.op === 'set') {
      if (edit.value === undefined) {
        errors.push(`${where}: give the new value (value), or use remove to take the field out.`)
        return
      }
      if (list) {
        if (index > list.length) {
          errors.push(`${where}: that list has ${list.length} ${list.length === 1 ? 'item' : 'items'}: set position ${list.length} to add one at its end.`)
          return
        }
        list[index] = edit.value
      } else {
        ;(parent as Record<string, unknown>)[key] = edit.value
      }
      return
    }
    if (current === undefined) {
      errors.push(`${where}: there is nothing there to remove.`)
      return
    }
    if (list) list.splice(index, 1)
    else delete (parent as Record<string, unknown>)[key]
  })
  return errors.length > 0 ? { errors } : { result: root }
}
