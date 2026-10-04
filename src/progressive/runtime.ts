import path from 'node:path'
import type { FormatInfoV1, ProviderHostV1 } from 'puros-provider-sdk'
import { TidalProgressiveFfmpeg } from '../progressiveFfmpeg'
import { TidalProgressiveStreamingManager } from './manager'
import type { StreamManifest, StreamingProgressEvent, StreamingSessionEvent } from './session'

function progressiveFormat(manifest: StreamManifest): FormatInfoV1 {
  const isHiRes = (manifest.sampleRate ?? 0) > 48_000 || (manifest.bitDepth ?? 0) > 16
  return {
    format: isHiRes ? 'FLAC_HIRES' : 'FLAC',
    sampleRate: manifest.sampleRate ?? 0,
    bitDepth: manifest.bitDepth ?? 0,
    bitrate: 0,
    channels: 2,
    isLossless: true,
    isHiRes,
    isMqa: false,
    isDsd: false,
  }
}

/**
 * The growing file's bitrate is unknown; once it is complete, the average
 * bitrate comes from the finished file. Sample rate and depth stay from the manifest.
 */
async function finalizedFormat(host: ProviderHostV1, manifest: StreamManifest, playbackPath: string): Promise<FormatInfoV1> {
  const format = progressiveFormat(manifest)
  const inspected = await Promise.resolve().then(() => host.cache.inspectFormat(playbackPath)).catch(() => null)
  const bitrate = inspected && Number.isFinite(inspected.bitrate) && inspected.bitrate > 0 ? Math.round(inspected.bitrate) : 0
  return bitrate > 0 ? { ...format, bitrate } : format
}

/** Inactive until the shared Tidal auth/playback cutover; owns only provider state. */
export async function createTidalProgressiveRuntime(
  host: ProviderHostV1,
  preferredQuality: string,
  fetchImpl?: typeof fetch,
): Promise<TidalProgressiveStreamingManager> {
  const cacheRoot = await host.paths.getCacheRoot()
  const ffmpeg = new TidalProgressiveFfmpeg(host.helpers)
  // Per finished session: the manifest format plus the average bitrate read from the final file.
  const finalFormats = new Map<string, Promise<FormatInfoV1>>()
  const finalFormat = (sessionId: string, manifest: StreamManifest, playbackPath: string): Promise<FormatInfoV1> => {
    let pending = finalFormats.get(sessionId)
    if (!pending) {
      pending = finalizedFormat(host, manifest, playbackPath)
      finalFormats.set(sessionId, pending)
      setTimeout(() => finalFormats.delete(sessionId), 60_000).unref?.()
    }
    return pending
  }
  return new TidalProgressiveStreamingManager({
    cacheDirectory: path.join(cacheRoot, '.streaming'),
    ffmpeg,
    finalPathForManifest(manifest) {
      const trackId = String(manifest.resolvedTrackId ?? manifest.trackId).replace(/[^a-z0-9_-]/gi, '')
      const quality = String(manifest.resolvedQuality ?? preferredQuality).toLowerCase().replace(/[^a-z0-9_-]/g, '')
      return path.join(cacheRoot, `${trackId}-${quality}-${manifest.sampleRate ?? 0}-${manifest.bitDepth ?? 0}.flac`)
    },
    onProgress(event: StreamingProgressEvent) {
      void host.events.emit({
        type: 'playback.progress',
        progress: {
          sessionId: event.sessionId,
          sourceId: event.trackId,
          state: event.state,
          bytesCompleted: event.bytesDownloaded,
          itemsCompleted: event.segmentsDownloaded,
          itemsTotal: event.segmentsTotal,
          percent: event.percent,
          bytesPerSecond: event.downloadRate,
          estimatedRemainingMs: event.estimatedRemaining == null ? null : event.estimatedRemaining * 1000,
          playbackStarted: event.playbackStarted,
          revision: event.playbackRevision,
        },
      })
    },
    onSessionEvent(event: StreamingSessionEvent) {
      void (async () => {
        const format = event.session.state === 'completed'
          ? await finalFormat(event.session.sessionId, event.session.manifest, event.playbackPath)
          : undefined
        await host.events.emit({
          type: 'playback.session',
          session: {
            sessionId: event.session.sessionId,
            sourceId: event.session.trackId,
            state: event.session.state,
            artifactPath: event.playbackPath,
            ...(format ? { format } : {}),
            playbackStarted: event.session.playbackStarted,
            revision: event.session.playbackRevision,
            ...(event.session.error ? { error: { code: 'NETWORK' as const, message: event.session.error, retryable: true } } : {}),
          },
        })
      })()
    },
    async onSessionCompleted(session, playbackPath) {
      const manifest = session.manifest
      const format = await finalFormat(session.sessionId, manifest, playbackPath)
      await host.catalog.updateTrackFormat({ sourceId: manifest.trackId, format })
      if (manifest.resolvedTrackId && manifest.resolvedTrackId !== manifest.trackId) {
        await host.catalog.updateTrackFormat({ sourceId: manifest.resolvedTrackId, format })
      }
      await host.cache.put({
        sourceId: manifest.trackId,
        qualityKey: preferredQuality,
        path: playbackPath,
        format,
        resolvedSourceId: manifest.resolvedTrackId ?? manifest.trackId,
        resolvedQuality: manifest.resolvedQuality,
      })
      await host.cache.trim()
      await host.events.scheduleLibraryCatalogRefreshWhenIdle()
      console.info('[Streaming] Session finalized to cache')
      console.info(`Path: ${playbackPath}`)
    },
    ...(fetchImpl ? { fetchImpl } : {}),
  })
}
