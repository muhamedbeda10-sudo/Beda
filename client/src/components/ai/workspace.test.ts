import { describe, expect, it } from 'vitest'
import { aiWorkspaceHref, isAiWorkspacePath, isKnownWorkspacePath, workspaceConversationId, workspaceReportId } from './workspace'

describe('the assistant’s full page and its addresses', () => {
  it('owns /ai and what is under it, not the owner’s settings', () => {
    expect(isAiWorkspacePath('/ai')).toBe(true)
    expect(isAiWorkspacePath('/ai/reports/r1')).toBe(true)
    expect(isAiWorkspacePath('/admin/ai')).toBe(false)
    expect(isAiWorkspacePath('/aisle')).toBe(false)
    expect(isAiWorkspacePath('/')).toBe(false)
  })

  it('reads the report an address opens', () => {
    expect(workspaceReportId('/ai/reports/r1')).toBe('r1')
    expect(workspaceReportId('/ai/reports/a%20b/')).toBe('a b')
    expect(workspaceReportId('/ai/reports/%E0%A4%A')).toBeNull()
    expect(workspaceReportId('/ai/reports/')).toBeNull()
    expect(workspaceReportId('/ai/reports/r1/run')).toBeNull()
    expect(workspaceReportId('/ai')).toBeNull()
  })

  it('knows /ai and a report’s address, and nothing else under /ai', () => {
    expect(isKnownWorkspacePath('/ai')).toBe(true)
    expect(isKnownWorkspacePath('/ai/')).toBe(true)
    expect(isKnownWorkspacePath('/ai/reports/r1')).toBe(true)
    expect(isKnownWorkspacePath('/ai/settings')).toBe(false)
  })

  it('writes the address of a conversation, a new one, or a report', () => {
    expect(aiWorkspaceHref({ conversationId: 'c 1' })).toBe('/ai?c=c%201')
    expect(aiWorkspaceHref({ conversationId: null })).toBe('/ai')
    expect(aiWorkspaceHref({ conversationId: 'c1', reportId: 'r/1' })).toBe('/ai/reports/r%2F1')
  })

  it('reads the conversation an address names', () => {
    expect(workspaceConversationId('?c=abc')).toBe('abc')
    expect(workspaceConversationId('?c=%20')).toBeNull()
    expect(workspaceConversationId('')).toBeNull()
    expect(workspaceReportId(aiWorkspaceHref({ reportId: 'r/1' }))).toBe('r/1')
  })
})
