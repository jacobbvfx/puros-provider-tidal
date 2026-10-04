import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProviderHelpersHostV1 } from 'puros-provider-sdk'

/** Remux a completed cache file through the manifest-declared host helper. */
export async function remuxFlacThroughHost(helpers: ProviderHelpersHostV1, sourcePath: string): Promise<string> {
  const targetPath = path.join(path.dirname(sourcePath), `${path.basename(sourcePath, path.extname(sourcePath))}.flac`)
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.flac`)
  const args = [
    '-y', '-hide_banner', '-nostdin', '-i', sourcePath,
    '-map', '0', '-movflags', 'use_metadata_tags', '-c:a', 'copy',
    '-map_metadata', '0:g', '-loglevel', 'quiet', temporaryPath,
  ]
  let handleId: string | undefined
  try {
    handleId = (await helpers.spawn({ binaryId: 'remux', args })).handleId
    await helpers.closeStdin(handleId)
    let stderr = ''
    while (true) {
      const event = await helpers.read(handleId)
      if (event.type === 'stderr') stderr = (stderr + new TextDecoder().decode(event.data)).slice(-64 * 1024)
      if (event.type === 'error') throw new Error(event.message)
      if (event.type !== 'exit') continue
      if (event.exitCode !== 0) throw new Error(stderr.trim() || `ffmpeg exited with code ${event.exitCode}`)
      break
    }
    const stat = await fs.stat(temporaryPath)
    if (!stat.isFile() || stat.size === 0) throw new Error('ffmpeg produced no FLAC output')
    try {
      await fs.link(temporaryPath, targetPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await fs.stat(targetPath)
      if (!existing.isFile() || existing.size === 0) throw error
    }
    return targetPath
  } catch (error) {
    if (handleId) await helpers.terminate(handleId).catch(() => {})
    throw error
  } finally {
    await fs.unlink(temporaryPath).catch(() => {})
  }
}
