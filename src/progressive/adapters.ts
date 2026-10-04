import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { StreamingSession, type StreamManifest } from './session'
import type { TidalProgressiveFfmpeg } from '../progressiveFfmpeg'
import { validateTidalProgressiveFlacFile } from '../progressiveValidation'

export const FLAC_MIN_START_BYTES = 16 * 1024 * 1024
export const FLAC_MIN_START_SEGMENTS = 5
export const M4A_MIN_START_BYTES = 8 * 1024 * 1024
// TIDAL manifests normally contain an init segment followed by roughly
// four-second media fragments. Three segments provide a small playable lead
// while avoiding the long startup delay caused by buffering twelve fragments.
export const M4A_MIN_START_SEGMENTS = 3
const M4A_REFRESH_SEGMENTS = 2
const PREFIX_PROBE_BYTES = 64 * 1024

export interface ProgressiveContainerTarget {
  playbackPath: string
  sourcePath: string
}

export interface FinalizedCacheFile {
  playbackPath: string
}

export interface ProgressivePlaybackValidation {
  codec: string
  sampleRate: number
  channels: number
  duration: number
}

export interface ProgressivePlaybackValidationOptions {
  requireDuration: boolean
}

export interface ProgressiveContainerAdapter {
  canHandle(manifest: StreamManifest): boolean
  prepare(session: StreamingSession): Promise<ProgressiveContainerTarget>
  appendSegment(session: StreamingSession, segment: Buffer): Promise<void>
  finalize(session: StreamingSession): Promise<FinalizedCacheFile>
  abort(sessionId: string): Promise<void>
  isReady(session: StreamingSession): boolean
  getTarget(sessionId: string): ProgressiveContainerTarget
  getPlaybackRevision(sessionId: string): number
}

type AdapterPaths = ProgressiveContainerTarget & {
  finalPath: string
}

function normalizedCodec(manifest: StreamManifest): string {
  return manifest.codec.trim().toUpperCase()
}

function normalizedExtension(manifest: StreamManifest): string {
  return (manifest.fileExtension ?? '').trim().toLowerCase()
}

function closeHandle(handles: Map<string, number>, sessionId: string): void {
  const handle = handles.get(sessionId)
  if (handle === undefined) return
  handles.delete(sessionId)
  fs.closeSync(handle)
}

export class FlacFileAdapter implements ProgressiveContainerAdapter {
  private readonly directory: string
  private readonly finalPathForManifest: (manifest: StreamManifest) => string
  private readonly handles = new Map<string, number>()
  private readonly paths = new Map<string, AdapterPaths>()
  private readonly revisions = new Map<string, number>()

  constructor(options: {
    directory: string
    finalPathForManifest: (manifest: StreamManifest) => string
  }) {
    this.directory = options.directory
    this.finalPathForManifest = options.finalPathForManifest
  }

  canHandle(manifest: StreamManifest): boolean {
    return !manifest.encrypted
      && normalizedCodec(manifest) === 'FLAC'
      && normalizedExtension(manifest) === '.flac'
  }

  async prepare(session: StreamingSession): Promise<ProgressiveContainerTarget> {
    fs.mkdirSync(this.directory, { recursive: true })
    const playbackPath = path.join(this.directory, `${session.sessionId}.part`)
    const target = {
      sourcePath: playbackPath,
      playbackPath,
      finalPath: this.finalPathForManifest(session.manifest),
    }
    this.paths.set(session.sessionId, target)
    this.revisions.set(session.sessionId, 0)
    this.handles.set(session.sessionId, fs.openSync(playbackPath, 'w'))
    return target
  }

  async appendSegment(session: StreamingSession, segment: Buffer): Promise<void> {
    const handle = this.handles.get(session.sessionId)
    if (handle === undefined) throw new Error(`FLAC adapter is not open for session ${session.sessionId}`)
    fs.writeSync(handle, segment)
    this.revisions.set(session.sessionId, (this.revisions.get(session.sessionId) ?? 0) + 1)
  }

  async finalize(session: StreamingSession): Promise<FinalizedCacheFile> {
    closeHandle(this.handles, session.sessionId)
    const target = this.requirePaths(session.sessionId)
    fs.mkdirSync(path.dirname(target.finalPath), { recursive: true })
    fs.renameSync(target.playbackPath, target.finalPath)
    return { playbackPath: target.finalPath }
  }

  async abort(sessionId: string): Promise<void> {
    closeHandle(this.handles, sessionId)
  }

  isReady(session: StreamingSession): boolean {
    return session.bytesDownloaded >= FLAC_MIN_START_BYTES
      || session.completedSegments >= FLAC_MIN_START_SEGMENTS
      || session.completedSegments >= session.totalSegments
  }

  getTarget(sessionId: string): ProgressiveContainerTarget {
    const target = this.requirePaths(sessionId)
    return { playbackPath: target.playbackPath, sourcePath: target.sourcePath }
  }

  getPlaybackRevision(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0
  }

  private requirePaths(sessionId: string): AdapterPaths {
    const target = this.paths.get(sessionId)
    if (!target) throw new Error(`Unknown FLAC adapter session ${sessionId}`)
    return target
  }
}

export class M4aFlacRemuxAdapter implements ProgressiveContainerAdapter {
  private readonly directory: string
  private readonly ffmpeg: TidalProgressiveFfmpeg
  private readonly finalPathForManifest: (manifest: StreamManifest) => string
  private readonly handles = new Map<string, number>()
  private readonly paths = new Map<string, AdapterPaths>()
  private readonly revisions = new Map<string, number>()
  private readonly readySessions = new Set<string>()
  private readonly lastRemuxSegment = new Map<string, number>()

  constructor(options: {
    directory: string
    ffmpeg: TidalProgressiveFfmpeg
    finalPathForManifest: (manifest: StreamManifest) => string
  }) {
    this.directory = options.directory
    this.ffmpeg = options.ffmpeg
    this.finalPathForManifest = options.finalPathForManifest
  }

  canHandle(manifest: StreamManifest): boolean {
    return !manifest.encrypted
      && normalizedCodec(manifest) === 'FLAC'
      && (normalizedExtension(manifest) === '.m4a' || normalizedExtension(manifest) === '.mp4')
  }

  async prepare(session: StreamingSession): Promise<ProgressiveContainerTarget> {
    fs.mkdirSync(this.directory, { recursive: true })
    const target = {
      sourcePath: path.join(this.directory, `${session.sessionId}.source.m4a.part`),
      playbackPath: path.join(this.directory, `${session.sessionId}.playback.flac.part`),
      finalPath: this.finalPathForManifest(session.manifest),
    }
    this.paths.set(session.sessionId, target)
    this.revisions.set(session.sessionId, 0)
    await this.assertFfmpegAvailable(session.sessionId)
    this.handles.set(session.sessionId, fs.openSync(target.sourcePath, 'w'))
    console.info('[Streaming] M4A FLAC stream detected')
    console.info('Using M4aFlacRemuxAdapter')
    return target
  }

  async appendSegment(session: StreamingSession, segment: Buffer): Promise<void> {
    const handle = this.handles.get(session.sessionId)
    if (handle === undefined) throw new Error(`M4A adapter is not open for session ${session.sessionId}`)
    fs.writeSync(handle, segment)

    const nextBytes = session.bytesDownloaded + segment.byteLength
    const nextSegments = session.completedSegments + 1
    const thresholdReached = nextBytes >= M4A_MIN_START_BYTES
      || nextSegments >= M4A_MIN_START_SEGMENTS
      || nextSegments >= session.totalSegments
    const lastRemux = this.lastRemuxSegment.get(session.sessionId) ?? 0
    const shouldRefresh = this.readySessions.has(session.sessionId)
      && nextSegments - lastRemux >= M4A_REFRESH_SEGMENTS

    if (!thresholdReached && !shouldRefresh) return

    try {
      await this.remuxAndPublish(session)
      this.lastRemuxSegment.set(session.sessionId, nextSegments)
      if (!this.readySessions.has(session.sessionId)) {
        this.readySessions.add(session.sessionId)
        console.info('[Streaming] Initial M4A remux successful')
        console.info('Starting playback from FLAC partial')
      }
    } catch (error) {
      if (!this.readySessions.has(session.sessionId)) {
        console.error('[Streaming] M4A progressive remux failed')
        throw error
      }
      console.warn('[Streaming] M4A refresh remux skipped:', error)
    }
  }

  async finalize(session: StreamingSession): Promise<FinalizedCacheFile> {
    closeHandle(this.handles, session.sessionId)
    const target = this.requirePaths(session.sessionId)
    await this.remuxAndPublish(session)
    fs.renameSync(target.playbackPath, target.finalPath)
    if (!fs.existsSync(target.finalPath)) {
      throw new Error('Final M4A remux did not produce a FLAC cache file')
    }
    console.info('[Streaming] Final M4A remux completed')
    console.info('Cached as FLAC')
    return { playbackPath: target.finalPath }
  }

  async abort(sessionId: string): Promise<void> {
    closeHandle(this.handles, sessionId)
    await this.ffmpeg.cancel(sessionId)
  }

  isReady(session: StreamingSession): boolean {
    return this.readySessions.has(session.sessionId)
  }

  getTarget(sessionId: string): ProgressiveContainerTarget {
    const target = this.requirePaths(sessionId)
    return { playbackPath: target.playbackPath, sourcePath: target.sourcePath }
  }

  getPlaybackRevision(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0
  }

  private async assertFfmpegAvailable(sessionId: string): Promise<void> {
    await this.ffmpeg.assertAvailable(sessionId)
  }

  private async remuxAndPublish(session: StreamingSession): Promise<void> {
    const target = this.requirePaths(session.sessionId)
    const destination = target.playbackPath
    const temporaryPath = `${destination}.refresh-${Date.now()}-${Math.random().toString(16).slice(2)}`
    fs.mkdirSync(path.dirname(destination), { recursive: true })

    let ffmpegError: unknown = null
    try {
      await this.ffmpeg.remux(session.sessionId, target.sourcePath, temporaryPath)
    } catch (error) {
      ffmpegError = error
    }

    try {
      const requireDuration = !this.readySessions.has(session.sessionId)
      const validation = await validateTidalProgressiveFlacFile(
        this.ffmpeg, session.sessionId, temporaryPath, { requireDuration },
      )
      if (validation.codec.trim().toUpperCase() !== 'FLAC') {
        throw new Error(`Remuxed output codec is ${validation.codec || 'unknown'}, expected FLAC`)
      }
      if (
        validation.sampleRate <= 0
        || validation.channels <= 0
        || (requireDuration && validation.duration <= 0)
      ) {
        throw new Error('Remuxed FLAC failed sample rate, channel, or duration validation')
      }
      const extended = fs.existsSync(destination)
        ? await this.extendPublishedFile(destination, temporaryPath)
        : false
      if (!extended) {
        fs.renameSync(temporaryPath, destination)
        if (this.readySessions.has(session.sessionId)) {
          console.warn('[Streaming] FLAC snapshot prefix changed; replaced playback file')
        }
      }
      this.revisions.set(session.sessionId, (this.revisions.get(session.sessionId) ?? 0) + 1)
    } catch (validationError) {
      try {
        fs.unlinkSync(temporaryPath)
      } catch {
        // Best-effort cleanup of an invalid refresh file.
      }
      if (ffmpegError) {
        const message = ffmpegError instanceof Error ? ffmpegError.message : String(ffmpegError)
        throw new Error(`ffmpeg stream-copy remux failed: ${message}`)
      }
      throw validationError
    }
  }

  private async extendPublishedFile(destination: string, candidate: string): Promise<boolean> {
    const [destinationStat, candidateStat] = await Promise.all([
      fs.promises.stat(destination),
      fs.promises.stat(candidate),
    ])
    if (candidateStat.size < destinationStat.size) return false

    const destinationHandle = await fs.promises.open(destination, 'r')
    const candidateHandle = await fs.promises.open(candidate, 'r')
    try {
      const probeOffsets = destinationStat.size <= PREFIX_PROBE_BYTES * 2
        ? [0]
        : [0, destinationStat.size - PREFIX_PROBE_BYTES]
      for (const offset of probeOffsets) {
        const length = Math.min(PREFIX_PROBE_BYTES, destinationStat.size - offset)
        const destinationChunk = Buffer.allocUnsafe(length)
        const candidateChunk = Buffer.allocUnsafe(length)
        const [destinationRead, candidateRead] = await Promise.all([
          destinationHandle.read(destinationChunk, 0, length, offset),
          candidateHandle.read(candidateChunk, 0, length, offset),
        ])
        if (
          destinationRead.bytesRead !== length
          || candidateRead.bytesRead !== length
          || !destinationChunk.equals(candidateChunk)
        ) return false
      }
    } finally {
      await Promise.all([destinationHandle.close(), candidateHandle.close()])
    }

    if (candidateStat.size > destinationStat.size) {
      await pipeline(
        fs.createReadStream(candidate, { start: destinationStat.size }),
        fs.createWriteStream(destination, { flags: 'a' }),
      )
    }
    await fs.promises.unlink(candidate)
    return true
  }

  private requirePaths(sessionId: string): AdapterPaths {
    const target = this.paths.get(sessionId)
    if (!target) throw new Error(`Unknown M4A adapter session ${sessionId}`)
    return target
  }
}
