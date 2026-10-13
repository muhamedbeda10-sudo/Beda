// ============================================================================
// §20 — the assistant's own pages, from its header: the Playbook, for
// everyone given the assistant, Automations (§21) for the people who may
// create them, and its settings (the gear) for its owner alone. They open inside the popup (its own router: AiPopup), with the
// way back to the conversation, rather than as tabs of the app's bar. Tasks
// are not here: they are the bell's, though the assistant still drafts them.
// ============================================================================

import { useLocation, useNavigate } from 'react-router-dom'
import { BookMarked, Settings, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'

export function AiHeaderLinks({ buttonClass, onClass }: { buttonClass: string; onClass: string }) {
  const { automations, owner, enabled } = useAi()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const onAutomations = pathname.startsWith('/automations')
  const onPlaybook = pathname.startsWith('/playbook')
  const onSettings = pathname.startsWith('/admin/ai')
  return (
    <>
      {enabled && (
      <button type="button" onClick={() => navigate('/playbook')} className={cn(buttonClass, onPlaybook && onClass)} aria-label="Playbook" aria-current={onPlaybook ? 'page' : undefined} data-tip="Playbook: what the assistant always follows">
        <BookMarked className="h-5 w-5" />
      </button>
      )}
      {automations && (
        <button type="button" onClick={() => navigate('/automations')} className={cn(buttonClass, onAutomations && onClass)} aria-label="Automations" aria-current={onAutomations ? 'page' : undefined} data-tip="Automations: watches and scheduled reports">
          <Zap className="h-5 w-5" />
        </button>
      )}
      {owner && (
        <button type="button" onClick={() => navigate('/admin/ai')} className={cn(buttonClass, onSettings && onClass)} aria-label="AI settings" aria-current={onSettings ? 'page' : undefined} data-tip="AI settings: the key, who can use it, caps, usage and activity">
          <Settings className="h-5 w-5" />
        </button>
      )}
    </>
  )
}
