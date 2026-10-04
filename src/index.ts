import manifestJson from '../provider.manifest.json'
import {
  API_VERSION,
  type ProviderAlbumV1,
  type ProviderArtistCreditV1,
  type ProviderArtistV1,
  type ProviderHostV1,
  type ProviderLibraryRecordV1,
  type ProviderManifestV1,
  type ProviderPlaylistV1,
  type ProviderPluginV1,
  type ProviderRuntimeV1,
  type ProviderTrackV1,
} from 'puros-provider-sdk'
import type {
  CatalogPlaylistSummary,
  CatalogProviderAlbum,
  CatalogProviderArtist,
  CatalogProviderTrack,
} from './catalogTypes'
import { TidalCatalogProvider } from './TidalCatalogProvider'
import { getTidalTrackDetails } from './trackDetails'
import { mapTidalLibraryRecords, pageTidalLibraryRecords } from './libraryRecords'
import { getTidalConfig } from './config'
import { createTidalRuntimeServices } from './runtimeServices'
import { createTidalPlaybackRuntime } from './playbackRuntime'
import { getDisplayArtworkUrl } from './artwork'

export const manifest = manifestJson as ProviderManifestV1

function artistCredit(artist: CatalogProviderArtist, position: number): ProviderArtistCreditV1 {
  return {
    artistSourceId: artist.sourceId,
    artistName: artist.name,
    role: artist.role ?? 'primary',
    joinPhrase: artist.joinPhrase ?? null,
    position,
  }
}

function artist(value: CatalogProviderArtist): ProviderArtistV1 {
  return {
    sourceId: value.sourceId,
    name: value.name,
    normalizedName: value.normalizedName ?? null,
    artworkUrl: value.artworkUrl ?? null,
    bio: value.bio ?? null,
    bioUrl: value.bioUrl ?? null,
    genres: value.genres ?? [],
    providerUrl: value.providerUrl ?? null,
    albumCount: value.albumCount ?? null,
    trackCount: value.trackCount ?? null,
    inLibrary: value.inLibrary,
  }
}

function album(value: CatalogProviderAlbum): ProviderAlbumV1 {
  return {
    sourceId: value.sourceId,
    title: value.title,
    normalizedTitle: value.normalizedTitle ?? null,
    upc: value.upc ?? null,
    year: value.year ?? null,
    releaseType: value.releaseSection ?? value.releaseType ?? null,
    artworkUrl: value.artworkUrl ?? null,
    primaryArtistSourceId: value.primaryArtistSourceId ?? null,
    primaryArtistName: value.primaryArtistName ?? null,
    artists: value.artists?.map(artistCredit),
    genres: value.genres ?? [],
    totalTracks: value.totalTracks ?? null,
    totalDiscs: value.totalDiscs ?? null,
    providerUrl: value.providerUrl ?? null,
    inLibrary: value.inLibrary,
  }
}

function track(value: CatalogProviderTrack): ProviderTrackV1 {
  return {
    sourceId: value.sourceId,
    title: value.title,
    normalizedTitle: value.normalizedTitle ?? null,
    isrc: value.isrc ?? null,
    upc: value.upc ?? null,
    durationMs: value.durationMs,
    trackNumber: value.trackNumber ?? null,
    discNumber: value.discNumber ?? null,
    albumSourceId: value.albumSourceId ?? null,
    albumTitle: value.albumTitle ?? null,
    primaryArtistSourceId: value.primaryArtistSourceId ?? null,
    primaryArtistName: value.primaryArtistName ?? null,
    artists: value.artists?.map(artistCredit),
    genres: value.genres ?? [],
    artworkUrl: value.artworkUrl ?? null,
    providerUrl: value.providerUrl ?? null,
    inLibrary: value.inLibrary,
    format: value.formatInfo ?? null,
  }
}

function playlist(value: CatalogPlaylistSummary): ProviderPlaylistV1 {
  return {
    sourceId: value.sourceId,
    title: value.title,
    artworkUrl: value.artworkUrl,
    trackCount: value.trackCount,
    providerUrl: value.providerUrl,
    collectionRef: { type: 'playlist', sourceId: value.sourceId },
  }
}

async function createRuntime(host: ProviderHostV1): Promise<ProviderRuntimeV1> {
  const config = getTidalConfig()
  const services = createTidalRuntimeServices(host, config)
  const playback = await createTidalPlaybackRuntime(host, services.api, services.playback, config.preferredAudioQuality)
  const catalog = new TidalCatalogProvider({ api: services.api, auth: services.auth })
  let active = true
  let librarySnapshot: { records: ProviderLibraryRecordV1[]; syncedAt: number } | null = null
  let homeShelvesSnapshot: { items: Awaited<ReturnType<typeof services.api.getHomeShelves>>; fetchedAt: number } | null = null
  const ensureActive = () => { if (!active) throw new Error('TIDAL provider is inactive') }
  const emitAuthStatus = async () => {
    const status = await services.auth.getConnectionStatus()
    await host.events.emit({
      type: 'auth.changed',
      status: {
        authenticated: status.connected,
        accountLabel: status.countryCode ? `TIDAL (${status.countryCode})` : null,
        expiresAt: status.expiresAt,
      },
    })
    await host.events.emit({
      type: 'status.changed',
      status: {
        state: 'ready',
        authenticated: status.connected,
        updatedAt: Date.now(),
        values: { account: status.connected ? `Connected${status.countryCode ? ` · ${status.countryCode}` : ''}` : 'Not connected' },
      },
    })
  }
  return {
    capabilities: {
      auth: {
        async getStatus() {
          ensureActive()
          const status = await services.auth.getConnectionStatus()
          return { authenticated: status.connected, expiresAt: status.expiresAt, accountLabel: status.countryCode }
        },
        async login() {
          ensureActive()
          const result = await services.auth.login()
          homeShelvesSnapshot = null
          await emitAuthStatus()
          const status = await services.auth.getConnectionStatus()
          return {
            status: { authenticated: status.connected, expiresAt: status.expiresAt, accountLabel: status.countryCode },
            verificationUrl: result.authorizationUrl,
            expiresAt: result.expiresAt,
          }
        },
        async logout() {
          ensureActive()
          await playback.logout()
          homeShelvesSnapshot = null
          await services.auth.logout()
          await emitAuthStatus()
        },
      },
      'catalog.search': {
        async search(request) {
          ensureActive()
          if (request.types?.length === 1 && request.types[0] === 'track') {
            const hits = await services.api.search(request.query, request.limit ?? 10)
            return {
              artists: [],
              albums: [],
              tracks: hits.map((hit): ProviderTrackV1 => ({
                sourceId: hit.id,
                title: hit.title,
                durationMs: Math.round(hit.duration * 1000),
                trackNumber: null,
                discNumber: 1,
                albumTitle: hit.album,
                primaryArtistName: hit.artist,
                artworkUrl: hit.coverUrl,
                format: hit.quality,
              })),
              playlists: [],
              nextCursor: null,
            }
          }
          const results = await catalog.search(request.query, { limit: request.limit })
          return {
            artists: results.artists.map(artist),
            albums: results.albums.map(album),
            tracks: results.tracks.map(track),
            playlists: results.playlists.map(playlist),
            nextCursor: null,
          }
        },
      },
      'catalog.entities': {
        async getArtist(sourceId) { ensureActive(); return artist(await catalog.getArtist(sourceId)) },
        async getArtistGenres(sourceIds) {
          ensureActive()
          return services.api.getArtistGenreMap(sourceIds)
        },
        async getArtistBundle(sourceId, request) {
          ensureActive()
          const bundle = await catalog.getArtistBundle(sourceId, { limit: request?.limit })
          return {
            artist: artist(bundle.artist),
            releases: bundle.releases.map(album),
            playlists: bundle.playlists.map(playlist),
            topTracks: bundle.topTracks.map(track),
            relatedArtists: bundle.relatedArtists.map(artist),
          }
        },
        async getAlbum(sourceId) { ensureActive(); return album(await catalog.getAlbum(sourceId)) },
        async getAlbumBundle(sourceId) {
          ensureActive()
          const bundle = await catalog.getAlbumBundle(sourceId)
          return { album: album(bundle.album), tracks: bundle.tracks.map(track) }
        },
        async getTrack(sourceId) {
          ensureActive()
          const stored = await host.catalog.getStoredTrack(sourceId)
          if (!stored) throw new Error('Track not found')
          return {
            ...stored,
            providerUrl: stored.providerUrl || `https://tidal.com/browse/track/${encodeURIComponent(sourceId)}`,
          }
        },
      },
      'catalog.home': {
        async getShelves() {
          ensureActive()
          if (!homeShelvesSnapshot || Date.now() - homeShelvesSnapshot.fetchedAt >= 5 * 60_000) {
            homeShelvesSnapshot = {
              items: await services.api.getHomeShelves(),
              fetchedAt: Date.now(),
            }
          }
          const shelves = homeShelvesSnapshot.items.filter((value) => value.provider === manifest.id)
          return {
            items: shelves.map((shelf) => ({
              id: shelf.id,
              title: shelf.title,
              kind: 'playlists' as const,
              items: shelf.items.map((item) => ({
                sourceId: item.sourceId,
                title: item.title,
                description: item.description ?? item.subtitle,
                artworkUrl: item.artworkUrl,
                trackCount: item.trackCount ?? null,
                providerUrl: item.providerUrl,
                collectionRef: { type: item.sourceType, sourceId: item.sourceId },
              })),
            })),
            nextCursor: null,
          }
        },
        async getCollection(request) {
          ensureActive()
          if (request.type === 'station') throw new Error('TIDAL home stations are not supported')
          const bundle = await services.api.getHomeCollection(request.type, request.sourceId)
          return {
            title: bundle.title,
            subtitle: bundle.subtitle,
            artworkUrl: bundle.artworkUrl,
            tracks: bundle.tracks.map((value) => ({
              sourceId: value.sourceId,
              title: value.title,
              durationMs: value.duration * 1000,
              trackNumber: value.trackNumber ?? null,
              albumTitle: value.album,
              primaryArtistName: value.artist,
              artworkUrl: value.artworkUrl,
              format: value.formatInfo,
            })),
          }
        },
      },
      'library.sync': {
        async enumerate(request) {
          ensureActive()
          if (!request.cursor) {
            homeShelvesSnapshot = null
            const payload = await services.api.fetchLibraryPayload()
            librarySnapshot = {
              records: mapTidalLibraryRecords(payload),
              syncedAt: Math.floor(Date.now() / 1_000),
            }
          }
          if (!librarySnapshot) throw new Error('TIDAL library cursor has expired')
          const offset = request.cursor ? Number(request.cursor) : 0
          const page = pageTidalLibraryRecords(librarySnapshot.records, offset, request.limit ?? 100, librarySnapshot.syncedAt)
          await host.events.emit({
            type: 'library.sync.progress',
            processed: offset + page.records.length,
            total: librarySnapshot.records.length,
            label: 'Fetching TIDAL library',
          })
          if (page.complete) librarySnapshot = null
          return page
        },
      },
      'playback.resolve': {
        async resolve(request) {
          ensureActive()
          return playback.resolve(request)
        },
      },
      'playback.prefetch': {
        async prefetch(request) {
          ensureActive()
          return playback.prefetch(request)
        },
      },
      'playback.progressive': {
        async markPlaybackStarted({ sessionId }) { ensureActive(); playback.markPlaybackStarted(sessionId) },
        async cancel({ sessionId }) { await playback.cancel(sessionId) },
      },
      'metadata.artwork': {
        async getDisplayArtworkUrl(url) {
          ensureActive()
          return getDisplayArtworkUrl(url)
        },
        async getArtwork(ref) {
          ensureActive()
          if (ref.entityType === 'artist') {
            const value = await catalog.getArtist(ref.sourceId)
            return value.artworkUrl ? { url: value.artworkUrl } : null
          }
          if (ref.entityType === 'album') {
            const value = await catalog.getAlbum(ref.sourceId)
            return value.artworkUrl ? { url: value.artworkUrl } : null
          }
          return null
        },
      },
      'metadata.bio': {
        async getBio(ref) {
          ensureActive()
          if (ref.entityType !== 'artist') return null
          const value = await catalog.getArtist(ref.sourceId)
          return value.bio ? { text: value.bio, sourceUrl: value.bioUrl ?? undefined, genres: value.genres } : null
        },
      },
      'metadata.credits': {
        async getTrackDetails(sourceId) {
          ensureActive()
          const value = await getTidalTrackDetails(host, sourceId, config.preferredAudioQuality, (id) => services.api.getTrackContributors(id))
          if (!value) return null
          return {
            sourceId: value.sourceId,
            providerUrl: value.providerUrl,
            albumSourceId: value.albumId,
            albumTitle: value.albumTitle,
            releaseDate: value.releaseDate,
            label: value.label,
            copyright: value.copyright,
            isrc: value.isrc,
            upc: value.upc,
            roles: value.roles,
          }
        },
        async getCredits(ref) {
          ensureActive()
          if (ref.entityType !== 'track') return []
          const value = await getTidalTrackDetails(host, ref.sourceId, config.preferredAudioQuality, (id) => services.api.getTrackContributors(id))
          return (value?.roles ?? []).flatMap((group, groupIndex) => group.contributors.map((name, index) => {
            const normalizedRole = group.role.trim().toLowerCase()
            const role = ['composer', 'producer', 'conductor', 'performer'].includes(normalizedRole)
              ? normalizedRole as 'composer' | 'producer' | 'conductor' | 'performer'
              : 'other' as const
            return { name, role, position: groupIndex * 100 + index }
          }))
        },
      },
    },
    async getStatus() {
      const status = await services.auth.getConnectionStatus()
      return {
        state: active ? 'ready' : 'inactive',
        authenticated: status.connected,
        updatedAt: Date.now(),
        values: { account: status.connected ? `Connected${status.countryCode ? ` · ${status.countryCode}` : ''}` : 'Not connected' },
      }
    },
    async deactivate() { active = false; librarySnapshot = null; homeShelvesSnapshot = null; playback.shutdown() },
  }
}

const plugin: ProviderPluginV1 = {
  apiVersion: API_VERSION,
  manifest,
  async activate(host) {
    await host.logger.info('TIDAL plugin activated')
    return createRuntime(host)
  },
}

export default plugin
