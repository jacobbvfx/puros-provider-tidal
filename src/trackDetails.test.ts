import { describe, expect, it, vi } from 'vitest'
import type { ProviderHostV1 } from 'puros-provider-sdk'
import type { TidalTrackContributors } from './types'
import { getTidalTrackDetails } from './trackDetails'

const session = {
  accessToken: 'old', refreshToken: 'refresh', expiresAt: 123,
  tokenType: 'Bearer', scopes: ['r_usr'], countryCode: 'US',
}
const details: TidalTrackContributors = {
  provider: 'tidal', sourceId: '42', albumTitle: 'Album',
  roles: [{ role: 'Composer', contributors: ['Artist'] }],
}

function hostWithOutput(secret: string | undefined, output: string | null) {
  const events = output === null
    ? [{ type: 'error' as const, message: 'helper unavailable' }]
    : [
      { type: 'stdout' as const, data: new TextEncoder().encode(output) },
      { type: 'exit' as const, exitCode: 0, signal: null },
    ]
  const get = vi.fn(async () => secret)
  const set = vi.fn(async () => {})
  const spawn = vi.fn(async () => ({ handleId: 'private-handle' }))
  const warn = vi.fn(async () => {})
  const host = {
    secrets: { get, set },
    helpers: {
      spawn,
      write: vi.fn(async () => {}),
      closeStdin: vi.fn(async () => {}),
      read: vi.fn(async () => events.shift()),
      terminate: vi.fn(async () => {}),
    },
    logger: { warn },
  } as unknown as ProviderHostV1
  return { host, get, set, spawn, warn }
}

describe('provider-owned track details helper', () => {
  it('uses a private helper handle and refreshes only its provider secret', async () => {
    const refreshed = { ...session, accessToken: 'new' }
    const fixture = hostWithOutput(JSON.stringify(session), `${JSON.stringify({ event: 'result', ok: true, result: details, session: refreshed })}\n`)
    const fallback = vi.fn(async () => null)
    expect(await getTidalTrackDetails(fixture.host, '42', 'MAX', fallback)).toEqual(details)
    expect(fixture.spawn).toHaveBeenCalledWith({ binaryId: 'bridge', args: ['track-contributors'] })
    expect(fixture.set).toHaveBeenCalledWith('session', JSON.stringify(refreshed))
    expect(fallback).not.toHaveBeenCalled()
  })

  it('preserves the compatibility path when secure session or helper is unavailable', async () => {
    const missing = hostWithOutput(undefined, null)
    const fallback = vi.fn(async () => details)
    expect(await getTidalTrackDetails(missing.host, '42', 'MAX', fallback)).toEqual(details)
    expect(missing.spawn).not.toHaveBeenCalled()

    const failure = hostWithOutput(JSON.stringify(session), null)
    expect(await getTidalTrackDetails(failure.host, '42', 'MAX', fallback)).toEqual(details)
    expect(failure.warn).toHaveBeenCalledOnce()
  })
})
