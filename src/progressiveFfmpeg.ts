import type { ProviderHelpersHostV1 } from 'puros-provider-sdk'

const REMUX_TIMEOUT_MS = 30_000
const VERSION_TIMEOUT_MS = 10_000
const MAX_STDERR_CHARS = 64 * 1024

/** Provider-owned ffmpeg commands; the host validates every argv and cache path. */
export class TidalProgressiveFfmpeg {
  private readonly active = new Map<string, string>()
  private readonly busy = new Set<string>()
  private readonly cancelled = new Set<string>()

  constructor(private readonly helpers: ProviderHelpersHostV1) {}

  async assertAvailable(sessionId: string): Promise<void> {
    await this.run(sessionId, 'progressive-version', ['-version'], VERSION_TIMEOUT_MS)
  }

  async remux(sessionId: string, sourcePath: string, temporaryPath: string): Promise<void> {
    await this.run(sessionId, 'progressive-remux', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
      '-y', '-i', sourcePath, '-map', '0:a:0', '-c:a', 'copy',
      '-map_metadata', '0:g', '-f', 'flac', temporaryPath,
    ], REMUX_TIMEOUT_MS)
  }

  async probeDuration(sessionId: string, filePath: string): Promise<number> {
    const stderr = await this.run(sessionId, 'progressive-duration', [
      '-hide_banner', '-nostdin', '-threads', '1', '-i', filePath,
      '-map', '0:a:0', '-f', 'null', '-',
    ], REMUX_TIMEOUT_MS)
    const timestamps = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
    const last = timestamps[timestamps.length - 1]
    return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : 0
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.add(sessionId)
    const handleId = this.active.get(sessionId)
    if (handleId) await this.helpers.terminate(handleId)
  }

  private async run(sessionId: string, binaryId: string, args: string[], timeoutMs: number): Promise<string> {
    if (this.cancelled.has(sessionId)) throw new Error('ffmpeg session was cancelled')
    if (this.busy.has(sessionId)) throw new Error(`ffmpeg is already running for session ${sessionId}`)
    this.busy.add(sessionId)
    let handleId: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      handleId = (await this.helpers.spawn({ binaryId, args })).handleId
      this.active.set(sessionId, handleId)
      if (this.cancelled.has(sessionId)) throw new Error('ffmpeg session was cancelled')
      await this.helpers.closeStdin(handleId)
      const activeHandle = handleId
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void this.helpers.terminate(activeHandle).catch(() => {})
          reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })
      const stderr = await Promise.race([this.collect(handleId), timeout])
      if (this.cancelled.has(sessionId)) throw new Error('ffmpeg session was cancelled')
      return stderr
    } catch (error) {
      if (handleId) await this.helpers.terminate(handleId).catch(() => {})
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (this.active.get(sessionId) === handleId) this.active.delete(sessionId)
      this.busy.delete(sessionId)
    }
  }

  private async collect(handleId: string): Promise<string> {
    let stderr = ''
    while (true) {
      const event = await this.helpers.read(handleId)
      if (event.type === 'stderr') stderr = (stderr + Buffer.from(event.data).toString()).slice(-MAX_STDERR_CHARS)
      if (event.type === 'error') throw new Error(event.message)
      if (event.type !== 'exit') continue
      if (event.exitCode !== 0) throw new Error(stderr.trim() || `ffmpeg exited with code ${event.exitCode}`)
      return stderr
    }
  }
}
