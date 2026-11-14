import type { HardwareProfile } from '../../constants/types'

/**
 * Soft limits for the performance settings: the user may set any number, but past
 * what this computer can run well we say so (Settings and the bottom bar).
 *  - Dolphin instances: each recording Dolphin keeps about two CPU threads busy
 *    (emulation + video encoding) and holds ~1 GB of memory. When Clipper has
 *    detected this computer (config.hardwareProfile), its pick is the limit.
 *  - Filter threads: more workers than CPU threads only adds overhead.
 *  - Recording resolution / format: heavy combinations on weak hardware.
 */
export function cpuThreads(): number {
  const n =
    typeof navigator !== 'undefined' ? Number(navigator.hardwareConcurrency) : 0
  return Number.isFinite(n) && n > 0 ? n : 4
}

/** Most Dolphins we'd recommend on a CPU with this many threads. */
export function recommendedDolphins(threads = cpuThreads()): number {
  return Math.max(1, Math.floor(threads / 2))
}

const RES_LABEL: Record<number, string> = {
  2: '1x',
  3: '1.5x',
  4: '2x',
  5: '2.5x',
  6: '3x',
  7: '4x',
  8: '5x',
  9: '6x',
  10: '7x',
  11: '8x',
}

export function performanceWarning(
  id: string,
  value: unknown,
  threads = cpuThreads(),
  hw: HardwareProfile | null = null,
): string | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (id === 'numCPUs') {
    const picked = hw?.picked?.numCPUs
    if (picked && n > picked)
      return `${n} Dolphins is more than we'd pick for this computer (${picked}: ${hw!.threads} CPU threads, ${Math.round(hw!.ramGB)} GB memory${hw!.integrated ? ', integrated graphics' : ''}). Too many can make recording slower, drop frames or run out of memory.`
    const max = recommendedDolphins(threads)
    if (!picked && n > max)
      return `${n} Dolphins is a lot for this computer (${threads} CPU threads; about ${max} is the most we'd suggest). Each one needs ~2 threads and ~1 GB of memory, so too many can make recording slower, drop frames or run out of memory.`
  }
  if (id === 'numFilterThreads') {
    if (n > threads)
      return `${n} threads is more than this computer's ${threads} CPU threads. Filtering won't get faster, and the app may stutter while it runs.`
  }
  return null
}

type RecordingSettings = {
  resolution?: number
  recordingFormat?: string
  hardwareProfile?: HardwareProfile | null
}

/**
 * A warning for a recording setting given the rest of the config and the
 * detected hardware, or null.
 */
export function recordingWarning(
  id: string,
  config: RecordingSettings,
  threads = config.hardwareProfile?.threads ?? cpuThreads(),
  platform: string | undefined = typeof window === 'undefined'
    ? undefined
    : (window as { electronPlatform?: string }).electronPlatform,
): string | null {
  const res = Number(config.resolution)
  const hw = config.hardwareProfile
  if (id === 'resolution' && res >= 7) {
    const why = hw?.integrated
      ? `integrated graphics (${hw.gpu})`
      : threads <= 8
        ? `${threads} CPU threads`
        : null
    if (why)
      return `${RES_LABEL[res] ?? 'This resolution'} is very heavy for this computer (${why}): recording may drop frames or run far slower than the game. 1x or 2x suits it better.`
  }
  if (id === 'recordingFormat' && res >= 4) {
    // Windows Slippi Dolphin has no UT Video encoder: "Fast" is MPEG-4 at
    // 150 Mb/s there (diskSpace.ts WINDOWS_AUTO_PLAN), lossless is FFV1 only.
    const windows = platform === 'win32'
    const format = config.recordingFormat || 'auto'
    if (format === 'lossless' && !windows)
      return `Lossless FFV1 at ${RES_LABEL[res] ?? 'this resolution'} is very slow; long clips may be cut off by the recording time limit. Fast lossless gives the same quality much faster.`
    if (format === 'lossless' && windows)
      return `On Windows, Slippi Dolphin can only record lossless as FFV1, which is very slow at ${RES_LABEL[res] ?? 'this resolution'} (about 3x longer than the clip at 2x). Fast is about 3.7x faster with no visible difference, or record at 1x.`
  }
  return null
}

/** Temporary disk per minute of footage for each Dolphin recording at once. */
export function tempGBPerMinute(
  resolution: number,
  format?: string,
  platform: string | undefined = typeof window === 'undefined'
    ? undefined
    : (window as { electronPlatform?: string }).electronPlatform,
): number {
  if (format === 'draft') return resolution <= 2 ? 0.3 : 1.1
  // Windows "Fast" above 1x: MPEG-4 at 150 Mb/s (at most ~1.1 GB a minute).
  if (platform === 'win32' && format !== 'lossless' && resolution > 2)
    return 1.1
  if (format === 'lossless' || resolution <= 2) return resolution <= 2 ? 1 : 2
  if (resolution <= 4) return 3
  if (resolution <= 6) return 10
  return 20
}

/**
 * A note on free disk for the Recording Format row: what's free where Dolphin's
 * temporary recordings go and where clips land, and a warning when it's tight.
 */
export function freeDiskNote(
  config: RecordingSettings & { numCPUs?: number },
): { text: string; low: boolean } | null {
  const hw = config.hardwareProfile
  if (!hw) return null
  const tmp = hw.scratchFreeDiskGB
  const out = hw.freeDiskGB
  if (tmp == null && out == null) return null
  const fmt = (gb: number) =>
    gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
  const parts: string[] = []
  if (tmp != null) parts.push(`${fmt(tmp)} free for temporary recordings`)
  if (out != null) parts.push(`${fmt(out)} free in the output folder`)
  const perMin =
    tempGBPerMinute(Number(config.resolution) || 2, config.recordingFormat) *
    Math.max(1, Number(config.numCPUs) || 1)
  // A 3-minute game per Dolphin, plus 2 GB to spare.
  const needed = perMin * 3 + 2
  const low = tmp != null && tmp < needed
  const text = `${parts.join(', ')}.${
    low
      ? ` That is tight: these settings use about ${Math.round(perMin)} GB per minute of footage while recording. Free some space, pick another Temporary Recording Folder (Paths), or lower the resolution.`
      : ''
  }`
  return { text, low }
}

/** One line describing the detected hardware and what was picked for it. */
export function hardwareSummary(hw: HardwareProfile | null | undefined) {
  if (!hw) return null
  const p = hw.picked
  return `${hw.threads} CPU threads · ${Math.round(hw.ramGB)} GB memory · ${hw.gpu}${hw.integrated ? ' (integrated)' : ''}. Picks: ${p.numCPUs} Dolphin${p.numCPUs === 1 ? '' : 's'}, ${RES_LABEL[p.resolution] ?? p.resolution} recording, ${p.videoPreset} encode, CRF ${p.crf}.`
}
