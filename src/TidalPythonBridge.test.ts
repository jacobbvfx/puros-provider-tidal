import { describe, expect, it, vi } from 'vitest'
import type { TidalConfig, TidalStoredSession } from './types'
import { TidalPythonBridge, type TidalHelperRunner } from './TidalPythonBridge'

const config = { preferredAudioQuality: 'MAX' } as TidalConfig
const session = {
  accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: 123,
  tokenType: 'Bearer', scopes: ['r_usr'], countryCode: 'US',
} satisfies TidalStoredSession

describe('Tidal host-only helper bridge', () => {
  it('keeps download and progressive-manifest command payloads compatible', async () => {
    const run = vi.fn(async (
      _command: string,
      _payload: Record<string, unknown>,
      onEvent?: (event: { event: string; [key: string]: unknown }) => Promise<void> | void,
    ) => {
      await onEvent?.({ event: 'buffer_progress', trackId: '42', progress: 1.4 })
      return { ok: true }
    })
    const bridge = new TidalPythonBridge(config, { run } as unknown as TidalHelperRunner, vi.fn(async () => '/granted/cache/track.flac'))
    const onProgress = vi.fn()
    await bridge.getPlaybackInfo(session, '42', onProgress, {
      allowRecovery: false,
      outputDir: '/granted/cache',
    })
    expect(run).toHaveBeenCalledWith('playback-info', {
      session,
      trackId: '42',
      allowRecovery: false,
      preferredQuality: 'MAX',
      outputDir: '/granted/cache',
      hostRemux: true,
    }, expect.any(Function))
    expect(onProgress).toHaveBeenCalledWith(1)

    await bridge.getStreamManifest(session, '42')
    expect(run).toHaveBeenLastCalledWith('stream_manifest', {
      cmd: 'stream_manifest',
      session,
      trackId: '42',
      quality: 'MAX',
      allowRecovery: false,
    })
  })

  it('remuxes only helper-requested FLAC containers and retains the old fallback on failure', async () => {
    const info = { playbackPath: '/granted/cache/track.m4a', quality: { format: 'FLAC' }, hostRemux: true }
    const run = vi.fn(async () => ({ ok: true, result: info }))
    const remux = vi.fn(async () => '/granted/cache/track.flac')
    const bridge = new TidalPythonBridge(config, { run } as unknown as TidalHelperRunner, remux)
    expect((await bridge.getPlaybackInfo(session, '42')).result?.playbackPath).toBe('/granted/cache/track.flac')
    expect(remux).toHaveBeenCalledWith(info.playbackPath)
    remux.mockRejectedValueOnce(new Error('ffmpeg failed'))
    expect((await bridge.getPlaybackInfo(session, '42')).result?.playbackPath).toBe(info.playbackPath)
  })
})
