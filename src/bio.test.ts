import { describe, expect, it } from 'vitest'
import { normalizeTidalBio } from './bio'

describe('TIDAL bio normalization', () => {
  it('turns wimpLink references into provider links and <br/> into paragraphs', () => {
    expect(normalizeTidalBio(
      '[wimpLink artistId="15349"]Deftones[/wimpLink] issued [wimpLink albumId="392528"]White Pony[/wimpLink].<br/>The group formed in 1988.',
    )).toBe('[Deftones](puros:artist/15349) issued [White Pony](puros:album/392528).\n\nThe group formed in 1988.')
  })

  it('keeps the text of unknown or broken tags and drops other markup', () => {
    expect(normalizeTidalBio('[wimpLink videoId="1"]Clip[/wimpLink] and <i>more</i> [wimpLink artistId="2"]x'))
      .toBe('Clip and more x')
  })

  it('returns null for empty bios', () => {
    expect(normalizeTidalBio('  ')).toBeNull()
    expect(normalizeTidalBio(null)).toBeNull()
  })
})
