import type {
  TidalAlbumBundle,
  TidalArtistBundle,
  TidalCatalogSearchResults,
  TidalConfig,
  TidalHomeCollectionBundle,
  TidalHomeShelves,
  TidalLibraryPayload,
  TidalSearchTrack,
  TidalStoredSession,
  TidalStreamManifest,
  TidalTrackContributors,
  TidalTrackFormatInfo,
} from './types'
import { TidalAuthService } from './TidalAuthService'
import type { TidalPythonBridge } from './TidalPythonBridge'

export class TidalApiService {
  private readonly auth: TidalAuthService
  private readonly bridge: TidalPythonBridge

  constructor(options: {
    auth: TidalAuthService
    config: TidalConfig
    bridge: TidalPythonBridge
  }) {
    this.auth = options.auth
    this.bridge = options.bridge
  }

  async fetchLibraryPayload(): Promise<TidalLibraryPayload> {
    const session = await this.requireSession()
    const response = await this.bridge.fetchLibrary(session)
    await this.auth.syncExternalSession(response.session)
    return response.result ?? { albums: [], tracks: [], playlists: [], playlistFolders: [] }
  }

  async getHomeShelves(): Promise<TidalHomeShelves> {
    const session = await this.requireSession()
    const response = await this.bridge.getHomeShelves(session)
    await this.auth.syncExternalSession(response.session)
    return response.result ?? []
  }

  async getHomeCollection(
    sourceType: 'playlist' | 'mix',
    sourceId: string,
  ): Promise<TidalHomeCollectionBundle> {
    const session = await this.requireSession()
    const response = await this.bridge.getHomeCollection(session, sourceType, sourceId)
    await this.auth.syncExternalSession(response.session)
    if (!response.result) throw new Error('No TIDAL home collection returned')
    return response.result
  }

  async search(query: string, limit = 25): Promise<TidalSearchTrack[]> {
    const session = await this.requireSession()
    const response = await this.bridge.search(session, query, limit)
    await this.auth.syncExternalSession(response.session)
    return response.result ?? []
  }

  async catalogSearch(query: string, limit = 12): Promise<TidalCatalogSearchResults> {
    const session = await this.requireSession()
    const response = await this.bridge.catalogSearch(session, query, limit)
    await this.auth.syncExternalSession(response.session)
    return response.result ?? { artists: [], albums: [], tracks: [], playlists: [] }
  }

  async getArtistBundle(artistId: string, limit = 32): Promise<TidalArtistBundle> {
    const session = await this.requireSession()
    const response = await this.bridge.getArtistBundle(session, artistId, limit)
    await this.auth.syncExternalSession(response.session)
    if (!response.result) throw new Error('No TIDAL artist bundle returned')
    return response.result
  }

  async getArtist(artistId: string): Promise<TidalArtistBundle['artist']> {
    const session = await this.requireSession()
    const response = await this.bridge.getArtist(session, artistId)
    await this.auth.syncExternalSession(response.session)
    if (!response.result) throw new Error('No TIDAL artist returned')
    return response.result
  }

  async getArtistGenreMap(artistIds: string[]): Promise<Record<string, string[]>> {
    const session = await this.requireSession()
    const response = await this.bridge.getArtistGenreMap(session, artistIds)
    await this.auth.syncExternalSession(response.session)
    return response.result ?? {}
  }

  async getAlbumBundle(albumId: string): Promise<TidalAlbumBundle> {
    const session = await this.requireSession()
    const response = await this.bridge.getAlbumBundle(session, albumId)
    await this.auth.syncExternalSession(response.session)
    if (!response.result) throw new Error('No TIDAL album bundle returned')
    return response.result
  }

  async addToLibrary(entityType: 'artist' | 'album' | 'track', sourceId: string): Promise<void> {
    const session = await this.requireSession()
    const response = await this.bridge.addToLibrary(session, entityType, sourceId)
    await this.auth.syncExternalSession(response.session)
    if (!response.result?.ok) throw new Error('TIDAL add-to-library failed')
  }

  async getPlaybackInfo(
    trackId: string,
    onProgress?: (progress: number) => void,
    options?: { allowRecovery?: boolean; outputDir?: string },
  ) {
    const session = await this.requireSession()
    const response = await this.bridge.getPlaybackInfo(session, trackId, onProgress, options)
    await this.auth.syncExternalSession(response.session)
    if (!response.result) throw new Error('No TIDAL playback info returned')
    return response.result
  }

  async getStreamManifest(trackId: string): Promise<TidalStreamManifest> {
    const session = await this.requireSession()
    const response = await this.bridge.getStreamManifest(session, trackId)
    await this.auth.syncExternalSession(response.session)
    if (!response.result) throw new Error('No TIDAL stream manifest returned')
    return response.result
  }

  async getTrackFormats(trackIds: string[]): Promise<Record<string, TidalTrackFormatInfo>> {
    const dedupedTrackIds = [...new Set(trackIds.filter(Boolean))]
    if (dedupedTrackIds.length === 0) return {}

    const session = await this.requireSession()
    const response = await this.bridge.getTrackFormats(session, dedupedTrackIds)
    await this.auth.syncExternalSession(response.session)
    return response.result ?? {}
  }

  async getTrackContributors(trackId: string): Promise<TidalTrackContributors | null> {
    const normalizedTrackId = trackId.trim()
    if (!normalizedTrackId) return null

    const session = await this.requireSession()
    const response = await this.bridge.getTrackContributors(session, normalizedTrackId)
    await this.auth.syncExternalSession(response.session)
    return response.result ?? null
  }

  private async requireSession(): Promise<TidalStoredSession> {
    const session = await this.auth.getSession()
    if (!session) throw new Error('TIDAL is not authenticated')
    return session
  }
}

export function imageIdToUrl(imageId: string | null | undefined, size = 640): string | null {
  if (!imageId) return null
  return `https://resources.tidal.com/images/${imageId.replace(/-/g, '/')}/${size}x${size}.jpg`
}
