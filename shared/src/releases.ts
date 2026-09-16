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
    id: '2026-09-16.1',
    date: '2026-09-16',
    title: 'Defect rate over production',
    items: [
      { text: 'Dashboard → Defect rate is now defect pieces per 100 produced: the final quantities of the sessions closed in the period. The tile says how many pieces and sessions it stands on. A session still open has no rate until it is closed.' },
      { text: 'By machine and by item the rate is over production too. By shift, by inspector and by coil supplier it stays "of inspected", since a session\'s production cannot be split between them; the titles say so.' },
      { text: 'First-pass yield counts samples with no defect recorded. A dimension out of tolerance no longer lowers it; "Dimensions out of tolerance" keeps its own tile.' },
      { text: 'Closing a session refuses a final quantity below the defective pieces recorded in it: the defect quantities are the defective pieces of the batch.' },
      { text: 'History → Defect % is over the final quantity; "Defect % of inspected" is there under Columns.' },
    ],
  },
  {
    id: '2026-09-15.2',
    date: '2026-09-15',
    title: 'A viewer role',
    items: [
      { text: 'Users → a new role, Viewer: signs in to read the board, History and the dashboard, and changes nothing. No new inspection, no continue or close, no corrections, no deletions.' },
      { text: 'A viewer has no chat, no notices and no gear menu. The API refuses every write for the role, so the limits hold whatever the screen shows.' },
      { text: 'History → Columns: the table now carries pieces inspected, defect records, defect pieces, defect % and more; tick the ones you need and drag them wider on a desktop.' },
    ],
  },
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
