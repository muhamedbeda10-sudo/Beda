// ============================================================================
// An item is its code AND its name. The ERP gives two items of one order the
// same code with a different ending ("Locker Slopping Top Front : 300 : 450 :
// N2" and "… : N3"), so a pick from an item list, which reads "code — name",
// must land on that one item, never on every item that shares the code.
// ============================================================================

/** What separates the code from the name in a list's "code — name" option. */
export const ITEM_PICK_SEPARATOR = ' — '

/**
 * The SQL test for an item filter. A pick from the list ("code — name")
 * matches that exact item; anything else typed is any part of the code or
 * the name. `p` binds a parameter and returns its placeholder.
 */
export function itemFilterSql(term: string, p: (v: unknown) => string, codeColumn: string, nameColumn: string): string {
  const at = term.indexOf(ITEM_PICK_SEPARATOR)
  if (at > 0) {
    const code = term.slice(0, at).trim()
    const name = term.slice(at + ITEM_PICK_SEPARATOR.length).trim()
    if (code !== '' && name !== '') {
      return `(lower(btrim(${codeColumn})) = lower(${p(code)}) AND lower(btrim(${nameColumn})) = lower(${p(name)}))`
    }
  }
  const t = p(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  return `(${codeColumn} ILIKE ${t} OR ${nameColumn} ILIKE ${t})`
}
