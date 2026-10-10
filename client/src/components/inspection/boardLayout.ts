// ============================================================================
// The board's choices that depend on the screen and on what is open: which
// factories its factory switch offers, in what order, and which of its three
// views a phone can show. Pure, so they are tested without a browser.
// ============================================================================

/** A factory and how many open sessions it holds now (after the inspector filter). */
export interface FactoryCount {
  key: string
  label: string
  count: number
}

/** The board's three views; a phone shows two of them. */
export type BoardDensity = 'cards' | 'compact' | 'table'

/**
 * The factories the switch offers beside All: those with something open, the
 * busiest first (ties by name, Factory 2 before Factory 10), and the chosen one
 * even when the inspector filter has emptied it, so the choice can be seen and
 * undone. A factory with nothing open is left out: on a tablet it pushed the
 * factories where the sessions were out of sight.
 */
export function factorySwitch(factories: readonly FactoryCount[], active: string): FactoryCount[] {
  return factories
    .filter((f) => f.count > 0 || f.key === active)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { numeric: true }))
}

/** Whether the switch is worth showing: more than one factory to choose from, or a choice already made to undo. */
export function offersFactoryChoice(offered: readonly FactoryCount[], active: string): boolean {
  return offered.length > 1 || active !== 'all'
}

/**
 * The view the board shows: the one kept on this device, except that a phone
 * has no room for the table's columns and shows the compact list instead. The
 * kept choice is not changed, so the same device turned or docked wider shows
 * the table again.
 */
export function boardViewFor(kept: BoardDensity, phone: boolean): BoardDensity {
  return phone && kept === 'table' ? 'compact' : kept
}
