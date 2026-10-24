import type { ProviderTrackUnavailableReasonV1, ProviderTrackV1 } from 'puros-provider-sdk'

/** What the helper read from `allowStreaming`/`streamReady`; absent when TIDAL said nothing. */
export interface TidalTrackAvailability {
  playable?: boolean
  unavailableReason?: ProviderTrackUnavailableReasonV1 | null
}

export function trackAvailability(value: TidalTrackAvailability): Pick<ProviderTrackV1, 'playable' | 'unavailableReason'> {
  if (typeof value.playable !== 'boolean') return {}
  return { playable: value.playable, unavailableReason: value.playable ? null : value.unavailableReason ?? 'other' }
}
