import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderHostV1 } from 'puros-provider-sdk'
import { createTidalProgressiveRuntime } from './runtime'

describe('provider-local Tidal progressive runtime', () => {
  it('uses core-owned cache/format writes and preserves idle refresh timing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-tidal-runtime-'))
    try {
      const catalog = { updateTrackFormat: vi.fn(async () => {}) }
      const cache = {
        put: vi.fn(async () => {}),
        trim: vi.fn(async () => {}),
        // The finished file supplies the average bitrate the growing file could not.
        inspectFormat: vi.fn(async () => ({ format: 'FLAC_HIRES', sampleRate: 96_000, bitDepth: 24, bitrate: 2_345, channels: 2, isLossless: true, isHiRes: true, isMqa: false, isDsd: false })),
      }
      const events = {
        emit: vi.fn(async () => {}),
        scheduleLibraryCatalogRefreshWhenIdle: vi.fn(async () => {}),
      }
      const host = {
        paths: { getCacheRoot: vi.fn(async () => root) },
        helpers: {},
        catalog,
        cache,
        events,
      } as unknown as ProviderHostV1
      const manager = await createTidalProgressiveRuntime(host, 'MAX', vi.fn(async () => new Response(Buffer.from('fLaC-data'))))
      const created = manager.createSession({
        trackId: 'requested',
        resolvedTrackId: 'resolved',
        resolvedQuality: 'HI_RES',
        codec: 'FLAC',
        fileExtension: '.flac',
        sampleRate: 96_000,
        bitDepth: 24,
        urls: ['https://cdn.example.test/segment'],
        encrypted: false,
      })
      await manager.startSession(created.sessionId)
      await vi.waitFor(() => expect(events.scheduleLibraryCatalogRefreshWhenIdle).toHaveBeenCalledOnce())
      const finalPath = path.join(root, 'resolved-hi_res-96000-24.flac')
      expect(fs.existsSync(finalPath)).toBe(true)
      const format = {
        format: 'FLAC_HIRES', sampleRate: 96_000, bitDepth: 24, bitrate: 2_345,
        channels: 2, isLossless: true, isHiRes: true, isMqa: false, isDsd: false,
      }
      expect(catalog.updateTrackFormat.mock.calls).toEqual([
        [{ sourceId: 'requested', format }],
        [{ sourceId: 'resolved', format }],
      ])
      expect(cache.put).toHaveBeenCalledWith({
        sourceId: 'requested', qualityKey: 'MAX', path: finalPath, format,
        resolvedSourceId: 'resolved', resolvedQuality: 'HI_RES',
      })
      expect(cache.trim).toHaveBeenCalledOnce()
      expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'playback.progress' }))
      expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'playback.session' }))
      expect(events.emit).toHaveBeenCalledWith({
        type: 'playback.session',
        session: expect.objectContaining({ state: 'completed', artifactPath: finalPath, format }),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
