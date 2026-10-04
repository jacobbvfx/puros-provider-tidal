import { randomUUID } from 'node:crypto'
import {
  StreamingSession,
  StreamingSessionState,
  type StreamManifest,
  type StreamingProgressEvent,
  type StreamingSessionEvent,
  type StreamingSessionSnapshot,
  type StreamingSessionStartResult,
} from './session'
import {
  FlacFileAdapter,
  M4aFlacRemuxAdapter,
  type FinalizedCacheFile,
  type ProgressiveContainerAdapter,
} from './adapters'
import { SequentialSegmentFetcher } from './fetcher'
import type { TidalProgressiveFfmpeg } from '../progressiveFfmpeg'

type FetchImplementation = typeof fetch

type ManagedSession = {
  session: StreamingSession
  adapter: ProgressiveContainerAdapter
  fetcher: SequentialSegmentFetcher
  task: Promise<FinalizedCacheFile> | null
  finalizedPath: string | null
}

export class TidalProgressiveStreamingManager {
  private readonly cacheDirectory: string
  private readonly onProgress: (event: StreamingProgressEvent) => void
  private readonly finalPathForManifest: (manifest: StreamManifest) => string
  private readonly ffmpeg: TidalProgressiveFfmpeg
  private readonly onSessionCompleted: (session: StreamingSession, playbackPath: string) => Promise<void>
  private readonly onSessionEvent: (event: StreamingSessionEvent) => void
  private readonly fetchImpl?: FetchImplementation
  private readonly sessions = new Map<string, ManagedSession>()

  constructor(options: {
    cacheDirectory: string
    onProgress: (event: StreamingProgressEvent) => void
    finalPathForManifest: (manifest: StreamManifest) => string
    ffmpeg: TidalProgressiveFfmpeg
    onSessionCompleted: (session: StreamingSession, playbackPath: string) => Promise<void>
    onSessionEvent: (event: StreamingSessionEvent) => void
    fetchImpl?: FetchImplementation
  }) {
    this.cacheDirectory = options.cacheDirectory
    this.onProgress = options.onProgress
    this.finalPathForManifest = options.finalPathForManifest
    this.ffmpeg = options.ffmpeg
    this.onSessionCompleted = options.onSessionCompleted
    this.onSessionEvent = options.onSessionEvent
    this.fetchImpl = options.fetchImpl
  }

  createSession(manifest: StreamManifest): StreamingSessionSnapshot {
    this.validateManifest(manifest)
    const session = new StreamingSession(randomUUID(), manifest)
    const adapter = this.createAdapter(manifest)
    const fetcher = new SequentialSegmentFetcher({
      adapter,
      onProgress: this.onProgress,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    })
    this.sessions.set(session.sessionId, {
      session,
      adapter,
      fetcher,
      task: null,
      finalizedPath: null,
    })
    console.info('[Streaming] Session created')
    console.info(`Session: ${session.sessionId}`)
    return session.snapshot()
  }

  async startSession(sessionId: string): Promise<StreamingSessionStartResult> {
    const managed = this.requireSession(sessionId)
    if (managed.task) throw new Error(`Streaming session ${sessionId} is already running`)

    const task = managed.fetcher.start(managed.session)
    managed.task = task
    void task.then((finalized) => {
      managed.finalizedPath = finalized.playbackPath
      this.onSessionEvent({
        session: managed.session.snapshot(),
        playbackPath: finalized.playbackPath,
      })
      void this.onSessionCompleted(managed.session, finalized.playbackPath).catch((error) => {
        console.error('[Streaming] Cache registration failed:', error)
      })
    }, (error) => {
      if (managed.session.state !== StreamingSessionState.Cancelled) {
        console.error('[Streaming] Session failed:', error)
      }
      this.onSessionEvent({
        session: managed.session.snapshot(),
        playbackPath: managed.adapter.getTarget(sessionId).playbackPath,
      })
    })

    await managed.fetcher.waitForReadiness(sessionId)
    if (managed.session.state === StreamingSessionState.Completed) {
      const finalized = await task
      managed.finalizedPath = finalized.playbackPath
    }
    return {
      playbackPath: managed.session.state === StreamingSessionState.Completed
        ? managed.finalizedPath ?? managed.adapter.getTarget(sessionId).playbackPath
        : managed.adapter.getTarget(sessionId).playbackPath,
      session: managed.session.snapshot(),
    }
  }

  markPlaybackStarted(sessionId: string): StreamingSessionSnapshot {
    const managed = this.requireSession(sessionId)
    managed.session.markPlaybackStarted()
    const snapshot = managed.session.snapshot()
    this.onSessionEvent({
      session: snapshot,
      playbackPath: snapshot.state === StreamingSessionState.Completed
        ? managed.finalizedPath ?? managed.adapter.getTarget(sessionId).playbackPath
        : managed.adapter.getTarget(sessionId).playbackPath,
    })
    console.info('[Streaming] Playback started from growing file')
    console.info(`Session: ${sessionId}`)
    return snapshot
  }

  async cancelSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    await managed.fetcher.stop(sessionId)
    await managed.task?.catch(() => undefined)
    this.sessions.delete(sessionId)
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.cancelSession(sessionId)))
  }

  shutdown(): void {
    for (const [sessionId, managed] of this.sessions) {
      void managed.fetcher.stop(sessionId)
    }
    this.sessions.clear()
  }

  private requireSession(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Unknown streaming session ${sessionId}`)
    return managed
  }

  private createAdapter(manifest: StreamManifest): ProgressiveContainerAdapter {
    const adapters: ProgressiveContainerAdapter[] = [
      new FlacFileAdapter({
        directory: this.cacheDirectory,
        finalPathForManifest: this.finalPathForManifest,
      }),
      new M4aFlacRemuxAdapter({
        directory: this.cacheDirectory,
        ffmpeg: this.ffmpeg,
        finalPathForManifest: this.finalPathForManifest,
      }),
    ]
    const adapter = adapters.find((candidate) => candidate.canHandle(manifest))
    if (!adapter) {
      throw new Error(
        `Unsupported progressive container: codec=${manifest.codec || 'unknown'} `
        + `container=${manifest.fileExtension || 'unknown'} encrypted=${manifest.encrypted}`,
      )
    }
    return adapter
  }

  private validateManifest(manifest: StreamManifest): void {
    if (!manifest.trackId.trim()) throw new Error('Streaming manifest is missing a track ID')
    if (manifest.urls.length === 0) throw new Error('Streaming manifest contains no segment URLs')
    for (const url of manifest.urls) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Unsupported streaming segment protocol: ${parsed.protocol}`)
      }
    }
  }
}
