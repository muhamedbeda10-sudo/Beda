// ============================================================================
// §20 — the assistant's own pages, from its header: Tasks, for everyone
// given the assistant, and Automations (§21) for the people who may create
// them. They are opened from here rather than
// from tabs of their own in the app's bar, since they are the assistant's
// work. From the panel the page opens beside it on a wide screen, and the
// panel steps aside on a narrower one, where it would cover the page.
// ============================================================================

import { useLocation, useNavigate } from 'react-router-dom'
import { ListTodo, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'

export function AiHeaderLinks({ buttonClass, onClass, fromPanel = false }: { buttonClass: string; onClass: string; fromPanel?: boolean }) {
  const { automations, docked, setOpen } = useAi()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const go = (to: string) => {
    navigate(to)
    if (fromPanel && !docked) setOpen(false)
  }
  const onTasks = pathname.startsWith('/tasks')
  const onAutomations = pathname.startsWith('/automations')
  return (
    <>
      <button type="button" onClick={() => go('/tasks')} className={cn(buttonClass, onTasks && onClass)} aria-label="Tasks" aria-current={onTasks ? 'page' : undefined} data-tip="Tasks: send work to people and follow it">
        <ListTodo className="h-5 w-5" />
      </button>
      {automations && (
        <button type="button" onClick={() => go('/automations')} className={cn(buttonClass, onAutomations && onClass)} aria-label="Automations" aria-current={onAutomations ? 'page' : undefined} data-tip="Automations: watches and scheduled reports">
          <Zap className="h-5 w-5" />
        </button>
      )}
    </>
  )
}
