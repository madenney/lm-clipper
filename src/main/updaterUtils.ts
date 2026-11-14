/** The test update feed (LUNAR_UPDATE_FEED_URL) may only be this computer or the
 *  home network, and the whole host must match: "localhost.example.com" or
 *  "10.evil.com" is not local. */
export function isLocalTestFeed(value: string): boolean {
  return /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d{1,5})?(\/|$)/.test(
    value,
  )
}

/** An updater error for the banner: one short line, not a stack or a page of text. */
export function shortUpdateError(
  message: string | undefined,
  fallback: string,
): string {
  const line = (message ?? '').split('\n')[0].trim()
  if (!line) return fallback
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}
