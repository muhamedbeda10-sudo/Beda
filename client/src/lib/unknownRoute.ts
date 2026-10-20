// ============================================================================
// An address this version of the app does not know. Most often it is a page a
// newer version added, opened from a link that version wrote — a bell alert,
// a push notification — on a device still running the version before it. So
// the app first asks for the newest version: when there is one, it takes over
// and the page reloads into it (main.tsx), where the address is known. Only
// when there is none is the address truly unknown, and the person goes home.
// ============================================================================

/** What a service worker registration tells after an update check, as far as this needs it. */
export interface UpdateCheck {
  update(): Promise<unknown>
  readonly installing: unknown
  readonly waiting: unknown
}

/** How long a new version may take to install and take over before the person goes home all the same. */
export const NEWER_VERSION_WAIT_MS = 15_000

/**
 * Ask for the newest version. 'newer': one is on its way (the page reloads into it when it takes over);
 * 'none': there is none, or no service worker to ask — the address is unknown.
 */
export async function lookForNewerVersion(registration: UpdateCheck | undefined | null): Promise<'newer' | 'none'> {
  if (!registration) return 'none'
  try {
    await registration.update()
  } catch {
    // Offline, or the check failed: nothing newer can be fetched now.
    return 'none'
  }
  return registration.installing || registration.waiting ? 'newer' : 'none'
}
