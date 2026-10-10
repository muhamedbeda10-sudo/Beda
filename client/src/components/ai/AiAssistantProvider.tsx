// ============================================================================
// §20 — the AI assistant's state, above the pages. The shell mounts this
// outside <main> (which remounts on every route), so an answer keeps
// streaming while the person moves around the app and the panel reopens
// where it was left. Signing out unmounts it, which stops the stream.
//
// Whether the assistant is there at all is /ai/me's to say — the owner gives
// it to people one by one, whatever their role. For anyone it is not given
// to, that one call is all: nothing else is fetched or drawn. Taken away
// while the panel is open, the panel says so instead of vanishing.
//
// Two contexts: the controls (open, the conversation, send, stop), which
// change rarely, and the answer being written, which changes every frame
// while text streams — so the header's button does not redraw with each word.
//
// The assistant has two places, one state: the panel beside any page, and
// the full page at /ai (./workspace). Expand and Dock move between them with
// the conversation, the draft and the answer being written as they are — the
// stream never notices. On /ai the panel steps aside.
//
// Another page may start a new conversation with the question box filled in
// (compose: §21's "Edit in chat" on the Automations page), for the person to
// finish and send.
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { AiChatRequest, AiConversation, AiMessage, AiMessagesResponse } from '@qc/shared/ai'
import { ApiError, apiStream } from '@/lib/api'
import { readSse } from '@/lib/sse'
import { newSubmissionId } from '@/lib/utils'
import { keys, useAiMe } from '@/services/queries'
import { applyEvent, endTurn, isInFlight, parseStreamEvent, sentAfter, settleMessages, startTurn, type LiveTurn } from './liveTurn'
import { STOP_SETTLE_MS, retryAfterStop } from './retryAfterStop'
import { aiWorkspaceHref, isAiWorkspacePath, type AiOpenReport, type AiWorkspaceList, type AiWorkspaceState } from './workspace'

export interface AiControls {
  /** The owner gave the signed-in person the assistant (/ai/me): its button, its menu entry and its panel are there. */
  enabled: boolean
  /** The signed-in person controls the assistant: the settings page is theirs. */
  owner: boolean
  /** §21 — the signed-in person may create automations (/ai/me): the Automations page is theirs. */
  automations: boolean
  /** It was given and has been taken away since: an open panel says so until it is closed. */
  revoked: boolean
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
  /**
   * A new conversation with the question box holding `text`, to finish and
   * send — the panel opens on it (the full page, when on screen, shows it).
   * §21: "Edit in chat" on the Automations page.
   */
  compose: (text: string) => void
  /** Counts compose()'s calls: a question box on screen takes the new text when it moves (useComposerDraft). */
  composed: number
  /** The full page (/ai) is on screen: the panel steps aside for it. */
  workspace: boolean
  /** From the panel to the full page: the conversation on screen, or the report (`report`) or list (`list`) the panel shows. */
  expand: (target?: { report?: AiOpenReport; list?: AiWorkspaceList }) => void
  /** From the full page back to the panel, beside the page the person came from; a report open there opens in the panel. */
  dock: (report?: AiOpenReport) => void
  /** What the panel opens on, once, after Dock: the report the page had open. */
  handoff: MutableRefObject<AiOpenReport | null>
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

/** A refusal that may mean the assistant was taken away (or never given): /ai/me is asked again, and says which. */
const mayBeRevoked = (err: unknown) => err instanceof ApiError && (err.status === 403 || err.status === 404)

export function AiAssistantProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const { data: me } = useAiMe()
  const enabled = me?.granted ?? false
  const owner = me?.owner ?? false
  const automations = me?.automations ?? false
  const docked = useMediaQuery('(min-width: 1024px)')
  const [open, setOpenState] = useState(false)
  const [revoked, setRevoked] = useState(false)
  // Whether it was ever given in this sign-in: losing it then is "taken away", not "never there".
  const given = useRef(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveTurn | null>(null)
  // What async code reads: the conversation on screen now, and the answer's abort handle.
  const active = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const draft = useRef('')
  const [composed, setComposed] = useState(0)
  // The last answer stopped here, and when: a question right after it may meet that answer still winding down.
  const lastStop = useRef<{ conversationId: string; at: number } | null>(null)

  // The full page, and where the person was before it: Dock goes back there.
  const workspace = isAiWorkspacePath(location.pathname)
  const cameFrom = useRef<string | null>(null)
  const handoff = useRef<AiOpenReport | null>(null)
  useEffect(() => {
    if (!workspace) cameFrom.current = `${location.pathname}${location.search}${location.hash}`
  }, [workspace, location.pathname, location.search, location.hash])
  // Arriving on the page puts the panel away: the same conversation is not shown twice, and leaving the page
  // other than by Dock does not bring it back unasked.
  useEffect(() => {
    if (workspace) setOpenState(false)
  }, [workspace])

  const setOpen = useCallback((next: boolean) => setOpenState(next), [])
  const toggle = useCallback(() => setOpenState((o) => !o), [])
  const openConversation = useCallback((id: string | null) => {
    active.current = id
    setConversationId(id)
  }, [])
  const stop = useCallback(() => controller.current?.abort(), [])
  const compose = useCallback(
    (text: string) => {
      draft.current = text
      active.current = null
      setConversationId(null)
      setComposed((n) => n + 1)
      // On the full page the box is on screen already; anywhere else the panel opens on it.
      if (!workspace) setOpenState(true)
    },
    [workspace],
  )
  const expand = useCallback(
    (target?: { report?: AiOpenReport; list?: AiWorkspaceList }) => {
      setOpenState(false)
      const state: AiWorkspaceState = { known: target?.report?.known, list: target?.list }
      navigate(aiWorkspaceHref({ conversationId: active.current, reportId: target?.report?.id }), { state })
    },
    [navigate],
  )
  const dock = useCallback(
    (report?: AiOpenReport) => {
      handoff.current = report ?? null
      navigate(cameFrom.current ?? '/')
      setOpenState(true)
    },
    [navigate],
  )

  // Losing access stops an answer (the server would stop it at its next call anyway); an open panel stays to say why.
  // Unmounting (signing out) stops it too.
  useEffect(() => {
    if (enabled) {
      given.current = true
      setRevoked(false)
      return
    }
    controller.current?.abort()
    if (given.current) setRevoked(true)
  }, [enabled])
  useEffect(() => () => controller.current?.abort(), [])

  // A list, a conversation or a report refused as forbidden or not found may be the first sign that access was
  // withdrawn: /ai/me is asked again at once rather than at the end of its minute.
  useEffect(
    () =>
      qc.getQueryCache().subscribe((e) => {
        if (e.type !== 'updated' || e.action.type !== 'error') return
        const [scope, what] = e.query.queryKey as readonly unknown[]
        if (scope === 'ai' && what !== 'me' && mayBeRevoked(e.action.error)) void qc.invalidateQueries({ queryKey: keys.aiMe })
      }),
    [qc],
  )

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
            // The event also carries the month's figures: the chat shows no amounts, so they are left where they are.
            ended = true
            release()
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
          // A refusal before the stream began (a cap, the switch, access taken away, a conflict) kept nothing.
          refused = !conversation && err.status > 0
          update((t) => endTurn(t, 'error', { code: err.code, message: err.message }))
        } else update((t) => endTurn(t, 'error', LOST))
      } finally {
        if (frame) cancelAnimationFrame(frame)
        release()
        // The saved conversation and the history catch up with what happened.
        if (conversation) {
          void qc.invalidateQueries({ queryKey: keys.aiMessages(conversation.id) })
          // The owner's page, when it is open beside the panel: the spend, each person's month and the usage tiles.
          void qc.invalidateQueries({ queryKey: keys.aiSettings })
          void qc.invalidateQueries({ queryKey: keys.aiAccess })
          void qc.invalidateQueries({ queryKey: ['ai', 'usage'] })
        } else if (from && !refused) {
          // Ended before the stream began: the server may still have kept the question (and a stopped answer).
          void qc.invalidateQueries({ queryKey: keys.aiMessages(from) })
        }
        void qc.invalidateQueries({ queryKey: keys.aiConversations })
        // Whether the next question can be asked: this one may have reached a cap, or met access taken away.
        void qc.invalidateQueries({ queryKey: keys.aiMe })
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
    () => ({
      enabled,
      owner,
      automations,
      revoked,
      open: (enabled || revoked) && open,
      setOpen,
      toggle,
      docked,
      conversationId,
      openConversation,
      busy,
      send,
      stop,
      draft,
      compose,
      composed,
      workspace,
      expand,
      dock,
      handoff,
    }),
    [enabled, owner, automations, revoked, open, setOpen, toggle, docked, conversationId, openConversation, busy, send, stop, compose, composed, workspace, expand, dock],
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
