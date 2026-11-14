/* eslint-disable no-await-in-loop */
/*

Where the magic happens.

If you're here to see how to convert slp to mp4, I recommend starting here:
https://github.com/kevinsung/slp-to-video

*/

import { ChildProcess, spawn } from 'child_process'
import { app } from 'electron'
import crypto from 'crypto'
import { promises as fsPromises } from 'fs'
import path from 'path'
import os from 'os'
// Every Dolphin this app spawns goes through slippi-dolphin-runner: the throwaway
// profile, the comm file, the --cout frame watch, the stall watchdog and the tree
// kill. Don't hand-roll any of those here again (its MIGRATING.md lists why).
import {
  BACKGROUND_RECORD,
  buildProfile,
  healRealProfile,
  killTree as killPidTree,
  profileAt,
  realProfileExists,
  realProfileRoot,
  record,
  type ProfileOptions,
  type RunnerWarning,
} from 'slippi-dolphin-runner'
import { SlippiGame } from '../lib/slippiGame'
import { readLastFrame } from '../lib/lastFrame'
import { playableSlp } from './slpCache'
import { checkIso } from './isoCheck'
import { GAME_START_FRAME } from '../constants/frames'

import { buildReplayVars, applyPattern } from '../lib/overlayTokens'
import { getFFMPEGPath, getAssetPath } from './util'
import { renderOverlayPng } from './overlayRenderer'
import { logMain, getLogPath } from './logger'
import { isFileLockedText } from './fsRetry'
import { hideLauncherPath } from './hideLauncher'
import { shownError } from './errorText'
import {
  WINDOWS_PATH_LIMIT,
  clipDiskBytes,
  dolphinTempRoot,
  driveLabel,
  dumpPlanFor,
  dumpCodecProblem,
  isWindowsPlatform,
  freeBytesAt,
  isDiskFullError,
  isDiskFullText,
  moveFile,
  preflightRecordingDisk,
  recordingFormatOf as recordingFormatOfConfig,
  removeTree,
  scratchDirFor,
  stripQuotes,
  unlinkQuiet,
} from './diskSpace'
import {
  ConfigInterface,
  ReplayInterface,
  OverlaySourceRule,
} from '../constants/types'

/** Pull the first WxH resolution out of an ffmpeg stderr dump. */
const parseVideoDimensions = (
  stderr: string,
): { width: number; height: number } | null => {
  const m = stderr.match(/Video:.*?[, ](\d{2,5})x(\d{2,5})/)
  if (!m) return null
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) }
}

export type VideoWorkerStatus = {
  replayPath: string
  phase: 'idle' | 'recording' | 'encoding'
  replayIndex: number
}

export type VideoJobController = {
  stop: () => void
  cancel: () => void
  promise: Promise<void>
  getWorkerStatus: () => VideoWorkerStatus[]
}

type VideoSignal = {
  stopped: boolean
  cancelled: boolean
  // Set when the run stops itself (disk full, Dolphin not starting): the one
  // message the user sees instead of a failure per remaining clip.
  abortReason: string | null
  // ffmpeg children, killed directly.
  activeProcesses: Set<ChildProcess>
  // One per recording Dolphin; aborting SIGKILLs its whole tree (the package's).
  activeRecordings: Set<AbortController>
}

const halted = (signal: VideoSignal) =>
  signal.stopped || signal.cancelled || signal.abortReason !== null

/** A run that stopped itself; its message is meant for the user as is. */
export class RecordingStoppedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecordingStoppedError'
  }
}

let ffmpegPath = getFFMPEGPath()
logMain('slpToVideo: resolved ffmpeg path', { ffmpegPath })

export function setFFMPEGPathOverride(overridePath: string) {
  // Windows Explorer's "Copy as path" wraps the path in double quotes; spawn
  // would look for a file literally named "C:\...\ffmpeg.exe" (quotes included).
  const cleaned = overridePath ? stripQuotes(overridePath) : ''
  if (cleaned) {
    ffmpegPath = cleaned
    logMain('slpToVideo: ffmpeg path overridden', { ffmpegPath })
  } else {
    ffmpegPath = getFFMPEGPath()
    logMain('slpToVideo: ffmpeg path reset to default', { ffmpegPath })
  }
}

/** The ffmpeg every recording/stitch spawns: the Settings override if set,
 *  else the bundled one. Other callers (probes, Test ffmpeg) should use this
 *  rather than getFFMPEGPath, which ignores the override. */
export const getEffectiveFFMPEGPath = (): string => ffmpegPath

const getAppDataPath = () => {
  if (app && typeof app.getPath === 'function') return app.getPath('appData')
  const platform = os.type()
  if (platform === 'Windows_NT') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  }
  if (platform === 'Darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support')
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

// --- Robustness knobs for the recording pipeline. Dolphin's own watchdog (no
// first frame within 90 s, frames stopped for 30 s) lives in slippi-dolphin-runner.
const STOP_GRACE_MS = 45_000 // Stop: force-kill anything still alive after 45s
// Accept a recording only if it holds this much of the expected footage. Dumps
// are not frame-exact (3504-3534 of 3600 frames across codecs and speeds,
// runner docs "Dumps are NOT frame-count stable"), so this is a ratio.
const MIN_FOOTAGE_RATIO = 0.9
// Kept free while recording; below it the run stops ("disk full") rather than
// letting Dolphin and ffmpeg write truncated files.
const RUN_FLOOR_BYTES = 512 * 1024 * 1024
// The first clips all failing with no frame at all means Dolphin isn't starting
// (wrong build, missing ISO access, GPU driver): stop after this many attempts
// rather than retrying every clip in the queue.
const NO_FRAME_ABORT_AFTER = 3

// The final encode RE-ENCODES, so its runtime scales with clip length — a fixed
// cap would false-kill a legit long game. Scale the timeout off the clip's
// footage seconds instead, with a generous ~10x-realtime headroom so even a slow
// machine never trips it; it's only a backstop against a truly wedged process,
// not a performance budget. e.g. 7s clip → ~3 min, 3-min game → ~32 min.
// Frames are 60fps.
const FFMPEG_TIMEOUT_BASE_MS = 120_000 // fixed startup/overhead allowance
const FFMPEG_TIMEOUT_PER_SEC_MS = 10_000 // + per second of footage (10x realtime)
const ffmpegTimeoutFor = (clipFrames: number) =>
  FFMPEG_TIMEOUT_BASE_MS +
  Math.max(0, clipFrames / 60) * FFMPEG_TIMEOUT_PER_SEC_MS

/**
 * Wall-clock cap for one Dolphin recording: boot allowance + the clip at the
 * slowest speed we expect for its dump codec. FFV1 is single-threaded and
 * encoder-bound: 0.34x at 2x and 0.10x at 3x on an idle box, and a loaded box
 * runs ~half its idle speed (runner docs: 0.6x → 0.33x under load), so ffv1 at
 * 2x and above assumes 0.03x. Everything else assumes 0.1x (utvideo at 3x is
 * 0.8x contended; mpeg4, Windows' "Fast", 1.26x at 2x and 0.62x at 3x idle). The runner's own stall watchdog catches
 * a frozen Dolphin long before this; it only ends one that keeps crawling.
 */
export const recordHardTimeoutMs = (
  config: ConfigInterface,
  clipFrames: number,
): number => {
  const slow =
    dumpPlanFor(config).dumpCodec === 'ffv1' && config.resolution >= 4
  const floorSpeed = slow ? 0.03 : 0.1
  return 180_000 + Math.ceil((clipFrames / 60 / floorSpeed) * 1000)
}

/** Encoder threads per final encode: the CPUs shared between the workers, so
 *  N parallel x264s don't each start a thread per core and thrash. */
export const encodeThreadsFor = (
  numProcesses: number,
  cpus: number = os.cpus().length || 1,
) => Math.max(1, Math.floor(cpus / Math.max(1, numProcesses)))

// Video-encoder args for the SINGLE final encode of Dolphin's dump (UT Video /
// FFV1 lossless, or mpeg4 in Fast draft). Recording used to re-encode twice
// (FFV1 → mpeg4 at merge → H.264), then stream-copy twice (merge, trim) before
// encoding; now this is the only pass. Defaults preserve the classic libx264 +
// target-bitrate behavior.
export const buildVideoEncodeArgs = (
  config: ConfigInterface,
  threads?: number,
): string[] => {
  const codec = config.videoCodec === 'h265' ? 'libx265' : 'libx264'
  const args = ['-c:v', codec, '-preset', config.videoPreset || 'medium']
  // hvc1 tag so HEVC .mp4s play in QuickTime / Apple ecosystems.
  if (codec === 'libx265') args.push('-tag:v', 'hvc1')
  if (config.videoQualityMode === 'crf') {
    const crf = Number.isFinite(config.crf as number) ? config.crf : 18
    args.push('-crf', String(crf))
  } else {
    args.push('-b:v', `${config.bitrateKbps}k`)
  }
  if (threads) args.push('-threads', String(threads))
  return args
}

// The scale filter for the final encode. 2x-widescreen normalizes to 1080p (the
// legacy behavior that used to live in the merge step); everything else keeps
// the native internal-resolution dims, rounded to even numbers so H.264/H.265
// accept them.
const wantsWidescreen1080 = (config: ConfigInterface): boolean =>
  config.resolution === 4 && config.widescreen !== false
const buildScaleExpr = (config: ConfigInterface): string =>
  `${
    wantsWidescreen1080(config)
      ? 'scale=1920:1080'
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
  },${TO_BT709}`

// Dolphin dumps RGB. Convert it the way every player expects an HD video:
// BT.709, limited (TV) range, 4:2:0, and say so in the stream (VIDEO_COLOR_TAGS).
// Before this the encode was untagged 4:4:4 converted with BT.601: phones and
// some browsers can't decode High 4:4:4 in hardware, and players that guess the
// range wrong showed Melee's blacks as grey.
const TO_BT709 = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'
export const VIDEO_COLOR_TAGS = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
]

// Overlay compositing filter. When normalizing to 1080p, scale the base there
// first so the (1080p) overlay lines up 1:1; otherwise scale the overlay to the
// base. Always pad to even dims for H.264/H.265. `ovr` is the overlay PNG's
// input index.
const buildOverlayFilter = (normalizeTo1080: boolean, ovr: number) =>
  normalizeTo1080
    ? `[0:v]scale=1920:1080[b];[b][${ovr}:v]scale2ref[base][ovr];` +
      `[base][ovr]overlay=0:0,pad=ceil(iw/2)*2:ceil(ih/2)*2,${TO_BT709}[outv]`
    : `[0:v][${ovr}:v]scale2ref[base][ovr];` +
      `[base][ovr]overlay=0:0,pad=ceil(iw/2)*2:ceil(ih/2)*2,${TO_BT709}[outv]`

// Seconds of lead-in dropped from the dump: the clip starts 60 frames early so
// Dolphin's boot/first-frame hiccups land outside it.
const LEAD_TRIM_SEC = 1

/**
 * The single ffmpeg pass that turns Dolphin's raw dump into the final clip. It
 * replaces three: merge (stream copy of -unmerged.avi + .wav), trim (-ss 1 copy)
 * and the encode. It reads the dump and its WAV directly, drops the 1 s lead-in
 * with an INPUT seek on each (frame-accurate here because both are decoded),
 * and composites the overlay, scales and encodes in one go.
 *
 * `wav` null (Dolphin wrote no audio dump) encodes a silent track (anullsrc)
 * instead of losing the clip: concatenation and players expect an audio stream.
 */
export const buildFinalEncodeArgs = (o: {
  config: ConfigInterface
  avi: string
  wav: string | null
  overlayPng: string | null
  output: string
  threads?: number
}): string[] => {
  const { config } = o
  const args = ['-hide_banner', '-y']
  args.push('-ss', String(LEAD_TRIM_SEC), '-i', o.avi)
  if (o.wav) args.push('-ss', String(LEAD_TRIM_SEC), '-i', o.wav)
  else
    args.push(
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
    )
  if (o.overlayPng) {
    args.push('-i', o.overlayPng)
    args.push(
      '-filter_complex',
      buildOverlayFilter(wantsWidescreen1080(config), 2),
      '-map',
      '[outv]',
    )
  } else {
    args.push('-map', '0:v', '-vf', buildScaleExpr(config))
  }
  args.push('-map', '1:a')
  args.push(...buildVideoEncodeArgs(config, o.threads), ...VIDEO_COLOR_TAGS)
  // MP4 carries AAC; the AVI output keeps PCM like the old copied WAV did.
  if (config.convertToMp4) args.push('-c:a', 'aac', '-b:a', '128k')
  else args.push('-c:a', 'pcm_s16le')
  // anullsrc never ends: stop with the video.
  if (!o.wav) args.push('-shortest')
  args.push(o.output)
  return args
}

// Custom/HD texture packs for a Dolphin profile. The bundled "Definitive Melee
// HD" pack is included when hdTexturesEnabled; user-imported packs when their
// toggle is on. buildProfile links each under Load/Textures/GALE01/<folder name>
// (Dolphin scans it recursively), so the bundled pack goes in as its parent
// folder: its own folder is called GALE01, a name user packs often share. Packs
// whose folders have the same name all load: since dolphin_runner 0.5.2 the later
// ones are linked as <name>-2, <name>-3 (the folder name is organisational only).
export const enabledTexturePacks = (config: ConfigInterface): string[] => {
  const packs: string[] = []
  if (config.hdTexturesEnabled) packs.push(getAssetPath('Melee_HD_Textures'))
  for (const p of config.texturePacks || []) {
    if (p.enabled && p.path) packs.push(p.path)
  }
  return packs
}

// Await a child's exit. CRITICAL: also settle on 'error' — a spawn that fails
// (ENOENT, EAGAIN/EMFILE/ENOMEM after spawning thousands of processes across an
// all-night run) emits 'error' and may never emit 'exit', which would otherwise
// park the awaiting worker forever. Both paths funnel through one resolve.
const exit = (process: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    let settled = false
    const done = (code: number | null) => {
      if (settled) return
      settled = true
      resolve(code)
    }
    process.on('exit', (code) => done(code))
    process.on('error', () => done(null))
  })

// Return true once the process has actually terminated (not merely been sent a
// signal — proc.killed only means "a signal was delivered").
const isDead = (proc: ChildProcess) =>
  !proc ||
  proc.pid == null ||
  proc.exitCode !== null ||
  proc.signalCode !== null

// Forcefully terminate an ffmpeg AND its children: SIGTERM, then SIGKILL if
// still alive (taskkill /T /F on Windows), via the package's pid-tree walk.
// Used by the length-scaled ffmpeg timeouts, Stop's backstop and Cancel.
const killTree = (proc: ChildProcess) => {
  if (isDead(proc) || proc.pid == null) return
  try {
    // Not graceful: ffmpeg runs hidden as a console process, which refuses
    // Windows' polite "taskkill /T" ("can only be terminated forcefully"), and
    // the quit watchdog exits the app before the 5 s escalation would fire,
    // leaving ffmpeg encoding as an orphan (launch review WIN-16).
    killPidTree(proc.pid, false)
  } catch {
    /* already gone */
  }
}

// Await a child's exit, but give up after `timeoutMs` — a wedged ffmpeg (e.g.
// fed a truncated dump from a killed Dolphin) must never park a worker forever.
// Returns the exit code, or null on timeout (after force-killing the process).
const awaitExitWithTimeout = async (
  proc: ChildProcess,
  timeoutMs: number,
  label: string,
): Promise<number | null> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<number | null>((resolve) => {
    timer = setTimeout(() => {
      logMain(`record: ${label} timed out after ${timeoutMs}ms — killing`)
      killTree(proc)
      resolve(null)
    }, timeoutMs)
  })
  const code = await Promise.race([exit(proc), timeout])
  if (timer) clearTimeout(timer)
  return code
}

/** Spawn ffmpeg hidden (no console window flashing up per clip on Windows),
 *  tracked so Stop/Cancel can kill it, with the stderr tail kept. */
const runFfmpeg = async (
  args: string[],
  signal: VideoSignal | null,
  timeoutMs: number,
  label: string,
): Promise<{ code: number | null; stderr: string }> => {
  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  signal?.activeProcesses.add(proc)
  let stderr = ''
  proc.on('error', (err) => {
    stderr += `\nspawn error: ${String(err)}`
    logMain(`record: ${label} spawn error`, err)
  })
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    stderr += chunk
    // Keep the head (stream info, for the overlay dims) and the tail (errors).
    if (stderr.length > 128_000)
      stderr = stderr.slice(0, 32_000) + stderr.slice(-64_000)
  })
  const code = await awaitExitWithTimeout(proc, timeoutMs, label)
  signal?.activeProcesses.delete(proc)
  return { code, stderr }
}

// Duration (seconds) and frame size of a dump, from ffmpeg's header read (we
// ship ffmpeg, not ffprobe); 0 / null if it can't be read.
const probeDump = async (
  file: string,
): Promise<{ sec: number; dims: { width: number; height: number } | null }> => {
  const { stderr } = await runFfmpeg(
    ['-hide_banner', '-i', file],
    null,
    30_000,
    'dump probe',
  )
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  return {
    sec: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0,
    dims: parseVideoDimensions(stderr),
  }
}

// Windows refuses these as file or folder names, with or without an extension
// ("CON.mp4" is still the console device), and silently drops trailing dots and
// spaces, so "Fox vs. " and "Fox vs" collide.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const sanitizeSegment = (segment: string): string => {
  // The pattern's own text, not only the token values: "Clip: {index}" on NTFS
  // creates an alternate data stream "Clip" and the video is invisible
  // (launch review WIN-14).
  let s = segment
    .replace(/[<>:"|?*\x00-\x1f]/g, '_') // eslint-disable-line no-control-regex
    .replace(/[. ]+$/, '')
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`
  return s || '_'
}

/**
 * Resolve a filename pattern using replay metadata.
 * Supports {character1}, {character2}, {player1}, {player2}, {stage},
 * {date}, {time}, {index}, {kills}, {damage}, {moves}.
 * Slashes (either way) in the pattern create subdirectories; every segment is
 * made safe on Windows (reserved device names, trailing dots/spaces), which
 * also turns a ".." segment into "_" so a pattern can't leave the output folder.
 */
export const resolveFilenamePattern = (
  pattern: string,
  replay: ReplayInterface,
  sourceRules?: OverlaySourceRule[],
): string => {
  const unsafeChars = /[<>:"/\\|?*\x00-\x1f]/g // eslint-disable-line no-control-regex
  const sanitize = (s: string) => s.replace(unsafeChars, '_').trim()

  // Shared token values (raw), sanitised here for filesystem safety. The
  // pattern's own '/' separators are preserved to allow folder structure.
  const raw = buildReplayVars(replay, sourceRules)
  const vars: Record<string, string> = {}
  for (const key of Object.keys(raw)) vars[key] = sanitize(raw[key])

  const resolved = pattern.replace(
    /\{(\w+)\}/g,
    (match, key) => vars[key] ?? match,
  )
  return resolved
    .split(/[\\/]+/)
    .filter((seg, i, all) => seg !== '' || all.length === 1)
    .map(sanitizeSegment)
    .join('/')
}

/** Shorten a file's base name so `<dir>/<base><longest suffix>` stays under
 *  Windows' path limit (only on Windows). */
const fitWindowsPath = (
  dir: string,
  base: string,
  longestSuffix: string,
  platform = process.platform,
): string => {
  if (platform !== 'win32') return base
  const room = WINDOWS_PATH_LIMIT - (dir.length + 1 + longestSuffix.length)
  if (base.length <= room) return base
  return base.slice(0, Math.max(8, room)).replace(/[. ]+$/, '') || '_'
}

/** How one clip ended. `noFrame`: Dolphin never produced a frame (it didn't
 *  start, or died at boot); `diskFull`: a drive ran out of room. */
type ClipOutcome =
  | { ok: true; file: string }
  | {
      ok: false
      kind: 'halted' | 'failed' | 'noFrame' | 'diskFull'
      detail?: string
    }

/** What the exit codes a Windows Dolphin (or its hidden-window launcher) ends with
 *  mean, so "exit code 91" is not all a user is told (launch review REC-13). */
const EXIT_CODE_NOTES: Record<number, string> = {
  90: 'the hidden-window helper was given bad arguments',
  91: 'the hidden-window helper could not create its hidden desktop',
  92: 'the hidden-window helper could not start Dolphin',
  3221225781:
    'a Windows library (DLL) is missing; install the Visual C++ runtime',
  3221226505:
    'Dolphin crashed (0xC0000409, a fatal error in a driver or library)',
  3221225595: 'a Windows library is the wrong kind (bad image)',
}

/** Did the hidden-window launcher itself fail (not Dolphin)? Its exit codes 90-92,
 *  or the launcher blocked from running (antivirus, AppLocker, Smart App Control):
 *  a spawn error naming it, EPERM/EACCES/UNKNOWN. */
const LAUNCHER_FAILURE =
  /exit code 9[0-2]\b|hidden[- ]?(window )?(helper|launcher)|lunar-hidden-launcher|\bEPERM\b|\bEACCES\b|\bUNKNOWN\b/i

/** Once the launcher has failed, the rest of the session records with visible
 *  windows rather than failing every clip. */
let hideDisabledForSession = false
/** Tests only. */
export const resetHideFallback = () => {
  hideDisabledForSession = false
}
export const hideLauncherFailed = (
  detail: string,
  platform: NodeJS.Platform,
): boolean => platform === 'win32' && LAUNCHER_FAILURE.test(detail)

/** A short reason from a record() result/error (0.5.7 adds exitCode,
 *  exitSignal and stderrTail; read defensively so 0.5.6 still works). */
const dolphinExitDetail = (src: unknown): string => {
  const r = (src || {}) as {
    exitCode?: number | null
    exitSignal?: string | null
    stderrTail?: string[]
    diagnostic?: { stderrTail?: string[]; reason?: string } | null
    message?: string
  }
  const tail = (r.stderrTail?.length ? r.stderrTail : r.diagnostic?.stderrTail)
    ?.map((l) => l.trim())
    .filter(Boolean)
  const parts: string[] = []
  if (tail?.length) parts.push(tail[tail.length - 1].slice(0, 200))
  else if (r.message) parts.push(r.message.split('\n')[0].slice(0, 200))
  if (r.exitCode != null)
    parts.push(
      EXIT_CODE_NOTES[r.exitCode]
        ? `exit code ${r.exitCode}: ${EXIT_CODE_NOTES[r.exitCode]}`
        : `exit code ${r.exitCode}`,
    )
  else if (r.exitSignal) parts.push(`signal ${r.exitSignal}`)
  if (r.diagnostic?.reason) parts.push(r.diagnostic.reason)
  return parts.join(', ') || 'no output from Dolphin'
}

/** The hidden-window launcher could not start (blocked, or no desktop to hide
 *  on): record this clip again, and the rest of the session, with visible
 *  windows. Returned as a plain failure so the clip is retried and the run does
 *  not stop with "Dolphin isn't starting" (launch review WIN-11, REC-13). */
const fallBackToVisible = (
  detail: string,
  onNotice?: (_msg: string) => void,
): ClipOutcome => {
  hideDisabledForSession = true
  logMain(
    'record: hidden-window launcher failed, recording with visible windows',
    {
      detail,
    },
  )
  onNotice?.(
    `Note: the helper that hides the recording windows could not start (${detail}). Clipper is recording with visible windows instead; the clips are not affected. A virus scanner may have blocked lunar-hidden-launcher.exe; turn off Hide Recording Windows in Settings > Recording to stop trying it.`,
  )
  return { ok: false, kind: 'failed', detail }
}

const processOneReplay = async (
  replay: ReplayInterface,
  config: ConfigInterface & { numProcesses: number; gameMusicOn: boolean },
  // Throwaway per-worker Dolphin profile (`--user`), built once per worker in
  // processReplays. Every Dolphin spawn in this run is isolated to it, so the
  // user's real Slippi profile is never read or written during recording.
  userDir: string,
  // This attempt's own folder inside the run's scratch dir: Dolphin's dump, its
  // WAV, the comm file, the overlay PNG and the encode all live here until the
  // final file is moved to the output folder.
  clipScratch: string,
  signal: VideoSignal,
  onRecorded?: () => void,
  onError?: (_msg: string) => void,
  // How far Dolphin is through this clip (0-1), as frames come in.
  onFrameProgress?: (_fraction: number) => void,
  // A non-blocking note for the app's console (warn level).
  onNotice?: (_msg: string) => void,
): Promise<ClipOutcome> => {
  const outputPattern = config.outputFilenamePattern || '{index}'
  const resolvedName = resolveFilenamePattern(
    outputPattern,
    replay,
    config.overlaySourceRules,
  )
  // resolvedName may contain path separators for folder structure
  const outputDir = path.resolve(config.outputPath, path.dirname(resolvedName))
  const ext = config.convertToMp4 ? '.mp4' : '.avi'
  const fileBasename = fitWindowsPath(
    outputDir,
    path.basename(resolvedName),
    config.keepLosslessMaster ? '.master.avi' : `${ext}.partial`,
  )
  const outputFile = (suffix: string) =>
    path.resolve(outputDir, `${fileBasename}${suffix}`)
  const finalOutput = outputFile(ext)

  const failed = (detail: string): ClipOutcome => {
    onError?.(`Error: ${detail}`)
    return { ok: false, kind: 'failed', detail }
  }

  // 1. Read the replay's length.
  try {
    await fsPromises.access(replay.path)
  } catch {
    logMain('record: replay file not found', { path: replay.path })
    return failed(`Replay file not found: ${replay.path}`)
  }

  // Dolphin plays only .slp: a .slpz is decoded into Clipper's cache first
  // (main/slpCache.ts), and that copy is what's read and recorded.
  let slpPath: string
  let game
  try {
    slpPath = await playableSlp(replay.path)
    game = new SlippiGame(slpPath)
  } catch (e) {
    logMain('record: broken/unreadable replay file', { path: replay.path })
    return failed(`Could not read replay: ${replay.path}`)
  }

  let gameLastFrame: number | undefined
  try {
    const metadata = game.getMetadata()
    // Anonymized replays have no metadata: read the end of the replay (a few
    // bytes) before falling back to parsing every frame.
    gameLastFrame =
      metadata?.lastFrame ??
      readLastFrame(slpPath) ??
      game.getLatestFrame()?.frame
  } catch {
    gameLastFrame = undefined
  }

  let endFrame: number
  if (gameLastFrame) {
    endFrame =
      replay.endFrame > 0
        ? Math.min(replay.endFrame, gameLastFrame - 1)
        : gameLastFrame - 1
  } else if (replay.endFrame > 0) {
    endFrame = replay.endFrame
  } else {
    logMain('record: cannot determine game length', { path: replay.path })
    return failed(`Cannot determine game length: ${replay.path}`)
  }

  const startFrame =
    replay.startFrame - 60 < GAME_START_FRAME
      ? GAME_START_FRAME
      : replay.startFrame - 60

  // Footage length in frames (60fps) — drives the length-scaled timeouts so a
  // long game isn't false-killed. Includes the 60-frame lead-in.
  const clipFrames = Math.max(1, endFrame - startFrame)
  const ffmpegTimeoutMs = ffmpegTimeoutFor(clipFrames)

  // 2. Room for this clip? Checked before every clip, not just at the start:
  // other programs fill disks too, and a long run outlives the preflight.
  const need = clipDiskBytes(
    { ...replay, lastFrame: gameLastFrame ?? null },
    config,
  )
  const [scratchFree, outputFree] = await Promise.all([
    freeBytesAt(clipScratch),
    freeBytesAt(outputDir),
  ])
  if (scratchFree !== null && scratchFree < need.scratch + RUN_FLOOR_BYTES) {
    return { ok: false, kind: 'diskFull', detail: driveLabel(clipScratch) }
  }
  if (
    outputFree !== null &&
    outputFree < need.final + need.master + RUN_FLOOR_BYTES
  ) {
    return { ok: false, kind: 'diskFull', detail: driveLabel(outputDir) }
  }

  try {
    await fsPromises.mkdir(clipScratch, { recursive: true })
    await fsPromises.mkdir(outputDir, { recursive: true })
  } catch (err) {
    if (isDiskFullError(err))
      return { ok: false, kind: 'diskFull', detail: driveLabel(clipScratch) }
    logMain('record: could not create folders', { err: String(err) })
    return failed(`Could not create folder: ${String(err)}`)
  }

  // A dump codec this platform's Dolphin lacks runs the whole replay and
  // writes nothing (Windows Playback has no UT Video encoder): refuse up front,
  // by name, instead of after a full-length "produced no video".
  const dumpCodec = dumpPlanFor(config).dumpCodec
  const codecProblem = dumpCodecProblem(dumpCodec)
  if (codecProblem) {
    logMain('record: dump codec unavailable', { dumpCodec })
    onError?.(`Error: ${codecProblem}`)
    return failed(codecProblem)
  }

  // 3. Record with Dolphin in this worker's throwaway --user profile, into the
  // clip's scratch folder (so the comm file and dump names can't clash with
  // another worker's).
  logMain('record: recording', {
    replay: replay.path,
    startFrame,
    endFrame,
    clipScratch,
  })
  const recording = new AbortController()
  signal.activeRecordings.add(recording)
  let result: Awaited<ReturnType<typeof record>> | null = null
  let recordError: unknown = null
  const runnerWarnings: RunnerWarning[] = []
  try {
    result = await record(
      { dolphinPath: config.dolphinPath, isoPath: config.ssbmIsoPath },
      slpPath,
      {
        outDir: clipScratch,
        baseName: 'clip-unmerged',
        commPath: path.join(clipScratch, 'comm.json'),
        userDir,
        startFrame,
        endFrame,
        ...(gameLastFrame ? { lastFrame: gameLastFrame } : {}),
        // A Dolphin that keeps printing frames but never reaches the end isn't
        // a stall; cap the run by the slowest speed its codec can reach.
        hardTimeoutMs: recordHardTimeoutMs(config, clipFrames),
        onFrame: (current: number) =>
          onFrameProgress?.(
            Math.max(0, Math.min(1, (current - startFrame) / clipFrames)),
          ),
        signal: recording.signal,
        // Same value buildProfile got (recordProfileOptions).
        ...recordHideOptions(config),
        onWarning: (w: RunnerWarning) => {
          runnerWarnings.push(w)
          logMain('record: dolphin-runner warning', w)
        },
      },
    )
    logMain('record: dolphin done', {
      replay: replay.path,
      dumpCodec,
      dumpBitrateKbps: dumpPlanFor(config).bitrateKbps ?? null,
      hide: result.hide
        ? {
            method: result.hide.method,
            verified: result.hide.verified,
            launcher: result.hide.desktop?.launcher ?? null,
            warnings: result.hide.warnings,
          }
        : null,
      forcedStop: result.forcedStop,
      wavRepaired: result.wavRepaired,
    })
  } catch (err) {
    // A bad path, an abort (Stop's backstop / Cancel), or a Dolphin that left
    // no video at all ("produced no video"; 0.5.7 adds how it exited). Anything
    // with footage resolves instead (below).
    recordError = err
    logMain('record: Dolphin produced no recording', {
      replay: replay.path,
      dumpCodec,
      err: String(err),
      detail: dolphinExitDetail(err),
    })
  } finally {
    signal.activeRecordings.delete(recording)
  }

  // Hiding was asked for and didn't happen: say so once, without stopping.
  if (recordHideFor(config) && !hideNoticeShown) {
    const failure = hideFailure([
      ...(result?.hide?.warnings ?? []),
      ...runnerWarnings,
    ])
    if (failure) {
      hideNoticeShown = true
      logMain('record: recording windows could not be hidden', failure)
      onNotice?.(
        `Note: the recording Dolphin windows could not be hidden on this computer (${failure.code}), so they may show up on screen. The clips are not affected. Turn off Hide Recording Windows in Settings > Recording to stop this note.`,
      )
    }
  }

  if (halted(signal)) return { ok: false, kind: 'halted' }

  if (!result) {
    if (isDiskFullError(recordError))
      return { ok: false, kind: 'diskFull', detail: driveLabel(clipScratch) }
    const detail = dolphinExitDetail(recordError)
    if (
      recordHideFor(config) &&
      hideLauncherFailed(`${recordError} ${detail}`, recorderPlatform())
    )
      return fallBackToVisible(detail, onNotice)
    onError?.(
      `Error: recording produced no video: ${path.basename(replay.path)} (dump codec ${dumpCodec})`,
    )
    return {
      ok: false,
      kind: 'noFrame',
      detail: dolphinExitDetail(recordError),
    }
  }

  // Dolphin died before its first frame (0.5.7's "early-exit"), or the
  // watchdog found a hung boot: counts toward "Dolphin isn't starting".
  const diag = result.diagnostic as {
    reason?: string
    hungOnBoot?: boolean
  } | null
  const neverStarted =
    diag?.reason === 'early-exit' || diag?.hungOnBoot === true

  // 4. Judge the footage on EVERY dump, not only stalled ones: a Dolphin that
  // exits early on its own (crash, GPU reset) leaves a short, valid-looking
  // file with no stall flagged. A stall is not a verdict either: dumps at the
  // moment of a stall have been 27-94% complete.
  const probe = await probeDump(result.avi)
  const expected = clipFrames / 60
  const short = probe.sec < expected * MIN_FOOTAGE_RATIO
  if (result.stalled || short || neverStarted) {
    logMain('record: dump check', {
      replay: replay.path,
      stalled: result.stalled,
      reason: result.diagnostic?.reason,
      gotSec: probe.sec,
      expectedSec: expected,
      detail: dolphinExitDetail(result),
    })
  }

  // Recording must have produced a non-empty video dump of the right length;
  // otherwise the clip failed (retried/counted by the caller) rather than
  // feeding a missing/partial input into ffmpeg and silently emitting nothing.
  // This is also what keeps the usage telemetry honest: only clips that
  // actually recorded advance the counter.
  let dumpOk = false
  try {
    dumpOk = !short && (await fsPromises.stat(result.avi)).size > 0
  } catch {
    dumpOk = false
  }
  if (!dumpOk) {
    logMain('record: no usable video dump', {
      stalled: result.stalled,
      short,
      replay: replay.path,
    })
    // A dump that stopped short on a full disk is a disk problem, not a clip one.
    const free = await freeBytesAt(clipScratch)
    if (free !== null && free < RUN_FLOOR_BYTES)
      return { ok: false, kind: 'diskFull', detail: driveLabel(clipScratch) }
    if (
      neverStarted &&
      recordHideFor(config) &&
      hideLauncherFailed(dolphinExitDetail(result), recorderPlatform())
    )
      return fallBackToVisible(dolphinExitDetail(result), onNotice)
    onError?.(
      `Error: recording produced no video: ${path.basename(replay.path)}`,
    )
    return {
      ok: false,
      kind: neverStarted || probe.sec === 0 ? 'noFrame' : 'failed',
      detail: dolphinExitDetail(result),
    }
  }

  onRecorded?.()

  // 5. Build the overlay PNG (optional). Rendered at the FINAL output resolution
  // — 1080p for the 2x-widescreen preset, else the dump's dims from the probe —
  // so composited text stays crisp after the single final encode.
  let overlayPngPath: string | null = null
  if (config.overlayEnabled) {
    const vars = buildReplayVars(replay, config.overlaySourceRules)
    const overlayText = applyPattern(config.overlayPattern || '', vars).trim()
    const dims = wantsWidescreen1080(config)
      ? { width: 1920, height: 1080 }
      : probe.dims
    if (overlayText && dims) {
      const pngPath = path.join(clipScratch, 'overlay.png')
      try {
        const ok = await renderOverlayPng(
          overlayText,
          dims.width,
          dims.height,
          config.overlayPosition || 'bottom-left',
          pngPath,
        )
        if (ok) overlayPngPath = pngPath
      } catch (err) {
        logMain('record: overlay render failed', err)
      }
    } else {
      logMain('record: overlay skipped', {
        hasText: Boolean(overlayText),
        dims,
      })
    }
  }

  if (halted(signal)) return { ok: false, kind: 'halted' }

  // 6. The single ffmpeg pass (buildFinalEncodeArgs): dump + wav → final, with
  // the lead-in trimmed, the overlay composited and the configured codec. It
  // writes into scratch; only a finished, non-empty file moves to the output.
  if (!result.wav) {
    logMain('record: no audio dump, encoding with a silent track', {
      replay: replay.path,
    })
  }
  const scratchOut = path.join(clipScratch, `final${ext}`)
  const encodeArgs = buildFinalEncodeArgs({
    config,
    avi: result.avi,
    wav: result.wav,
    overlayPng: overlayPngPath,
    output: scratchOut,
    threads: encodeThreadsFor(config.numProcesses),
  })
  logMain('record: spawning ffmpeg encode', { args: encodeArgs })
  let enc = await runFfmpeg(
    encodeArgs,
    signal,
    ffmpegTimeoutMs,
    'ffmpeg encode',
  )
  // Dolphin or Defender can still hold the dump's wav/avi for a moment after
  // Dolphin exits (ffmpeg: "Permission denied"): wait and try again before the
  // whole clip is recorded a second time.
  for (
    let again = 1;
    again <= 3 &&
    enc.code !== 0 &&
    !halted(signal) &&
    isFileLockedText(enc.stderr);
    again++
  ) {
    logMain('record: ffmpeg input is locked, retrying the encode', {
      attempt: again,
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 1000 * again)
    })
    enc = await runFfmpeg(encodeArgs, signal, ffmpegTimeoutMs, 'ffmpeg encode')
  }
  if (halted(signal)) return { ok: false, kind: 'halted' }
  if (enc.code !== 0) {
    logMain(`record: ffmpeg encode failed (code ${enc.code})`, {
      stderr: enc.stderr.slice(-2000),
    })
    if (isDiskFullText(enc.stderr))
      return { ok: false, kind: 'diskFull', detail: driveLabel(clipScratch) }
    return failed(
      `encoding failed (ffmpeg exit ${enc.code ?? 'timeout'}): ${path.basename(
        replay.path,
      )}`,
    )
  }

  // 7. Validate the encode actually wrote something before it counts. An ffmpeg
  // can exit 0 yet leave a 0-byte file; counting it inflated the usage stats and
  // produced the "holes" seen when forensically recounting a run.
  try {
    const st = await fsPromises.stat(scratchOut)
    if (st.size === 0) throw new Error('empty output')
  } catch {
    logMain('record: final output missing or empty', {
      scratchOut,
      replay: replay.path,
    })
    return failed(`clip produced no output file: ${path.basename(replay.path)}`)
  }

  // 8. Into the output folder: a rename on the same drive, copy + delete across
  // drives (moveFile handles EXDEV and never leaves a partial under the real name).
  try {
    await moveFile(scratchOut, finalOutput)
  } catch (err) {
    if (isDiskFullError(err))
      return { ok: false, kind: 'diskFull', detail: driveLabel(outputDir) }
    logMain('record: could not move clip to the output folder', {
      finalOutput,
      err: String(err),
    })
    return failed(`could not write ${finalOutput}`)
  }

  // "Keep Lossless Master": keep Dolphin's RAW dump next to the clip, moved
  // rather than copied. It is the untouched recording: video only, in the dump
  // codec (UT Video/FFV1 lossless; mpeg4 in Fast draft), with the 1 s lead-in
  // still at the start; its audio is the matching .master.wav.
  if (config.keepLosslessMaster) {
    try {
      await moveFile(result.avi, outputFile('.master.avi'))
      if (result.wav) await moveFile(result.wav, outputFile('.master.wav'))
    } catch (err) {
      logMain('record: keep-lossless-master move failed', {
        err: String(err),
      })
      if (isDiskFullError(err))
        return { ok: false, kind: 'diskFull', detail: driveLabel(outputDir) }
    }
  }

  return { ok: true, file: finalOutput }
}

// Never concatenated: kept masters, leftovers of the old in-place pipeline
// (-unmerged/-merged/-lossless/-final), half-copied clips, and the previous
// concat result.
const NOT_A_CLIP =
  /(\.master\.(avi|wav)$|-unmerged|-merged|-lossless\.|-final\.|\.partial$)/i

/**
 * The finished clips to concatenate, in name order, including those the
 * filename pattern put in subfolders (relative paths sort folder by folder).
 */
export const listConcatInputs = async (
  outputPath: string,
  ext: string,
): Promise<string[]> => {
  const found: string[] = []
  const walk = async (dir: string, rel: string) => {
    let entries: import('fs').Dirent[] = []
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), relPath)
      } else if (
        e.isFile() &&
        e.name.toLowerCase().endsWith(ext) &&
        !NOT_A_CLIP.test(e.name) &&
        !(rel === '' && e.name === `final${ext}`)
      ) {
        found.push(relPath)
      }
    }
  }
  await walk(outputPath, '')
  return found.sort().map((r) => path.resolve(outputPath, ...r.split('/')))
}

/** One `file '...'` line for ffmpeg's concat demuxer, quotes escaped. */
export const concatLine = (file: string) =>
  `file '${file.replace(/'/g, "'\\''")}'`

const processReplays = async (
  replays: ReplayInterface[],
  config: ConfigInterface & { numProcesses: number; gameMusicOn: boolean },
  eventEmitter: (_msg: string) => void,
  signal: VideoSignal,
  workerStatuses: VideoWorkerStatus[],
  // This run's scratch folder (scratchDirFor); removed when the run ends.
  scratchDir: string,
  abortJob: (_reason: string) => void,
  onClipEncoded?: (_replay: ReplayInterface) => void,
  onClipFailed?: (_replay: ReplayInterface) => void,
  onNotice?: (_msg: string) => void,
) => {
  const queue = [...replays]
  const total = replays.length
  const progress = { recorded: 0, encoded: 0 }
  // Clips that failed every attempt (not stop/cancel) — surfaced to the user and
  // written to failures.json so a run that silently drops clips is visible.
  const failures: ReplayInterface[] = []
  // "Dolphin isn't starting": attempts with no frame before anything worked.
  let anyFrame = false
  let noFrameAttempts = 0

  // Each worker's progress through the clip it is recording (0-1), so the
  // status moves during a long clip, not only when one finishes.
  const inFlight: number[] = []
  let lastPct = -1
  const emitStatus = () => {
    if (progress.recorded < total) {
      const done =
        progress.recorded + inFlight.reduce((sum, f) => sum + (f || 0), 0)
      const pct = Math.min(99, Math.floor((done / total) * 100))
      lastPct = pct
      eventEmitter(`recording ${progress.recorded}/${total} · ${pct}%`)
    } else {
      eventEmitter(`encoding ${progress.encoded}/${total}`)
    }
  }
  emitStatus()

  const onRecorded = () => {
    anyFrame = true
    progress.recorded += 1
    emitStatus()
  }
  const onFrameProgress = (workerIndex: number, fraction: number) => {
    if (fraction > 0) anyFrame = true
    inFlight[workerIndex] = fraction
    const done =
      progress.recorded + inFlight.reduce((sum, f) => sum + (f || 0), 0)
    if (Math.floor((done / total) * 100) !== lastPct) emitStatus()
  }
  // One throwaway Dolphin `--user` profile per worker (recordProfileOptions),
  // indexed by workerIndex. Populated before the workers start, deleted in the
  // finally below — recording never touches the user's real Slippi profile.
  const workerProfiles: string[] = []

  const MAX_ATTEMPTS = 2 // one retry on a genuine failure
  let clipSeq = 0
  const worker = async (workerIndex: number) => {
    let replay = queue.shift()
    while (replay !== undefined) {
      if (halted(signal)) break

      // A failed clip after recording (e.g. encode error) already bumped the
      // recorded counter; guard so a retry that re-records doesn't count twice.
      let recordedCounted = false
      const onRecordedOnce = () => {
        inFlight[workerIndex] = 0
        workerStatuses[workerIndex].phase = 'encoding'
        if (!recordedCounted) {
          recordedCounted = true
          onRecorded()
        }
      }

      let outcome: ClipOutcome = { ok: false, kind: 'halted' }
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (halted(signal)) break
        workerStatuses[workerIndex] = {
          replayPath: replay.path,
          phase: 'recording',
          replayIndex: replay.index,
        }
        // Short, per-attempt names: the scratch path stays well under Windows'
        // path limit whatever the output pattern makes, and a retry never sees
        // the failed attempt's files.
        clipSeq += 1
        const clipScratch = path.join(scratchDir, `c${clipSeq}`)
        try {
          outcome = await processOneReplay(
            replay,
            config,
            workerProfiles[workerIndex],
            clipScratch,
            signal,
            onRecordedOnce,
            eventEmitter,
            (fraction) => onFrameProgress(workerIndex, fraction),
            onNotice,
          )
        } catch (err) {
          // Anything unexpected is this clip's failure, not the run's.
          logMain('record: clip threw', {
            replay: replay.path,
            err: String(err),
          })
          outcome = isDiskFullError(err)
            ? { ok: false, kind: 'diskFull', detail: driveLabel(scratchDir) }
            : { ok: false, kind: 'failed', detail: String(err) }
        } finally {
          // Every attempt's scratch goes, success or not (a kept master was
          // moved out already).
          await removeTree(clipScratch)
        }
        inFlight[workerIndex] = 0
        if (outcome.ok || outcome.kind === 'halted') break
        if (outcome.kind === 'diskFull') {
          abortJob(`Stopped: disk full on ${outcome.detail}`)
          break
        }
        if (outcome.kind === 'noFrame' && !anyFrame) {
          noFrameAttempts += 1
          if (noFrameAttempts >= NO_FRAME_ABORT_AFTER) {
            abortJob(
              `Stopped: Dolphin isn't starting (last error: ${outcome.detail})`,
            )
            break
          }
        }
        logMain('record: clip failed, retrying', {
          replay: replay.path,
          attempt,
          kind: outcome.kind,
          detail: outcome.detail,
        })
      }

      if (!outcome.ok && halted(signal)) break
      if (outcome.ok) {
        progress.encoded += 1
        emitStatus()
        onClipEncoded?.(replay)
      } else {
        // Exhausted retries without a Stop/Cancel — a real failure.
        failures.push(replay)
        onClipFailed?.(replay)
      }
      workerStatuses[workerIndex] = {
        replayPath: '',
        phase: 'idle',
        replayIndex: -1,
      }
      replay = queue.shift()
    }
  }

  // Build the per-worker profiles up front, run, then delete them (and the
  // run's scratch folder) in the finally so an error/stop/cancel can never
  // leave temp profiles or GBs of dumps behind.
  try {
    eventEmitter('Preparing Dolphin...')
    await fsPromises.mkdir(scratchDir, { recursive: true })
    for (let i = 0; i < config.numProcesses; i++) {
      const dir = await fsPromises.mkdtemp(
        path.join(dolphinTempRoot(), 'lmclip-dolphin-'),
      )
      workerProfiles.push(dir) // pushed first, so the finally removes it on failure
      await buildProfileWithFallback(dir, recordProfileOptions(config, i))
    }

    const workers = []
    for (let i = 0; i < config.numProcesses; i++) workers.push(worker(i))
    await Promise.all(workers)
  } finally {
    await Promise.all([
      ...workerProfiles.map((d) => removeTree(d)),
      removeTree(scratchDir),
    ])
  }

  // Persist a manifest of failed clips so they can be inspected or re-run later.
  if (failures.length > 0) {
    logMain(`record: ${failures.length} clip(s) failed`, {
      count: failures.length,
    })
    await fsPromises
      .writeFile(
        path.resolve(config.outputPath, 'failures.json'),
        JSON.stringify(
          failures.map((r) => ({
            index: r.index,
            path: r.path,
            startFrame: r.startFrame,
            endFrame: r.endFrame,
          })),
          null,
          2,
        ),
      )
      .catch((err) => logMain('record: could not write failures.json', err))
  }

  // The run stopped itself: one message, no concat (a full disk can't hold it,
  // and a Dolphin that won't start made nothing to join).
  if (signal.abortReason) throw new RecordingStoppedError(signal.abortReason)

  // Concatenate the finished clips into a single video. Runs on a normal finish
  // AND on Stop — Stop means "keep completed clips": it lets the in-flight clip
  // finish and kills nothing, so every clip in the output folder is complete
  // (clips are only moved there once encoded). Only Cancel skips it.
  if (config.concatenate && !signal.cancelled) {
    eventEmitter('Concatenating clips...')

    const ext = config.convertToMp4 ? '.mp4' : '.avi'
    const outputFiles = await listConcatInputs(config.outputPath, ext)

    if (outputFiles.length > 1) {
      const concatListPath = path.resolve(config.outputPath, 'concat_list.txt')
      await fsPromises.writeFile(
        concatListPath,
        outputFiles.map(concatLine).join('\n'),
      )

      const finalPath = path.resolve(config.outputPath, `final${ext}`)
      const concatArgs = [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c:v',
        'copy',
        '-fflags',
        '+genpts',
      ]
      if (config.convertToMp4) {
        // MP4 clips already have AAC audio, pure stream copy
        concatArgs.push('-c:a', 'copy')
      } else {
        concatArgs.push(
          '-b:v',
          `${config.bitrateKbps}k`,
          '-af',
          'aresample=async=1:first_pts=0',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
        )
      }
      concatArgs.push(finalPath)

      logMain('record: spawning ffmpeg concat', { args: concatArgs })
      // A stream copy: bounded by the bytes, so a generous size-free cap.
      const concat = await runFfmpeg(
        concatArgs,
        signal,
        6 * 60 * 60 * 1000,
        'ffmpeg concat',
      )
      if (concat.code !== 0) {
        logMain(`record: ffmpeg concat failed (code ${concat.code})`, {
          stderr: concat.stderr.slice(-2000),
        })
        await unlinkQuiet(finalPath)
        eventEmitter(
          isDiskFullText(concat.stderr)
            ? `Error: could not join the clips: disk full on ${driveLabel(
                config.outputPath,
              )} (the clips are kept)`
            : 'Error: could not join the clips (the clips are kept)',
        )
      }

      // Clean up concat list
      await unlinkQuiet(concatListPath)
    }
  }

  eventEmitter(
    failures.length > 0
      ? `Done — ${failures.length} clip(s) failed (see failures.json) :)`
      : 'Done :)',
  )
  // Clears the status line; never keeps a process (or a test run) alive.
  setTimeout(
    () => {
      eventEmitter('')
    },
    failures.length > 0 ? 6000 : 2000,
  ).unref?.()
}

const DUMP_FLAG_ON =
  /^\s*(DumpFrames|DumpFramesSilent|DumpAudio|DumpAudioSilent)\s*=\s*True\s*$/im

/** Does the real profile's Dolphin.ini have a dump flag switched on (a profile an
 *  older Clipper recorded in place)? Unreadable or missing: no. */
export const dumpFlagsAreOn = async (profile: unknown): Promise<boolean> => {
  const ini = (profile as { dolphinIni?: string } | null)?.dolphinIni
  if (!ini) return false
  try {
    return DUMP_FLAG_ON.test(await fsPromises.readFile(ini, 'utf8'))
  } catch {
    return false
  }
}

// The user's real Slippi Playback profile, which the throwaway profiles copy
// (and healRealProfile repairs). Windows keeps it portable next to the binary;
// elsewhere it is under Electron's appData, which we pass on explicitly rather
// than let the package guess it.
const realProfileOf = (config: ConfigInterface) =>
  profileAt(
    os.type() === 'Windows_NT'
      ? realProfileRoot(config.dolphinPath, 'Windows_NT')
      : path.resolve(getAppDataPath(), 'SlippiPlayback'),
  )

// Builds the GALE01.ini [Gecko] / [Gecko_Enabled] / [Gecko_Disabled] body from
// the current config. Shared by recording (configureDolphin) and playback so
// the play window reflects the same rendering toggles as recording.
const buildGeckoSettings = (config: ConfigInterface): string[] => {
  // gameMusicOn is injected for recording jobs; fall back to the raw setting
  // so playback (which passes the plain config) behaves identically.
  const gameMusicOn =
    (config as { gameMusicOn?: boolean }).gameMusicOn ?? config.gameMusic

  // Custom gecko codes go in the [Gecko] section as definitions
  const geckoDefinitions: string[] = []
  const customGeckoCodes = config.customGeckoCodes || []
  for (const gc of customGeckoCodes) {
    if (gc.name && gc.code) {
      geckoDefinitions.push(`$${gc.name}`)
      // Each line of the code block is a hex line
      for (const line of gc.code.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) geckoDefinitions.push(trimmed)
      }
    }
  }

  const settings: string[] = ['[Gecko]']

  // Inline definitions for codes not in the playback GALE01r2.ini
  if (config.freezeFD) {
    settings.push('$Freeze FD Background')
    settings.push('0421AAE0 48000008')
  }
  if (config.centerHud) {
    settings.push('$Center Align 2P HUD')
    settings.push('C216E9AC 00000009')
    settings.push('887F0061 2C030003')
    settings.push('41820030 887F0085')
    settings.push('2C030003 41820024')
    settings.push('887F00A9 2C030003')
    settings.push('40820018 887F00CD')
    settings.push('2C030003 4082000C')
    settings.push('38600002 4800000C')
    settings.push('887F0000 5463F77E')
    settings.push('60000000 00000000')
  }
  if (config.flashRedLCancel) {
    settings.push('$Flash Red Failed L-Cancel A')
    settings.push('C20C0148 0000000C')
    settings.push('387F0488 899E0564')
    settings.push('2C0C00D4 41820008')
    settings.push('4800004C 39800091')
    settings.push('999E0564 3D80437F')
    settings.push('919E0518 3D80C200')
    settings.push('919E0524 3D800000')
    settings.push('919E051C 919E0520')
    settings.push('919E0528 919E052C')
    settings.push('919E0530 3D80C280')
    settings.push('919E0534 3D80800C')
    settings.push('618C0150 7D8903A6')
    settings.push('4E800420 00000000')
    settings.push('$Flash Red Failed L-Cancel B')
    settings.push('C208D690 00000009')
    settings.push('3D808048 818C9D30')
    settings.push('558C443E 2C0C0208')
    settings.push('40820020 818DB61C')
    settings.push('898C0000 8965000C')
    settings.push('7C0C5800 4182000C')
    settings.push('88A5067F 48000018')
    settings.push('88A5067F 2C050007')
    settings.push('4180000C 398000D4')
    settings.push('99830564 00000000')
  }

  // Write custom code definitions
  settings.push(...geckoDefinitions)

  settings.push('[Gecko_Enabled]')
  if (!gameMusicOn) settings.push('$Optional: Game Music OFF')
  if (config.hideHud) settings.push('$Optional: Hide HUD')
  if (config.hideTags) settings.push('$Optional: Hide Tags')
  if (config.fixedCamera) settings.push('$Optional: Fixed Camera Always')
  if (config.widescreen !== false) settings.push('$Optional: Widescreen 16:9')
  if (config.disableScreenShake)
    settings.push('$Optional: Disable Screen Shake')
  if (config.noElectricSFX) settings.push('$Optional: No Electric SFX')
  if (config.noCrowdNoise) settings.push('$Optional: Prevent Crowd Noises')
  if (!config.enableChants)
    settings.push('$Optional: Prevent Character Crowd Chants')
  if (config.disableMagnifyingGlass)
    settings.push('$Optional: Disable Magnifying-glass HUD')
  if (config.freezeFD) settings.push('$Freeze FD Background')
  if (config.centerHud) settings.push('$Center Align 2P HUD')
  if (config.developMode) settings.push('$Optional: Enable Develop Mode')
  if (config.flashRedLCancel) {
    settings.push('$Flash Red Failed L-Cancel A')
    settings.push('$Flash Red Failed L-Cancel B')
  }
  // Enable custom gecko codes
  for (const gc of customGeckoCodes) {
    if (gc.name && gc.code && gc.enabled) {
      settings.push(`$${gc.name}`)
    }
  }

  settings.push('[Gecko_Disabled]')
  if (config.hideNames) settings.push('$Optional: Show Player Names')
  // Codes left in [Gecko_Enabled] when the toggle is off would otherwise keep
  // whatever the base GALE01r2.ini / a previous job set. Explicitly disable the
  // optional rendering codes when their toggle is off so they never go stale
  // (e.g. Hide HUD persisting into the play window after a prior recording).
  if (!config.hideHud) settings.push('$Optional: Hide HUD')
  if (!config.hideTags) settings.push('$Optional: Hide Tags')
  if (!config.fixedCamera) settings.push('$Optional: Fixed Camera Always')
  if (config.widescreen === false) settings.push('$Optional: Widescreen 16:9')
  if (!config.disableScreenShake)
    settings.push('$Optional: Disable Screen Shake')
  if (!config.noElectricSFX) settings.push('$Optional: No Electric SFX')
  if (!config.noCrowdNoise) settings.push('$Optional: Prevent Crowd Noises')
  if (!config.disableMagnifyingGlass)
    settings.push('$Optional: Disable Magnifying-glass HUD')
  if (!config.developMode) settings.push('$Optional: Enable Develop Mode')
  // Disabled custom gecko codes
  for (const gc of customGeckoCodes) {
    if (gc.name && gc.code && !gc.enabled) {
      settings.push(`$${gc.name}`)
    }
  }

  return settings
}

/** Parse "HH:MM:SS.xx" (ffmpeg time/duration) into seconds. */
const parseFfmpegTime = (m: RegExpMatchArray): number =>
  parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3])

/**
 * Header info for a concat list. A metadata-only pass — `ffmpeg -i <concat>`
 * with no output prints the container header to stderr then exits non-zero. We
 * bundle ffmpeg but not ffprobe, so this is the way in.
 *
 * NOTE: the concat demuxer reports `Duration: N/A` (it doesn't sum segment
 * lengths without reading them all), so `seconds` is usually 0. It DOES report
 * `bitrate` (from the first segment), which callers pair with the total byte
 * size to derive a duration — the clips are near-constant-bitrate dumps, so
 * size ÷ bitrate is a good estimate and stays O(1) regardless of clip count.
 */
const probeConcatInfo = (
  listPath: string,
): Promise<{ seconds: number; bitrateKbps: number }> =>
  new Promise((resolve) => {
    const p = spawn(
      ffmpegPath,
      ['-f', 'concat', '-safe', '0', '-i', listPath],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    )
    let err = ''
    p.stderr?.on('data', (c: Buffer) => {
      err += c.toString()
    })
    p.on('error', () => resolve({ seconds: 0, bitrateKbps: 0 }))
    p.on('exit', () => {
      const dm = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(err)
      const bm = /bitrate:\s*(\d+)\s*kb\/s/.exec(err)
      resolve({
        seconds: dm ? parseFfmpegTime(dm) : 0,
        bitrateKbps: bm ? parseInt(bm[1], 10) : 0,
      })
    })
  })

/**
 * Header info for an ordered list of clip files — the Stitch modal's live
 * estimate. Writes a throwaway concat list next to the first clip (guaranteed
 * writable), header-probes it, and cleans up. Returns the reported duration
 * (usually 0 — see probeConcatInfo) and the source bitrate.
 */
export async function probeFilesInfo(
  files: string[],
): Promise<{ seconds: number; bitrateKbps: number }> {
  if (!files || files.length === 0) return { seconds: 0, bitrateKbps: 0 }
  const listPath = path.resolve(
    path.dirname(files[0]),
    `probe_list_${crypto.randomBytes(6).toString('hex')}.txt`,
  )
  const lines = files.map(concatLine)
  try {
    await fsPromises.writeFile(listPath, lines.join('\n'))
    return await probeConcatInfo(listPath)
  } catch {
    return { seconds: 0, bitrateKbps: 0 }
  } finally {
    await fsPromises.unlink(listPath).catch(() => {})
  }
}

/**
 * Stitch already-rendered clips into one video, in the given order. The
 * standalone counterpart to the concat step baked into a recording run — used
 * by the Stitch tool on an existing output folder. Stream-copies video (fast,
 * lossless); for .avi it re-encodes audio to AAC, mirroring the run path.
 *
 * `files` are absolute paths in final order. `onProgress` (optional) reports
 * 0–100 as ffmpeg works. Resolves { ok } / { ok:false, error } rather than
 * throwing, so the caller can surface a clean message.
 */
export async function concatClips(
  files: string[],
  output: string,
  opts: {
    convertToMp4: boolean
    bitrateKbps: number
    // When set, re-encode the joined video to H.264 at ~`videoKbps` (instead of
    // stream-copying) so the result is a small, upload-friendly file. The
    // near-lossless recording dumps shrink dramatically with no visible loss.
    compress?: boolean
    videoKbps?: number
  },
  onProgress?: (_percent: number) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (!files || files.length < 2) {
    return { ok: false, error: 'Need at least 2 clips to stitch.' }
  }
  const listPath = path.resolve(
    path.dirname(output),
    `stitch_list_${crypto.randomBytes(6).toString('hex')}.txt`,
  )
  // ffmpeg concat demuxer: one `file '…'` line per input. Escape single quotes.
  const lines = files.map(concatLine)
  await fsPromises.writeFile(listPath, lines.join('\n'))

  const args = [
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-fflags',
    '+genpts',
  ]
  if (opts.compress) {
    // Re-encode to a target bitrate so the output size is predictable (what the
    // modal estimates from) and small enough to upload. Always writes AAC audio.
    args.push(
      '-c:v',
      'libx264',
      '-b:v',
      `${opts.videoKbps ?? 4000}k`,
      '-preset',
      'medium',
      '-pix_fmt',
      'yuv420p',
      '-af',
      'aresample=async=1:first_pts=0',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
    )
  } else {
    args.push('-c:v', 'copy')
    if (opts.convertToMp4) {
      args.push('-c:a', 'copy')
    } else {
      args.push(
        '-b:v',
        `${opts.bitrateKbps}k`,
        '-af',
        'aresample=async=1:first_pts=0',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
      )
    }
  }
  args.push('-y', output)

  logMain('stitch: spawning ffmpeg concat', { args })
  try {
    // Total footage seconds up front, so ffmpeg's stderr `time=` can be turned
    // into a real %. The concat demuxer usually reports `Duration: N/A`, so when
    // it does we derive the total from the summed file sizes ÷ the (reported)
    // bitrate — the same estimate the Stitch modal shows, and accurate for these
    // near-constant-bitrate clips. 0 → the caller keeps its indeterminate bar.
    let totalSec = 0
    if (onProgress) {
      const info = await probeConcatInfo(listPath)
      totalSec = info.seconds
      if (totalSec <= 0 && info.bitrateKbps > 0) {
        const sizes = await Promise.all(
          files.map((f) =>
            fsPromises
              .stat(f)
              .then((s) => s.size)
              .catch(() => 0),
          ),
        )
        const bytes = sizes.reduce((a, b) => a + b, 0)
        totalSec = (bytes * 8) / (info.bitrateKbps * 1000)
      }
      logMain('stitch: estimated total footage', {
        totalSec: Math.round(totalSec),
      })
    }
    onProgress?.(0)

    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    let lastPct = -1
    proc.stderr?.on('data', (c: Buffer) => {
      const s = c.toString()
      stderr += s
      if (onProgress && totalSec > 0) {
        const times = [...s.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)]
        const last = times[times.length - 1]
        if (last) {
          // Cap at 99 while running; the 100 comes only on a clean exit.
          const pct = Math.min(
            99,
            Math.max(0, Math.round((parseFfmpegTime(last) / totalSec) * 100)),
          )
          if (pct !== lastPct) {
            lastPct = pct
            onProgress(pct)
          }
        }
      }
    })
    const code = await exit(proc)
    if (code !== 0) {
      logMain(`stitch: ffmpeg concat failed (code ${code})`, {
        stderr: stderr.slice(-2000),
      })
      return { ok: false, error: `ffmpeg exited with code ${code}` }
    }
    onProgress?.(100)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || 'ffmpeg failed' }
  } finally {
    await fsPromises.unlink(listPath).catch(() => {})
  }
}

// The throwaway `--user` profiles. Recording and previews never touch the user's
// real Slippi profile: buildProfile copies its inis and applies these options to
// the copies (one profile per worker, deleted when the run ends).

// Dolphin's dump codec is the recording-speed lever (it encodes on one thread).
// slippi-dolphin-runner's measurements, EFB 4 (2x), one minute of footage:
//   utvideo 1.81x realtime, lossless (identical to FFV1 after 4:2:0), ~3 GB/min
//   mpeg4   1.66x at 150 Mb/s (lossy, ~42 dB), 0.57 GB/min
//   ffv1    0.34x, lossless, 3.8 GB/min (0.10x at 3x)
// utvideo needs an even dump width and native (resolution 2) is 939 wide, so
// native stays FFV1 (lossless) or mpeg4 (draft). Windows Playback has no
// utvideo encoder: its "auto" above native is mpeg4 at 150 Mb/s (1.26x at 2x,
// 0.62x at 3x on the Windows rig, 49-51 dB against FFV1). Never h264: Dolphin drops the
// last ~50 frames of an h264 dump. Each clip's dump is deleted once encoded.
// The decision itself lives in diskSpace.ts (dumpPlanFor), which the disk
// estimate shares, so the two can never disagree about what will be dumped.
export type RecordingFormat = 'auto' | 'lossless' | 'draft'

/** The format this config records in (Fast draft from before the setting). */
export const recordingFormatOf = (config: ConfigInterface): RecordingFormat =>
  recordingFormatOfConfig(config)

/** The dump codec (and bitrate) Dolphin records with. */
export const dumpCodecFor = (
  config: ConfigInterface,
): Partial<Pick<ProfileOptions, 'dumpCodec' | 'bitrateKbps'>> =>
  dumpPlanFor(config)

const shaderCacheRoot = () =>
  path.join(
    app && typeof app.getPath === 'function'
      ? app.getPath('userData')
      : path.join(os.tmpdir(), 'lunar-clipper'),
    'shader-cache',
  )

/** A worker slot's own shader cache, kept between runs (never shared: two
 *  Dolphins writing one cache corrupt it). */
const shaderCacheDirOf = (slot: number) =>
  path.join(shaderCacheRoot(), `worker-${slot}`)

/** Previews' shader cache: their own, so a preview opened during a recording
 *  never writes into a recording slot's cache. */
const previewShaderCacheDir = () => path.join(shaderCacheRoot(), 'preview')

/** "Hide Recording Windows" (on unless turned off). */
const hideSettingOn = (config: ConfigInterface) =>
  (config as { hideRecordingWindows?: boolean }).hideRecordingWindows !== false

/** The OS the recorder runs on (tests mock os.type for Windows). */
const recorderPlatform = (): NodeJS.Platform =>
  isWindowsPlatform() ? 'win32' : process.platform

/**
 * Pass the runner's `hide` (identically to buildProfile and record())? The
 * setting is on, and the OS is Windows (hidden desktop through the launcher)
 * or Linux (parked on the last workspace). Not macOS: the runner's Mac path is
 * unverified, so recordings there stay small background windows, as before.
 */
export const recordHideFor = (
  config: ConfigInterface,
  platform: NodeJS.Platform = recorderPlatform(),
): boolean =>
  hideSettingOn(config) && !hideDisabledForSession && platform !== 'darwin'

/** record()'s hide options: `hide` plus, on Windows, the unpacked launcher. */
export const recordHideOptions = (
  config: ConfigInterface,
  platform: NodeJS.Platform = recorderPlatform(),
  launcherPath: () => string = hideLauncherPath,
): { hide?: true; hideLauncherPath?: string } => {
  if (!recordHideFor(config, platform)) return {}
  return platform === 'win32'
    ? { hide: true, hideLauncherPath: launcherPath() }
    : { hide: true }
}

// Warnings that mean a recording could NOT be kept off screen. Not
// hide-native-unavailable (optional extras on top of the hidden desktop) or
// dump-codec-fallback (not about windows).
const HIDE_FAILED_CODES = new Set([
  'hide-unsupported',
  'hide-desktop-unavailable',
  'hide-session-unsupported',
  'hide-failed',
  'placement-unsupported',
  'placement-no-wm',
  'placement-no-workspace',
  'placement-ignored',
])

/** The first warning saying hiding didn't happen, or null. */
export const hideFailure = (
  warnings: ReadonlyArray<{ code: string; detail?: string }>,
): { code: string; detail?: string } | null =>
  warnings.find((w) => HIDE_FAILED_CODES.has(w.code)) ?? null

// Once per app session, not per clip: a machine that can't hide can't hide
// any of its clips.
let hideNoticeShown = false
/** Tests only. */
export const resetHideNotice = () => {
  hideNoticeShown = false
}

// Recording. Every recording runs unthrottled (EmulationSpeed 0): the dump is
// identical, Dolphin boots in ~1.1 s instead of ~3.8 s, and short clips are
// mostly boot. Muted by default (the WAV dump is unaffected). With "Hide
// Recording Windows" on (the default), out of the way (BACKGROUND_RECORD) and,
// on Windows and Linux, off screen entirely (`hide`, recordHideFor).
export const recordProfileOptions = (
  config: ConfigInterface,
  slot?: number,
): ProfileOptions & { dolphinPath: string } => {
  const packs = enabledTexturePacks(config)
  const c = config as {
    muteRecordings?: boolean
  }
  return {
    mode: 'record',
    dolphinPath: config.dolphinPath,
    sourceProfile: realProfileOf(config),
    ...(hideSettingOn(config) ? BACKGROUND_RECORD : {}),
    // The ini half of `hide` (Windows: one small main window on OGL); the same
    // value goes to record() (processOneReplay).
    ...(recordHideFor(config) ? { hide: true as const } : {}),
    // Never gate a recording on the display, shown or not: a copied profile
    // with VSync on (Slippi's default) holds a visible recording to exactly
    // 1.0x (measured on the Windows rig: 1.00x with VSync, 1.2x without, the
    // rest is the encoder).
    vsync: false,
    // Windows: OGL, never the blank default (= DX11), which DROPS frames from
    // the dump: 3240 of 3600 measured, visible or hidden; OGL is frame-exact.
    ...(isWindowsPlatform() ? { gfxBackend: 'OGL' as const } : {}),
    efbScale: config.resolution,
    aspectRatio: config.widescreen !== false ? 6 : 5,
    ...dumpCodecFor(config),
    emulationSpeed: 0,
    // Synchronous shader compilation. The async modes (1-3) draw a frame
    // without objects whose shaders aren't ready yet, and a dump keeps that
    // frame: missing characters/effects for the first moments of a clip.
    shaderCompilationMode: 0,
    ...(c.muteRecordings !== false ? { silent: true } : {}),
    ...(slot !== undefined ? { shaderCacheDir: shaderCacheDirOf(slot) } : {}),
    geckoIni: buildGeckoSettings(config).join('\n'),
    texturePacks: packs,
    hiresTextures: packs.length > 0,
    // Offline per-clip dumps: lazy-load what each clip shows rather than
    // prefetching a multi-hundred-MB pack on every Dolphin boot.
    cacheHiresTextures: false,
  }
}

// Clip preview and Test Dolphin: the same look, no dump, at the playback
// resolution (default native), at real speed. A copied profile can carry
// EmulationSpeed 0 or VSync off from a user's own tinkering, and a preview at
// unlimited speed plays in fast-forward; vsync keeps it from tearing.
export const playbackProfileOptions = (
  config: ConfigInterface,
): ProfileOptions & { dolphinPath: string } => {
  const packs = enabledTexturePacks(config)
  return {
    mode: 'play',
    dolphinPath: config.dolphinPath,
    sourceProfile: realProfileOf(config),
    efbScale:
      (config as { playbackResolution?: number }).playbackResolution ?? 2,
    // The preview matches the recording's shape, and opens fullscreen when
    // "Fullscreen preview" is on (otherwise in a window).
    aspectRatio: config.widescreen !== false ? 6 : 5,
    window: config.fullscreen !== false ? { fullscreen: true } : undefined,
    emulationSpeed: 1,
    vsync: true,
    // Kept between previews (a cold cache stutters the first seconds of play).
    shaderCacheDir: previewShaderCacheDir(),
    geckoIni: buildGeckoSettings(config).join('\n'),
    texturePacks: packs,
    hiresTextures: packs.length > 0,
    cacheHiresTextures: false,
  }
}

const NO_PROFILE_RE = /no Slippi Playback profile/i

/**
 * buildProfile, but a user who has never opened Slippi Playback (no real
 * profile to copy) still gets a working profile: built fresh from Dolphin's
 * defaults plus every option we set, with a warning in the log. Their own
 * Playback settings (controller, audio device) aren't there to copy anyway.
 */
export const buildProfileWithFallback = async (
  userDir: string,
  opts: ProfileOptions & { dolphinPath: string },
): Promise<void> => {
  const missing =
    opts.sourceProfile !== undefined && !realProfileExists(opts.sourceProfile)
  if (!missing) {
    try {
      await buildProfile(userDir, opts)
      return
    } catch (err) {
      if (!NO_PROFILE_RE.test(String((err as Error)?.message ?? err))) throw err
    }
  }
  logMain('dolphin profile: no Slippi Playback profile, building a fresh one', {
    source: opts.sourceProfile?.configDir,
  })
  await buildProfile(userDir, { ...opts, freshProfile: true })
}

export const buildPlaybackProfile = (
  config: ConfigInterface,
  userDir: string,
) => buildProfileWithFallback(userDir, playbackProfileOptions(config))

const slpToVideo = (
  replays: ReplayInterface[],
  config: ConfigInterface & { numProcesses: number; gameMusicOn: boolean },
  eventEmitter: (_msg: string) => void,
  // Called once per clip the moment its final file is written, so the caller
  // can report progress incrementally (e.g. checkpointed usage telemetry) and
  // not lose a whole long render if the process is killed before it finishes.
  onClipEncoded?: (_replay: ReplayInterface) => void,
  // Called once per clip that failed every attempt (not a Stop/Cancel), so the
  // caller can surface a running "N failed" count.
  onClipFailed?: (_replay: ReplayInterface) => void,
  // A non-blocking note for the app's console (e.g. windows couldn't be hidden).
  onNotice?: (_msg: string) => void,
): VideoJobController => {
  const signal: VideoSignal = {
    stopped: false,
    cancelled: false,
    abortReason: null,
    activeProcesses: new Set(),
    activeRecordings: new Set(),
  }

  const workerStatuses: VideoWorkerStatus[] = Array.from(
    { length: config.numProcesses },
    () => ({
      replayPath: '',
      phase: 'idle' as const,
      replayIndex: -1,
    }),
  )

  // Backstop for Stop: it asks workers to drain gracefully (let in-flight clips
  // finish, keep everything done), but if some process is genuinely wedged past
  // the watchdog, this force-kills whatever is still active so the job can never
  // hang forever. Cleared the moment the job settles.
  let stopBackstop: ReturnType<typeof setTimeout> | null = null
  const forceKillAll = (reason: string) => {
    const n = signal.activeProcesses.size + signal.activeRecordings.size
    if (n > 0) {
      logMain(`record: force-killing ${n} process(es)`, { reason }) // prettier-ignore
    }
    signal.activeProcesses.forEach((p) => killTree(p))
    signal.activeProcesses.clear()
    signal.activeRecordings.forEach((r) => r.abort())
    signal.activeRecordings.clear()
  }

  // The run stops itself (disk full, Dolphin not starting): remember the one
  // message, stop the workers and kill what's in flight (their clips can't
  // finish anyway). processReplays throws it as a RecordingStoppedError.
  // Said with "Dolphin isn't starting" when the ISO looks incomplete (isoCheck.ts).
  let isoHint: string | null = null
  const abortJob = (reason: string) => {
    if (signal.abortReason !== null) return
    signal.abortReason =
      isoHint && reason.includes("Dolphin isn't starting")
        ? `${reason}. ${isoHint}`
        : reason
    logMain('record: run stopped itself', { reason })
    forceKillAll(reason)
  }

  // Dolphin's dumps and every intermediate go here, never into the output
  // folder; removed when the run ends, however it ends.
  const scratchDir = scratchDirFor(config)

  const promise = (async () => {
    try {
      try {
        await fsPromises.access(config.ssbmIsoPath).catch((err) => {
          if (err.code === 'ENOENT')
            throw new Error(
              `Could not read SSBM iso from path ${config.ssbmIsoPath}.`,
            )
          throw err
        })
        await fsPromises.access(config.dolphinPath).catch((err) => {
          if (err.code === 'ENOENT')
            throw new Error(
              `Could not open Dolphin from path ${config.dolphinPath}.`,
            )
          throw err
        })
        const iso = await checkIso(config.ssbmIsoPath)
        if (iso.fatal) throw new RecordingStoppedError(iso.fatal)
        isoHint = iso.hint
        // Recording renders in isolated per-worker profiles (built in
        // processReplays), so nothing here touches the real Slippi profile.
        // We proactively turn the dump flags OFF in the REAL profile to HEAL
        // installs poisoned by older app versions that recorded in-place —
        // after this, opening Dolphin to watch a replay never inherits a
        // recording rig. No-op on a clean profile. Best-effort: a profile it
        // can't write (EPERM under Program Files) or that doesn't exist yet
        // must not stop a recording, which never reads it for dumping.
        // Only when a dump flag really is on: the runner's heal rewrites the file
        // whenever its text differs, and on a Windows Dolphin.ini (CRLF) it always
        // does, touching the user's real settings under a Dolphin that may be
        // open (launch review WIN-12).
        const realProfile = realProfileOf(config)
        if (await dumpFlagsAreOn(realProfile))
          await healRealProfile(config.dolphinPath, realProfile).catch(
            (err: unknown) =>
              logMain('record: healRealProfile failed (continuing)', {
                err: String(err),
              }),
          )

        // Windows' path limit: Dolphin and ffmpeg aren't long-path aware, and
        // the longest scratch file is <scratch>/c<n>/clip-unmerged.avi.
        const longestScratchFile = path.join(
          scratchDir,
          'c999999',
          'clip-unmerged.avi',
        )
        if (
          process.platform === 'win32' &&
          longestScratchFile.length > WINDOWS_PATH_LIMIT
        ) {
          throw new RecordingStoppedError(
            `The scratch folder's path is too long for Windows ` +
              `(${scratchDir}). Choose a shorter scratch folder in Settings.`,
          )
        }

        // Will it fit? Falls back to Fast draft, then fewer workers, or
        // refuses with what's needed where (diskSpace.ts).
        eventEmitter('Checking disk space...')
        const disk = await preflightRecordingDisk(replays, config, {
          scratch: scratchDir,
          output: config.outputPath,
        })
        logMain('record: disk preflight', disk)
        if (!disk.ok)
          throw new RecordingStoppedError(
            disk.message || 'Not enough disk space for this recording.',
          )
        const jobConfig = { ...config, ...(disk.fallback || {}) }
        if (disk.fallback && disk.message) eventEmitter(disk.message)

        if (!halted(signal))
          await processReplays(
            replays,
            jobConfig,
            eventEmitter,
            signal,
            workerStatuses,
            scratchDir,
            abortJob,
            onClipEncoded,
            onClipFailed,
            onNotice,
          )
      } catch (err) {
        logMain('slpToVideo: error', err)
        // A run that stopped itself says why in plain words; the caller shows
        // the rejection (VideoManager: "Error: <message>"), so no log pointer.
        if (!(err instanceof RecordingStoppedError))
          eventEmitter(`${shownError(err)} — Check ${getLogPath()}/main.log`)
        throw err instanceof Error ? err : new Error(String(err))
      } finally {
        // processReplays removes it too; this covers a throw before it ran.
        await removeTree(scratchDir)
      }

      if (signal.stopped) {
        eventEmitter('Stopped.')
        setTimeout(() => eventEmitter(''), 2000)
      } else if (signal.cancelled) {
        eventEmitter('Cancelled.')
        setTimeout(() => eventEmitter(''), 2000)
      }
    } finally {
      if (stopBackstop) clearTimeout(stopBackstop)
    }
  })()

  return {
    stop: () => {
      signal.stopped = true
      // Arm the backstop once. Workers will normally drain well before this
      // fires (short clips + the per-Dolphin stale watchdog); it only matters if
      // something is truly stuck.
      if (!stopBackstop) {
        stopBackstop = setTimeout(
          () => forceKillAll('Stop grace period elapsed'),
          STOP_GRACE_MS,
        )
      }
    },
    cancel: () => {
      signal.cancelled = true
      forceKillAll('Cancel')
    },
    promise,
    getWorkerStatus: () => workerStatuses,
  }
}

export default slpToVideo
