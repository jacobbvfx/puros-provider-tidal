import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TidalProgressiveFfmpeg } from '../progressiveFfmpeg'
import { TidalProgressiveStreamingManager } from './manager'
import type { StreamManifest } from './session'

const parseFile = vi.hoisted(() => vi.fn(async () => ({
  format: { codec: 'FLAC', sampleRate: 44_100, numberOfChannels: 2, duration: 1 },
})))
vi.mock('music-metadata', () => ({ parseFile }))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function manifest(fileExtension: string): StreamManifest {
  return {
    trackId: 'track-1',
    codec: 'FLAC',
    fileExtension,
    urls: ['https://cdn.example.test/segment'],
    encrypted: false,
  }
}

function createManager(fileExtension: string, ffmpeg: TidalProgressiveFfmpeg, fetchImpl?: typeof fetch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-tidal-progressive-'))
  roots.push(root)
  const finalPath = path.join(root, 'final.flac')
  const onProgress = vi.fn()
  const onSessionEvent = vi.fn()
  const onSessionCompleted = vi.fn(async () => {})
  const manager = new TidalProgressiveStreamingManager({
    cacheDirectory: path.join(root, '.streaming'),
    finalPathForManifest: () => finalPath,
    ffmpeg,
    onProgress,
    onSessionEvent,
    onSessionCompleted,
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response(Buffer.from('fLaC-segment'))),
  })
  return { manager, finalPath, onProgress, onSessionEvent, onSessionCompleted, manifest: manifest(fileExtension) }
}

describe('provider-local Tidal progressive manager', () => {
  it('keeps direct FLAC segment readiness, finalization, and revision behavior', async () => {
    const ffmpeg = { assertAvailable: vi.fn(), remux: vi.fn(), probeDuration: vi.fn(), cancel: vi.fn() } as unknown as TidalProgressiveFfmpeg
    const fixture = createManager('.flac', ffmpeg)
    const created = fixture.manager.createSession(fixture.manifest)
    const started = await fixture.manager.startSession(created.sessionId)
    expect(started.session.sessionId).toBe(created.sessionId)
    await vi.waitFor(() => expect(fs.existsSync(fixture.finalPath)).toBe(true))
    expect(fs.readFileSync(fixture.finalPath).toString()).toBe('fLaC-segment')
    expect(fixture.onProgress).toHaveBeenCalledWith(expect.objectContaining({
      trackId: 'track-1', segmentsDownloaded: 1, segmentsTotal: 1, playbackRevision: 1,
    }))
    expect(fixture.onSessionCompleted).toHaveBeenCalledOnce()
    expect(ffmpeg.assertAvailable).not.toHaveBeenCalled()
  })

  it('runs M4A snapshots through the provider-owned ffmpeg handle', async () => {
    const ffmpeg = {
      assertAvailable: vi.fn(async () => {}),
      remux: vi.fn(async (_sessionId: string, _source: string, output: string) => {
        fs.writeFileSync(output, 'fLaC-remuxed')
      }),
      probeDuration: vi.fn(async () => 1),
      cancel: vi.fn(async () => {}),
    } as unknown as TidalProgressiveFfmpeg
    const fixture = createManager('.m4a', ffmpeg)
    const created = fixture.manager.createSession(fixture.manifest)
    await fixture.manager.startSession(created.sessionId)
    await vi.waitFor(() => expect(fs.existsSync(fixture.finalPath)).toBe(true))
    expect(fs.readFileSync(fixture.finalPath).toString()).toBe('fLaC-remuxed')
    expect(ffmpeg.assertAvailable).toHaveBeenCalledWith(created.sessionId)
    expect(ffmpeg.remux).toHaveBeenCalledTimes(2)
    expect(parseFile).toHaveBeenCalledWith(expect.stringContaining('.refresh-'), {
      duration: true, skipCovers: true,
    })
    expect(fixture.onSessionCompleted).toHaveBeenCalledOnce()
  })

  it('cancels a pending M4A fetch and terminates its host ffmpeg session', async () => {
    const ffmpeg = {
      assertAvailable: vi.fn(async () => {}),
      remux: vi.fn(async () => {}),
      probeDuration: vi.fn(async () => 0),
      cancel: vi.fn(async () => {}),
    } as unknown as TidalProgressiveFfmpeg
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })) as typeof fetch
    const fixture = createManager('.m4a', ffmpeg, fetchImpl)
    const created = fixture.manager.createSession(fixture.manifest)
    const started = fixture.manager.startSession(created.sessionId)
    const rejected = expect(started).rejects.toThrow(/abort|cancel/i)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    await fixture.manager.cancelSession(created.sessionId)
    await rejected
    expect(ffmpeg.cancel).toHaveBeenCalledWith(created.sessionId)
    expect(fs.existsSync(fixture.finalPath)).toBe(false)
  })
})
