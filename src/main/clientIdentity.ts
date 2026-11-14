/*
 * How Clipper names itself to Lunar's website: a User-Agent and the app version
 * on every call, so the server can tell versions apart, show an "update" notice
 * or answer 426 to a build that is too old.
 *
 * No install id goes with these calls. It used to be sent as X-Lunar-Install-Id
 * "for per-install download limits", but the website never read it, and it went
 * out even when the user had turned usage stats off (analytics review F20). The
 * install id is for the anonymous usage events only, and only while they are on.
 */
import { app } from 'electron'

let versionOverride = ''

/** Set once at startup (controller) with the app version. */
export function setClientIdentity(identity: { version?: string }) {
  if (typeof identity.version === 'string') versionOverride = identity.version
}

function appVersion(): string {
  if (versionOverride) return versionOverride
  try {
    return app?.getVersion?.() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Same headers as clientHeaders (kept as a separate name for the storage and plan downloads). */
export function userAgentHeaders(): Record<string, string> {
  return clientHeaders()
}

/** Headers for every call to lunarmelee.com (and the storage it points at). */
export function clientHeaders(): Record<string, string> {
  const version = appVersion()
  return {
    'User-Agent': `LunarClipper/${version} (${process.platform}; ${process.arch})`,
    'X-Lunar-App-Version': version,
  }
}
