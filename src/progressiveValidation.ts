import type { TidalProgressiveFfmpeg } from './progressiveFfmpeg'

/** Validate a progressive FLAC snapshot without launching a provider binary directly. */
export async function validateTidalProgressiveFlacFile(
  ffmpeg: Pick<TidalProgressiveFfmpeg, 'probeDuration'>,
  sessionId: string,
  filePath: string,
  options: { requireDuration: boolean },
) {
  const mm = await import('music-metadata')
  const metadata = await mm.parseFile(filePath, { duration: true, skipCovers: true })
  let duration = metadata.format.duration ?? 0
  if (duration <= 0 && options.requireDuration) {
    duration = await ffmpeg.probeDuration(sessionId, filePath)
  }
  return {
    codec: metadata.format.codec ?? '',
    sampleRate: metadata.format.sampleRate ?? 0,
    channels: metadata.format.numberOfChannels ?? 0,
    duration,
  }
}
