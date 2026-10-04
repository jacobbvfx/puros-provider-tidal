import { describe, expect, it, vi } from 'vitest'
import type { ProviderHelperOutputV1, ProviderHelpersHostV1 } from 'puros-provider-sdk'
import { TidalProgressiveFfmpeg } from './progressiveFfmpeg'

function fakeHelpers(events: ProviderHelperOutputV1[] = [{ type: 'exit', exitCode: 0, signal: null }]) {
  const helpers = {
    spawn: vi.fn(async () => ({ handleId: 'handle-1' })),
    closeStdin: vi.fn(async () => {}),
    read: vi.fn(async () => events.shift() ?? { type: 'exit', exitCode: 0, signal: null }),
    terminate: vi.fn(async () => {}),
  }
  return helpers as unknown as ProviderHelpersHostV1 & typeof helpers
}

describe('Tidal progressive ffmpeg host runner', () => {
  it('uses only declared host helpers with the legacy remux and duration argv', async () => {
    const helpers = fakeHelpers([
      { type: 'exit', exitCode: 0, signal: null },
      { type: 'exit', exitCode: 0, signal: null },
      { type: 'stderr', data: new TextEncoder().encode('time=00:00:12.34\ntime=00:00:13.50') },
      { type: 'exit', exitCode: 0, signal: null },
    ])
    const runner = new TidalProgressiveFfmpeg(helpers)
    await runner.assertAvailable('session')
    await runner.remux('session', '/cache/source.m4a.part', '/cache/output.refresh')
    expect(await runner.probeDuration('session', '/cache/output.refresh')).toBe(13.5)
    expect(helpers.spawn.mock.calls).toEqual([
      [{ binaryId: 'progressive-version', args: ['-version'] }],
      [{ binaryId: 'progressive-remux', args: [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
        '-y', '-i', '/cache/source.m4a.part', '-map', '0:a:0', '-c:a', 'copy',
        '-map_metadata', '0:g', '-f', 'flac', '/cache/output.refresh',
      ] }],
      [{ binaryId: 'progressive-duration', args: [
        '-hide_banner', '-nostdin', '-threads', '1', '-i', '/cache/output.refresh',
        '-map', '0:a:0', '-f', 'null', '-',
      ] }],
    ])
    expect(helpers.closeStdin).toHaveBeenCalledTimes(3)
  })

  it('terminates the opaque helper handle on cancellation', async () => {
    let releaseRead: ((event: ProviderHelperOutputV1) => void) | undefined
    const helpers = fakeHelpers()
    helpers.read.mockImplementation(() => new Promise<ProviderHelperOutputV1>((resolve) => { releaseRead = resolve }))
    const runner = new TidalProgressiveFfmpeg(helpers)
    const operation = runner.remux('cancelled', '/cache/source', '/cache/output')
    await vi.waitFor(() => expect(releaseRead).toBeDefined())
    await runner.cancel('cancelled')
    releaseRead?.({ type: 'exit', exitCode: null, signal: 'SIGTERM' })
    await expect(operation).rejects.toThrow(/ffmpeg exited|cancelled/)
    expect(helpers.terminate).toHaveBeenCalledWith('handle-1')
    await expect(runner.remux('cancelled', '/cache/source', '/cache/again')).rejects.toThrow(/cancelled/)
  })

  it('reports helper stderr without exposing it as a renderer event', async () => {
    const helpers = fakeHelpers([
      { type: 'stderr', data: new TextEncoder().encode('invalid FLAC container') },
      { type: 'exit', exitCode: 1, signal: null },
    ])
    const runner = new TidalProgressiveFfmpeg(helpers)
    await expect(runner.remux('failure', '/cache/source', '/cache/output')).rejects.toThrow('invalid FLAC container')
    expect(helpers.terminate).toHaveBeenCalledWith('handle-1')
  })

  it('terminates a stalled remux after the existing 30-second timeout', async () => {
    vi.useFakeTimers()
    try {
      const helpers = fakeHelpers()
      helpers.read.mockImplementation(() => new Promise<ProviderHelperOutputV1>(() => {}))
      const runner = new TidalProgressiveFfmpeg(helpers)
      const assertion = expect(runner.remux('stalled', '/cache/source', '/cache/output'))
        .rejects.toThrow('ffmpeg timed out after 30000ms')
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
      expect(helpers.terminate).toHaveBeenCalledWith('handle-1')
    } finally {
      vi.useRealTimers()
    }
  })
})
