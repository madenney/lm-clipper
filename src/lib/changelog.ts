import type { ChangelogEntry } from '../constants/changelog'

/** [major, minor, patch, prerelease ids] of "3.0.0" or "2.0.0-beta.5"; null when unreadable. */
function parseVersion(
  v: string,
): { nums: [number, number, number]; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    String(v ?? '').trim(),
  )
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** -1, 0 or 1 like semver (a prerelease sorts before its release); null if either is unreadable. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1
  }
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0
    return x.pre.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * The entries to show once after an update: everything newer than the version the user
 * last saw, up to the one they run now (newest first). Nothing when they have not
 * updated, or when the running version has no entry yet.
 */
export function entriesToShow(
  entries: ChangelogEntry[],
  lastSeen: string | undefined,
  current: string,
): ChangelogEntry[] {
  if (
    !current ||
    !entries.some((e) => compareVersions(e.version, current) === 0)
  )
    return []
  if (lastSeen) {
    const seen = compareVersions(current, lastSeen)
    if (seen === null || seen <= 0) return []
  }
  return entries.filter((e) => {
    const upToNow = compareVersions(e.version, current)
    if (upToNow === null || upToNow > 0) return false
    if (!lastSeen) return upToNow === 0 // no history: only this version's notes
    return (compareVersions(e.version, lastSeen) ?? -1) > 0
  })
}
