import os from 'node:os'
import path from 'node:path'
import type {
  TidalAlbumBundle,
  TidalArtistBundle,
  TidalCatalogSearchResults,
  TidalHomeCollectionBundle,
  TidalHomeShelves,
  LoginResult,
  TidalConfig,
  TidalLibraryPayload,
  TidalPlaybackInfo,
  TidalSearchTrack,
  TidalStoredSession,
  TidalStreamManifest,
  TidalTrackContributors,
  TidalTrackFormatInfo,
} from './types'

interface BridgeEnvelope<T> {
  ok: boolean
  result?: T
  session?: TidalStoredSession
  error?: string
}

interface BridgeLoginEvent {
  event: 'login_url'
  verificationUri: string
  verificationUriComplete: string
  userCode: string
  expiresIn: number
}

interface BridgeBufferProgressEvent {
  event: 'buffer_progress'
  trackId: string
  progress: number
}

interface BridgeResultEvent<T> {
  event: 'result'
  ok: boolean
  result?: T
  session?: TidalStoredSession
  error?: string
}

type BridgeEvent<T> = BridgeLoginEvent | BridgeBufferProgressEvent | BridgeResultEvent<T>

export interface TidalHelperRunner {
  run<T>(
    command: string,
    payload: Record<string, unknown>,
    onEvent?: (event: { event: string; [key: string]: unknown }) => Promise<void> | void,
  ): Promise<BridgeEnvelope<T>>
}

interface HostRemuxPlaybackInfo extends TidalPlaybackInfo {
  hostRemux?: boolean
}

export class TidalPythonBridge {
  private readonly config: TidalConfig
  private readonly runner: TidalHelperRunner
  private readonly remuxFlac: (sourcePath: string) => Promise<string>

  constructor(config: TidalConfig, runner: TidalHelperRunner, remuxFlac: (sourcePath: string) => Promise<string>) {
    this.config = config
    this.runner = runner
    this.remuxFlac = remuxFlac
  }

  async login(openExternal: (url: string) => Promise<void>): Promise<BridgeEnvelope<LoginResult>> {
    return this.runStreamingCommand<LoginResult>('login', {
      preferredQuality: this.config.preferredAudioQuality,
    }, async (event, child) => {
      if (event.event !== 'login_url') return
      try {
        await openExternal(event.verificationUriComplete)
      } catch (error) {
        child.kill()
        throw error
      }
    })
  }

  async search(session: TidalStoredSession, query: string, limit: number): Promise<BridgeEnvelope<TidalSearchTrack[]>> {
    return this.runCommand<TidalSearchTrack[]>('search', {
      session,
      query,
      limit,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async catalogSearch(
    session: TidalStoredSession,
    query: string,
    limit: number,
  ): Promise<BridgeEnvelope<TidalCatalogSearchResults>> {
    return this.runCommand<TidalCatalogSearchResults>('catalog-search', {
      session,
      query,
      limit,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async getArtistBundle(
    session: TidalStoredSession,
    artistId: string,
    limit: number,
  ): Promise<BridgeEnvelope<TidalArtistBundle>> {
    return this.runCommand<TidalArtistBundle>('artist-bundle', {
      session,
      artistId,
      limit,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async getArtist(
    session: TidalStoredSession,
    artistId: string,
  ): Promise<BridgeEnvelope<TidalArtistBundle['artist']>> {
    return this.runCommand<TidalArtistBundle['artist']>('artist', {
      session,
      artistId,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async getArtistGenreMap(
    session: TidalStoredSession,
    artistIds: string[],
  ): Promise<BridgeEnvelope<Record<string, string[]>>> {
    return this.runCommand<Record<string, string[]>>('artist-genre-map', {
      session,
      artistIds,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async getAlbumBundle(
    session: TidalStoredSession,
    albumId: string,
  ): Promise<BridgeEnvelope<TidalAlbumBundle>> {
    return this.runCommand<TidalAlbumBundle>('album-bundle', {
      session,
      albumId,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async addToLibrary(
    session: TidalStoredSession,
    entityType: 'artist' | 'album' | 'track',
    sourceId: string,
  ): Promise<BridgeEnvelope<{ ok: boolean }>> {
    return this.runCommand<{ ok: boolean }>('add-to-library', {
      session,
      entityType,
      sourceId,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async fetchLibrary(session: TidalStoredSession): Promise<BridgeEnvelope<TidalLibraryPayload>> {
    return this.runCommand<TidalLibraryPayload>('library-sync', {
      session,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async getHomeShelves(session: TidalStoredSession): Promise<BridgeEnvelope<TidalHomeShelves>> {
    return this.runCommand<TidalHomeShelves>('home-shelves', {
      session,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async getHomeCollection(
    session: TidalStoredSession,
    sourceType: 'playlist' | 'mix',
    sourceId: string,
  ): Promise<BridgeEnvelope<TidalHomeCollectionBundle>> {
    return this.runCommand<TidalHomeCollectionBundle>('home-collection', {
      session,
      sourceType,
      sourceId,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async getPlaybackInfo(
    session: TidalStoredSession,
    trackId: string,
    onProgress?: (progress: number) => void,
    options?: { allowRecovery?: boolean; outputDir?: string },
  ): Promise<BridgeEnvelope<TidalPlaybackInfo>> {
    const response = await this.runStreamingCommand<HostRemuxPlaybackInfo>('playback-info', {
      session,
      trackId,
      allowRecovery: options?.allowRecovery ?? true,
      preferredQuality: this.config.preferredAudioQuality,
      outputDir: options?.outputDir ?? path.join(os.tmpdir(), 'puros-tidal-playback'),
      hostRemux: true,
    }, (event) => {
      if (event.event === 'buffer_progress' && event.trackId === trackId) {
        onProgress?.(Math.max(0, Math.min(1, event.progress)))
      }
    })
    const result = response.result
    if (!result?.hostRemux) return response
    const playbackInfo = { ...result }
    delete playbackInfo.hostRemux
    try {
      return { ...response, result: { ...playbackInfo, playbackPath: await this.remuxFlac(result.playbackPath) } }
    } catch {
      // Match the old Python helper's fallback: retain the downloaded container if remux fails.
      return { ...response, result: playbackInfo }
    }
  }

  async getStreamManifest(
    session: TidalStoredSession,
    trackId: string,
    options?: { allowRecovery?: boolean },
  ): Promise<BridgeEnvelope<TidalStreamManifest>> {
    return this.runCommand<TidalStreamManifest>('stream_manifest', {
      cmd: 'stream_manifest',
      session,
      trackId,
      quality: this.config.preferredAudioQuality,
      allowRecovery: options?.allowRecovery ?? false,
    })
  }

  async getTrackFormats(
    session: TidalStoredSession,
    trackIds: string[],
  ): Promise<BridgeEnvelope<Record<string, TidalTrackFormatInfo>>> {
    return this.runCommand<Record<string, TidalTrackFormatInfo>>('format-info-batch', {
      session,
      trackIds,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async getTrackContributors(
    session: TidalStoredSession,
    trackId: string,
  ): Promise<BridgeEnvelope<TidalTrackContributors>> {
    return this.runCommand<TidalTrackContributors>('track-contributors', {
      session,
      trackId,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  async ensureSession(session: TidalStoredSession): Promise<BridgeEnvelope<TidalStoredSession>> {
    return this.runCommand<TidalStoredSession>('session-info', {
      session,
      preferredQuality: this.config.preferredAudioQuality,
    })
  }

  private runCommand<T>(command: string, payload: Record<string, unknown>): Promise<BridgeEnvelope<T>> {
    return this.runner.run<T>(command, payload)
  }

  private runStreamingCommand<T>(
    command: string,
    payload: Record<string, unknown>,
    onEvent: (event: BridgeEvent<T>, child: { kill(): void }) => Promise<void> | void,
  ): Promise<BridgeEnvelope<T>> {
    return this.runner.run<T>(command, payload, (event) => onEvent(event as unknown as BridgeEvent<T>, { kill() {} }))
  }
}
