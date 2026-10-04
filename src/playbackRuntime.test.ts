import { describe, expect, it, vi } from 'vitest'
import type { TidalApiService } from './TidalApiService'
import type { TidalPlaybackInfo } from './types'
import type { TidalProgressiveStreamingManager } from './progressive/manager'
import { TidalPlaybackCoordinator } from './playbackCoordinator'
import { TidalPlaybackRuntime } from './playbackRuntime'

const quality = {
  format: 'FLAC' as const, sampleRate: 44_100, bitDepth: 16, bitrate: 0,
  channels: 2, isLossless: true, isHiRes: false, isMqa: false, isDsd: false,
}
const downloaded: TidalPlaybackInfo = { playbackPath: '/cache/requested.flac', quality }
const manifest = {
  trackId: 'requested', resolvedTrackId: 'requested', resolvedQuality: 'HI_RES',
  codec: 'FLAC', fileExtension: '.flac', sampleRate: 96_000, bitDepth: 24,
  urls: ['https://cdn.example.test/segment'], encrypted: false,
}

function fixture() {
  const api = { getStreamManifest: vi.fn(async () => manifest) } as unknown as TidalApiService
  const coordinator = {
    getCached: vi.fn(async () => null as TidalPlaybackInfo | null),
    resolve: vi.fn(async () => downloaded),
    prefetch: vi.fn(async () => downloaded),
    clearTasks: vi.fn(),
  } as unknown as TidalPlaybackCoordinator
  const progressive = {
    createSession: vi.fn(() => ({ sessionId: 'session-1' })),
    startSession: vi.fn(async () => ({
      playbackPath: '/cache/.streaming/partial.flac',
      session: { sessionId: 'session-1', state: 'running' },
    })),
    markPlaybackStarted: vi.fn(), cancelSession: vi.fn(async () => {}),
    cancelAll: vi.fn(async () => {}), shutdown: vi.fn(),
  } as unknown as TidalProgressiveStreamingManager
  return { api, coordinator, progressive, runtime: new TidalPlaybackRuntime(api, coordinator, progressive) }
}

describe('provider-owned Tidal D5 playback boundary', () => {
  it('returns a complete host-cache artifact without a manifest call', async () => {
    const { api, coordinator, runtime } = fixture()
    vi.mocked(coordinator.getCached).mockResolvedValue(downloaded)
    expect(await runtime.resolve({ sourceId: 'requested', intent: 'playback' })).toEqual({
      path: '/cache/requested.flac', lifecycle: 'complete', format: quality,
    })
    expect(api.getStreamManifest).not.toHaveBeenCalled()
  })

  it('returns a growing progressive artifact with its session handle', async () => {
    const { coordinator, progressive, runtime } = fixture()
    expect(await runtime.resolve({ sourceId: 'requested', intent: 'playback' })).toEqual({
      path: '/cache/.streaming/partial.flac', lifecycle: 'growing', sessionId: 'session-1',
      format: {
        ...quality, format: 'FLAC_HIRES', sampleRate: 96_000, bitDepth: 24, isHiRes: true,
      },
    })
    expect(progressive.createSession).toHaveBeenCalledWith(manifest)
    expect(coordinator.resolve).not.toHaveBeenCalled()
    runtime.markPlaybackStarted('session-1')
    await runtime.cancel('session-1')
    expect(progressive.markPlaybackStarted).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(progressive.cancelSession).toHaveBeenCalledExactlyOnceWith('session-1')
  })

  it('downloads encrypted streams and prefetches the exact requested track without alternatives', async () => {
    const { api, coordinator, runtime } = fixture()
    vi.mocked(api.getStreamManifest).mockResolvedValue({ ...manifest, encrypted: true })
    expect(await runtime.resolve({
      sourceId: 'requested', fallbackSourceIds: ['fallback'], intent: 'playback',
    })).toEqual({ path: '/cache/requested.flac', lifecycle: 'complete', format: quality })
    expect(coordinator.resolve).toHaveBeenCalledExactlyOnceWith(['requested'], {
      allowRecovery: false, emitWarning: true,
    })
    await runtime.prefetch({ sourceId: 'next', fallbackSourceIds: ['other'] })
    expect(coordinator.prefetch).toHaveBeenCalledExactlyOnceWith(['next'])
  })

  it('rejects a matched replacement returned by the manifest or completed download', async () => {
    const { api, coordinator, progressive, runtime } = fixture()
    vi.mocked(api.getStreamManifest).mockResolvedValue({ ...manifest, resolvedTrackId: 'replacement' })
    await expect(runtime.resolve({ sourceId: 'requested', intent: 'playback' })).rejects.toThrow('different source track')
    expect(progressive.createSession).not.toHaveBeenCalled()
    vi.mocked(api.getStreamManifest).mockResolvedValue({ ...manifest, encrypted: true })
    vi.mocked(coordinator.resolve).mockResolvedValue({ ...downloaded, resolvedTrackId: 'replacement' })
    await expect(runtime.resolve({ sourceId: 'requested', intent: 'playback' })).rejects.toThrow('different source track')
  })

  it('cancels provider sessions on logout and clears tasks on shutdown', async () => {
    const { coordinator, progressive, runtime } = fixture()
    await runtime.logout()
    runtime.shutdown()
    expect(progressive.cancelAll).toHaveBeenCalledOnce()
    expect(progressive.shutdown).toHaveBeenCalledOnce()
    expect(coordinator.clearTasks).toHaveBeenCalledOnce()
  })
})
