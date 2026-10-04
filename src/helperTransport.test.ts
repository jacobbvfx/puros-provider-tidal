import { describe, expect, it, vi } from 'vitest'
import type { ProviderHelperOutputV1, ProviderHelpersHostV1 } from 'puros-provider-sdk'
import type { TidalConfig } from './types'
import { TidalHelperTransport } from './helperTransport'
import { TidalPythonBridge, type TidalHelperRunner } from './TidalPythonBridge'

function fakeHelpers(events: ProviderHelperOutputV1[]): ProviderHelpersHostV1 {
  return {
    spawn: vi.fn(async () => ({ handleId: 'private-handle' })),
    write: vi.fn(async () => {}),
    closeStdin: vi.fn(async () => {}),
    read: vi.fn(async () => {
      const next = events.shift()
      if (!next) throw new Error('No helper output left')
      return next
    }),
    terminate: vi.fn(async () => {}),
  }
}

const bytes = (value: string) => new TextEncoder().encode(value)

describe('Tidal private helper transport', () => {
  it('reassembles split NDJSON and returns a helper session without emitting renderer events', async () => {
    const helpers = fakeHelpers([
      { type: 'stdout', data: bytes('{"event":"login_url","verificationUriComplete":"https://login.tidal.com/x"}\n{"event":"res') },
      { type: 'stdout', data: bytes('ult","ok":true,"result":{"authorizationUrl":"https://login.tidal.com/x"},"session":{"accessToken":"private"}}\n') },
      { type: 'exit', exitCode: 0, signal: null },
    ])
    const onEvent = vi.fn()
    const runner: TidalHelperRunner = new TidalHelperTransport(helpers)
    const result = await runner.run<{ authorizationUrl: string }>('login', { quality: 'MAX' }, onEvent)
    expect(helpers.spawn).toHaveBeenCalledWith({ binaryId: 'bridge', args: ['login'] })
    expect(helpers.write).toHaveBeenCalledWith({ handleId: 'private-handle', data: '{"quality":"MAX"}' })
    expect(result.session).toEqual({ accessToken: 'private' })
    expect(result.result?.authorizationUrl).toBe('https://login.tidal.com/x')
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(helpers.terminate).not.toHaveBeenCalled()
  })

  it('terminates its handle when event processing rejects', async () => {
    const helpers = fakeHelpers([
      { type: 'stdout', data: bytes('{"event":"login_url","verificationUriComplete":"https://login.tidal.com/x"}\n') },
    ])
    await expect(new TidalHelperTransport(helpers).run('login', {}, () => {
      throw new Error('external navigation denied')
    })).rejects.toThrow('external navigation denied')
    expect(helpers.terminate).toHaveBeenCalledWith('private-handle')
  })

  it('supports the existing device-code bridge protocol through host-issued handles', async () => {
    const helpers = fakeHelpers([
      { type: 'stdout', data: bytes('{"event":"login_url","verificationUriComplete":"https://login.tidal.com/x"}\n') },
      { type: 'stdout', data: bytes('{"event":"result","ok":true,"result":{"authorizationUrl":"https://login.tidal.com/x","expiresAt":123,"countryCode":"US"},"session":{"accessToken":"private"}}\n') },
      { type: 'exit', exitCode: 0, signal: null },
    ])
    const bridge = new TidalPythonBridge({ preferredAudioQuality: 'MAX' } as TidalConfig, new TidalHelperTransport(helpers), async (source) => source)
    const openExternal = vi.fn(async () => {})
    const result = await bridge.login(openExternal)
    expect(openExternal).toHaveBeenCalledWith('https://login.tidal.com/x')
    expect(result.result?.authorizationUrl).toBe('https://login.tidal.com/x')
    expect(result.session?.accessToken).toBe('private')
  })
})
