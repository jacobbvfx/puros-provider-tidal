/** Preserve the provider CDN's existing large-artwork URL convention. */
export function getDisplayArtworkUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'resources.tidal.com') {
      return null
    }
    url.pathname = url.pathname.replace(/\/\d+x\d+\.(jpe?g|png)$/i, '/1280x1280.$1')
    return url.toString()
  } catch {
    return null
  }
}
