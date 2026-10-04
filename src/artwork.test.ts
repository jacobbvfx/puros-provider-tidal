import { describe, expect, it } from 'vitest'
import { getDisplayArtworkUrl } from './artwork'

describe('Tidal display artwork URL', () => {
  it('preserves the existing 1280-pixel rewrite for saved CDN URLs', () => {
    expect(getDisplayArtworkUrl('https://resources.tidal.com/images/a/b/c/640x640.jpg'))
      .toBe('https://resources.tidal.com/images/a/b/c/1280x1280.jpg')
    expect(getDisplayArtworkUrl('https://resources.tidal.com/images/a/b/c/320x320.png?token=x'))
      .toBe('https://resources.tidal.com/images/a/b/c/1280x1280.png?token=x')
  })

  it('does not rewrite another host or a non-HTTP URL', () => {
    expect(getDisplayArtworkUrl('https://other.example/images/a/640x640.jpg')).toBeNull()
    expect(getDisplayArtworkUrl('file:///images/a/640x640.jpg')).toBeNull()
  })
})
