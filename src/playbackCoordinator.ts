import type { ProviderHostV1 } from 'puros-provider-sdk'
import type { TidalPlaybackInfo } from './types'
import type { TidalPlaybackService } from './TidalPlaybackService'

const REQUEST_COOLDOWN_MS = 5_000

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('too many requests') || normalized.includes('429')
}

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('unauthorized') || normalized.includes('401') || normalized.includes('token')
}

function candidates(trackIds: string[]): string[] {
  return [...new Set(trackIds.filter(Boolean))]
}

/** Provider-owned single-flight, fallback, cooldown, and cache policy for completed downloads. */
export class TidalPlaybackCoordinator {
  private readonly tasks = new Map<string, Promise<TidalPlaybackInfo>>()
  private cooldownUntil = 0

  private constructor(
    private readonly host: ProviderHostV1,
    private readonly playback: TidalPlaybackService,
    private readonly qualityKey: string,
    private readonly cacheRoot: string,
  ) {}

  static async create(host: ProviderHostV1, playback: TidalPlaybackService, qualityKey: string) {
    return new TidalPlaybackCoordinator(host, playback, qualityKey, await host.paths.getCacheRoot())
  }

  clearTasks(): void { this.tasks.clear() }

  async getCached(trackIds: string[]): Promise<TidalPlaybackInfo | null> {
    for (const trackId of candidates(trackIds)) {
      const cached = await this.host.cache.get({ sourceId: trackId, qualityKey: this.qualityKey })
      if (cached) {
        console.info('[Puros][TIDAL] Playback cache hit:', trackId)
        return {
          playbackPath: cached.path,
          quality: cached.format,
          resolvedTrackId: cached.resolvedSourceId,
          resolvedQuality: cached.resolvedQuality,
          cacheHit: true,
        }
      }
    }
    return null
  }

  async resolve(trackIds: string[], options: { allowRecovery?: boolean; emitWarning?: boolean } = {}): Promise<TidalPlaybackInfo> {
    const trackIdsToTry = candidates(trackIds)
    let lastError: unknown = null
    if (trackIdsToTry.length > 1) console.info('[Puros][TIDAL] Trying playback candidates:', trackIdsToTry.join(', '))

    const cached = await this.getCached(trackIdsToTry)
    if (cached) return cached

    for (const trackId of trackIdsToTry) {
      try {
        const resolved = await this.getOrCreateTask(trackId, options.allowRecovery !== false)
        if (trackIdsToTry.length > 1 && trackId !== trackIdsToTry[0]) {
          console.info('[Puros][TIDAL] Playback fallback succeeded with:', trackId)
        }
        return resolved
      } catch (error) {
        lastError = error
        if (isRateLimitError(error)) this.noteRateLimit(error, options.emitWarning === false)
        console.warn('[Puros][TIDAL] Playback candidate failed:', trackId, error instanceof Error ? error.message : String(error))
        if (isRateLimitError(error)) break
      }
    }

    if (trackIdsToTry.length > 1) console.error('[Puros][TIDAL] All playback candidates failed:', trackIdsToTry.join(', '))
    if (options.emitWarning !== false) await this.emitOperationalWarning(lastError)
    throw lastError instanceof Error ? lastError : new Error('Unable to resolve a playable TIDAL stream')
  }

  async prefetch(trackIds: string[]): Promise<TidalPlaybackInfo | null> {
    if (this.cooldownUntil > Date.now()) {
      console.info('[Puros][TIDAL] Prefetch skipped during cooldown')
      return null
    }
    try {
      return await this.resolve(trackIds.slice(0, 1), { allowRecovery: false, emitWarning: false })
    } catch (error) {
      console.warn('[Puros][TIDAL] Prefetch skipped:', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  private getOrCreateTask(trackId: string, allowRecovery: boolean): Promise<TidalPlaybackInfo> {
    const key = `${trackId}:${allowRecovery ? 'recovery' : 'direct'}`
    const existing = this.tasks.get(key)
    if (existing) return existing
    const task = this.prepare(trackId, allowRecovery).finally(() => { this.tasks.delete(key) })
    this.tasks.set(key, task)
    return task
  }

  private async prepare(trackId: string, allowRecovery: boolean): Promise<TidalPlaybackInfo> {
    const cached = await this.getCached([trackId])
    if (cached) {
      await this.persistFormat(trackId, cached)
      await this.host.events.scheduleLibraryCatalogRefreshWhenIdle()
      return cached
    }

    const waitMs = this.cooldownUntil - Date.now()
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    const playbackInfo = await this.playback.getPlaybackInfo(trackId, undefined, {
      allowRecovery,
      outputDir: this.cacheRoot,
    })
    if (playbackInfo.recoveryTrace?.length) {
      console.info('[Puros][TIDAL] Helper recovery trace for', trackId, ':', playbackInfo.recoveryTrace.join(' | '))
    }
    if (playbackInfo.resolvedTrackId && playbackInfo.resolvedTrackId !== trackId) {
      console.info('[Puros][TIDAL] Resolved stale playback track', trackId, '->', playbackInfo.resolvedTrackId)
    }
    const actualQuality = await this.host.cache.inspectFormat(playbackInfo.playbackPath)
    const resolved = { ...playbackInfo, quality: actualQuality ?? playbackInfo.quality }
    await this.persistFormat(trackId, resolved)
    await this.host.events.scheduleLibraryCatalogRefreshWhenIdle()
    await this.host.cache.put({
      sourceId: trackId,
      qualityKey: this.qualityKey,
      path: resolved.playbackPath,
      format: resolved.quality,
      resolvedSourceId: resolved.resolvedTrackId,
      resolvedQuality: resolved.resolvedQuality,
    })
    await this.host.cache.trim()
    return resolved
  }

  private async persistFormat(sourceId: string, info: TidalPlaybackInfo): Promise<void> {
    await this.host.catalog.updateTrackFormat({ sourceId, format: info.quality })
    if (info.resolvedTrackId && info.resolvedTrackId !== sourceId) {
      await this.host.catalog.updateTrackFormat({ sourceId: info.resolvedTrackId, format: info.quality })
    }
  }

  private noteRateLimit(error: unknown, silent: boolean): void {
    if (!isRateLimitError(error)) return
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + REQUEST_COOLDOWN_MS)
    if (silent) return
    console.warn('[Puros][TIDAL] Rate limit detected, applying cooldown')
    void this.host.events.emit({
      type: 'warning', code: 'rate_limited',
      message: 'TIDAL is rate limiting requests. Puros will retry shortly.', retryable: true,
    })
  }

  private async emitOperationalWarning(error: unknown): Promise<void> {
    if (isRateLimitError(error)) { this.noteRateLimit(error, false); return }
    if (isAuthError(error)) {
      await this.host.events.emit({
        type: 'warning', code: 'auth_expired',
        message: 'Your TIDAL session expired. Please reconnect your account.', retryable: false,
      })
      return
    }
    await this.host.events.emit({
      type: 'warning', code: 'playback_failed',
      message: 'Puros could not resolve a playable TIDAL stream for this track right now.', retryable: true,
    })
  }
}
