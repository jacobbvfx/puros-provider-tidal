import type { TidalPlaybackInfo, TidalTrackFormatInfo } from './types'
import type { TidalApiService } from './TidalApiService'

export class TidalPlaybackService {
  private readonly api: TidalApiService

  constructor(options: {
    api: TidalApiService
    preferredQuality: 'LOW' | 'HIGH' | 'LOSSLESS' | 'HI_RES' | 'MAX'
  }) {
    this.api = options.api
  }

  async getStreamUrl(trackId: string): Promise<string> {
    const data = await this.api.getPlaybackInfo(trackId)
    const url = data.playbackPath
    if (!url) throw new Error('No Tidal stream URL returned for this track')
    return url
  }

  async getPlaybackInfo(
    trackId: string,
    onProgress?: (progress: number) => void,
    options?: { allowRecovery?: boolean; outputDir?: string },
  ): Promise<TidalPlaybackInfo> {
    return this.api.getPlaybackInfo(trackId, onProgress, options)
  }

  async getTrackFormats(trackIds: string[]): Promise<Record<string, TidalTrackFormatInfo>> {
    return this.api.getTrackFormats(trackIds)
  }
}
