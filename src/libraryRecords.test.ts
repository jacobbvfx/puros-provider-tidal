import { describe, expect, it } from 'vitest'
import type { TidalLibraryPayload } from './types'
import { mapTidalLibraryRecords, pageTidalLibraryRecords } from './libraryRecords'

const artist = { id: 7, name: 'Artist' }
const album = { id: 9, title: 'Album', upc: '000123', cover: 'abc-def', artists: [artist], numberOfTracks: 1 }
const track = { id: 11, title: 'Track', isrc: 'USABC1234567', duration: 121, album, artists: [artist], providerUrl: 'https://tidal.com/browse/track/11' }
const payload: TidalLibraryPayload = {
  albums: [album],
  tracks: [track],
  playlistFolders: [{ sourceId: 'folder', name: 'Folder', position: 0 }],
  playlists: [{ uuid: 'playlist', title: 'List', folderSourceId: 'folder', folderPosition: 2, items: [track, track] }],
}

describe('Tidal paged library mapping', () => {
  it('emits dependencies before ordered, repeated playlist membership records', () => {
    const records = mapTidalLibraryRecords(payload)
    expect(records.map((record) => record.type)).toEqual([
      'artist', 'album', 'track', 'playlistFolder', 'playlist', 'playlistTrack', 'playlistTrack',
    ])
    expect(records[2]).toMatchObject({ type: 'track', value: { sourceId: '11', albumSourceId: '9', durationMs: 121_000, providerUrl: 'https://tidal.com/browse/track/11' } })
    expect(records[4]).toMatchObject({ type: 'playlist', value: { sourceId: 'playlist', folderSourceId: 'folder', folderPosition: 2 } })
    expect(records[5]).toMatchObject({ type: 'playlistTrack', value: { trackSourceId: '11', position: 0 } })
    expect(records[6]).toMatchObject({ type: 'playlistTrack', value: { trackSourceId: '11', position: 1 } })
    // The legacy Tidal importer did not persist these remote identifiers.
    // Keep its catalog-dedup behavior unchanged during the provider cutover.
    expect(records[1]?.value).not.toHaveProperty('upc')
    expect(records[2]?.value).not.toHaveProperty('isrc')
    expect(structuredClone(records)).toEqual(records)
  })

  it('returns bounded pages with checkpoint only at completion', () => {
    const records = mapTidalLibraryRecords(payload)
    const first = pageTidalLibraryRecords(records, 0, 3, 123)
    expect(first.records).toHaveLength(3)
    expect(first.nextCursor).toBe('3')
    expect(first.complete).toBe(false)
    expect(first.checkpoint).toBeUndefined()
    const last = pageTidalLibraryRecords(records, 3, 200, 123)
    expect(last.records).toHaveLength(4)
    expect(last.nextCursor).toBeNull()
    expect(last.complete).toBe(true)
    expect(last.checkpoint).toBe(123)
  })
})
