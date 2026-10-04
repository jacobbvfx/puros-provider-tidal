import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TidalProgressiveFfmpeg } from './progressiveFfmpeg'
import { validateTidalProgressiveFlacFile } from './progressiveValidation'

const parseFile = vi.hoisted(() => vi.fn())
vi.mock('music-metadata', () => ({ parseFile }))

const ffmpeg = { probeDuration: vi.fn(async () => 12.5) } satisfies Pick<TidalProgressiveFfmpeg, 'probeDuration'>

beforeEach(() => {
  parseFile.mockReset()
  ffmpeg.probeDuration.mockClear()
})

describe('Tidal progressive FLAC validation', () => {
  it('keeps the metadata duration when it is present', async () => {
    parseFile.mockResolvedValue({ format: { codec: 'FLAC', sampleRate: 96_000, numberOfChannels: 2, duration: 8.25 } })
    expect(await validateTidalProgressiveFlacFile(ffmpeg, 'session', '/cache/snapshot.flac', { requireDuration: true }))
      .toEqual({ codec: 'FLAC', sampleRate: 96_000, channels: 2, duration: 8.25 })
    expect(parseFile).toHaveBeenCalledWith('/cache/snapshot.flac', { duration: true, skipCovers: true })
    expect(ffmpeg.probeDuration).not.toHaveBeenCalled()
  })

  it('uses the declared host helper only for a required missing duration', async () => {
    parseFile.mockResolvedValue({ format: { codec: 'FLAC', sampleRate: 44_100, numberOfChannels: 2 } })
    expect(await validateTidalProgressiveFlacFile(ffmpeg, 'session', '/cache/snapshot.flac', { requireDuration: true }))
      .toEqual({ codec: 'FLAC', sampleRate: 44_100, channels: 2, duration: 12.5 })
    expect(ffmpeg.probeDuration).toHaveBeenCalledWith('session', '/cache/snapshot.flac')
    expect(await validateTidalProgressiveFlacFile(ffmpeg, 'session', '/cache/snapshot.flac', { requireDuration: false }))
      .toEqual({ codec: 'FLAC', sampleRate: 44_100, channels: 2, duration: 0 })
    expect(ffmpeg.probeDuration).toHaveBeenCalledTimes(1)
  })
})
