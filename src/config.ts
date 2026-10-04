import type { TidalConfig } from './types'

const DEFAULT_API_BASE_URL = 'https://api.tidal.com/v1'
const DEFAULT_AUTH_BASE_URL = 'https://auth.tidal.com/v1/oauth2'
const DEFAULT_AUTHORIZE_URL = 'https://login.tidal.com/authorize'
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:47892/tidal/callback'

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : undefined
}

export function getTidalConfig(): TidalConfig {
  return {
    clientId: readEnv('TIDAL_CLIENT_ID') ?? '',
    clientSecret: readEnv('TIDAL_CLIENT_SECRET'),
    apiBaseUrl: readEnv('TIDAL_API_BASE_URL') ?? DEFAULT_API_BASE_URL,
    authBaseUrl: readEnv('TIDAL_AUTH_BASE_URL') ?? DEFAULT_AUTH_BASE_URL,
    authorizeUrl: readEnv('TIDAL_AUTHORIZE_URL') ?? DEFAULT_AUTHORIZE_URL,
    redirectUri: readEnv('TIDAL_REDIRECT_URI') ?? DEFAULT_REDIRECT_URI,
    pythonBin: readEnv('TIDAL_PYTHON_BIN'),
    scopes: (readEnv('TIDAL_SCOPES') ?? 'r_usr w_usr')
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
    defaultCountryCode: readEnv('TIDAL_DEFAULT_COUNTRY_CODE') ?? 'US',
    preferredAudioQuality: (readEnv('TIDAL_AUDIO_QUALITY') as TidalConfig['preferredAudioQuality'] | undefined) ?? 'MAX',
    requestTimeoutMs: Number(readEnv('TIDAL_REQUEST_TIMEOUT_MS') ?? 15_000),
    maxRetries: Number(readEnv('TIDAL_MAX_RETRIES') ?? 2),
  }
}
