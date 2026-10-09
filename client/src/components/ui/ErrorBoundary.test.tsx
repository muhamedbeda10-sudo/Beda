import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary, LoadFailed } from './ErrorBoundary'

describe('a part of the app that failed to draw', () => {
  it('draws its children until one throws, then the fallback in their place', () => {
    // Rendered on a server React never catches, so the boundary is driven as React drives it.
    const boundary = new ErrorBoundary({ fallback: 'fallback', children: 'children' })
    expect(boundary.render()).toBe('children')
    boundary.state = ErrorBoundary.getDerivedStateFromError()
    expect(boundary.render()).toBe('fallback')
  })

  it('says what could not be loaded, with Reload and the caller’s own way out', () => {
    const html = renderToStaticMarkup(<LoadFailed what="The assistant" action={<button type="button">Close</button>} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('The assistant could not be loaded.')
    expect(html).toContain('Reload')
    expect(html).toContain('<button type="button">Close</button>')
  })
})
