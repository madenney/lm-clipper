// What the newer usage events carry (2026-11-18, the owner's ask: enough to learn later how people really use
// the app and where it fails them). Every payload is small, anonymous and bounded: settings are reported only for
// switches, choices and numbers (never a folder, file, text or name), errors only as a short kind, never their
// message. The website keeps exactly these fields (apps/website/src/utils/appUsageData.ts). docs/telemetry-api.md.
import { videoConfig } from '../constants/config'

/** Settings whose value may be reported: Settings' checkboxes, dropdowns and number fields only. */
const REPORTABLE_TYPES = new Set(['checkbox', 'dropdown', 'int'])
const REPORTABLE_SETTINGS: ReadonlySet<string> = new Set(
  (videoConfig as { id?: string; type?: string }[])
    .filter(
      (s) => typeof s.id === 'string' && REPORTABLE_TYPES.has(String(s.type)),
    )
    .map((s) => s.id as string),
)
// The usage choice reports itself (usage_opt_out / usage_opt_in); bookkeeping is not a setting.
const NEVER = new Set(['sendAnonymousUsage', 'consentNoticeSeen'])

/** A dropdown value is a short code ("1080p", "fast_lossless"), never free text. */
const ENUM_RE = /^[A-Za-z0-9_.:x-]{1,32}$/

/** `{ key, value }` for a setting change worth reporting, or null. */
export function settingChange(
  key: unknown,
  value: unknown,
): { key: string; value: boolean | number | string } | null {
  if (
    typeof key !== 'string' ||
    NEVER.has(key) ||
    !REPORTABLE_SETTINGS.has(key)
  )
    return null
  if (typeof value === 'boolean') return { key, value }
  if (typeof value === 'number' && Number.isFinite(value)) return { key, value }
  if (typeof value === 'string' && ENUM_RE.test(value)) return { key, value }
  return null
}

/** Whether a setting key is one that is reported (for tests and the docs). */
export function isReportableSetting(key: string): boolean {
  return REPORTABLE_SETTINGS.has(key) && !NEVER.has(key)
}

/**
 * A failure as one short kind, from its message. The message itself is never sent (it can hold paths and
 * names). Unknown failures are 'other'.
 */
export function errorKind(err: unknown): string {
  const m = String(
    (err as { message?: unknown })?.message ?? err ?? '',
  ).toLowerCase()
  if (!m) return 'other'
  if (/no space|disk full|enospc/.test(m)) return 'disk_full'
  if (/eacces|eperm|permission|access is denied|not permitted/.test(m))
    return 'permission'
  if (/\biso\b|disc image|gale01|not a melee/.test(m)) return 'iso'
  if (/dolphin|playback|frame stall|emulat/.test(m)) return 'dolphin'
  if (/ffmpeg|encod|codec|utvideo|produced no video|muxer/.test(m))
    return 'ffmpeg'
  if (/enoent|not found|missing|no such file/.test(m)) return 'missing_file'
  if (/timed? ?out|timeout/.test(m)) return 'timeout'
  if (/network|econn|enotfound|socket|fetch failed/.test(m)) return 'network'
  return 'other'
}

/** The recording settings a render ran with, as reportable values only (settingChange's rules). */
export function renderSettings(
  config: Record<string, unknown>,
): Record<string, boolean | number | string> {
  const keys = [
    'resolution',
    'recordingFormat',
    'videoCodec',
    'videoQualityMode',
    'videoPreset',
    'widescreen',
    'concatenate',
    'convertToMp4',
    'includeGameEnding',
    'hideHud',
    'fixedCamera',
    'muteRecordings',
    'hideRecordingWindows',
    'keepLosslessMaster',
    'gameMusic',
    'numCPUs',
  ]
  const out: Record<string, boolean | number | string> = {}
  for (const k of keys) {
    const v = config[k]
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      out[k] = v
    else if (typeof v === 'string' && ENUM_RE.test(v)) out[k] = v
  }
  // The text overlay: on/off, its position and size only, never its words or font.
  out.overlay = config.overlayEnabled === true
  if (
    typeof config.overlayPosition === 'string' &&
    ENUM_RE.test(config.overlayPosition)
  )
    out.overlayPosition = config.overlayPosition
  if (
    typeof config.overlayFontSize === 'number' &&
    Number.isFinite(config.overlayFontSize)
  )
    out.overlayFontSize = config.overlayFontSize
  out.customFont =
    typeof config.overlayFont === 'string' && config.overlayFont.length > 0
  return out
}

/** Features counted when used (feature_used). Keep in step with the website's list. */
export const FEATURES = ['play_clip', 'record_clip', 'auto_import'] as const
export type Feature = (typeof FEATURES)[number]
