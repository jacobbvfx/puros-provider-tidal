import type {
  PlaybackArtifactV1,
  PlaybackResolveRequestV1,
  ProviderHostV1,
} from 'puros-provider-sdk'
import type { TidalApiService } from './TidalApiService'
import type { TidalPlaybackService } from './TidalPlaybackService'
import { TidalPlaybackCoordinator } from './playbackCoordinator'
import { createTidalProgressiveRuntime } from './progressive/runtime'
import type { TidalProgressiveStreamingManager } from './progressive/manager'

function complete(path: string, format: PlaybackArtifactV1['format']): PlaybackArtifactV1 {
  return { path, lifecycle: 'complete', format }
}

function progressiveFormat(sampleRate = 0, bitDepth = 0): PlaybackArtifactV1['format'] {
  const isHiRes = sampleRate > 48_000 || bitDepth > 16
  return {
    format: isHiRes ? 'FLAC_HIRES' : 'FLAC', sampleRate, bitDepth, bitrate: 0,
    channels: 2, isLossless: true, isHiRes, isMqa: false, isDsd: false,
  }
}

type ManifestApi = Pick<TidalApiService, 'getStreamManifest'>
type PlaybackCoordinator = Pick<TidalPlaybackCoordinator, 'getCached' | 'resolve' | 'prefetch' | 'clearTasks'>
type ProgressiveManager = Pick<TidalProgressiveStreamingManager,
  'createSession' | 'startSession' | 'markPlaybackStarted' | 'cancelSession' | 'cancelAll' | 'shutdown'
>

/** D5 file-artifact boundary; no decoder, output-device, or UI ownership enters the provider. */
export class TidalPlaybackRuntime {
  constructor(
    private readonly api: ManifestApi,
    private readonly coordinator: PlaybackCoordinator,
    private readonly progressive: ProgressiveManager,
  ) {}

  async resolve(request: PlaybackResolveRequestV1): Promise<PlaybackArtifactV1> {
    const sourceIds = [request.sourceId]
    const cached = await this.coordinator.getCached(sourceIds)
    if (cached && (!cached.resolvedTrackId || cached.resolvedTrackId === request.sourceId)) return complete(cached.playbackPath, cached.quality)

    const stream = await this.api.getStreamManifest(request.sourceId)
    if (stream.trackId !== request.sourceId || (stream.resolvedTrackId && stream.resolvedTrackId !== request.sourceId)) throw new Error('TIDAL returned a different source track')
    console.info('[Streaming] Manifest received')
    console.info(`Track: ${stream.trackId}`)
    console.info(`Segments: ${stream.urls.length}`)
    console.info(`Codec: ${stream.codec || 'unknown'}`)
    console.info(`Container: ${stream.fileExtension || 'unknown'}`)
    console.info(`Encrypted: ${stream.encrypted}`)
    const codec = stream.codec.trim().toUpperCase()
    const container = (stream.fileExtension ?? '').trim().toLowerCase()
    const progressive = !stream.encrypted && codec === 'FLAC' && ['.flac', '.m4a', '.mp4'].includes(container)
    if (progressive) {
      if (container === '.m4a' || container === '.mp4') {
        console.info('[Streaming] M4A FLAC stream detected')
        console.info('Using M4aFlacRemuxAdapter')
      }
      const created = this.progressive.createSession(stream)
      const started = await this.progressive.startSession(created.sessionId)
      return {
        path: started.playbackPath,
        lifecycle: started.session.state === 'completed' ? 'complete' : 'growing',
        format: progressiveFormat(stream.sampleRate, stream.bitDepth),
        sessionId: started.session.sessionId,
      }
    }
    console.info('[Streaming] Fallback to download-first')
    console.info(`Reason: ${stream.encrypted ? 'encrypted stream' : codec !== 'FLAC'
      ? `unsupported codec: ${stream.codec || 'unknown'}`
      : `unsupported container: ${stream.fileExtension || 'unknown'}`}`)
    const resolved = await this.coordinator.resolve(sourceIds, { allowRecovery: false, emitWarning: true })
    if (resolved.resolvedTrackId && resolved.resolvedTrackId !== request.sourceId) throw new Error('TIDAL returned a different source track')
    return complete(resolved.playbackPath, resolved.quality)
  }

  async prefetch(request: Omit<PlaybackResolveRequestV1, 'intent'>): Promise<PlaybackArtifactV1 | null> {
    const resolved = await this.coordinator.prefetch([request.sourceId])
    if (resolved?.resolvedTrackId && resolved.resolvedTrackId !== request.sourceId) return null
    return resolved ? complete(resolved.playbackPath, resolved.quality) : null
  }

  markPlaybackStarted(sessionId: string): void { this.progressive.markPlaybackStarted(sessionId) }
  async cancel(sessionId: string): Promise<void> { await this.progressive.cancelSession(sessionId) }
  async logout(): Promise<void> { await this.progressive.cancelAll() }
  shutdown(): void { this.progressive.shutdown(); this.coordinator.clearTasks() }
}

export async function createTidalPlaybackRuntime(
  host: ProviderHostV1,
  api: TidalApiService,
  playback: TidalPlaybackService,
  qualityKey: string,
): Promise<TidalPlaybackRuntime> {
  const [coordinator, progressive] = await Promise.all([
    TidalPlaybackCoordinator.create(host, playback, qualityKey),
    createTidalProgressiveRuntime(host, qualityKey),
  ])
  return new TidalPlaybackRuntime(api, coordinator, progressive)
}
