import { describe, expect, it, vi } from 'vitest'
import type { TidalApiService } from './TidalApiService'
import { TidalPlaybackService } from './TidalPlaybackService'

describe('Tidal provider playback service', () => {
  it('passes recovery, progress, and format requests to the provider API', async () => {
    const getPlaybackInfo = vi.fn(async () => ({ playbackPath: '/cache/track.flac', quality: { codec: 'FLAC' } }))
    const getTrackFormats = vi.fn(async () => ({ '42': { quality: { codec: 'FLAC' } } }))
    const service = new TidalPlaybackService({
      api: { getPlaybackInfo, getTrackFormats } as unknown as TidalApiService,
      preferredQuality: 'MAX',
    })
    const onProgress = vi.fn()
    const options = { allowRecovery: true, outputDir: '/cache' }

    expect(await service.getStreamUrl('42')).toBe('/cache/track.flac')
    expect(await service.getPlaybackInfo('42', onProgress, options)).toEqual({
      playbackPath: '/cache/track.flac', quality: { codec: 'FLAC' },
    })
    expect(getPlaybackInfo).toHaveBeenLastCalledWith('42', onProgress, options)
    expect(await service.getTrackFormats(['42'])).toEqual({ '42': { quality: { codec: 'FLAC' } } })
    expect(getTrackFormats).toHaveBeenCalledWith(['42'])
  })

  it('rejects a missing playback path as the legacy service does', async () => {
    const service = new TidalPlaybackService({
      api: { getPlaybackInfo: vi.fn(async () => ({ playbackPath: '' })) } as unknown as TidalApiService,
      preferredQuality: 'MAX',
    })
    await expect(service.getStreamUrl('42')).rejects.toThrow('No Tidal stream URL returned for this track')
  })
})
