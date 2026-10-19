import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ImageAsset } from '@qc/shared/types'
import { AppProvider } from '@/store/AppContext'
import { keys } from '@/services/queries'
import { ImagePicker } from './ImagePicker'

// The picker drawn to a string, with its photo already fetched.
beforeAll(() => {
  const stored = new Map<string, string>([['qc-system-theme', 'light']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
})
afterAll(() => vi.unstubAllGlobals())

const photo = { id: 'img-1', originalFilename: 'crack.jpg', thumbnailDataUrl: 'data:image/jpeg;base64,AA==', byteSize: 1024, sha256: 'ab'.repeat(32) } as ImageAsset

function html(lockedReason?: string): string {
  const qc = new QueryClient()
  qc.setQueryData(keys.images('img-1'), [photo])
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AppProvider>
        <ImagePicker imageIds={['img-1']} onChange={() => undefined} lockedReason={lockedReason} />
      </AppProvider>
    </QueryClientProvider>,
  )
}

describe('photos while the record is being saved', () => {
  it('can be added and removed as usual otherwise', () => {
    const open = html()
    expect(open).toMatch(/<button type="button" class="[^"]*" aria-label="Take a photo">/)
    expect(open).toMatch(/<button type="button" class="[^"]*" aria-label="Upload from gallery">/)
    expect(open).toContain('aria-label="Remove crack.jpg"')
  })

  it('can be neither added nor removed, and the picker says why, so no photo is silently left off the sample', () => {
    const saving = html('The sample is being saved: photos can be added again if the save does not go through.')
    expect(saving).toMatch(/<button type="button" disabled="" class="[^"]*" aria-label="Take a photo">/)
    expect(saving).toMatch(/<button type="button" disabled="" class="[^"]*" aria-label="Upload from gallery">/)
    expect(saving).not.toContain('aria-label="Remove crack.jpg"')
    expect(saving).toContain('The sample is being saved: photos can be added again if the save does not go through.')
    // The photo already on it stays in view.
    expect(saving).toContain('alt="crack.jpg"')
  })
})
