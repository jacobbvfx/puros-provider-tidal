import type { ProviderHostV1 } from 'puros-provider-sdk'
import { getTidalConfig } from './config'
import type { TidalConfig } from './types'
import { TidalApiService } from './TidalApiService'
import { TidalAuthService } from './TidalAuthService'
import { TidalPythonBridge } from './TidalPythonBridge'
import { TidalPlaybackService } from './TidalPlaybackService'
import { TidalHostCredentialStore } from './credentialStore'
import { TidalHelperTransport } from './helperTransport'
import { remuxFlacThroughHost } from './hostRemux'

/** Construct private provider services using only host-granted secret/helper/navigation operations. */
export function createTidalRuntimeServices(host: ProviderHostV1, config: TidalConfig = getTidalConfig()) {
  const bridge = new TidalPythonBridge(
    config,
    new TidalHelperTransport(host.helpers),
    (sourcePath) => remuxFlacThroughHost(host.helpers, sourcePath),
  )
  const auth = new TidalAuthService({
    config,
    store: new TidalHostCredentialStore(host.secrets),
    openExternal: (url) => host.openExternal(url),
    bridge,
  })
  const api = new TidalApiService({ auth, config, bridge })
  const playback = new TidalPlaybackService({ api, preferredQuality: config.preferredAudioQuality })
  return { auth, api, playback }
}
