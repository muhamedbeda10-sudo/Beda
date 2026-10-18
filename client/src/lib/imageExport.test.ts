import { describe, expect, it } from 'vitest'
import { photoFileName } from './imageExport'

describe('a photo saved on the device', () => {
  it('keeps the name it is known by, with the extension of what it is', () => {
    expect(photoFileName('IMG_2031.JPG', 'image/jpeg')).toBe('IMG_2031.jpg')
    expect(photoFileName('scan.png', 'image/png')).toBe('scan.png')
    // A photo stored as JPEG under a .png name is saved as what it is.
    expect(photoFileName('weld.png', 'image/jpeg')).toBe('weld.jpg')
    expect(photoFileName('Defect - sample 3 - Burr', 'image/webp')).toBe('Defect - sample 3 - Burr.webp')
  })

  it('takes out what a file name cannot hold, and has a name when it is given none', () => {
    expect(photoFileName('Order 20332/Ph2: weld?', 'image/jpeg')).toBe('Order 20332 Ph2 weld.jpg')
    expect(photoFileName('عيب لحام', 'image/jpeg')).toBe('عيب لحام.jpg')
    expect(photoFileName('   ', 'image/jpeg')).toBe('Photo.jpg')
    // An unknown type is saved as a JPEG, what the app stores photos as.
    expect(photoFileName('x', '')).toBe('x.jpg')
  })
})
