import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderHelpersHostV1 } from 'puros-provider-sdk'
import { remuxFlacThroughHost } from './hostRemux'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Tidal host-launched FLAC remux', () => {
  it('uses the declared helper and publishes its output only after completion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-remux-'))
    roots.push(root)
    const source = path.join(root, 'track.m4a')
    fs.writeFileSync(source, 'source')
    let temporaryPath = ''
    const spawn = vi.fn(async ({ args }: { args?: string[] }) => {
      temporaryPath = args?.at(-1) ?? ''
      expect(args).toEqual([
        '-y', '-hide_banner', '-nostdin', '-i', source,
        '-map', '0', '-movflags', 'use_metadata_tags', '-c:a', 'copy',
        '-map_metadata', '0:g', '-loglevel', 'quiet', temporaryPath,
      ])
      expect(fs.existsSync(path.join(root, 'track.flac'))).toBe(false)
      fs.writeFileSync(temporaryPath, 'flac')
      return { handleId: 'remux-handle' }
    })
    const helpers = {
      spawn, closeStdin: vi.fn(async () => {}),
      read: vi.fn(async () => ({ type: 'exit', exitCode: 0, signal: null })),
      terminate: vi.fn(async () => {}),
    } as unknown as ProviderHelpersHostV1
    expect(await remuxFlacThroughHost(helpers, source)).toBe(path.join(root, 'track.flac'))
    expect(fs.readFileSync(path.join(root, 'track.flac'), 'utf8')).toBe('flac')
    expect(fs.existsSync(temporaryPath)).toBe(false)
    expect(spawn).toHaveBeenCalledWith({ binaryId: 'remux', args: expect.any(Array) })
  })

  it('removes incomplete output and leaves the downloaded source on ffmpeg failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-remux-'))
    roots.push(root)
    const source = path.join(root, 'track.m4a')
    fs.writeFileSync(source, 'source')
    let temporaryPath = ''
    const helpers = {
      spawn: vi.fn(async ({ args }: { args?: string[] }) => {
        temporaryPath = args?.at(-1) ?? ''
        fs.writeFileSync(temporaryPath, 'partial')
        return { handleId: 'remux-handle' }
      }),
      closeStdin: vi.fn(async () => {}),
      read: vi.fn(async () => ({ type: 'exit', exitCode: 1, signal: null })),
      terminate: vi.fn(async () => {}),
    } as unknown as ProviderHelpersHostV1
    await expect(remuxFlacThroughHost(helpers, source)).rejects.toThrow(/exited with code 1/)
    expect(fs.existsSync(temporaryPath)).toBe(false)
    expect(fs.readFileSync(source, 'utf8')).toBe('source')
    expect(fs.existsSync(path.join(root, 'track.flac'))).toBe(false)
  })
})
