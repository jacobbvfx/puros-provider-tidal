import type {
  LoginResult,
  TidalConfig,
  TidalConnectionStatus,
  TidalCredentialStore,
  TidalStoredSession,
} from './types'
import type { TidalPythonBridge } from './TidalPythonBridge'

export class TidalAuthService {
  private readonly config: TidalConfig
  private readonly store: TidalCredentialStore
  private readonly openExternal: (url: string) => Promise<void>
  private readonly bridge: TidalPythonBridge
  private memorySession: TidalStoredSession | null = null

  constructor(options: {
    config: TidalConfig
    store: TidalCredentialStore
    openExternal: (url: string) => Promise<void>
    bridge: TidalPythonBridge
  }) {
    this.config = options.config
    this.store = options.store
    this.openExternal = options.openExternal
    this.bridge = options.bridge
  }

  async login(): Promise<LoginResult> {
    const response = await this.bridge.login(this.openExternal)
    const nextSession = response.session
    if (!nextSession || !response.result) {
      throw new Error('TIDAL login did not return a session')
    }

    await this.persistSession(nextSession)
    return response.result
  }

  async refreshAccessToken(_refreshToken: string): Promise<TidalStoredSession> {
    void _refreshToken
    const session = await this.getStoredSession()
    if (!session) throw new Error('TIDAL is not authenticated')
    return this.ensureSession(session)
  }

  async getAccessToken(): Promise<string> {
    const session = await this.getStoredSession()
    if (!session) throw new Error('TIDAL is not authenticated')
    const refreshed = await this.ensureSession(session)
    return refreshed.accessToken
  }

  async getConnectionStatus(): Promise<TidalConnectionStatus> {
    const session = await this.getStoredSession()
    return {
      connected: !!session,
      expiresAt: session?.expiresAt ?? null,
      countryCode: session?.countryCode ?? null,
    }
  }

  async getSession(): Promise<TidalStoredSession | null> {
    return this.getStoredSession()
  }

  async forceRefresh(): Promise<TidalStoredSession> {
    const session = await this.getStoredSession()
    if (!session) throw new Error('TIDAL is not authenticated')
    return this.ensureSession(session)
  }

  async syncExternalSession(session: TidalStoredSession | null | undefined): Promise<TidalStoredSession | null> {
    if (!session) return null
    return this.persistSession({
      ...session,
      scopes: session.scopes?.length ? session.scopes : ['r_usr', 'w_usr', 'w_sub'],
      countryCode: session.countryCode || this.config.defaultCountryCode,
    })
  }

  async logout(): Promise<void> {
    this.memorySession = null
    await this.store.clear()
  }

  private async ensureSession(session: TidalStoredSession): Promise<TidalStoredSession> {
    const response = await this.bridge.ensureSession(session)
    const nextSession = response.session ?? response.result
    if (!nextSession) {
      throw new Error('Unable to refresh TIDAL session')
    }
    return this.persistSession(nextSession)
  }

  private async getStoredSession(): Promise<TidalStoredSession | null> {
    if (this.memorySession) return this.memorySession
    this.memorySession = await this.store.load()
    return this.memorySession
  }

  private async persistSession(session: TidalStoredSession): Promise<TidalStoredSession> {
    this.memorySession = {
      ...session,
      scopes: session.scopes?.length ? session.scopes : ['r_usr', 'w_usr', 'w_sub'],
      countryCode: session.countryCode || this.config.defaultCountryCode,
    }
    await this.store.save(this.memorySession)
    return this.memorySession
  }
}
