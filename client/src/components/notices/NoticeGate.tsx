// ============================================================================
// §16 — the gate: notices that must be read before work goes on, one at a
// time. A notice that requires acknowledgement is not passed until the
// button is pressed; the record carries the reader's name, the time and
// where they were.
// ============================================================================

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BellRing, Check, Loader2, X } from 'lucide-react'
import type { AcknowledgeNoticeRequest } from '@qc/shared/api'
import type { NoticeForUser } from '@qc/shared/types'
import { Button, Modal } from '@/components/ui'
import { acknowledgeNotice, markNoticeSeen } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { NoticeCard } from './NoticeCard'

export function NoticeGate({
  notices,
  context,
  onDone,
  onCancel,
}: {
  notices: NoticeForUser[]
  context?: AcknowledgeNoticeRequest['context']
  /** Every notice handled. */
  onDone: () => void
  /** The reader backed out; nothing recorded for the notices left. Omit to make the gate unavoidable. */
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const current = notices[index]
  if (!current) return null

  const advance = async () => {
    setBusy(true)
    try {
      if (current.requiresAck) await acknowledgeNotice(qc, current.id, { context })
      else await markNoticeSeen(qc, current.id, { context })
      if (index + 1 >= notices.length) onDone()
      else setIndex(index + 1)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record that.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => onCancel?.()}
      size="lg"
      icon={<BellRing className="h-5 w-5" />}
      title={
        <span>
          Read before you continue
          {notices.length > 1 && <span className="ml-2 text-sm font-semibold text-muted">{index + 1} of {notices.length}</span>}
        </span>
      }
      footer={
        <>
          {onCancel && (
            <Button onClick={onCancel} disabled={busy} className="min-h-[44px]">
              <X className="h-4 w-4" /> Not now
            </Button>
          )}
          <Button variant="primary" onClick={advance} disabled={busy} className="min-h-[44px]">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {current.requiresAck ? 'I have read this — acknowledge' : 'Got it'}
          </Button>
        </>
      }
    >
      <NoticeCard key={current.id} notice={current} showTargets={false} className="ring-0 p-0 bg-transparent dark:bg-transparent" />
    </Modal>
  )
}
