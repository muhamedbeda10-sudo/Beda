// ============================================================================
// Where a link to a record leads. A session tapped anywhere it is only read
// about — a dashboard figure, a grouped view, a hold, a chat mention — opens
// History's view of it (samples, photos, notes), never the recording wizard.
// ============================================================================

/** History, opened on one session. */
export const sessionDetailPath = (sessionId: string): string =>
  `/history?session=${encodeURIComponent(sessionId)}`;
