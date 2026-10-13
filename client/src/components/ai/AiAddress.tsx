// ============================================================================
// §20 — an address of the assistant opened in the app (/ai, /ai?c=<conversation>,
// /ai/reports/<id>: a link from a message, a bookmark, a link copied before the
// assistant became a popup). There is no page there any more: it opens the
// popup's large window on the same place, over the page the person was on —
// or the home page, when the address was the first thing opened.
// ============================================================================

import { useEffect, useRef } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAi } from './AiAssistantProvider'

export function AiAddress() {
  const { openAt } = useAi()
  const location = useLocation()
  const place = `${location.pathname}${location.search}`
  // Opening twice (StrictMode) opens the same place: harmless.
  useEffect(() => {
    openAt(place, 'large')
  }, [openAt, place])
  // Back to where the person was, or home when the address was the first page opened.
  return location.key === 'default' ? <Navigate to="/" replace /> : <GoBack />
}

/** One step back, once (StrictMode runs an effect twice; the ref keeps the second from going back further). */
function GoBack() {
  const navigate = useNavigate()
  const gone = useRef(false)
  useEffect(() => {
    if (gone.current) return
    gone.current = true
    navigate(-1)
  }, [navigate])
  return null
}
