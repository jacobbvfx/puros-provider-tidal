import { describe, expect, it, vi } from 'vitest'
import type { ProviderHostV1 } from 'puros-provider-sdk'
import type { TidalPlaybackInfo } from './types'
import { TidalPlaybackCoordinator } from './playbackCoordinator'
import type { TidalPlaybackService } from './TidalPlaybackService'

const requestedFormat = {
  format: 'FLAC' as const, sampleRate: 44_100, bitDepth: 16, bitrate: 0,
  channels: 2, isLossless: true, isHiRes: false, isMqa: false, isDsd: false,
}
const inspectedFormat = {
  ...requestedFormat, format: 'FLAC_HIRES' as const, sampleRate: 96_000,
  bitDepth: 24, isHiRes: true,
}

function fixture() {
  const cache = {
    get: vi.fn(async (_request: { sourceId: string; qualityKey: string }) => null as null | {
      path: string; format: typeof requestedFormat; resolvedSourceId: string; resolvedQuality?: string
    }),
    inspectFormat: vi.fn(async () => inspectedFormat),
    put: vi.fn(async () => {}),
    trim: vi.fn(async () => {}),
  }
  const catalog = { updateTrackFormat: vi.fn(async () => {}) }
  const events = {
    emit: vi.fn(async () => {}),
    scheduleLibraryCatalogRefreshWhenIdle: vi.fn(async () => {}),
  }
  const host = {
    paths: { getCacheRoot: vi.fn(async () => '/provider/cache') },
    cache, catalog, events,
  } as unknown as ProviderHostV1
  const playback = {
    getPlaybackInfo: vi.fn(async (sourceId: string): Promise<TidalPlaybackInfo> => ({
      playbackPath: `/provider/cache/${sourceId}.flac`,
      quality: requestedFormat,
      resolvedTrackId: sourceId,
    })),
  } as unknown as TidalPlaybackService
  return { host, cache, catalog, events, playback }
}

describe('provider-local Tidal playback coordinator', () => {
  it('checks every candidate cache before requesting remote playback', async () => {
    const { host, cache, playback } = fixture()
    cache.get.mockImplementation(async ({ sourceId }) => sourceId === 'fallback'
      ? { path: '/provider/cache/fallback.flac', format: requestedFormat, resolvedSourceId: 'fallback' }
      : null)
    const coordinator = await TidalPlaybackCoordinator.create(host, playback, 'MAX')
    expect(await coordinator.resolve(['missing', 'fallback'])).toMatchObject({
      playbackPath: '/provider/cache/fallback.flac', cacheHit: true,
    })
    expect(cache.get.mock.calls.map(([request]) => request.sourceId)).toEqual(['missing', 'fallback'])
    expect(playback.getPlaybackInfo).not.toHaveBeenCalled()
  })

  it('falls back, persists the inspected file format, and registers the completed cache entry', async () => {
    const { host, cache, catalog, events, playback } = fixture()
    vi.mocked(playback.getPlaybackInfo).mockImplementation(async (sourceId) => {
      if (sourceId === 'stale') throw new Error('Track unavailable')
      return {
        playbackPath: '/provider/cache/resolved.flac', quality: requestedFormat,
        resolvedTrackId: 'resolved', resolvedQuality: 'HI_RES',
      }
    })
    const coordinator = await TidalPlaybackCoordinator.create(host, playback, 'MAX')
    const result = await coordinator.resolve(['stale', 'requested'])
    expect(result.quality).toEqual(inspectedFormat)
    expect(playback.getPlaybackInfo).toHaveBeenNthCalledWith(2, 'requested', undefined, {
      allowRecovery: true, outputDir: '/provider/cache',
    })
    expect(cache.inspectFormat).toHaveBeenCalledExactlyOnceWith('/provider/cache/resolved.flac')
    expect(catalog.updateTrackFormat.mock.calls).toEqual([
      [{ sourceId: 'requested', format: inspectedFormat }],
      [{ sourceId: 'resolved', format: inspectedFormat }],
    ])
    expect(events.scheduleLibraryCatalogRefreshWhenIdle).toHaveBeenCalledOnce()
    expect(cache.put).toHaveBeenCalledExactlyOnceWith({
      sourceId: 'requested', qualityKey: 'MAX', path: '/provider/cache/resolved.flac',
      format: inspectedFormat, resolvedSourceId: 'resolved', resolvedQuality: 'HI_RES',
    })
    expect(cache.trim).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent downloads and limits prefetch to the first candidate', async () => {
    const { host, playback } = fixture()
    const coordinator = await TidalPlaybackCoordinator.create(host, playback, 'MAX')
    const [first, second] = await Promise.all([
      coordinator.resolve(['requested']), coordinator.resolve(['requested']),
    ])
    expect(first).toEqual(second)
    expect(playback.getPlaybackInfo).toHaveBeenCalledOnce()
    await coordinator.prefetch(['next', 'other'])
    expect(playback.getPlaybackInfo).toHaveBeenLastCalledWith('next', undefined, {
      allowRecovery: false, outputDir: '/provider/cache',
    })
  })

  it('emits a scoped warning after an unrecoverable playback failure', async () => {
    const { host, events, playback } = fixture()
    vi.mocked(playback.getPlaybackInfo).mockRejectedValue(new Error('Unauthorized (401)'))
    const coordinator = await TidalPlaybackCoordinator.create(host, playback, 'MAX')
    await expect(coordinator.resolve(['requested'])).rejects.toThrow('Unauthorized')
    expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning', code: 'auth_expired', retryable: false,
    }))
  })
})
