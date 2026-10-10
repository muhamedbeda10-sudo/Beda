// ============================================================================
// Where a link to a record leads. A session tapped anywhere it is only read
// about — a dashboard figure, a grouped view, a hold, a chat mention — opens
// History's view of it (samples, photos, notes), never the recording wizard.
// ============================================================================

/** History, opened on one session. */
export const sessionDetailPath = (sessionId: string): string =>
  `/history?session=${encodeURIComponent(sessionId)}`;

/** §21 — History, opened on one sample of a session (the sample's full record over the session's list). */
export const sampleDetailPath = (sessionId: string, sampleId: string): string =>
  `/history?session=${encodeURIComponent(sessionId)}&sample=${encodeURIComponent(sampleId)}`;

/** §21 — History searched for one order number: every session of the order. */
export const orderHistoryPath = (orderNumber: string): string =>
  `/history?q=${encodeURIComponent(orderNumber)}`;

/** A stand-in origin for resolving paths: whatever leaves it was never a path of this app. */
const APP_ORIGIN = 'https://app.invalid';

/**
 * §21 — a link the server handed over (an alert's, an automated chat
 * message's) as a page of this app to open in place, or null when it is not
 * one. Only a plain path is followed: no other site (`//host`, a dot segment
 * that resolves to one), no scheme, no control character or backslash —
 * browsers read "\" as "/". The path comes back as resolved, with its query
 * and fragment.
 */
export function appPath(link: string | null | undefined): string | null {
  if (!link) return null;
  const raw = link.trim();
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, APP_ORIGIN);
  } catch {
    return null;
  }
  const to = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === APP_ORIGIN && !to.startsWith('//') ? to : null;
}
