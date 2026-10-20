// ============================================================================
// §20 — the handlers of a conversation's tools besides run_sql, for one turn:
// the same whether the turn is being answered for the first time or is
// continued after a hand-over (answerRunner.ts). Each handler reads the
// person's access (and role) again when it runs; the conversation's stored
// tools decide which of them it may call (assistant.ts, toolHandler).
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import type { AiStreamEvent } from '@qc/shared/ai'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import type { ImageStorage } from '../images/storage'
import type { RateLimiter } from '../lib/rateLimit'
import { asksForConfirmation } from '../automations/confirmation'
import { PROPOSE_AUTOMATION_TOOL_NAME, automationToolHandlers } from '../automations/tools'
import { noticeToolHandlers } from '../noticeAssistant/tools'
import { playbookToolHandlers } from '../playbook/assistant'
import { taskToolHandlers } from '../tasks/assistant'
import type { ToolHandler } from './assistant'
import { diagramToolHandlers } from './diagram'
import { reportToolHandlers } from './reportTools'
import { excelToolHandlers } from './excel'
import type { AiReader } from './reader'
import { savedTableToolHandlers } from './savedTableTools'

export interface TurnToolsContext {
  db: Db
  config: Config
  readers: AiReader
  images: ImageStorage
  /** Excel files and report runs, per person. */
  reportLimiter: RateLimiter
  userId: string
  userName: string
  conversation: { id: string; tools: Anthropic.Beta.BetaToolUnion[] }
  turnId: string
  emit: (event: AiStreamEvent) => void
}

export function turnToolHandlers(c: TurnToolsContext): Record<string, ToolHandler> {
  const base = { db: c.db, config: c.config, userId: c.userId, conversationId: c.conversation.id, turnId: c.turnId, emit: c.emit }
  return {
    ...automationToolHandlers({
      ...base,
      readers: c.readers,
      // Held to the person's words of agreement when its tool asks for them (§22): conversations begun before go on as they were sent.
      confirmFirst: asksForConfirmation(c.conversation.tools, PROPOSE_AUTOMATION_TOOL_NAME),
    }),
    // §23 — each reads the person's role again: what they see, and whether they may still have a notice written.
    ...noticeToolHandlers(base),
    // Tasks: drafting ones checks the person may still send tasks.
    ...taskToolHandlers({ ...base, userName: c.userName }),
    // The playbook: changed at once, at the person's word; the owner alone sets instructions for everyone.
    ...playbookToolHandlers({ ...base, userName: c.userName }),
    // Excel files: whether the person may still have them made, and their domains, read again; every request logged, made or not.
    ...excelToolHandlers({ ...base, readers: c.readers, store: c.images, limiter: c.reportLimiter, userName: c.userName }),
    // Saved tables: each call reads the person's access again; what a table may read is what they may.
    ...savedTableToolHandlers({ ...base, readers: c.readers, userName: c.userName }),
    // Diagrams: for everyone given the assistant; their figures read what the person may, as their domains are now.
    ...diagramToolHandlers({ ...base, readers: c.readers }),
    // Reports it builds: test-run as the person's domains are now; a report runs as whoever opens it reads. Sharing one
    // with people and roles is the same change as its Share panel makes, at the person's own word.
    ...reportToolHandlers({ ...base, readers: c.readers, userName: c.userName }),
  }
}
