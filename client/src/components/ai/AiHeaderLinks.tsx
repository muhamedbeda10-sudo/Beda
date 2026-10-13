// ============================================================================
// §20 — the assistant's own pages, from its header: the Playbook, for
// everyone given the assistant, and Automations (§21) for the people who may
// create them. They open inside the popup (its own router: AiPopup), with the
// way back to the conversation, rather than as tabs of the app's bar. Tasks
// are not here: they are the bell's, though the assistant still drafts them.
// ============================================================================

import { useLocation, useNavigate } from 'react-router-dom'
import { BookMarked, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'

export function AiHeaderLinks({ buttonClass, onClass }: { buttonClass: string; onClass: string }) {
  const { automations } = useAi()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const onAutomations = pathname.startsWith('/automations')
  const onPlaybook = pathname.startsWith('/playbook')
  return (
    <>
      <button type="button" onClick={() => navigate('/playbook')} className={cn(buttonClass, onPlaybook && onClass)} aria-label="Playbook" aria-current={onPlaybook ? 'page' : undefined} data-tip="Playbook: what the assistant always follows">
        <BookMarked className="h-5 w-5" />
      </button>
      {automations && (
        <button type="button" onClick={() => navigate('/automations')} className={cn(buttonClass, onAutomations && onClass)} aria-label="Automations" aria-current={onAutomations ? 'page' : undefined} data-tip="Automations: watches and scheduled reports">
          <Zap className="h-5 w-5" />
        </button>
      )}
    </>
  )
}
