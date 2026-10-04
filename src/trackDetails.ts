import type { ProviderHostV1 } from 'puros-provider-sdk'
import type { TidalTrackContributors } from './types'
import { TidalHostCredentialStore } from './credentialStore'
import { TidalHelperTransport } from './helperTransport'

/** Read rich credits through the host helper, retaining a legacy fallback during extraction. */
export async function getTidalTrackDetails(
  host: ProviderHostV1,
  sourceId: string,
  preferredQuality: string,
  legacyFallback: (sourceId: string) => Promise<TidalTrackContributors | null>,
): Promise<TidalTrackContributors | null> {
  const credentials = new TidalHostCredentialStore(host.secrets)
  const session = await credentials.load()
  if (!session) return legacyFallback(sourceId)

  try {
    const response = await new TidalHelperTransport(host.helpers).run<TidalTrackContributors>(
      'track-contributors',
      { session, trackId: sourceId, preferredQuality },
    )
    if (response.session) await credentials.save(response.session)
    return response.result ?? null
  } catch {
    await host.logger.warn('Private track-details helper failed; using compatibility path')
    return legacyFallback(sourceId)
  }
}
