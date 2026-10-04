import { describe, expect, it, vi } from 'vitest'
import type { ProviderHelperOutputV1, ProviderHostV1 } from 'puros-provider-sdk'
import type { TidalConfig, TidalStoredSession } from './types'
import { TidalCatalogProvider } from './TidalCatalogProvider'
import { createTidalRuntimeServices } from './runtimeServices'

const config = { preferredAudioQuality: 'MAX', defaultCountryCode: 'US' } as TidalConfig
const session: TidalStoredSession = {
  accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: 123,
  tokenType: 'Bearer', scopes: ['r_usr'], countryCode: 'US',
}

function hostForHelper(events: ProviderHelperOutputV1[]) {
  let secret: string | undefined
  const openExternal = vi.fn(async () => {})
  const spawn = vi.fn(async () => ({ handleId: 'private-handle' }))
  const host = {
    secrets: {
      has: vi.fn(async () => secret !== undefined),
      get: vi.fn(async () => secret),
      set: vi.fn(async (_key: string, value: string) => { secret = value }),
      delete: vi.fn(async () => { secret = undefined }),
    },
    helpers: {
      spawn,
      write: vi.fn(async () => {}),
      closeStdin: vi.fn(async () => {}),
      read: vi.fn(async () => {
        const event = events.shift()
        if (!event) throw new Error('Missing helper output')
        return event
      }),
      terminate: vi.fn(async () => {}),
    },
    openExternal,
  } as unknown as ProviderHostV1
  return { host, openExternal, spawn }
}

describe('Tidal private runtime services', () => {
  it('uses host helper/navigation and persists a device-code session through host secrets', async () => {
    const output = [
      { event: 'login_url', verificationUri: 'https://login.tidal.com/device', verificationUriComplete: 'https://login.tidal.com/device', userCode: 'ABCD', expiresIn: 60 },
      { event: 'result', ok: true, result: { authorizationUrl: 'https://login.tidal.com/device', expiresAt: 123, countryCode: 'US' }, session },
    ].map((value): ProviderHelperOutputV1 => ({ type: 'stdout', data: new TextEncoder().encode(`${JSON.stringify(value)}\n`) }))
    output.push({ type: 'exit', exitCode: 0, signal: null })
    const { host, openExternal, spawn } = hostForHelper(output)
    const runtime = createTidalRuntimeServices(host, config)
    expect(await runtime.auth.login()).toEqual({ authorizationUrl: 'https://login.tidal.com/device', expiresAt: 123, countryCode: 'US' })
    expect(openExternal).toHaveBeenCalledWith('https://login.tidal.com/device')
    expect(spawn).toHaveBeenCalledWith({ binaryId: 'bridge', args: ['login'] })
    expect(await host.secrets.get('session')).toBe(JSON.stringify(session))
    expect(await runtime.auth.getConnectionStatus()).toEqual({ connected: true, expiresAt: 123, countryCode: 'US' })
    expect(await new TidalCatalogProvider(runtime).isAuthenticated()).toBe(true)
  })
})
