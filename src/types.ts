import type { StreamManifest } from './progressive/session'
import type {
  CatalogProviderAlbum,
  CatalogProviderArtist,
  CatalogProviderArtistBundle,
  CatalogProviderSearchResults,
  CatalogProviderTrack,
  FormatInfo,
  HomeProviderCollectionBundle,
  HomeProviderShelf,
} from './catalogTypes'

export interface TidalConfig {
  clientId: string
  clientSecret?: string
  apiBaseUrl: string
  authBaseUrl: string
  authorizeUrl: string
  redirectUri: string
  pythonBin?: string
  scopes: string[]
  defaultCountryCode: string
  preferredAudioQuality: 'LOW' | 'HIGH' | 'LOSSLESS' | 'HI_RES' | 'MAX'
  requestTimeoutMs: number
  maxRetries: number
}

export interface TidalStoredSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenType: string
  scopes: string[]
  countryCode: string
  userId?: string
  isPkce?: boolean
  sessionId?: string
}

export interface LoginResult {
  authorizationUrl: string
  expiresAt: number
  countryCode: string
}

export interface TidalConnectionStatus {
  connected: boolean
  expiresAt: number | null
  countryCode: string | null
}

export interface TidalCredentialStore {
  load(): Promise<TidalStoredSession | null>
  save(session: TidalStoredSession): Promise<void>
  clear(): Promise<void>
}

export interface TidalApiRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface TidalCollectionPage<T> {
  items?: Array<T | { item?: T | null } | null>
  limit?: number
  offset?: number
  totalNumberOfItems?: number
}

export interface TidalArtist {
  id: string | number
  name: string
  picture?: string | null
  genres?: string[]
  providerUrl?: string | null
}

export interface TidalAlbum {
  id: string | number
  title: string
  cover?: string | null
  upc?: string | null
  releaseDate?: string | null
  numberOfTracks?: number | null
  numberOfVolumes?: number | null
  artists?: TidalArtist[]
  artist?: TidalArtist | null
  genres?: string[]
  providerUrl?: string | null
}

export interface TidalTrack {
  id: string | number
  title: string
  duration: number
  isrc?: string | null
  audioQuality?: 'LOW' | 'HIGH' | 'LOSSLESS' | 'HI_RES' | 'MAX' | null
  trackNumber?: number | null
  volumeNumber?: number | null
  artists?: TidalArtist[]
  artist?: TidalArtist | null
  album?: TidalAlbum | null
  genres?: string[]
  providerUrl?: string | null
}

export interface TidalPlaylist {
  uuid?: string
  id?: string | number
  title?: string
  name?: string
  numberOfTracks?: number
  squareImage?: string | null
  image?: string | null
  lastUpdated?: string | null
  folderSourceId?: string | null
  folderPosition?: number | null
}

export interface TidalPlaylistFolder {
  sourceId: string
  name: string
  parentSourceId?: string | null
  position?: number | null
}

export interface TidalSearchTrack {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  coverUrl: string | null
  quality: FormatInfo
}

export type TidalCatalogSearchResults = CatalogProviderSearchResults
export type TidalArtistDetails = CatalogProviderArtist
export type TidalAlbumDetails = CatalogProviderAlbum
export type TidalTrackDetails = CatalogProviderTrack
export type TidalArtistBundle = CatalogProviderArtistBundle

export interface TidalAlbumBundle {
  album: CatalogProviderAlbum
  tracks: CatalogProviderTrack[]
}

export interface TidalSyncProgress {
  stage: 'fetching' | 'persisting' | 'catalog' | 'metadata' | 'done'
  processed: number
  total: number
  label: string
}

export interface TidalSyncResult {
  albums: number
  tracks: number
  playlists: number
  syncedAt: number
}

export interface TidalLibraryPayload {
  albums: TidalAlbum[]
  tracks: TidalTrack[]
  playlists: Array<TidalPlaylist & { items: TidalTrack[] }>
  playlistFolders?: TidalPlaylistFolder[]
}

export interface TidalPlaybackInfo {
  playbackPath: string
  quality: FormatInfo
  resolvedQuality?: string
  resolvedTrackId?: string
  recoveryTrace?: string[]
  cacheHit?: boolean
}

export type TidalStreamManifest = StreamManifest

export interface TidalTrackFormatInfo {
  quality: FormatInfo
  resolvedQuality?: string
  resolvedTrackId?: string
}

export interface TidalTrackContributorGroup {
  role: string
  contributors: string[]
}

export interface TidalTrackContributors {
  provider: 'tidal'
  sourceId: string
  providerUrl?: string | null
  albumId?: string | null
  albumTitle?: string | null
  releaseDate?: string | null
  label?: string | null
  copyright?: string | null
  isrc?: string | null
  upc?: string | null
  roles: TidalTrackContributorGroup[]
}

export type TidalHomeShelves = HomeProviderShelf[]
export type TidalHomeCollectionBundle = HomeProviderCollectionBundle

export interface TidalArtworkCache {
  cacheRemoteArtwork(url: string | null | undefined): Promise<string | null>
}
