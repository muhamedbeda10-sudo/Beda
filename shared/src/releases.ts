// ============================================================================
// §18 — What's new. The release notes ship with the code: every change that
// reaches the floor adds an entry here, newest first, so the note and the
// build are the same deploy. An administrator sees the entries newer than
// the last one they dismissed, once, when the application opens.
// ============================================================================

export interface ReleaseItem {
  /** One change, in plain words: what it does and where it is. */
  text: string
}

export interface Release {
  /** Sorts as text: the day, then a counter for a second release on the same day. */
  id: string
  /** ISO date of the deploy. */
  date: string
  title: string
  items: ReleaseItem[]
}

/**
 * Nothing before this id is ever shown as new: the feature starts with the
 * release after the one that introduced it.
 */
export const RELEASE_NOTES_BASELINE = '2026-09-15.1'

/** Newest first. Add a new entry at the top with a fresh id. */
export const RELEASES: readonly Release[] = [
  {
    id: '2026-09-15.1',
    date: '2026-09-15',
    title: "What's new, in the application",
    items: [
      { text: 'Administrators see a note like this one the first time they open the application after an update. It lists what changed and where to find it.' },
      { text: "Earlier notes stay under the gear menu → What's new." },
    ],
  },
]

const byIdDesc = (a: Release, b: Release) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** The entries newer than what this person has dismissed (or than the baseline), newest first. */
export function unseenReleases(lastSeenId: string | null | undefined, releases: readonly Release[] = RELEASES): Release[] {
  const floor = lastSeenId && lastSeenId > RELEASE_NOTES_BASELINE ? lastSeenId : RELEASE_NOTES_BASELINE
  return releases.filter((r) => r.id > floor).sort(byIdDesc)
}

export function latestReleaseId(releases: readonly Release[] = RELEASES): string | null {
  return releases.length ? [...releases].sort(byIdDesc)[0].id : null
}

export function isReleaseId(id: string, releases: readonly Release[] = RELEASES): boolean {
  return releases.some((r) => r.id === id)
}
