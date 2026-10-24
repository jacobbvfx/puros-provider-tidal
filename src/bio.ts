const WIMP_LINK = /\[wimpLink\s+(artist|album|track|playlist)Id="([^"]+)"\s*\]([\s\S]*?)\[\/wimpLink\]/gi
const ANY_WIMP_TAG = /\[\/?wimpLink[^\]]*\]/gi
const LINE_BREAK = /<br\s*\/?>/gi
const HTML_TAG = /<\/?[a-z][^>]*>/gi

/**
 * TIDAL bios carry `[wimpLink artistId="…"]Name[/wimpLink]` references and
 * `<br/>` breaks. Converts them to the SDK bio format: blank lines between
 * paragraphs and `[Name](puros:artist/<sourceId>)` links to this provider.
 */
export function normalizeTidalBio(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  const text = value
    .replace(WIMP_LINK, (_match, type: string, id: string, label: string) => {
      const name = label.replace(/[[\]]/g, '').trim()
      return name ? `[${name}](puros:${type.toLowerCase()}/${encodeURIComponent(id)})` : ''
    })
    .replace(ANY_WIMP_TAG, '')
    .replace(LINE_BREAK, '\n\n')
    .replace(HTML_TAG, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}
