// `npm run ai:pin-owner -w server -- <username>` — pin the AI assistant's
// owner (§20, ai/owner.ts): the live, active account of that username (any
// case; AI_OWNER_USERNAME when none is given). For whoever runs the server:
// the app itself never pins anyone on a request. Once pinned, the owner never
// moves; asking again names who it is. Exits 1 when nothing could be pinned.
import { loadConfig } from '../config'
import { createPool } from './pool'
import { pinAiOwner, pinnedAiOwner } from '../ai/owner'

const config = loadConfig()
const username = (process.argv[2] ?? config.AI_OWNER_USERNAME).trim()
const db = createPool(config.DATABASE_URL, 2)
try {
  const before = await pinnedAiOwner(db)
  if (before) {
    console.log(`The assistant's owner is already pinned: ${before.username}${before.live ? '' : ' (deactivated or removed)'}. The pin never moves.`)
    process.exitCode = before.username.toLowerCase() === username.toLowerCase() ? 0 : 1
  } else if (await pinAiOwner(db, config, username)) {
    console.log(`The assistant's owner is now ${username}.`)
  } else {
    console.error(`No active account "${username}" to pin. Create it (or name an existing one) and run this again.`)
    process.exitCode = 1
  }
} finally {
  await db.end()
}
