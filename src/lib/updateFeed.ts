/**
 * LUNAR_UPDATE_FEED_URL (testing an update without publishing, docs/packaging.md) may
 * point the updater only at this computer or the home network: "localhost" or a loopback /
 * private IPv4 address as the WHOLE host. A prefix match let http://localhost.example.test
 * or http://10.example.test through, and an unsigned build has no publisher check to
 * catch a redirected feed.
 */
export function isLocalUpdateFeed(raw: string | undefined | null): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname
  if (host === 'localhost') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b, c, d] = m.slice(1).map(Number)
  if ([a, b, c, d].some((n) => n > 255)) return false
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  )
}
