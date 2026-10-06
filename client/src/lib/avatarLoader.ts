// ============================================================================
// Colleagues' small photos for the chat, fetched together: every circle asks
// for its person on its own, and the asks of one moment are gathered into one
// request (at most AVATARS_MAX_IDS people each). A person without a photo
// resolves to null, and their circle shows their initials.
// ============================================================================

import { AVATARS_MAX_IDS, type AvatarsResponse } from '@qc/shared/api'
import { api } from '@/lib/api'

type Waiter = { resolve: (v: string | null) => void; reject: (e: unknown) => void }

let waiting = new Map<string, Waiter[]>()
let scheduled = false

async function flush(): Promise<void> {
  const batch = waiting
  waiting = new Map()
  scheduled = false
  const ids = Array.from(batch.keys())
  for (let i = 0; i < ids.length; i += AVATARS_MAX_IDS) {
    const part = ids.slice(i, i + AVATARS_MAX_IDS)
    try {
      const { avatars } = await api<AvatarsResponse>(`/auth/avatars?ids=${part.map(encodeURIComponent).join(',')}`)
      for (const id of part) for (const w of batch.get(id) ?? []) w.resolve(avatars[id] ?? null)
    } catch (e) {
      for (const id of part) for (const w of batch.get(id) ?? []) w.reject(e)
    }
  }
}

/** One person's small photo, or null; asked together with every other circle drawn at the same moment. */
export function loadAvatar(userId: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    waiting.set(userId, [...(waiting.get(userId) ?? []), { resolve, reject }])
    if (!scheduled) {
      scheduled = true
      // The circles of one render all ask before this runs.
      setTimeout(() => void flush(), 0)
    }
  })
}
