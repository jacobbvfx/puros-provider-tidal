import type {
  CatalogProviderAlbum,
  CatalogProviderArtist,
  CatalogProviderArtistBundle,
  CatalogProviderTrack,
} from './catalogTypes'
import type { TidalApiService } from './TidalApiService'
import type { TidalAuthService } from './TidalAuthService'

type CatalogApi = Pick<TidalApiService,
  'catalogSearch' | 'getArtist' | 'getArtistBundle' | 'getAlbumBundle' | 'addToLibrary'
>
type CatalogAuth = Pick<TidalAuthService, 'getConnectionStatus'>

export class TidalCatalogProvider {
  readonly name = 'tidal' as const
  readonly capabilities = {
    search: true,
    artistProfile: true,
    artistDiscography: true,
    albumDetails: true,
    trackPlayback: true,
    relatedArtists: true,
    similarAlbums: false,
    addToLibrary: true,
    addArtistToLibrary: true,
    addAlbumToLibrary: true,
    addTrackToLibrary: true,
  }

  private readonly api: CatalogApi
  private readonly auth: CatalogAuth
  constructor(options: {
    api: CatalogApi
    auth: CatalogAuth
  }) {
    this.api = options.api
    this.auth = options.auth
  }

  async isAuthenticated() {
    const status = await this.auth.getConnectionStatus()
    return status.connected
  }

  async search(query: string, options?: { limit?: number }) {
    return this.api.catalogSearch(query, options?.limit ?? 12)
  }

  async getArtist(providerArtistId: string): Promise<CatalogProviderArtist> {
    return this.api.getArtist(providerArtistId)
  }

  async getArtistDiscography(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderAlbum[]> {
    const bundle = await this.api.getArtistBundle(providerArtistId, options?.limit ?? 32)
    return bundle.releases
  }

  async getArtistTopTracks(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderTrack[]> {
    const bundle = await this.api.getArtistBundle(providerArtistId, options?.limit ?? 25)
    return bundle.topTracks
  }

  async getArtistRelated(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderArtist[]> {
    const bundle = await this.api.getArtistBundle(providerArtistId, options?.limit ?? 12)
    return bundle.relatedArtists
  }

  async getArtistBundle(providerArtistId: string, options?: { limit?: number }): Promise<CatalogProviderArtistBundle> {
    return this.api.getArtistBundle(providerArtistId, options?.limit ?? 32)
  }

  async getAlbum(providerAlbumId: string): Promise<CatalogProviderAlbum> {
    const bundle = await this.api.getAlbumBundle(providerAlbumId)
    return bundle.album
  }

  async getAlbumTracks(providerAlbumId: string): Promise<CatalogProviderTrack[]> {
    const bundle = await this.api.getAlbumBundle(providerAlbumId)
    return bundle.tracks
  }

  async getAlbumBundle(providerAlbumId: string) {
    return this.api.getAlbumBundle(providerAlbumId)
  }

  async addArtistToLibrary(providerArtistId: string): Promise<void> {
    await this.api.addToLibrary('artist', providerArtistId)
  }

  async addAlbumToLibrary(providerAlbumId: string): Promise<void> {
    await this.api.addToLibrary('album', providerAlbumId)
  }

  async addTrackToLibrary(providerTrackId: string): Promise<void> {
    await this.api.addToLibrary('track', providerTrackId)
  }
}
