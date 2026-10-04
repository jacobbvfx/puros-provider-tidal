import type { ProviderSecretsHostV1 } from 'puros-provider-sdk'
import type { TidalCredentialStore, TidalStoredSession } from './types'

const SESSION_KEY = 'session'

/** Tidal-private session adapter; encryption and provider scoping stay with the host. */
export class TidalHostCredentialStore implements TidalCredentialStore {
  constructor(private readonly secrets: ProviderSecretsHostV1) {}

  async load(): Promise<TidalStoredSession | null> {
    const raw = await this.secrets.get(SESSION_KEY)
    if (!raw) return null
    try {
      const value = JSON.parse(raw) as Partial<TidalStoredSession>
      return typeof value.accessToken === 'string' && typeof value.refreshToken === 'string'
        ? value as TidalStoredSession
        : null
    } catch {
      return null
    }
  }

  async save(session: TidalStoredSession): Promise<void> {
    await this.secrets.set(SESSION_KEY, JSON.stringify(session))
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SESSION_KEY)
  }
}
