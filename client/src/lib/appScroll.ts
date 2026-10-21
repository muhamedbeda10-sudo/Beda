// ============================================================================
// The app's one scrolling box. The window never scrolls: the shell fills it
// (AppShell), the header stays, and <main> — marked with APP_SCROLL_ATTR —
// scrolls only when a page is taller than the room under the header. A page
// built to fill the window (a list in its GridFrame, Planning, the chat)
// never makes it scroll: what is long scrolls inside its own frame.
//
// Whatever used to read or set the document's scrolling (a frame measuring
// the room it has, a sticky rail checking whether it is stuck, the scroll
// padding a focused field keeps clear of the bars) goes through here.
// ============================================================================

export const APP_SCROLL_ATTR = 'data-app-scroll'

/** The box the page scrolls in: the shell's <main>, or the document where there is no shell (a test, the login). */
export function appScroller(): HTMLElement {
  return document.querySelector<HTMLElement>(`[${APP_SCROLL_ATTR}]`) ?? document.documentElement
}

/** Whether `el` lies in a scroller of the app's, and which. */
export function scrollerOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(`[${APP_SCROLL_ATTR}]`)
}
