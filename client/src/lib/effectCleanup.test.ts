import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// An effect written `useEffect(() => something(), …)` hands React whatever
// something() answers as its cleanup, and React calls it when the effect ends.
// That is only safe for a call that answers nothing, or for a cleanup itself.
// A browser's scroll methods now answer a promise in Chrome: React called it
// and the page fell over ("n is not a function", the Report styles page,
// 2026-10-18). So an effect's arrow either has braces, or its expression is a
// state setter's call, or it names the cleanup function itself.

const SRC = join(__dirname, '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/** What an expression-bodied effect may be: a setter's call (set…(…)), a call known to answer nothing, or a cleanup named. */
const ALLOWED = /^(set[A-Z]\w*\(|recheckAccessOn404\(|stop$)/

describe('effects', () => {
  it('never hand React a value it would call as their cleanup', () => {
    const offending: string[] = []
    for (const file of files(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = /use(?:Layout)?Effect\(\(\) => ([^{(\s][^,]*)/.exec(line)
          if (m && !ALLOWED.test(m[1].trim())) offending.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offending).toEqual([])
  })
})
