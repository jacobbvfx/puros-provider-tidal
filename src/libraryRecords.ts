import type {
  ProviderAlbumV1,
  ProviderArtistCreditV1,
  ProviderArtistV1,
  ProviderLibraryRecordV1,
  ProviderLibrarySyncPageV1,
  ProviderPlaylistV1,
  ProviderTrackV1,
} from 'puros-provider-sdk'
import { imageIdToUrl } from './TidalApiService'
import type { TidalAlbum, TidalArtist, TidalLibraryPayload, TidalTrack } from './types'

function sourceId(value: string | number | null | undefined): string {
  return value == null ? '' : String(value).trim()
}

function artistsOf(value: { artists?: TidalArtist[]; artist?: TidalArtist | null }): TidalArtist[] {
  return value.artists?.length ? value.artists : value.artist ? [value.artist] : []
}

function creditsOf(artists: TidalArtist[]): ProviderArtistCreditV1[] {
  return artists.filter((item) => !!sourceId(item.id) && !!item.name?.trim()).map((item, position) => ({
    artistSourceId: sourceId(item.id),
    artistName: item.name,
    role: position === 0 ? 'primary' : 'main',
    position,
  }))
}

function mapArtist(value: TidalArtist): ProviderArtistV1 {
  return {
    sourceId: sourceId(value.id),
    name: value.name,
    artworkUrl: imageIdToUrl(value.picture),
    genres: value.genres ?? [],
    providerUrl: value.providerUrl ?? null,
    inLibrary: true,
  }
}

function mapAlbum(value: TidalAlbum): ProviderAlbumV1 {
  const credits = creditsOf(artistsOf(value))
  return {
    sourceId: sourceId(value.id),
    title: value.title,
    year: value.releaseDate ? Number(value.releaseDate.slice(0, 4)) || null : null,
    artworkUrl: imageIdToUrl(value.cover),
    primaryArtistSourceId: credits[0]?.artistSourceId ?? null,
    primaryArtistName: credits[0]?.artistName ?? null,
    artists: credits,
    genres: value.genres ?? [],
    totalTracks: value.numberOfTracks ?? null,
    totalDiscs: value.numberOfVolumes ?? 1,
    providerUrl: value.providerUrl ?? null,
    inLibrary: true,
  }
}

function mapTrack(value: TidalTrack): ProviderTrackV1 {
  const credits = creditsOf(artistsOf(value))
  return {
    sourceId: sourceId(value.id),
    title: value.title,
    durationMs: Math.round(value.duration * 1_000),
    trackNumber: value.trackNumber ?? null,
    discNumber: value.volumeNumber ?? 1,
    albumSourceId: value.album ? sourceId(value.album.id) : null,
    albumTitle: value.album?.title ?? null,
    primaryArtistSourceId: credits[0]?.artistSourceId ?? null,
    primaryArtistName: credits[0]?.artistName ?? null,
    artists: credits,
    genres: value.genres ?? value.album?.genres ?? [],
    artworkUrl: imageIdToUrl(value.album?.cover),
    providerUrl: value.providerUrl ?? null,
    inLibrary: true,
  }
}

/** Stable ordering lets core ingest bounded pages without losing playlist positions. */
export function mapTidalLibraryRecords(payload: TidalLibraryPayload): ProviderLibraryRecordV1[] {
  const records: ProviderLibraryRecordV1[] = []
  const artists = new Map<string, TidalArtist>()
  const albums = new Map<string, TidalAlbum>()
  const tracks = new Map<string, TidalTrack>()

  const addArtists = (value: { artists?: TidalArtist[]; artist?: TidalArtist | null }) => {
    for (const artist of artistsOf(value)) {
      const id = sourceId(artist.id)
      if (id && artist.name?.trim()) artists.set(id, artist)
    }
  }
  const addAlbum = (album: TidalAlbum) => {
    const id = sourceId(album.id)
    if (id) albums.set(id, album)
    addArtists(album)
  }
  for (const album of payload.albums) addAlbum(album)
  for (const track of payload.tracks) {
    const id = sourceId(track.id)
    if (!id) continue
    tracks.set(id, track)
    addArtists(track)
    if (track.album) addAlbum(track.album)
  }

  for (const value of artists.values()) records.push({ type: 'artist', value: mapArtist(value) })
  for (const value of albums.values()) records.push({ type: 'album', value: mapAlbum(value) })
  for (const value of tracks.values()) records.push({ type: 'track', value: mapTrack(value) })

  for (const folder of payload.playlistFolders ?? []) {
    const id = sourceId(folder.sourceId)
    if (!id) continue
    records.push({ type: 'playlistFolder', value: {
      sourceId: id,
      name: folder.name?.trim() || 'TIDAL Folder',
      parentSourceId: folder.parentSourceId ? sourceId(folder.parentSourceId) : null,
      position: Number.isFinite(folder.position) ? folder.position : 0,
    } })
  }

  for (const value of payload.playlists) {
    const id = sourceId(value.uuid ?? value.id)
    if (!id) continue
    const playlist: ProviderPlaylistV1 = {
      sourceId: id,
      title: value.title ?? value.name ?? 'TIDAL Playlist',
      artworkUrl: imageIdToUrl(value.squareImage ?? value.image, 320),
      trackCount: value.numberOfTracks ?? value.items.length,
      folderSourceId: value.folderSourceId ? sourceId(value.folderSourceId) : null,
      folderPosition: Number.isFinite(value.folderPosition) ? value.folderPosition : null,
      collectionRef: { type: 'playlist', sourceId: id },
    }
    records.push({ type: 'playlist', value: playlist })
    value.items.forEach((item, position) => {
      const trackId = sourceId(item.id)
      if (tracks.has(trackId)) {
        records.push({ type: 'playlistTrack', value: {
          playlistSourceId: id,
          trackSourceId: trackId,
          position,
        } })
      }
    })
  }
  return records
}

export function pageTidalLibraryRecords(
  records: ProviderLibraryRecordV1[],
  offset: number,
  limit: number,
  syncedAt: number,
): ProviderLibrarySyncPageV1 {
  if (!Number.isInteger(offset) || offset < 0) throw new TypeError('Invalid library cursor')
  const pageSize = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100
  const nextOffset = Math.min(records.length, offset + pageSize)
  return {
    records: records.slice(offset, nextOffset),
    nextCursor: nextOffset < records.length ? String(nextOffset) : null,
    complete: nextOffset === records.length,
    ...(nextOffset === records.length ? { checkpoint: syncedAt } : {}),
  }
}
