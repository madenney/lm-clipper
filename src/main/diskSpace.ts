/* eslint-disable no-await-in-loop */
/*
 * Disk space, scratch folders and file moves for the clip recorder
 * (slpToVideo.ts). Kept apart from the recorder so the arithmetic and the
 * Windows-flavoured file handling can be tested without spawning anything.
 *
 * Why this exists: a recording dumps lossless video, and at 2x/3x that is GBs
 * per minute per worker. A run that started on a nearly full drive used to fail
 * every remaining clip one by one (each retried), leaving a pile of truncated
 * dumps next to the user's clips. Now the job is sized up front, checked before
 * each clip, and stopped with one message when the disk fills.
 */
import crypto from 'crypto'
import fs, { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import { lastFrameFromFooter } from 'slippi-dolphin-runner'
import { GAME_START_FRAME } from '../constants/frames'
import { ConfigInterface, ReplayInterface } from '../constants/types'
import { logMain } from './logger'
import {
  retryFs,
  freeBytesAt,
  existingAncestor as existingAncestorOf,
} from './fsRetry'
import {
  isSlpzPath,
  looksLikeSlp,
  readSlpzHead,
  slpzMetadata,
} from '../lib/slpz'

export const GiB = 1024 ** 3
export const MiB = 1024 ** 2

// --- Measured dump rates (slippi-dolphin-runner docs/background-and-mute.md,
// "Speed and codec"; 60 s of footage, emulationSpeed 0):
//   utvideo at EFB 4 (2x): 3.1 GB/min; at EFB 6 (3x): ~12 GB per 75 s game = 9.5 GB/min
//   ffv1    at EFB 4 (2x): 3.8 GB/min
//   mpeg4: whatever bitrate it is given (it caps lower: 0.57 GB/min measured at
//   150 Mb/s at 2x, and it never passes about 141 Mb/s, so bitrate × time is an
//   upper bound: 1.125 GB/min at 150 Mb/s). This sizes Windows "Fast" too
//   (WINDOWS_AUTO_PLAN), whatever the resolution.
// Other resolutions scale with the pixel count. GB here = 1e9 bytes (what the
// measurements reported).
const GB = 1e9
const UTVIDEO_GB_PER_MIN_2X = 3.1
const UTVIDEO_GB_PER_MIN_3X = 9.5
const FFV1_GB_PER_MIN_2X = 3.8
// Dolphin's audio dump: 16-bit stereo PCM, at most 48 kHz.
const WAV_BYTES_PER_MIN = 48000 * 2 * 2 * 60
// Encodes are sized from the target bitrate. CRF has no target, so assume a
// generous 30 Mb/s for 1080p (Melee at CRF 18 lands well under it), scaled by
// pixels above that, and 4x that for near-lossless CRFs.
const CRF_ASSUMED_KBPS_1080P = 30000
const AUDIO_KBPS = 128
// Every estimate is padded: dump sizes vary with what's on screen.
const SAFETY = 1.2
/** Left free on any drive we write to, before and during a run. */
export const DISK_FLOOR_BYTES = 1 * GiB
/** A replay we could not size (no lastFrame anywhere): assume a long game. */
const UNKNOWN_GAME_SEC = 4 * 60
// The pre-GO! frames and the 60-frame lead-in slpToVideo adds.
const LEAD_IN_FRAMES = 60

// EFBScale enum → internal-resolution multiplier (the runner's ProfileOptions
// docs: 2 = 1x native, 3 = 1.5x, 4 = 2x, 5 = 2.5x, 6 = 3x, 7 = 4x, 8 = 5x).
// 0/1 are window-sized ("auto"): assume 3x, the worst common case.
const EFB_MULTIPLIER: Record<number, number> = {
  2: 1,
  3: 1.5,
  4: 2,
  5: 2.5,
  6: 3,
  7: 4,
  8: 5,
  9: 6,
  10: 7,
  11: 8,
}
export const efbMultiplier = (resolution: number): number =>
  EFB_MULTIPLIER[resolution] ?? 3

/** The codec Dolphin dumps in, mirroring slpToVideo's dumpCodecFor (kept here
 *  so the estimate needs no Electron imports). */
export type DumpPlan = {
  dumpCodec: 'ffv1' | 'utvideo' | 'mpeg4'
  bitrateKbps?: number
}
export const NATIVE_RESOLUTION = 2

/**
 * The width of Dolphin's dump for a recording, in pixels: the height (528 x the
 * resolution multiplier) times the picture's shape, rounded UP. 16:9 with the
 * widescreen code, Melee's own 73:60 without. Measured on the Linux Playback
 * build at every multiplier from 1x to 5x, both shapes (2026-11-15):
 * 939, 1408, 1878, 2347, 2816, 3755, 4694 wide; 643, 964, 1285, 1606, 1928,
 * 2570, 3212 without. Null for the window-sized settings (0, 1).
 */
export const dumpWidthFor = (
  config: Pick<ConfigInterface, 'resolution' | 'widescreen'>,
): number | null => {
  const m = EFB_MULTIPLIER[config.resolution]
  if (!m) return null
  const height = 528 * m
  return Math.ceil(
    config.widescreen !== false ? (height * 16) / 9 : (height * 73) / 60,
  )
}
export const DRAFT_MPEG4_KBPS_NATIVE = 40000
export const DRAFT_MPEG4_KBPS = 150000
/**
 * Windows "auto" above native: MPEG-4 at 150 Mb/s. Windows Playback has no UT
 * Video encoder, and FFV1 there is 0.34x real time at 2x and 0.16x at 3x;
 * MPEG-4 at 150 Mb/s was 1.26x and 0.62x, 49-51 dB PSNR against FFV1
 * (slippi-dolphin-runner 0.5.8 README, Windows rig, hidden, 10 s clip).
 * Native stays FFV1 (1.19x there, lossless).
 */
export const WINDOWS_AUTO_PLAN: DumpPlan = {
  dumpCodec: 'mpeg4',
  bitrateKbps: DRAFT_MPEG4_KBPS,
}

export const recordingFormatOf = (
  config: ConfigInterface,
): 'auto' | 'lossless' | 'draft' => {
  const f = (config as { recordingFormat?: string }).recordingFormat
  if (f === 'auto' || f === 'lossless' || f === 'draft') return f
  return config.fastDraft ? 'draft' : 'auto'
}

/** Windows, the way the rest of the recorder asks (tests mock os.type). */
export const isWindowsPlatform = (): boolean => os.type() === 'Windows_NT'

/**
 * The dump encoders the platform's Slippi Playback Dolphin actually has.
 * Windows Playback (3.5.2) links FFmpeg 3.2.4 built with only the FFV1 and
 * MPEG-4 encoders (measured on the Windows rig, 2026-10-15): utvideo, ffvhuff,
 * huffyuv, magicyuv and zmbv log "Could not find encoder or allocate codec
 * context" on every frame, write NO video and exit 0 (or crash with
 * 0xC0000409 on a hidden desktop); libx264/h264_nvenc are unknown names and
 * silently fall back to MPEG-4. The Linux AppImage has the full set.
 */
export const dumpCodecsAvailable = (
  windows: boolean = isWindowsPlatform(),
): ReadonlyArray<DumpPlan['dumpCodec']> =>
  windows ? ['ffv1', 'mpeg4'] : ['ffv1', 'utvideo', 'mpeg4']

/** Null when this platform's Dolphin can dump `codec`, else why not (for the user). */
export const dumpCodecProblem = (
  codec: string,
  windows: boolean = isWindowsPlatform(),
): string | null =>
  (dumpCodecsAvailable(windows) as readonly string[]).includes(codec)
    ? null
    : `Slippi Dolphin on ${windows ? 'Windows' : 'this system'} cannot record with the ${codec} codec (it has ${dumpCodecsAvailable(windows).join(' and ')} only)`

export const dumpPlanFor = (
  config: ConfigInterface,
  windows: boolean = isWindowsPlatform(),
): DumpPlan => {
  const native = config.resolution === NATIVE_RESOLUTION
  const format = recordingFormatOf(config)
  if (format === 'lossless') return { dumpCodec: 'ffv1' }
  if (format === 'draft')
    return {
      dumpCodec: 'mpeg4',
      bitrateKbps: native ? DRAFT_MPEG4_KBPS_NATIVE : DRAFT_MPEG4_KBPS,
    }
  if (native) return { dumpCodec: 'ffv1' }
  // Fast lossless is UT Video, which Windows Playback cannot encode (above):
  // there "Fast" records high-bitrate MPEG-4 (WINDOWS_AUTO_PLAN).
  if (windows) return WINDOWS_AUTO_PLAN
  // UT Video cannot open an odd width ("Could not open codec": Dolphin exits 0
  // with no video). Native is one such size; so are 2.5x and 4x widescreen and
  // 2x without widescreen, which recorded nothing until this was checked
  // (2026-11-15). Those record as Windows does: MPEG-4 at 150 Mb/s (FFV1 there
  // was lossless but slow, a 4 s clip at 4x took 112 s; owner's choice).
  const width = dumpWidthFor(config)
  if (width !== null && width % 2 === 1) return WINDOWS_AUTO_PLAN
  return { dumpCodec: 'utvideo' }
}

/** Bytes per minute of Dolphin's video dump for this config. */
export const dumpBytesPerMin = (
  config: ConfigInterface,
  windows: boolean = isWindowsPlatform(),
): number => {
  const plan = dumpPlanFor(config, windows)
  const m = efbMultiplier(config.resolution)
  if (plan.dumpCodec === 'mpeg4')
    return ((plan.bitrateKbps || DRAFT_MPEG4_KBPS) * 1000 * 60) / 8
  if (plan.dumpCodec === 'ffv1') return FFV1_GB_PER_MIN_2X * GB * (m / 2) ** 2
  // utvideo: both measured points, interpolated by pixel count between them.
  if (m <= 2) return UTVIDEO_GB_PER_MIN_2X * GB * (m / 2) ** 2
  if (m >= 3) return UTVIDEO_GB_PER_MIN_3X * GB * (m / 3) ** 2
  const t = (m * m - 4) / (9 - 4)
  return (
    (UTVIDEO_GB_PER_MIN_2X +
      t * (UTVIDEO_GB_PER_MIN_3X - UTVIDEO_GB_PER_MIN_2X)) *
    GB
  )
}

/** Bytes per minute of the final encoded clip (video + AAC/PCM audio). */
export const finalBytesPerMin = (config: ConfigInterface): number => {
  let kbps: number
  if (config.videoQualityMode === 'crf') {
    const m = efbMultiplier(config.resolution)
    const pixels =
      config.resolution === 4 && config.widescreen !== false
        ? 1920 * 1080
        : (config.widescreen !== false ? 939 : 704) * 528 * m * m
    const crf = Number.isFinite(config.crf as number)
      ? (config.crf as number)
      : 18
    kbps =
      CRF_ASSUMED_KBPS_1080P *
      Math.max(1, pixels / (1920 * 1080)) *
      (crf <= 10 ? 4 : 1)
  } else {
    kbps = Number(config.bitrateKbps) || 50000
  }
  // AVI output carries PCM audio (1536 kb/s), MP4 carries AAC.
  const audioKbps = config.convertToMp4 === false ? 1536 : AUDIO_KBPS
  return ((kbps + audioKbps) * 1000 * 60) / 8
}

type SizedReplay = ReplayInterface & { lastFrame?: number | null }

/** Seconds of footage slpToVideo will dump for this clip (with its lead-in). */
export const clipFootageSec = (replay: SizedReplay): number => {
  const start = Math.max(GAME_START_FRAME, replay.startFrame - LEAD_IN_FRAMES)
  let end: number
  if (replay.lastFrame && replay.lastFrame > 0)
    end =
      replay.endFrame > 0
        ? Math.min(replay.endFrame, replay.lastFrame - 1)
        : replay.lastFrame - 1
  else if (replay.endFrame > 0) end = replay.endFrame
  else return UNKNOWN_GAME_SEC
  return Math.max(1, end - start) / 60
}

export type ClipBytes = { scratch: number; final: number; master: number }

/** What one clip needs: scratch while it records + encodes, the final file,
 *  and the kept master (raw dump + wav) when keepLosslessMaster is on. */
export const clipDiskBytes = (
  replay: SizedReplay,
  config: ConfigInterface,
): ClipBytes => {
  const min = clipFootageSec(replay) / 60
  const dump = dumpBytesPerMin(config) * min
  const wav = WAV_BYTES_PER_MIN * min
  const final = finalBytesPerMin(config) * min
  // Peak on scratch: the raw dump + wav (one copy: the old merge/trim passes
  // made three) while the encode writes the final next to them.
  return {
    scratch: (dump + wav + final) * SAFETY,
    final: final * SAFETY,
    master: config.keepLosslessMaster ? (dump + wav) * SAFETY : 0,
  }
}

export type RecordingDiskEstimate = {
  /** Peak on the scratch drive: the numProcesses longest clips at once. */
  scratchBytes: number
  /** Everything that stays in the output folder (clips, masters, concat). */
  outputBytes: number
  /** The single biggest clip's scratch need (for the per-clip check). */
  largestClipScratchBytes: number
}

/**
 * Disk needed by a recording run. Replays with endFrame 0 (whole game) are
 * sized from `lastFrame` when known (preflightRecordingDisk fills it), else
 * assumed to be UNKNOWN_GAME_SEC long.
 */
export const estimateRecordingDiskBytes = (
  replays: SizedReplay[],
  config: ConfigInterface & { numProcesses?: number },
): RecordingDiskEstimate => {
  const workers = Math.max(1, Math.floor(config.numProcesses || 1))
  const clips = replays.map((r) => clipDiskBytes(r, config))
  const scratchSorted = clips.map((c) => c.scratch).sort((a, b) => b - a)
  const scratchBytes = scratchSorted
    .slice(0, Math.min(workers, scratchSorted.length))
    .reduce((a, b) => a + b, 0)
  const finals = clips.reduce((a, c) => a + c.final, 0)
  const masters = clips.reduce((a, c) => a + c.master, 0)
  // Concatenation writes final.<ext> next to the clips: a second copy of them.
  const concat = config.concatenate && clips.length > 1 ? finals : 0
  return {
    scratchBytes,
    outputBytes: finals + masters + concat,
    largestClipScratchBytes: scratchSorted[0] || 0,
  }
}

// --- Free space -----------------------------------------------------------

/** The nearest existing folder at or above `p` (see fsRetry). */
const existingAncestor = existingAncestorOf

/** Device id of the drive holding `folder`, to tell whether scratch and output
 *  share a disk (their needs then add up). */
export const deviceOf = async (folder: string): Promise<number | null> => {
  try {
    return (await fsp.stat(await existingAncestor(folder))).dev
  } catch {
    return null
  }
}

/** How a drive is named in messages: "D:\" on Windows, the folder elsewhere. */
export const driveLabel = (folder: string, platform = process.platform) => {
  if (platform === 'win32') {
    const root = path.win32.parse(path.win32.resolve(folder)).root
    if (root) return root
  }
  return folder
}

export const formatGB = (bytes: number) =>
  `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`

/** A disk-full error from Node (ENOSPC) or from a child's stderr. */
export const isDiskFullError = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string } | null
  if (e?.code === 'ENOSPC' || e?.code === 'EDQUOT') return true
  return isDiskFullText(String(e?.message ?? err ?? ''))
}
export const isDiskFullText = (text: string): boolean =>
  /ENOSPC|No space left on device|not enough space on the disk|disk quota exceeded/i.test(
    text,
  )

// --- Preflight --------------------------------------------------------------

export type DiskFallback = {
  recordingFormat?: 'draft'
  numProcesses?: number
}

export type DiskPreflight = {
  ok: boolean
  /** Bytes needed on the tightest drive (with the floor). */
  needBytes: number
  /** Free bytes there (Infinity when free space couldn't be read). */
  freeBytes: number
  /** Changes that make the run fit; apply them to the job's config. */
  fallback?: DiskFallback
  /** For the user: what fell back, or why the run is refused. */
  message?: string
  /** Drive the numbers refer to (for messages). */
  drive?: string
}

type Drives = {
  scratch: string
  output: string
  free: (_folder: string) => Promise<number | null>
  device: (_folder: string) => Promise<number | null>
}

/** Read each replay's lastFrame from its metadata footer (a 16 KB tail read,
 *  not the whole file) so whole-game clips are sized from their real length. */
export const withLastFrames = async (
  replays: ReplayInterface[],
): Promise<SizedReplay[]> => {
  const out: SizedReplay[] = replays.map((r) => ({ ...r }))
  const todo = out.filter((r) => !(r.endFrame > 0))
  const TAIL = 16 * 1024
  const CONCURRENCY = 16
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + CONCURRENCY).map(async (r) => {
        let handle: fs.promises.FileHandle | null = null
        try {
          // A .slpz keeps its metadata uncompressed, after the Game Start.
          if (isSlpzPath(r.path)) {
            const head = readSlpzHead(r.path)
            if (!looksLikeSlp(head)) {
              const lf = lastFrameFromFooter(slpzMetadata(head))
              // The decoded events' size stands in for the .slp's size.
              r.lastFrame =
                lf && lf > 0 ? lf : Math.ceil(head.readUInt32BE(20) / 350)
              return
            }
          }
          handle = await fsp.open(r.path, 'r')
          const { size } = await handle.stat()
          const len = Math.min(size, TAIL)
          const buf = Buffer.alloc(len)
          await handle.read(buf, 0, len, size - len)
          const lf = lastFrameFromFooter(buf)
          // No footer (anonymised ranked): ~350 bytes a frame for two players
          // overestimates the length, which is the safe direction here.
          r.lastFrame = lf && lf > 0 ? lf : Math.ceil(size / 350)
        } catch {
          r.lastFrame = null
        } finally {
          await handle?.close().catch(() => {})
        }
      }),
    )
  }
  return out
}

/**
 * Will this run fit on disk? Checks the scratch drive (Dolphin's dumps, the
 * numProcesses longest clips at once) and the output drive (every final, kept
 * masters, the concat copy), added together when they are the same drive.
 * If not, it tries, in order: recording in Fast draft (mpeg4, 150 Mb/s above
 * native; skipped when keepLosslessMaster asks for a lossless master), then
 * fewer workers, then refuses with a message saying what's needed where.
 */
export const preflightRecordingDisk = async (
  replays: ReplayInterface[],
  config: ConfigInterface & { numProcesses: number },
  dirs: { scratch: string; output: string },
  // Injected in tests.
  io: Partial<Pick<Drives, 'free' | 'device'>> = {},
): Promise<DiskPreflight> => {
  const drives: Drives = {
    ...dirs,
    free: io.free ?? freeBytesAt,
    device: io.device ?? deviceOf,
  }
  const sized = await withLastFrames(replays)
  const [scratchFree, outputFree, scratchDev, outputDev] = await Promise.all([
    drives.free(drives.scratch),
    drives.free(drives.output),
    drives.device(drives.scratch),
    drives.device(drives.output),
  ])
  const sameDrive = scratchDev != null && scratchDev === outputDev
  const scratchLabel = driveLabel(drives.scratch)
  const outputLabel = driveLabel(drives.output)

  const check = (cfg: ConfigInterface & { numProcesses: number }) => {
    const est = estimateRecordingDiskBytes(sized, cfg)
    if (sameDrive) {
      const need = est.scratchBytes + est.outputBytes + DISK_FLOOR_BYTES
      const free = scratchFree ?? Infinity
      return { ok: need <= free, need, free, drive: outputLabel }
    }
    const sNeed = est.scratchBytes + DISK_FLOOR_BYTES
    const oNeed = est.outputBytes + DISK_FLOOR_BYTES
    const sFree = scratchFree ?? Infinity
    const oFree = outputFree ?? Infinity
    if (oNeed > oFree)
      return {
        ok: false,
        need: oNeed,
        free: oFree,
        drive: outputLabel,
        outputBound: true,
      }
    if (sNeed > sFree)
      return { ok: false, need: sNeed, free: sFree, drive: scratchLabel }
    // Report the tighter of the two.
    return sFree - sNeed < oFree - oNeed
      ? { ok: true, need: sNeed, free: sFree, drive: scratchLabel }
      : { ok: true, need: oNeed, free: oFree, drive: outputLabel }
  }

  const first = check(config)
  if (first.ok)
    return {
      ok: true,
      needBytes: first.need,
      freeBytes: first.free,
      drive: first.drive,
    }

  const fallback: DiskFallback = {}
  let cfg = { ...config }
  const notes: string[] = []
  const plan = dumpPlanFor(config)
  if (plan.dumpCodec !== 'mpeg4' && !config.keepLosslessMaster) {
    cfg = { ...cfg, recordingFormat: 'draft' }
    fallback.recordingFormat = 'draft'
    notes.push('in Fast draft (mpeg4) instead of lossless')
    const r = check(cfg)
    if (r.ok)
      return {
        ok: true,
        needBytes: r.need,
        freeBytes: r.free,
        drive: r.drive,
        fallback,
        message: fallbackMessage(first, notes),
      }
  }
  for (let n = config.numProcesses - 1; n >= 1; n--) {
    const r = check({ ...cfg, numProcesses: n })
    if (r.ok) {
      fallback.numProcesses = n
      notes.push(`${n} at a time instead of ${config.numProcesses}`)
      return {
        ok: true,
        needBytes: r.need,
        freeBytes: r.free,
        drive: r.drive,
        fallback,
        message: fallbackMessage(first, notes),
      }
    }
  }
  const last = check({ ...cfg, numProcesses: 1 })
  return {
    ok: false,
    needBytes: first.need,
    freeBytes: first.free,
    drive: first.drive,
    message: `Not enough disk space: this recording needs about ${formatGB(
      first.need,
    )} on ${first.drive} and ${formatGB(first.free)} is free${
      last.need < first.need
        ? ` (still ${formatGB(last.need)} recording one clip at a time${
            fallback.recordingFormat ? ' in Fast draft' : ''
          })`
        : ''
    }. Free up space, record fewer or shorter clips, lower the resolution, or choose an output folder on another drive.`,
  }
}

const fallbackMessage = (
  first: { need: number; free: number; drive: string },
  notes: string[],
) =>
  `Low disk space on ${first.drive} (${formatGB(first.free)} free, ` +
  `~${formatGB(first.need)} needed): recording ${notes.join(', ')}.`

// --- Scratch folder ---------------------------------------------------------

/** Parent of every run's scratch folder (unless config.scratchPath is set). */
export const SCRATCH_ROOT_NAME = 'lm-clipper-scratch'

// --- Folders Dolphin is given ----------------------------------------------

/**
 * Slippi Playback Dolphin can't use a --user folder (or dump into one) whose
 * path has any non-ASCII character: on Windows it records nothing (exit 0, or
 * 0xC0000409 at start), measured on the Windows rig 2026-10-15 with é/ü and with
 * Japanese. The replay and ISO paths may have them. Windows puts TEMP under the
 * user's profile, so a user named José or Дмитрий could not record at all.
 */
export const isAsciiPath = (p: string): boolean => /^[\x20-\x7e]*$/.test(p)

let dolphinTempCache: { tmp: string; root: string } | null = null

/**
 * Where Dolphin's per-run folders (profiles, dumps) go by default: the system
 * temp folder, or on Windows, when that path isn't plain ASCII, a folder of
 * this Windows user's own under ProgramData (named by a hash of the user name,
 * which may itself be the non-ASCII part). Falls back to the temp folder when
 * that can't be made.
 */
export const dolphinTempRoot = (
  // Injected in tests.
  env: {
    platform?: string
    tmp?: string
    programData?: string
    user?: string
    mkdir?: (_dir: string) => void
  } = {},
): string => {
  const platform = env.platform ?? process.platform
  const tmp = env.tmp ?? os.tmpdir()
  if (platform !== 'win32' || isAsciiPath(tmp)) return tmp
  if (!env.tmp && dolphinTempCache?.tmp === tmp) return dolphinTempCache.root
  const programData =
    env.programData ?? process.env.ProgramData ?? 'C:\\ProgramData'
  let user = env.user
  if (user === undefined) {
    try {
      user = os.userInfo().username
    } catch {
      user = os.homedir()
    }
  }
  const id = crypto
    .createHash('sha1')
    .update(String(user))
    .digest('hex')
    .slice(0, 10)
  const root = path.win32.join(programData, 'Lunar Clipper', `tmp-${id}`)
  let chosen = tmp
  if (isAsciiPath(root)) {
    try {
      ;(env.mkdir ?? ((d: string) => fs.mkdirSync(d, { recursive: true })))(
        root,
      )
      chosen = root
    } catch (err) {
      logMain('dolphinTempRoot: fallback folder not made', {
        root,
        err: String(err),
      })
    }
  }
  if (!env.tmp) {
    dolphinTempCache = { tmp, root: chosen }
    if (chosen !== tmp)
      logMain('dolphinTempRoot: temp path is not ASCII, using', {
        tmp,
        root: chosen,
      })
  }
  return chosen
}

/**
 * Where a run's Dolphin dumps and ffmpeg intermediates go: a local folder, not
 * the output folder (which may be a slow, synced or network drive, and which
 * used to collect -unmerged/-merged debris). Defaults to
 * <tmp>/lm-clipper-scratch/<runId>; config.scratchPath (a folder) puts the
 * lm-clipper-scratch root there instead.
 */
export const scratchRootFor = (
  config: Pick<ConfigInterface, 'scratchPath'>,
): string => {
  const custom =
    typeof config.scratchPath === 'string'
      ? stripQuotes(config.scratchPath)
      : ''
  if (!custom) return path.join(dolphinTempRoot(), SCRATCH_ROOT_NAME)
  const root = path.resolve(custom, SCRATCH_ROOT_NAME)
  // Dolphin dumps here: a folder it can't write into is no use, so the same
  // drive's root instead (the drive is what the user picked it for).
  if (process.platform === 'win32' && !isAsciiPath(root)) {
    const drive = path.win32.parse(root).root
    if (drive && isAsciiPath(drive))
      return path.win32.join(drive, SCRATCH_ROOT_NAME)
  }
  return root
}

export const scratchDirFor = (
  config: Pick<ConfigInterface, 'scratchPath'>,
  runId: string = `${Date.now().toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`,
): string => path.join(scratchRootFor(config), runId)

/** Strip surrounding quotes and whitespace (Windows "Copy as path" adds quotes). */
export const stripQuotes = (p: string): string =>
  p
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim()

// Windows MAX_PATH is 260 including the terminator; Dolphin and ffmpeg are not
// long-path aware, so keep a margin under it.
export const WINDOWS_PATH_LIMIT = 240

// --- Robust file operations ------------------------------------------------

export { retryFs, freeBytesAt }

/** Delete a file, retrying on Windows locks; a missing file is fine. Logs (and
 *  returns false) instead of throwing. */
export const unlinkQuiet = async (file: string): Promise<boolean> => {
  try {
    await retryFs(
      () =>
        fsp.unlink(file).catch((err) => {
          if ((err as { code?: string }).code === 'ENOENT') return undefined
          throw err
        }),
      `unlink ${file}`,
    )
    return true
  } catch {
    return false
  }
}

/** Remove a folder tree, retrying locked files; logs instead of throwing. */
export const removeTree = async (dir: string): Promise<boolean> => {
  try {
    await fsp.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
    return true
  } catch (err) {
    logMain('fs: could not remove folder', { dir, err: String(err) })
    return false
  }
}

/**
 * Move a file into place. A rename when source and destination share a drive;
 * across drives (EXDEV: scratch on C:, output on D:) a copy to `<dst>.partial`
 * then a rename, so a half-copied clip never sits in the output folder under
 * its real name, then the source is deleted.
 */
export const moveFile = async (src: string, dst: string): Promise<void> => {
  try {
    await retryFs(() => fsp.rename(src, dst), `rename ${src}`)
    return
  } catch (err) {
    if ((err as { code?: string })?.code !== 'EXDEV') throw err
  }
  const partial = `${dst}.partial`
  try {
    await fsp.copyFile(src, partial)
    await retryFs(() => fsp.rename(partial, dst), `rename ${partial}`)
  } catch (err) {
    await unlinkQuiet(partial)
    throw err
  }
  await unlinkQuiet(src)
}

// --- Startup cleanup ----------------------------------------------------------

// Temp folders the recorder and previews make under os.tmpdir(). A crash, a
// killed app or a locked file on Windows can leave them behind; a lossless dump
// left in scratch is GBs.
const STALE_PREFIXES = ['lmclip-dolphin-', 'lm-clipper-test-', 'lm-clipper-']
// Not ours to delete: the workflow tool's output, and the scratch root itself
// (only its old run folders go).
const KEEP_PREFIXES = ['lm-clipper-workflow-', SCRATCH_ROOT_NAME]

/**
 * Delete leftover temp folders older than `maxAgeMs` (default 1 hour): the
 * per-worker Dolphin profiles (lmclip-dolphin-*), preview/test profiles
 * (lm-clipper-*, lm-clipper-test-*) and old run folders in the scratch root.
 * Call once at startup, passing scratchRoots: [scratchRootFor(config)] when
 * config.scratchPath is set. Never throws; returns how many folders went.
 */
export const cleanupStaleTempDirs = async (
  opts: { maxAgeMs?: number; tmpDir?: string; scratchRoots?: string[] } = {},
): Promise<number> => {
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000
  const tmp = opts.tmpDir ?? os.tmpdir()
  const cutoff = Date.now() - maxAgeMs
  const victims: string[] = []
  const oldDirsIn = async (dir: string, match: (_n: string) => boolean) => {
    let names: string[] = []
    try {
      names = await fsp.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!match(name)) continue
      const full = path.join(dir, name)
      try {
        const st = await fsp.lstat(full)
        if (st.isDirectory() && st.mtimeMs < cutoff) victims.push(full)
      } catch {
        /* gone already */
      }
    }
  }
  await oldDirsIn(
    tmp,
    (n) =>
      STALE_PREFIXES.some((p) => n.startsWith(p)) &&
      !KEEP_PREFIXES.some((p) => n.startsWith(p)),
  )
  const dolphinTmp = opts.tmpDir ? tmp : dolphinTempRoot()
  if (dolphinTmp !== tmp)
    await oldDirsIn(
      dolphinTmp,
      (n) =>
        STALE_PREFIXES.some((p) => n.startsWith(p)) &&
        !KEEP_PREFIXES.some((p) => n.startsWith(p)),
    )
  const roots = [
    path.join(tmp, SCRATCH_ROOT_NAME),
    ...(dolphinTmp !== tmp ? [path.join(dolphinTmp, SCRATCH_ROOT_NAME)] : []),
    ...(opts.scratchRoots || []),
  ]
  for (const root of roots) await oldDirsIn(root, () => true)
  let removed = 0
  for (const v of victims) if (await removeTree(v)) removed++
  if (victims.length)
    logMain('cleanupStaleTempDirs', { found: victims.length, removed })
  return removed
}
