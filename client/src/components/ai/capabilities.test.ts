import { describe, expect, it } from 'vitest'
import { AI_DOMAIN_IDS, type AiDomain } from '@qc/shared/ai'
import { AI_CAPABILITIES, AI_CAPABILITY_TONE, capabilitiesFor } from './capabilities'

const me = (domains: AiDomain[], over: { excel?: boolean; automations?: boolean } = {}) => ({ domains, excel: false, automations: false, ...over })
const ids = (m: Parameters<typeof capabilitiesFor>[0]) => capabilitiesFor(m).map((c) => c.id)

describe('§20 what the assistant can do, card by card', () => {
  it('offers everything to someone given all the data and both permissions, in a fixed order', () => {
    expect(ids(me([...AI_DOMAIN_IDS], { excel: true, automations: true }))).toEqual(AI_CAPABILITIES.map((c) => c.id))
  })

  it('offers the planning cards only with the planning module', () => {
    expect(ids(me(['inspection']))).not.toContain('what-if')
    expect(ids(me(['inspection']))).not.toContain('deadline')
    expect(ids(me(['planning']))).toEqual(expect.arrayContaining(['what-if', 'deadline']))
  })

  it('offers Excel and automations only to people allowed them', () => {
    expect(ids(me(['inspection']))).not.toContain('excel')
    expect(ids(me(['inspection']))).not.toContain('automation')
    expect(ids(me(['inspection'], { excel: true, automations: true }))).toEqual(expect.arrayContaining(['excel', 'automation']))
  })

  it('offers what needs the record of quality or production only to people who read it', () => {
    // Coils and master data alone: no briefing, no "why did it change".
    expect(ids(me(['materials']))).toEqual(['report', 'chart', 'wrong', 'scan', 'diagram', 'task'])
    expect(ids(me(['production']))).toEqual(expect.arrayContaining(['briefing', 'why']))
  })

  it('before /ai/me has come back, offers only what needs neither data nor a permission', () => {
    expect(ids(undefined)).toEqual(AI_CAPABILITIES.filter((c) => !c.domains && !c.needs).map((c) => c.id))
  })

  it('gives every card a question, a colour of its own, and a photo only to the paper sheet', () => {
    for (const c of AI_CAPABILITIES) {
      expect(c.question.length, c.id).toBeGreaterThan(20)
      expect(AI_CAPABILITY_TONE[c.tone], c.id).toBeTruthy()
    }
    expect(new Set(AI_CAPABILITIES.map((c) => c.tone)).size).toBe(AI_CAPABILITIES.length)
    expect(AI_CAPABILITIES.filter((c) => c.photo).map((c) => c.id)).toEqual(['scan'])
  })

  it('never promises to write the record: the assistant only reads it', () => {
    for (const c of AI_CAPABILITIES) expect(`${c.title} ${c.hint} ${c.question}`, c.id).not.toMatch(/\b(approve|record it|save it to the record|create (a |the )?record)/i)
  })
})
