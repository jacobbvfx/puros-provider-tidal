import { describe, expect, it, vi } from 'vitest'
import type { ProviderSecretsHostV1 } from 'puros-provider-sdk'
import type { TidalStoredSession } from './types'
import { TidalHostCredentialStore } from './credentialStore'

const session: TidalStoredSession = {
  accessToken: 'private-access',
  refreshToken: 'private-refresh',
  expiresAt: 123,
  tokenType: 'Bearer',
  scopes: ['r_usr'],
  countryCode: 'US',
}

function fakeSecrets(initial?: string): ProviderSecretsHostV1 {
  let value = initial
  return {
    has: vi.fn(async () => value !== undefined),
    get: vi.fn(async () => value),
    set: vi.fn(async (_key, next) => { value = next }),
    delete: vi.fn(async () => { value = undefined }),
  }
}

describe('Tidal host credential store', () => {
  it('round-trips the session only through the declared host secret slot', async () => {
    const secrets = fakeSecrets()
    const store = new TidalHostCredentialStore(secrets)
    expect(await store.load()).toBeNull()
    await store.save(session)
    expect(secrets.set).toHaveBeenCalledWith('session', JSON.stringify(session))
    expect(await store.load()).toEqual(session)
    await store.clear()
    expect(secrets.delete).toHaveBeenCalledWith('session')
    expect(await store.load()).toBeNull()
  })

  it('does not return malformed stored JSON as a session', async () => {
    const store = new TidalHostCredentialStore(fakeSecrets('{broken'))
    expect(await store.load()).toBeNull()
    expect(await new TidalHostCredentialStore(fakeSecrets('{"accessToken":"only-one"}')).load()).toBeNull()
  })

  it('propagates a host secret write failure', async () => {
    const secrets = fakeSecrets()
    secrets.set = vi.fn(async () => { throw new Error('secure storage unavailable') })
    await expect(new TidalHostCredentialStore(secrets).save(session)).rejects.toThrow('secure storage unavailable')
  })
})
