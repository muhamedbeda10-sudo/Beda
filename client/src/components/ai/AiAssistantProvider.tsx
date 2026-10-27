// ============================================================================
// §20 — the AI assistant's state, above the pages. The shell mounts this
// outside <main> (which remounts on every route), so an answer keeps
// streaming while the person moves around the app and the panel reopens
// where it was left.
//
// An answer is the server's once its stream has begun: it goes on there
// whether or not this device reads it, and only Stop ends it early (the
// server is asked to, and the stream brings its end). Signing out, losing
// access or a lost connection only let go of the stream; the conversation,
// asked again every few seconds while its answer runs, shows the rest, and
// the bell says when it is ready to someone who was not watching. Reopened
// while its answer runs, a conversation shows it the same way, with Stop.
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
// The assistant lives in one popup over the app, opened from the floating
// button at the bottom right (AiPanelHost). It has two sizes on a desktop: a
// small card in the corner that leaves the page usable (compact), and a large
// window in the middle (large); on a phone it fills the screen. The popup has
// places of its own (the conversation, a saved report, the Automations and
// Playbook pages), kept here as the path it shows, so it reopens where it was
// left and a link (/ai?c=…) or another page can open it on one of them.
// Changing size keeps the conversation, the draft and the answer being
// written as they are — the stream never notices.
//
// Another page may start a new conversation with the question box filled in
// (compose: §21's "Edit in chat" on the Automations page), for the person to
// finish and send.
//
// Files attached to the next question (photos, PDFs, spreadsheets) are kept
// here with the draft: each is uploaded as soon as it is picked, and the
// question takes them once every one is kept. A question refused before its
// answer began gives them back to the box.
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AI_DEFAULT_DEPTH, type AiAttachment, type AiChatRequest, type AiConversation, type AiDepth, type AiMessage, type AiMessagesResponse } from '@qc/shared/ai'
import { ApiError, apiStream } from '@/lib/api'
import { AttachRejected, attachFile, detachFile } from '@/services/aiAttachments'
import { useMediaQuery } from '@/lib/media'
import { readSse } from '@/lib/sse'
import { newSubmissionId } from '@/lib/utils'
import { stopAiAnswer } from '@/services/mutations'
import { keys, useAiMe } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { revisedProposalId, supersedeAutomationPart } from '@/components/automations/wording'
import { pickedKind, readyIds, type PendingAttachment } from './attachments'
import { readDepth, writeDepth } from './depth'
import { hasOpenNoticeCard } from './noticeProposal'
import { hasOpenTaskCard } from './taskProposal'
import { applyEvent, askedToStop, endTurn, followsKeptRound, isInFlight, parseStreamEvent, sentAfter, settleMessages, startTurn, streamEnded, type LiveTurn } from './liveTurn'
import { STOP_SETTLE_MS, retryAfterStop } from './retryAfterStop'
import { messagesConversation, refreshAfterAnswer, runningWatch } from './running'
import { AI_WORKSPACE_PATH } from './workspace'

/** The popup's two sizes on a desktop: the card in the corner, or the whole screen. */
export type AiPopupSize = 'compact' | 'large'

export interface AiControls {
  /** The owner gave the signed-in person the assistant (/ai/me): its button, its menu entry and its panel are there. */
  enabled: boolean
  /** The signed-in person controls the assistant: the settings page is theirs. */
  owner: boolean
  /** §21 — the signed-in person may create automations (/ai/me): the Automations page is theirs. */
  automations: boolean
  /** §23 — the signed-in person may have the assistant write notices (/ai/me): the Notices page's "New in the assistant". */
  notices: boolean
  /** It was given and has been taken away since: an open panel says so until it is closed. */
  revoked: boolean
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** The popup's size on a desktop. */
  size: AiPopupSize
  setSize: (size: AiPopupSize) => void
  /** A phone (narrower than sm): the popup fills the screen, whatever its size. */
  phone: boolean
  /** Opens the popup on one of its places (/ai?c=…, /ai/reports/<id>, /automations…), in `size` when given. */
  openAt: (path: string, size?: AiPopupSize) => void
  /**
   * A link from the popup to a page of the app: the popup steps aside so the page is in view — a phone's closes,
   * the large window becomes the card in the corner, and the card stays where it is, beside the page.
   */
  leaveForPage: () => void
  /** Where the popup is (its own path): it reopens there. Written by the popup as it moves. */
  popupPath: MutableRefObject<string>
  /** The popup's own navigate while it is open, so openAt moves it rather than reopening it. */
  popupNavigate: MutableRefObject<((to: string) => void) | null>
  /** The conversation on screen; null for a new one. */
  conversationId: string | null
  openConversation: (id: string | null) => void
  /** An answer is being written. */
  busy: boolean
  /**
   * Asks a question in the conversation on screen, with the files attached to it. False when it was not sent
   * (nothing to ask, a file still on its way or failed, or an answer is still being written).
   */
  send: (question: string) => boolean
  /** How deep the next question is answered, as picked above the box; remembered on this device. */
  depth: AiDepth
  setDepth: (depth: AiDepth) => void
  /** Files attached to the next question, kept while the panel is closed or moves (Expand, Dock). */
  attachments: PendingAttachment[]
  /** Attach picked files to the next question, each uploaded at once. Returns the names of those it cannot take. */
  attach: (files: readonly File[]) => string[]
  /** Take a file off the next question. */
  detach: (key: string) => void
  /** Stops the answer this device asked and is reading: the server ends it at its next step, and the stream says so. */
  stop: () => void
  /**
   * Stops the answer the server is writing in a conversation that this device is not reading (reopened while it
   * runs, or let go of): the conversation goes on being asked again until it has ended.
   */
  stopConversation: (id: string) => void
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
}

const ControlsContext = createContext<AiControls | null>(null)
const LiveContext = createContext<LiveTurn | null>(null)

/**
 * The answer this device is reading: its abort handle (which lets go of the stream, never of the answer), the
 * conversation it is in once known (at once for a question in one already open), whether `start` has come, and
 * whether Stop was pressed.
 */
interface Reading {
  key: string
  ac: AbortController
  conversationId: string | null
  started: boolean
  stopAsked: boolean
  /** Waiting to ask again after a refusal (retryAfterStop): nothing of the question is with the server. */
  pausing: boolean
  /** Stop pressed before `start`: the stream is let go of only if neither `start` nor a refusal comes by then. */
  letGo: ReturnType<typeof setTimeout> | null
}

/** Stop pressed before `start`: how long to wait for it (or a refusal) before letting go of the request. */
const STOP_BEFORE_START_MS = 10_000

/** Whether an answer that ended says it was answered, as the bell does: not stopped, limited or refused. */
const answered = (m: AiMessage) => m.stopReason === 'end_turn' || m.stopReason === 'max_tokens'

/** Narrower than sm (640 px): a phone, where the popup fills the screen. */
const AI_PHONE = '(max-width: 639.98px)'

/** A refusal that may mean the assistant was taken away (or never given): /ai/me is asked again, and says which. */
const mayBeRevoked = (err: unknown) => err instanceof ApiError && (err.status === 403 || err.status === 404)

export function AiAssistantProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { data: me } = useAiMe()
  const enabled = me?.granted ?? false
  const owner = me?.owner ?? false
  const automations = me?.automations ?? false
  const notices = me?.notices ?? false
  const phone = useMediaQuery(AI_PHONE)
  const [open, setOpenState] = useState(false)
  const [size, setSize] = useState<AiPopupSize>('compact')
  const popupPath = useRef(AI_WORKSPACE_PATH)
  const popupNavigate = useRef<((to: string) => void) | null>(null)
  const [revoked, setRevoked] = useState(false)
  // Whether it was ever given in this sign-in: losing it then is "taken away", not "never there".
  const given = useRef(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveTurn | null>(null)
  // What async code reads: the conversation on screen now, the answer being read, and whether the popup is in view.
  const active = useRef<string | null>(null)
  const reading = useRef<Reading | null>(null)
  const shown = useRef(false)
  const draft = useRef('')
  const [composed, setComposed] = useState(0)
  // The depth the box shows; the ref is what send reads.
  const [depth, setDepthState] = useState<AiDepth>(readDepth)
  const picked = useRef(depth)
  const setDepth = useCallback((d: AiDepth) => {
    picked.current = d
    setDepthState(d)
    writeDepth(d)
  }, [])
  // The next question's files: the state draws the box, the ref is what send reads.
  const [attachments, setAttachmentsState] = useState<PendingAttachment[]>([])
  const attached = useRef<PendingAttachment[]>([])
  const uploads = useRef(new Map<string, AbortController>())
  const setAttachments = useCallback((fn: (list: PendingAttachment[]) => PendingAttachment[]) => {
    attached.current = fn(attached.current)
    setAttachmentsState(attached.current)
  }, [])
  // The last answer stopped here, and when: a question right after it may meet that answer still winding down.
  const lastStop = useRef<{ conversationId: string; at: number } | null>(null)
  // Whether each conversation's answer ran as last fetched, to tell when one followed through it has ended: made once.
  const [answerEnded] = useState(runningWatch)

  const setOpen = useCallback((next: boolean) => setOpenState(next), [])
  const toggle = useCallback(() => setOpenState((o) => !o), [])
  const openConversation = useCallback((id: string | null) => {
    active.current = id
    setConversationId(id)
  }, [])

  // Asks the server to stop the answer it is writing in a conversation; it ends at its next step. A question asked
  // there right after may meet it still winding down (retryAfterStop). False when the server could not be told.
  const askToStop = useCallback(
    async (id: string): Promise<boolean> => {
      lastStop.current = { conversationId: id, at: Date.now() }
      try {
        await stopAiAnswer(qc, id)
        return true
      } catch (e) {
        if (mayBeRevoked(e)) void qc.invalidateQueries({ queryKey: keys.aiMe })
        toast(e instanceof ApiError ? e.message : 'Could not stop the answer. Try again.', 'error')
        return false
      }
    },
    [qc, toast],
  )
  const stopConversation = useCallback((id: string) => void askToStop(id), [askToStop])
  // Stop on the answer this device reads: the server is told, and the stream goes on until its `done` says the answer
  // stopped. Pressed before `start`, the server may be keeping the question this very moment, and letting go of the
  // request then would leave its answer running: the stream is read on, and `start` brings the conversation to stop
  // (see stream); a refusal kept nothing. Only while waiting to ask again, with nothing sent, is the request let go
  // of at once — or, as a last resort, when neither comes.
  const stop = useCallback(() => {
    const r = reading.current
    if (!r || r.stopAsked) return
    r.stopAsked = true
    setLive((t) => (t && t.key === r.key ? askedToStop(t) : t))
    if (r.started && r.conversationId) {
      void askToStop(r.conversationId).then((told) => {
        if (told) return
        r.stopAsked = false
        setLive((t) => (t && t.key === r.key ? askedToStop(t, false) : t))
      })
      return
    }
    if (r.conversationId) lastStop.current = { conversationId: r.conversationId, at: Date.now() }
    if (r.pausing) r.ac.abort()
    else r.letGo = setTimeout(() => r.ac.abort(), STOP_BEFORE_START_MS)
  }, [askToStop])
  const openAt = useCallback((path: string, next?: AiPopupSize) => {
    if (next) setSize(next)
    if (popupNavigate.current) popupNavigate.current(path)
    else popupPath.current = path
    setOpenState(true)
  }, [])
  const compose = useCallback(
    (text: string) => {
      draft.current = text
      active.current = null
      setConversationId(null)
      setComposed((n) => n + 1)
      // The popup opens on the conversation, from wherever it was (the Automations page in it, or closed).
      openAt(AI_WORKSPACE_PATH)
    },
    [openAt],
  )
  const leaveForPage = useCallback(() => {
    if (phone) setOpenState(false)
    else setSize('compact')
  }, [phone])

  // Losing access lets go of the answer being read (the server ends it at its next call if the person may no longer
  // ask); an open panel stays to say why. Unmounting (signing out) lets go of it too: it goes on on the server, and
  // the bell says when it is ready.
  useEffect(() => {
    if (enabled) {
      given.current = true
      setRevoked(false)
      return
    }
    reading.current?.ac.abort()
    if (given.current) setRevoked(true)
  }, [enabled])
  useEffect(() => () => reading.current?.ac.abort(), [])

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

  // An answer followed through its conversation (reopened while it ran, or let go of) has ended when a fetch of the
  // conversation no longer says it runs: what the end of a streamed answer refreshes is refreshed then, and the bell.
  useEffect(
    () =>
      qc.getQueryCache().subscribe((e) => {
        if (e.type !== 'updated' || e.action.type !== 'success') return
        const id = messagesConversation(e.query.queryKey)
        if (id && answerEnded(id, e.action.data as AiMessagesResponse | undefined, e.action.manual ?? false)) refreshAfterAnswer(qc)
      }),
    [qc, answerEnded],
  )

  const attach = useCallback(
    (files: readonly File[]): string[] => {
      const refused: string[] = []
      for (const file of files) {
        const kind = pickedKind(file)
        if (!kind) {
          refused.push(file.name || 'file')
          continue
        }
        const key = newSubmissionId()
        const ac = new AbortController()
        uploads.current.set(key, ac)
        setAttachments((list) => [...list, { key, name: file.name || 'file', kind, state: 'uploading' }])
        const settleFile = (patch: Partial<PendingAttachment>) => setAttachments((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)))
        attachFile(file, kind, ac.signal)
          .then((attachment) => {
            // Taken off while it uploaded: the server's copy is let go too.
            if (ac.signal.aborted) void detachFile(attachment.id).catch(() => undefined)
            else settleFile({ state: 'ready', attachment, name: attachment.name })
          })
          .catch((e: unknown) => {
            if (ac.signal.aborted) return
            const message = e instanceof AttachRejected || e instanceof ApiError ? e.message : 'The file could not be attached. Try again.'
            settleFile({ state: 'failed', error: message })
          })
          .finally(() => uploads.current.delete(key))
      }
      return refused
    },
    [setAttachments],
  )
  const detach = useCallback(
    (key: string) => {
      const file = attached.current.find((p) => p.key === key)
      if (!file) return
      uploads.current.get(key)?.abort()
      if (file.attachment) void detachFile(file.attachment.id).catch(() => undefined)
      setAttachments((list) => list.filter((p) => p.key !== key))
    },
    [setAttachments],
  )

  const stream = useCallback(
    async (handle: Reading, from: string | null, question: string, sentAt: string, files: PendingAttachment[], depth: AiDepth) => {
      const { key, ac } = handle
      const sent: AiAttachment[] = files.map((f) => f.attachment!)
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
      // shortly — with the same key, which a refused send never kept. Not once this question is stopped too.
      const settling = () => {
        const stopped = lastStop.current
        handle.pausing = !handle.stopAsked && from !== null && stopped?.conversationId === from && Date.now() - stopped.at < STOP_SETTLE_MS
        return handle.pausing
      }
      const attempt = (request: AiChatRequest) => {
        handle.pausing = false
        return apiStream('/ai/chat', { body: request, signal: ac.signal })
      }
      const connect = (request: AiChatRequest) => retryAfterStop(() => attempt(request), settling, ac.signal)

      // The answer has ended, or this device let go of it: another question may be asked at once, even while the
      // connection winds down.
      const release = () => {
        if (reading.current === handle) reading.current = null
      }

      let conversation: AiConversation | null = null
      let userMessageId: string | null = null
      // §23 — a conversation to fetch again once the round that drafted a notice or task card is kept (see 'notice' below).
      let recheck: string | null = null
      const recheckNotices = () => {
        if (!recheck) return
        void qc.invalidateQueries({ queryKey: keys.aiMessages(recheck) })
        recheck = null
      }
      let ended = false
      // The server answered the request with a refusal: nothing of the question was kept.
      let refused = false
      // Refused as still answering: an answer this device did not know of runs in the conversation.
      let conflict = false
      try {
        const request: AiChatRequest = { message: question, clientId: key }
        if (from) request.conversationId = from
        if (sent.length > 0) request.attachmentIds = sent.map((a) => a.id)
        if (depth !== AI_DEFAULT_DEPTH) request.depth = depth
        const body = await connect(request)
        for await (const raw of readSse(body)) {
          const e = parseStreamEvent(raw.event, raw.data)
          if (!e) continue
          if (followsKeptRound(e)) recheckNotices()
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
            handle.started = true
            handle.conversationId = e.conversation.id
            // Stop was pressed before the server named the conversation: the server has the answer now, so it is
            // told to stop it; the stream goes on until its `done` says it stopped.
            if (handle.stopAsked) {
              if (handle.letGo) clearTimeout(handle.letGo)
              handle.letGo = null
              update((t) => askedToStop(t))
              void askToStop(e.conversation.id).then((told) => {
                if (told) return
                handle.stopAsked = false
                update((t) => askedToStop(t, false))
              })
            }
            // A first question opens its conversation: nothing in it needs fetching yet, and the thread follows it there.
            const id = e.conversation.id
            if (qc.getQueryData(keys.aiMessages(id)) === undefined) qc.setQueryData<AiMessagesResponse>(keys.aiMessages(id), { conversation: e.conversation, messages: [] })
            if (from === null && active.current === null) {
              active.current = id
              setConversationId(id)
            }
            void qc.invalidateQueries({ queryKey: keys.aiConversations })
          } else if (e.type === 'title') {
            // The assistant named the new conversation: its header and the list say so at once.
            conversation = e.conversation
            qc.setQueryData<AiMessagesResponse>(keys.aiMessages(e.conversation.id), (old) => (old ? { ...old, conversation: e.conversation } : old))
            void qc.invalidateQueries({ queryKey: keys.aiConversations })
          } else if (e.type === 'automation') {
            // §22 — a newer version of a card of an earlier answer: that card says at once it was replaced (the server
            // marked it so as it kept this one, and the conversation fetched once the answer ends says the same).
            const replaced = revisedProposalId(e.part)
            const id = conversation?.id ?? from
            if (replaced && id) qc.setQueryData<AiMessagesResponse>(keys.aiMessages(id), (old) => supersedeAutomationPart(old, replaced))
          } else if (e.type === 'notice') {
            // §23 — a newer notice card may replace one of an earlier answer still waiting for its button. The server
            // marks it so only as it keeps the round that drafted this one, once every call of that round has run, so
            // with such a card on screen the conversation is fetched again after that: at the model's next words, or
            // as the answer ends. Until then the earlier cards wait (noticeCardsWait).
            const id = conversation?.id ?? from
            if (e.part.ok && id && hasOpenNoticeCard(qc.getQueryData<AiMessagesResponse>(keys.aiMessages(id)), e.part.proposalId)) recheck = id
          } else if (e.type === 'task') {
            // The same for a newer task card: the earlier one it replaces is marked so once its round is kept (taskCardsWait).
            const id = conversation?.id ?? from
            if (e.part.ok && id && hasOpenTaskCard(qc.getQueryData<AiMessagesResponse>(keys.aiMessages(id)), e.part.proposalId)) recheck = id
          } else if (e.type === 'done') {
            // The event also carries the month's figures: the chat shows no amounts, so they are left where they are.
            ended = true
            release()
            if (conversation && userMessageId) {
              const asked: AiMessage = { id: userMessageId, role: 'user', parts: [{ type: 'text', text: question }], createdAt: sentAt }
              if (sent.length > 0) asked.attachments = sent
              settle(conversation, asked, e.message)
            }
            // Ended while the popup was closed: a word, wherever the person is in the app — none for one stopped, here
            // or wherever else they stopped it.
            if (!shown.current && !handle.stopAsked && e.message.stopReason !== 'stopped') {
              if (answered(e.message)) toast('The assistant finished answering.', 'success')
              else toast('The assistant could not finish its answer.', 'warning')
            }
            break
          } else if (e.type === 'error') {
            ended = true
            release()
            break
          }
        }
        flush()
        // Ended with neither done nor error (a server that restarted, say): after `start` the answer goes on there,
        // and the conversation shows it; before, it was lost.
        if (!ended) update((t) => streamEnded(t, false))
      } catch (err) {
        flush()
        if (!ac.signal.aborted && err instanceof ApiError) {
          // A refusal before the stream began (a cap, the switch, access taken away, a conflict) kept nothing:
          // its files go back to the box, ahead of any attached since. Stopped meanwhile, it ends as stopped.
          refused = !conversation && err.status > 0
          conflict = refused && err.status === 409 && err.code === 'conflict'
          if (refused && files.length > 0) setAttachments((list) => [...files.filter((f) => !list.some((p) => p.key === f.key)), ...list])
          update((t) => (refused && handle.stopAsked ? endTurn(t, 'stopped') : endTurn(t, 'error', { code: err.code, message: err.message })))
        } else {
          // Let go of (Stop before `start`, signing out, access taken away) or cut off: only that Stop ends the turn
          // as stopped, and only before the server had the answer; otherwise it goes on there (streamEnded).
          update((t) => streamEnded(t, ac.signal.aborted && handle.stopAsked))
        }
      } finally {
        if (frame) cancelAnimationFrame(frame)
        if (handle.letGo) clearTimeout(handle.letGo)
        release()
        // The saved conversation and the history catch up with what happened.
        if (conversation) {
          void qc.invalidateQueries({ queryKey: keys.aiMessages(conversation.id) })
          // The owner's page, when it is open beside the panel: the spend, each person's month and the usage tiles.
          void qc.invalidateQueries({ queryKey: keys.aiSettings })
          void qc.invalidateQueries({ queryKey: keys.aiAccess })
          void qc.invalidateQueries({ queryKey: ['ai', 'usage'] })
        } else if (from && (!refused || conflict)) {
          // Ended before the stream began: the server may still have kept the question, and its answer (stopped, or
          // going on there), which the thread then draws from the saved conversation. Refused as still answering, the
          // conversation is fetched too: the answer it is writing (asked elsewhere) shows, with its Stop.
          void qc.invalidateQueries({ queryKey: keys.aiMessages(from) })
        }
        void qc.invalidateQueries({ queryKey: keys.aiConversations })
        // Whether the next question can be asked: this one may have reached a cap, or met access taken away.
        void qc.invalidateQueries({ queryKey: keys.aiMe })
      }
    },
    [qc, toast, askToStop, setAttachments],
  )

  const send = useCallback(
    (text: string): boolean => {
      const question = text.trim()
      const files = attached.current
      const ids = readyIds(files)
      // A file still on its way, or one that failed, holds the question until it is kept or taken off.
      if (ids === null || (!question && ids.length === 0) || reading.current) return false
      const key = newSubmissionId()
      const from = active.current
      const sentAt = new Date().toISOString()
      // What this device had of the conversation (and of the answer before): the question, once saved, comes after it.
      const cached = from ? qc.getQueryData<AiMessagesResponse>(keys.aiMessages(from))?.messages : undefined
      const handle: Reading = { key, ac: new AbortController(), conversationId: from, started: false, stopAsked: false, pausing: false, letGo: null }
      reading.current = handle
      setLive((prev) => startTurn(key, from, question, sentAt, sentAfter(prev, from, cached), files.map((f) => f.attachment!)))
      setAttachments(() => [])
      void stream(handle, from, question, sentAt, files, picked.current)
      return true
    },
    [qc, stream, setAttachments],
  )

  const busy = isInFlight(live)
  // The owner has the popup for its settings even without the assistant given to them.
  const visible = (enabled || revoked || owner) && open
  useEffect(() => {
    shown.current = visible
  }, [visible])
  const controls = useMemo<AiControls>(
    () => ({
      enabled,
      owner,
      automations,
      notices,
      revoked,
      open: visible,
      setOpen,
      toggle,
      size,
      setSize,
      phone,
      openAt,
      leaveForPage,
      popupPath,
      popupNavigate,
      conversationId,
      openConversation,
      busy,
      send,
      depth,
      setDepth,
      attachments,
      attach,
      detach,
      stop,
      stopConversation,
      draft,
      compose,
      composed,
    }),
    [enabled, owner, automations, notices, revoked, visible, setOpen, toggle, size, phone, openAt, leaveForPage, conversationId, openConversation, busy, send, depth, setDepth, attachments, attach, detach, stop, stopConversation, compose, composed],
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
