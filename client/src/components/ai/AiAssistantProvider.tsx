// ============================================================================
// §20 — the AI assistant's state, above the pages. The shell mounts this
// outside <main> (which remounts on every route), so an answer keeps
// streaming while the administrator moves around the app and the panel
// reopens where it was left. Signing out unmounts it, which stops the stream.
//
// Two contexts: the controls (open, the conversation, send, stop), which
// change rarely, and the answer being written, which changes every frame
// while text streams — so the header's button does not redraw with each word.
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AiChatRequest, AiConversation, AiMessage, AiMessagesResponse } from '@qc/shared/ai'
import { ApiError, apiStream } from '@/lib/api'
import { readSse } from '@/lib/sse'
import { newSubmissionId } from '@/lib/utils'
import { keys } from '@/services/queries'
import { applyEvent, endTurn, isInFlight, parseStreamEvent, sentAfter, settleMessages, startTurn, type LiveTurn } from './liveTurn'
import { STOP_SETTLE_MS, retryAfterStop } from './retryAfterStop'

export interface AiControls {
  /** The signed-in role may use the assistant (administrators). */
  enabled: boolean
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** A desktop (lg and up): the panel docks beside the page instead of covering it. */
  docked: boolean
  /** The conversation on screen; null for a new one. */
  conversationId: string | null
  openConversation: (id: string | null) => void
  /** An answer is being written. */
  busy: boolean
  /** Asks a question in the conversation on screen. False when it was not sent (empty, or an answer is still being written). */
  send: (question: string) => boolean
  stop: () => void
  /** The composer's unsent text, kept while the panel is closed; a ref, so typing redraws nothing up here. */
  draft: MutableRefObject<string>
}

const ControlsContext = createContext<AiControls | null>(null)
const LiveContext = createContext<LiveTurn | null>(null)

const LOST = { code: 'internal' as const, message: 'The connection was lost before the answer finished.' }

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function AiAssistantProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const qc = useQueryClient()
  const docked = useMediaQuery('(min-width: 1024px)')
  const [open, setOpenState] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveTurn | null>(null)
  // What async code reads: the conversation on screen now, and the answer's abort handle.
  const active = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const draft = useRef('')
  // The last answer stopped here, and when: a question right after it may meet that answer still winding down.
  const lastStop = useRef<{ conversationId: string; at: number } | null>(null)

  const setOpen = useCallback((next: boolean) => setOpenState(next), [])
  const toggle = useCallback(() => setOpenState((o) => !o), [])
  const openConversation = useCallback((id: string | null) => {
    active.current = id
    setConversationId(id)
  }, [])
  const stop = useCallback(() => controller.current?.abort(), [])

  // Losing the capability closes the panel and stops an answer; unmounting (signing out) stops it too.
  useEffect(() => {
    if (enabled) return
    controller.current?.abort()
    setOpenState(false)
  }, [enabled])
  useEffect(() => () => controller.current?.abort(), [])

  const stream = useCallback(
    async (key: string, from: string | null, question: string, sentAt: string, ac: AbortController) => {
      // Every change goes to this turn only: a later question has its own.
      const update = (fn: (t: LiveTurn) => LiveTurn) => setLive((t) => (t && t.key === key ? fn(t) : t))
      // Text arrives a few characters at a time; it is drawn once per frame, not once per piece.
      let pending = ''
      let frame = 0
      const flush = () => {
        if (frame) cancelAnimationFrame(frame)
        frame = 0
        if (!pending) return
        const delta = pending
        pending = ''
        update((t) => applyEvent(t, { type: 'text', delta }))
      }

      // The question and its answer go into the saved conversation at once, so the hand-over draws nothing twice.
      const settle = (c: AiConversation, asked: AiMessage, answer: AiMessage) => {
        qc.setQueryData<AiMessagesResponse>(keys.aiMessages(c.id), (old) => settleMessages(old, c, asked, answer))
      }

      // Refused as "still answering" just after a stop here: that stopped answer is winding down, so ask again
      // shortly — with the same key, which a refused send never kept.
      const settling = () => {
        const stopped = lastStop.current
        return from !== null && stopped?.conversationId === from && Date.now() - stopped.at < STOP_SETTLE_MS
      }
      const connect = (request: AiChatRequest) => retryAfterStop(() => apiStream('/ai/chat', { body: request, signal: ac.signal }), settling, ac.signal)

      // The answer has ended: another question may be asked at once, even while the connection winds down.
      const release = () => {
        if (controller.current === ac) controller.current = null
      }

      let conversation: AiConversation | null = null
      let userMessageId: string | null = null
      let ended = false
      let statusFresh = false
      // The server answered the request with a refusal: nothing of the question was kept.
      let refused = false
      try {
        const request: AiChatRequest = from ? { conversationId: from, message: question, clientId: key } : { message: question, clientId: key }
        const body = await connect(request)
        for await (const raw of readSse(body)) {
          const e = parseStreamEvent(raw.event, raw.data)
          if (!e) continue
          if (e.type === 'text') {
            pending += e.delta
            if (!frame) frame = requestAnimationFrame(flush)
            continue
          }
          flush()
          update((t) => applyEvent(t, e))
          if (e.type === 'start') {
            conversation = e.conversation
            userMessageId = e.userMessageId
            // A first question opens its conversation: nothing in it needs fetching yet, and the thread follows it there.
            const id = e.conversation.id
            if (qc.getQueryData(keys.aiMessages(id)) === undefined) qc.setQueryData<AiMessagesResponse>(keys.aiMessages(id), { conversation: e.conversation, messages: [] })
            if (from === null && active.current === null) {
              active.current = id
              setConversationId(id)
            }
            void qc.invalidateQueries({ queryKey: keys.aiConversations })
          } else if (e.type === 'done') {
            ended = true
            statusFresh = true
            release()
            qc.setQueryData(keys.aiStatus, e.status)
            if (conversation && userMessageId) settle(conversation, { id: userMessageId, role: 'user', parts: [{ type: 'text', text: question }], createdAt: sentAt }, e.message)
            break
          } else if (e.type === 'error') {
            ended = true
            release()
            break
          }
        }
        flush()
        if (!ended) update((t) => endTurn(t, 'error', LOST))
      } catch (err) {
        flush()
        if (ac.signal.aborted) {
          update((t) => endTurn(t, 'stopped'))
          const stoppedIn = conversation?.id ?? from
          if (stoppedIn) lastStop.current = { conversationId: stoppedIn, at: Date.now() }
        } else if (err instanceof ApiError) {
          // A refusal before the stream began (the cap, the switch, a conflict) kept nothing.
          refused = !conversation && err.status > 0
          update((t) => endTurn(t, 'error', { code: err.code, message: err.message }))
        } else update((t) => endTurn(t, 'error', LOST))
      } finally {
        if (frame) cancelAnimationFrame(frame)
        release()
        // The saved conversation, the history and the month's spend catch up with what happened.
        if (conversation) {
          void qc.invalidateQueries({ queryKey: keys.aiMessages(conversation.id) })
          // The administration page, when it is open beside the panel: its spend and its usage tiles.
          void qc.invalidateQueries({ queryKey: keys.aiSettings })
          void qc.invalidateQueries({ queryKey: ['ai', 'usage'] })
        } else if (from && !refused) {
          // Ended before the stream began: the server may still have kept the question (and a stopped answer).
          void qc.invalidateQueries({ queryKey: keys.aiMessages(from) })
        }
        void qc.invalidateQueries({ queryKey: keys.aiConversations })
        if (!statusFresh) void qc.invalidateQueries({ queryKey: keys.aiStatus })
      }
    },
    [qc],
  )

  const send = useCallback(
    (text: string): boolean => {
      const question = text.trim()
      if (!question || controller.current) return false
      const key = newSubmissionId()
      const from = active.current
      const sentAt = new Date().toISOString()
      // What this device had of the conversation (and of the answer before): the question, once saved, comes after it.
      const cached = from ? qc.getQueryData<AiMessagesResponse>(keys.aiMessages(from))?.messages : undefined
      const ac = new AbortController()
      controller.current = ac
      setLive((prev) => startTurn(key, from, question, sentAt, sentAfter(prev, from, cached)))
      void stream(key, from, question, sentAt, ac)
      return true
    },
    [qc, stream],
  )

  const busy = isInFlight(live)
  const controls = useMemo<AiControls>(
    () => ({ enabled, open: enabled && open, setOpen, toggle, docked, conversationId, openConversation, busy, send, stop, draft }),
    [enabled, open, setOpen, toggle, docked, conversationId, openConversation, busy, send, stop],
  )

  return (
    <ControlsContext.Provider value={controls}>
      <LiveContext.Provider value={live}>{children}</LiveContext.Provider>
    </ControlsContext.Provider>
  )
}

export function useAi(): AiControls {
  const ctx = useContext(ControlsContext)
  if (!ctx) throw new Error('useAi must be used within AiAssistantProvider')
  return ctx
}

/** The answer being written (or the last one, until the next question). */
export function useAiLive(): LiveTurn | null {
  return useContext(LiveContext)
}
