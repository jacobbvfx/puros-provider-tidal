import type { ProviderHelpersHostV1 } from 'puros-provider-sdk'
import type { TidalStoredSession } from './types'

interface HelperResult<T> {
  event: 'result'
  ok: boolean
  result?: T
  session?: TidalStoredSession
  error?: string
}

export interface TidalHelperEnvelope<T> {
  ok: true
  result?: T
  session?: TidalStoredSession
}

export type TidalHelperEvent = Record<string, unknown> & { event: string }

/** Private NDJSON transport for the declared Tidal helper. No output is sent to the renderer. */
export class TidalHelperTransport {
  constructor(private readonly helpers: ProviderHelpersHostV1) {}

  async run<T>(
    command: string,
    payload: Record<string, unknown>,
    onEvent?: (event: TidalHelperEvent) => Promise<void> | void,
  ): Promise<TidalHelperEnvelope<T>> {
    const { handleId } = await this.helpers.spawn({ binaryId: 'bridge', args: [command] })
    const decoder = new TextDecoder()
    let stdout = ''
    let stderr = ''
    let result: HelperResult<T> | null = null
    let exited = false

    const acceptLine = async (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let event: unknown
      try {
        event = JSON.parse(trimmed)
      } catch {
        return // The helper may print non-protocol diagnostics before its result.
      }
      if (!event || typeof event !== 'object' || typeof (event as { event?: unknown }).event !== 'string') return
      const parsed = event as TidalHelperEvent
      if (parsed.event === 'result') result = parsed as unknown as HelperResult<T>
      await onEvent?.(parsed)
    }

    const acceptStdout = async (chunk: Uint8Array) => {
      stdout += decoder.decode(chunk, { stream: true })
      while (true) {
        const newline = stdout.indexOf('\n')
        if (newline < 0) break
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        await acceptLine(line)
      }
    }

    try {
      await this.helpers.write({ handleId, data: JSON.stringify(payload) })
      await this.helpers.closeStdin(handleId)
      while (!exited) {
        const event = await this.helpers.read(handleId)
        if (event.type === 'stdout') await acceptStdout(event.data)
        else if (event.type === 'stderr') stderr = (stderr + new TextDecoder().decode(event.data)).slice(-64 * 1024)
        else if (event.type === 'error') throw new Error(event.message)
        else exited = true
      }
      stdout += decoder.decode()
      if (stdout.trim()) await acceptLine(stdout)
      if (!result) throw new Error(stderr.trim() || 'Tidal helper did not return a result')
      const envelope: HelperResult<T> = result
      if (!envelope.ok) throw new Error(envelope.error || stderr.trim() || 'Tidal helper failed')
      return { ok: true, result: envelope.result, session: envelope.session }
    } catch (error) {
      await this.helpers.terminate(handleId).catch(() => {})
      throw error
    }
  }
}
