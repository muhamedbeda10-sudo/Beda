// ============================================================================
// The assistant's refusals, said the same way wherever a call to Claude can
// be refused: not given the assistant, the assistant not able to answer now,
// a cap reached or a call that could pass one. No amounts for anyone; the
// owner is also told where to put it right.
// ============================================================================

import { HttpError } from '../lib/errors'
import type { PersonAvailability } from './access'

/** Where the owner fixes what stops the assistant. */
export const SETTINGS_PAGE = 'Administration → AI assistant'

/** What someone the owner has not given the assistant (or has stopped) gets from its routes. */
export const notGranted = () => new HttpError(403, 'forbidden', 'You do not have access to the assistant.')

const LIMIT = {
  app: "The assistant's monthly limit is reached. It is available again on the 1st.",
  personal: "You have reached this month's limit for the assistant. It is available again on the 1st.",
}

/**
 * The refusal for a question the person cannot ask now, by why. No amounts
 * for anyone; the owner is also told where to put it right, and precisely
 * what stops the assistant, which is nobody else's to know.
 */
export function unavailable(p: PersonAvailability): HttpError {
  const owner = p.me.owner
  switch (p.me.reason) {
    case 'cap-reached':
      return new HttpError(402, 'ai_budget_reached', owner ? `${LIMIT.app} You can raise it under ${SETTINGS_PAGE}.` : LIMIT.app)
    case 'personal-cap':
      return new HttpError(402, 'ai_budget_reached', owner ? `${LIMIT.personal} You can raise your own limit under ${SETTINGS_PAGE}.` : LIMIT.personal)
    case 'not-granted':
      return notGranted()
  }
  if (!owner) return new HttpError(503, 'ai_unavailable', 'The assistant is not available right now. Try again later.')
  switch (p.app.status.reason) {
    case 'disabled':
      return new HttpError(503, 'ai_unavailable', `The AI assistant is switched off. Switch it on under ${SETTINGS_PAGE}.`)
    case 'no-key':
      return new HttpError(503, 'ai_unavailable', `The AI assistant has no API key. Set it under ${SETTINGS_PAGE}.`)
    default:
      return new HttpError(503, 'ai_unavailable', 'The AI assistant cannot reach its data right now. Try again later.')
  }
}

/** The refusal for a call whose worst case could pass a cap: which one, without its amount. */
export function tooClose(which: 'app' | 'personal', what: string, owner: boolean, hint = ''): HttpError {
  const limit = which === 'app' ? "the assistant's monthly limit" : 'your monthly limit for the assistant'
  const raise = owner ? ` You can raise ${which === 'app' ? 'it' : 'your own limit'} under ${SETTINGS_PAGE}.` : ''
  return new HttpError(402, 'ai_budget_reached', `${what} could pass ${limit}, so it was not started.${hint}${raise}`)
}
