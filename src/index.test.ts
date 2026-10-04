import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderHostV1 } from 'puros-provider-sdk'
import { getTidalConfig } from './config'
import plugin from './index'

describe('active Tidal plugin composition', () => {
  it('provides listening links for older imported tracks without contacting the API', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-tidal-link-'))
    try {
      const getStoredTrack = vi.fn(async (sourceId: string) => ({
        sourceId, title: 'Without a Whisper', durationMs: 258_000,
        providerUrl: sourceId === 'existing' ? 'https://tidal.com/track/existing' : null,
      }))
      const host = {
        paths: { getCacheRoot: vi.fn(async () => root) },
        catalog: { getStoredTrack },
        logger: { info: vi.fn(async () => {}) },
      } as unknown as ProviderHostV1
      const runtime = await plugin.activate(host)
      expect(await runtime.capabilities['catalog.entities']!.getTrack('379605138')).toMatchObject({
        sourceId: '379605138', providerUrl: 'https://tidal.com/browse/track/379605138',
      })
      expect(await runtime.capabilities['catalog.entities']!.getTrack('existing')).toMatchObject({
        providerUrl: 'https://tidal.com/track/existing',
      })
      await runtime.deactivate()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads its session and completed playback only through the provider host', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-tidal-plugin-'))
    const filePath = path.join(root, 'cached.flac')
    fs.writeFileSync(filePath, 'fixture')
    try {
      const format = {
        format: 'FLAC' as const, sampleRate: 44_100, bitDepth: 16, bitrate: 0,
        channels: 2, isLossless: true, isHiRes: false, isMqa: false, isDsd: false,
      }
      const session = {
        accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: 123,
        tokenType: 'Bearer', scopes: ['r_usr'], countryCode: 'US',
      }
      const secrets = { get: vi.fn(async () => JSON.stringify(session)) }
      const cache = { get: vi.fn(async () => ({
        path: filePath, format, resolvedSourceId: 'track-1',
      })) }
      const host = {
        paths: { getCacheRoot: vi.fn(async () => root) },
        secrets, cache,
        logger: { info: vi.fn(async () => {}) },
      } as unknown as ProviderHostV1
      const runtime = await plugin.activate(host)
      expect(await runtime.getStatus()).toMatchObject({ state: 'ready', authenticated: true })
      expect(await runtime.capabilities['metadata.artwork']!.getDisplayArtworkUrl!(
        'https://resources.tidal.com/images/a/b/c/640x640.jpg',
      )).toBe('https://resources.tidal.com/images/a/b/c/1280x1280.jpg')
      expect(await runtime.capabilities['playback.resolve']!.resolve({
        sourceId: 'track-1', intent: 'playback',
      })).toEqual({ path: filePath, lifecycle: 'complete', format })
      expect(secrets.get).toHaveBeenCalledWith('session')
      expect(cache.get).toHaveBeenCalledWith({ sourceId: 'track-1', qualityKey: getTidalConfig().preferredAudioQuality })
      await runtime.deactivate()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('completes device-code login through private helper output and host secrets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-tidal-login-'))
    try {
      let secret: string | undefined
      const output = [
        { event: 'login_url', verificationUriComplete: 'https://login.tidal.com/device' },
        { event: 'result', ok: true, result: {
          authorizationUrl: 'https://login.tidal.com/device', expiresAt: 123, countryCode: 'US',
        }, session: {
          accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: 123,
          tokenType: 'Bearer', scopes: ['r_usr'], countryCode: 'US',
        } },
      ].map((value) => ({ type: 'stdout' as const, data: new TextEncoder().encode(`${JSON.stringify(value)}\n`) }))
      const helperOutput = [...output, { type: 'exit' as const, exitCode: 0, signal: null }]
      const events = { emit: vi.fn(async () => {}) }
      const openExternal = vi.fn(async () => {})
      const secrets = {
        get: vi.fn(async () => secret),
        set: vi.fn(async (_key: string, value: string) => { secret = value }),
        delete: vi.fn(async () => { secret = undefined }),
      }
      const host = {
        paths: { getCacheRoot: vi.fn(async () => root) },
        helpers: {
          spawn: vi.fn(async () => ({ handleId: 'private-handle' })),
          write: vi.fn(async () => {}), closeStdin: vi.fn(async () => {}),
          read: vi.fn(async () => {
            const event = helperOutput.shift()
            if (!event) throw new Error('Missing helper output')
            return event
          }),
          terminate: vi.fn(async () => {}),
        },
        events, secrets, openExternal,
        logger: { info: vi.fn(async () => {}) },
      } as unknown as ProviderHostV1
      const runtime = await plugin.activate(host)
      const result = await runtime.capabilities.auth!.login()
      expect(result.verificationUrl).toBe('https://login.tidal.com/device')
      expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://login.tidal.com/device')
      expect(secrets.set).toHaveBeenCalledWith('session', expect.stringContaining('private-access'))
      expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth.changed' }))
      await runtime.capabilities.auth!.logout()
      expect(secret).toBeUndefined()
      await runtime.deactivate()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
