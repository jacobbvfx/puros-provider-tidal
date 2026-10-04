import type { FormatInfoV1 } from 'puros-provider-sdk'

/**
 * The plugin's internal catalog shapes, produced by the helper bridge and
 * mapped to the Provider API v1 DTOs in index.ts.
 */
export type FormatInfo = FormatInfoV1

export type CatalogCreditRole =
  | 'primary'
  | 'main'
  | 'featured'
  | 'composer'
  | 'producer'
  | 'conductor'
  | 'performer'
  | 'related'

export type CatalogReleaseType = 'album' | 'ep' | 'single' | 'compilation'
export type CatalogReleaseSection = 'album' | 'ep' | 'single' | 'compilation' | 'live' | 'other'

export interface CatalogProviderArtist {
  provider: string
  sourceId: string
  name: string
  normalizedName?: string | null
  role?: CatalogCreditRole | null
  joinPhrase?: string | null
  artworkUrl?: string | null
  artworkId?: string | null
  bio?: string | null
  bioSource?: string | null
  bioUrl?: string | null
  genres?: string[]
  providerUrl?: string | null
  albumCount?: number | null
  trackCount?: number | null
  inLibrary?: boolean
}

export interface CatalogProviderAlbum {
  provider: string
  sourceId: string
  title: string
  normalizedTitle?: string | null
  upc?: string | null
  year?: number | null
  releaseType?: CatalogReleaseType | null
  releaseSection?: CatalogReleaseSection | null
  artworkUrl?: string | null
  artworkId?: string | null
  primaryArtistSourceId?: string | null
  primaryArtistName?: string | null
  primaryArtistNormalizedName?: string | null
  artists?: CatalogProviderArtist[]
  genres?: string[]
  totalTracks?: number | null
  totalDiscs?: number | null
  providerUrl?: string | null
  inLibrary?: boolean
}

export interface CatalogProviderTrack {
  provider: string
  sourceId: string
  title: string
  normalizedTitle?: string | null
  isrc?: string | null
  upc?: string | null
  durationMs: number
  trackNumber?: number | null
  discNumber?: number | null
  albumSourceId?: string | null
  albumTitle?: string | null
  primaryArtistSourceId?: string | null
  primaryArtistName?: string | null
  primaryArtistNormalizedName?: string | null
  artists?: CatalogProviderArtist[]
  genres?: string[]
  artworkUrl?: string | null
  artworkId?: string | null
  providerUrl?: string | null
  inLibrary?: boolean
  formatInfo?: FormatInfo | null
}

export interface CatalogPlaylistSummary {
  id: string
  provider: string
  sourceId: string
  title: string
  artworkUrl: string | null
  artworkId?: string | null
  trackCount: number | null
  providerUrl: string | null
}

export interface CatalogProviderSearchResults {
  artists: CatalogProviderArtist[]
  albums: CatalogProviderAlbum[]
  tracks: CatalogProviderTrack[]
  playlists: CatalogPlaylistSummary[]
}

export interface CatalogProviderArtistBundle {
  artist: CatalogProviderArtist
  releases: CatalogProviderAlbum[]
  playlists: CatalogPlaylistSummary[]
  topTracks: CatalogProviderTrack[]
  relatedArtists: CatalogProviderArtist[]
}

export type HomeProviderCollectionKind = 'playlist' | 'mix' | 'station'

export interface HomeProviderCollectionItem {
  id: string
  provider: string
  sourceType: HomeProviderCollectionKind
  sourceId: string
  title: string
  subtitle: string | null
  description?: string | null
  artworkUrl: string | null
  providerUrl: string | null
  trackCount?: number | null
  syncedPlaylistId?: number | null
}

export interface HomeProviderShelf {
  id: string
  provider: string
  title: string
  subtitle: string | null
  items: HomeProviderCollectionItem[]
}

export interface HomeProviderTrack {
  id: string
  provider: string
  sourceId: string
  catalogTrackId?: string | null
  catalogAlbumId?: string | null
  catalogArtistId?: string | null
  title: string
  artist: string
  album: string
  duration: number
  artworkUrl: string | null
  providerUrl?: string | null
  discordArtworkUrl?: string | null
  trackNumber?: number | null
  formatInfo: FormatInfo | null
}

export interface HomeProviderCollectionBundle {
  provider: string
  sourceType: HomeProviderCollectionKind
  sourceId: string
  title: string
  subtitle: string | null
  description?: string | null
  artworkUrl: string | null
  providerUrl: string | null
  tracks: HomeProviderTrack[]
}
