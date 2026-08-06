/* eslint-disable no-await-in-loop */
/*

Where the magic happens.

If you're here to see how to convert slp to mp4, I recommend starting here:
https://github.com/kevinsung/slp-to-video

*/

import {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  spawn,
} from 'child_process'
import { app } from 'electron'
import crypto from 'crypto'
import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import readline from 'readline'
import { SlippiGame } from '@slippi/slippi-js'
import os from 'os'
import { GAME_START_FRAME } from '../constants/frames'

import { buildReplayVars, applyPattern } from '../lib/overlayTokens'
import { getFFMPEGPath } from './util'
import { renderOverlayPng } from './overlayRenderer'
import { logMain, getLogPath } from './logger'
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
  activeProcesses: Set<ChildProcess>
}

let ffmpegPath = getFFMPEGPath()
logMain('slpToVideo: resolved ffmpeg path', { ffmpegPath })

export function setFFMPEGPathOverride(overridePath: string) {
  if (overridePath && overridePath.trim()) {
    ffmpegPath = overridePath.trim()
    logMain('slpToVideo: ffmpeg path overridden', { ffmpegPath })
  } else {
    ffmpegPath = getFFMPEGPath()
    logMain('slpToVideo: ffmpeg path reset to default', { ffmpegPath })
  }
}

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

// --- Robustness knobs for the recording pipeline (watchdog + Stop below).
// Tuned to kill genuine hangs quickly without false-positiving healthy work.
//
// The two Dolphin timers are LENGTH-INDEPENDENT on purpose: the stale timer
// measures the gap BETWEEN frames, not total runtime, so a 3-minute game (which
// streams [CURRENT_FRAME] continuously) keeps resetting it and never trips —
// only genuine silence does. Boot grace is about ISO load, also length-agnostic.
const DOLPHIN_BOOT_STALE_MS = 90_000 // no first frame within 90s of spawn = hung boot
const DOLPHIN_FRAME_STALE_MS = 30_000 // frames stopped for 30s mid-record = frozen
const SIGKILL_ESCALATION_MS = 5_000 // POSIX: SIGTERM, then SIGKILL after 5s
const STOP_GRACE_MS = 45_000 // Stop: force-kill anything still alive after 45s

// The ffmpeg steps (merge + mp4 convert) RE-ENCODE, so their runtime scales with
// clip length — a fixed cap would false-kill a legit long game. Scale the timeout
// off the clip's footage seconds instead, with a generous ~10x-realtime headroom
// so even a slow machine never trips it; it's only a backstop against a truly
// wedged process, not a performance budget. e.g. 7s clip → ~3 min, 3-min game →
// ~32 min. Frames are 60fps.
const FFMPEG_TIMEOUT_BASE_MS = 120_000 // fixed startup/overhead allowance
const FFMPEG_TIMEOUT_PER_SEC_MS = 10_000 // + per second of footage (10x realtime)
const ffmpegTimeoutFor = (clipFrames: number) =>
  FFMPEG_TIMEOUT_BASE_MS +
  Math.max(0, clipFrames / 60) * FFMPEG_TIMEOUT_PER_SEC_MS

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

// Forcefully terminate a process AND its children, cross-platform. Windows has
// no real signals (kill() maps to TerminateProcess and won't reap children, and
// Dolphin can spawn helpers) so we use `taskkill /T /F` to take down the whole
// tree. On POSIX we SIGTERM, then escalate to SIGKILL if it's still alive. Used
// by the stale watchdog, Stop's backstop, and Cancel — the force paths. The
// normal per-clip end-frame stop still uses a plain proc.kill() (below).
const killTree = (proc: ChildProcess) => {
  if (isDead(proc)) return
  const { pid } = proc
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
    return
  }
  try {
    proc.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (!isDead(proc)) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }, SIGKILL_ESCALATION_MS)
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

// Watch a recording Dolphin: kill it when it reaches the target end frame (the
// normal per-clip stop), and — the missing safety net — kill it if it FREEZES.
// A Dolphin that hangs on load (never emits a frame) or stalls mid-record (frames
// stop arriving) would otherwise hold a worker slot forever, since it never
// reaches its end frame and never exits. Mirrors the playback path's stale timer,
// with a longer boot grace so a slow ISO load isn't mistaken for a hang. Returns
// a cleanup fn to clear the timer once the process has exited.
const monitorDolphinRecording = (
  proc: ChildProcessWithoutNullStreams,
  onStale: (_sawAnyFrame: boolean) => void,
) => {
  let endFrame = Infinity
  let sawAnyFrame = false
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  const clearStale = () => {
    if (staleTimer) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
  }
  const armStale = () => {
    clearStale()
    staleTimer = setTimeout(
      () => {
        onStale(sawAnyFrame)
        killTree(proc)
      },
      sawAnyFrame ? DOLPHIN_FRAME_STALE_MS : DOLPHIN_BOOT_STALE_MS,
    )
  }
  const rl = readline.createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    if (line.includes('[PLAYBACK_END_FRAME]')) {
      const match = /\[PLAYBACK_END_FRAME\] ([0-9]+)/.exec(line)
      if (match?.[1]) endFrame = Math.min(endFrame, parseInt(match[1], 10))
    } else if (line.includes('[GAME_END_FRAME]')) {
      const match = /\[GAME_END_FRAME\] ([0-9]+)/.exec(line)
      if (match?.[1]) endFrame = Math.min(endFrame, parseInt(match[1], 10))
    } else if (line.includes('[CURRENT_FRAME]')) {
      sawAnyFrame = true
      armStale()
      if (
        endFrame !== Infinity &&
        line.includes(`[CURRENT_FRAME] ${endFrame}`)
      ) {
        proc.kill() // reached the end normally — gentle stop is enough
      }
    }
  })
  armStale() // start the boot-grace clock immediately
  return () => {
    clearStale()
    rl.close()
  }
}

/**
 * Resolve a filename pattern using replay metadata.
 * Supports {character1}, {character2}, {player1}, {player2}, {stage},
 * {date}, {time}, {index}, {kills}, {damage}, {moves}.
 * Slashes in the pattern create subdirectories.
 */
const resolveFilenamePattern = (
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

  return pattern.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match)
}

const processOneReplay = async (
  replay: ReplayInterface,
  config: ConfigInterface & { numProcesses: number; gameMusicOn: boolean },
  signal: VideoSignal,
  onRecorded?: () => void,
  onError?: (_msg: string) => void,
): Promise<boolean> => {
  const outputPattern = config.outputFilenamePattern || '{index}'
  const resolvedName = resolveFilenamePattern(
    outputPattern,
    replay,
    config.overlaySourceRules,
  )
  // resolvedName may contain path separators for folder structure
  const outputDir = path.resolve(config.outputPath, path.dirname(resolvedName))
  const fileBasename = path.basename(resolvedName)

  // Ensure output subdirectories exist
  await fsPromises.mkdir(outputDir, { recursive: true })

  const basePath = (suffix: string) =>
    path.resolve(outputDir, `${fileBasename}${suffix}`)

  // Overlay PNG path, set later if an overlay is rendered. Declared here so the
  // cleanup helper can always reach it regardless of which path we exit through.
  let overlayPngPath: string | null = null

  // Remove every non-final scratch file for this clip. Never touches the final
  // `.mp4`/`.avi`. Called on success AND on every failure/stop exit so a long
  // run with retries doesn't slowly litter the output folder with -unmerged/
  // -merged debris.
  const cleanupIntermediates = () =>
    Promise.all([
      fsPromises.unlink(basePath('.json')).catch(() => {}),
      fsPromises.unlink(basePath('-unmerged.avi')).catch(() => {}),
      fsPromises.unlink(basePath('-unmerged.wav')).catch(() => {}),
      fsPromises.unlink(basePath('-merged.avi')).catch(() => {}),
      fsPromises.unlink(basePath('-overlaid.avi')).catch(() => {}),
      ...(overlayPngPath
        ? [fsPromises.unlink(overlayPngPath).catch(() => {})]
        : []),
    ])

  // 1. Write JSON config for this replay
  // Check file exists before trying to parse
  try {
    await fsPromises.access(replay.path)
  } catch {
    logMain('record: replay file not found', { path: replay.path })
    onError?.(`Error: Replay file not found: ${replay.path}`)
    return false
  }

  let game
  try {
    game = new SlippiGame(replay.path)
  } catch (e) {
    logMain('record: broken/unreadable replay file', { path: replay.path })
    onError?.(`Error: Could not read replay: ${replay.path}`)
    return false
  }

  const metadata = game.getMetadata()
  const gameLastFrame = metadata?.lastFrame ?? game.getLatestFrame()?.frame

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
    onError?.(`Error: Cannot determine game length: ${replay.path}`)
    return false
  }

  const dolphinConfig = {
    mode: 'normal',
    replay: replay.path,
    startFrame:
      replay.startFrame - 60 < GAME_START_FRAME
        ? GAME_START_FRAME
        : replay.startFrame - 60,
    endFrame,
    isRealTimeMode: false,
    commandId: `${crypto.randomBytes(12).toString('hex')}`,
  }
  await fsPromises.writeFile(basePath('.json'), JSON.stringify(dolphinConfig))

  // Footage length in frames (60fps) — drives the length-scaled ffmpeg timeouts
  // so a long game's re-encode isn't false-killed. Includes the 60-frame lead-in.
  const clipFrames = Math.max(1, endFrame - dolphinConfig.startFrame)
  const ffmpegTimeoutMs = ffmpegTimeoutFor(clipFrames)

  // 2. Record with Dolphin
  const dolphinArgs = [
    '-i',
    basePath('.json'),
    '-o',
    `${fileBasename}-unmerged`,
    `--output-directory=${outputDir}`,
    ...(config.fullscreen !== false ? ['-b'] : []),
    '-e',
    config.ssbmIsoPath,
    '--cout',
  ]

  // Clean up leftover audio dump files so Dolphin doesn't prompt the user
  const dolphinDirname = path.dirname(config.dolphinPath)
  const dumpAudioDirs = [
    // Windows: User/Dump/Audio relative to dolphin dir
    path.join(dolphinDirname, 'User', 'Dump', 'Audio'),
    // Linux: SlippiPlayback/Dump/Audio
    path.join(getAppDataPath(), 'SlippiPlayback', 'Dump', 'Audio'),
  ]
  for (const dumpDir of dumpAudioDirs) {
    for (const file of ['dtkdump.wav', 'dspdump.wav']) {
      await fsPromises.unlink(path.join(dumpDir, file)).catch(() => {})
    }
  }

  logMain('record: spawning Dolphin', {
    dolphinPath: config.dolphinPath,
    args: dolphinArgs,
    replay: replay.path,
    startFrame: dolphinConfig.startFrame,
    endFrame: dolphinConfig.endFrame,
  })

  const dolphinProcess = spawn(config.dolphinPath, dolphinArgs, {})
  signal.activeProcesses.add(dolphinProcess)

  let dolphinStderr = ''
  dolphinProcess.stderr.setEncoding('utf8')
  dolphinProcess.stderr.on('data', (chunk: string) => {
    dolphinStderr += chunk
  })
  dolphinProcess.on('error', (err) => {
    logMain('record: Dolphin spawn error', err)
  })

  const dolphinExit = exit(dolphinProcess)
  let staleKill = false
  const stopMonitor = monitorDolphinRecording(dolphinProcess, (sawAnyFrame) => {
    staleKill = true
    logMain('record: Dolphin watchdog killed a frozen recording', {
      replay: replay.path,
      reason: sawAnyFrame
        ? 'frames stopped mid-record'
        : 'no frames within boot grace',
    })
  })
  const dolphinExitCode = await dolphinExit
  stopMonitor()
  signal.activeProcesses.delete(dolphinProcess)

  logMain('record: Dolphin exited', {
    code: dolphinExitCode,
    staleKill,
    stderr: dolphinStderr.slice(-2000),
    replay: replay.path,
  })

  if (signal.stopped || signal.cancelled) {
    await cleanupIntermediates()
    return false
  }

  // Recording must have produced a non-empty video dump. If it didn't — a spawn
  // 'error', a crash, or a watchdog kill of a frozen Dolphin — treat the clip as
  // failed (retried/counted below) rather than feeding a missing/partial input
  // into ffmpeg and silently emitting nothing. This is also what keeps the usage
  // telemetry honest: only clips that actually recorded advance the counter.
  try {
    const dump = await fsPromises.stat(basePath('-unmerged.avi'))
    if (dump.size === 0) throw new Error('empty dump')
  } catch {
    logMain('record: no video dump produced', {
      code: dolphinExitCode,
      staleKill,
      replay: replay.path,
      stderr: dolphinStderr.slice(-500),
    })
    onError?.(
      `Error: recording produced no video: ${path.basename(replay.path)}`,
    )
    await cleanupIntermediates()
    return false
  }

  onRecorded?.()

  // 3. Merge video and audio with ffmpeg
  const ffmpegMergeArgs = [
    '-i',
    basePath('-unmerged.avi'),
    '-i',
    basePath('-unmerged.wav'),
    '-b:v',
    `${config.bitrateKbps}k`,
  ]
  if (config.resolution === 4 && config.widescreen !== false) {
    ffmpegMergeArgs.push('-vf', 'scale=1920:1080')
  }
  ffmpegMergeArgs.push(basePath('-merged.avi'))

  logMain('record: spawning ffmpeg merge', {
    ffmpegPath,
    args: ffmpegMergeArgs,
  })

  const mergeProcess = spawn(ffmpegPath, ffmpegMergeArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  signal.activeProcesses.add(mergeProcess)
  mergeProcess.on('error', (err) => {
    logMain('record: ffmpeg merge spawn error', err)
  })
  let mergeStderr = ''
  mergeProcess.stderr!.on('data', (chunk: Buffer) => {
    mergeStderr += chunk.toString()
  })
  const mergeCode = await awaitExitWithTimeout(
    mergeProcess,
    ffmpegTimeoutMs,
    'ffmpeg merge',
  )
  signal.activeProcesses.delete(mergeProcess)
  if (mergeCode !== 0) {
    logMain(`record: ffmpeg merge failed (code ${mergeCode})`, {
      stderr: mergeStderr.slice(-2000),
    })
  }

  if (signal.stopped || signal.cancelled) {
    await cleanupIntermediates()
    return false
  }

  // 4. Trim buffer frames
  const ffmpegTrimArgs = [
    '-ss',
    '1',
    '-i',
    basePath('-merged.avi'),
    '-c',
    'copy',
    basePath('.avi'),
  ]

  logMain('record: spawning ffmpeg trim', { args: ffmpegTrimArgs })

  const trimProcess = spawn(ffmpegPath, ffmpegTrimArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  signal.activeProcesses.add(trimProcess)
  trimProcess.on('error', (err) => {
    logMain('record: ffmpeg trim spawn error', err)
  })
  let trimStderr = ''
  trimProcess.stderr!.on('data', (chunk: Buffer) => {
    trimStderr += chunk.toString()
  })
  const trimCode = await awaitExitWithTimeout(
    trimProcess,
    ffmpegTimeoutMs,
    'ffmpeg trim',
  )
  signal.activeProcesses.delete(trimProcess)
  if (trimCode !== 0) {
    logMain(`record: ffmpeg trim failed (code ${trimCode})`, {
      stderr: trimStderr.slice(-2000),
    })
  }

  if (signal.stopped || signal.cancelled) {
    await cleanupIntermediates()
    return false
  }

  // 4b. Build the overlay PNG (optional). Rendered at the clip's true
  // resolution (parsed from ffmpeg's stderr) and composited during the final
  // encode below via ffmpeg's overlay filter.
  if (config.overlayEnabled) {
    const vars = buildReplayVars(replay, config.overlaySourceRules)
    const overlayText = applyPattern(config.overlayPattern || '', vars).trim()
    const dims = parseVideoDimensions(trimStderr)
    if (overlayText && dims) {
      const pngPath = basePath('-overlay.png')
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

  const overlayFilter =
    '[0:v][1:v]scale2ref[base][ovr];' +
    '[base][ovr]overlay=0:0,pad=ceil(iw/2)*2:ceil(ih/2)*2[outv]'

  if (signal.stopped || signal.cancelled) {
    await cleanupIntermediates()
    return false
  }

  // 5. Convert to MP4 (optional)
  if (config.convertToMp4) {
    const mp4Args = overlayPngPath
      ? [
          '-i',
          basePath('.avi'),
          '-i',
          overlayPngPath,
          '-filter_complex',
          overlayFilter,
          '-map',
          '[outv]',
          '-map',
          '0:a?',
          '-c:v',
          'libx264',
          '-b:v',
          `${config.bitrateKbps}k`,
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          basePath('.mp4'),
        ]
      : [
          '-i',
          basePath('.avi'),
          '-vf',
          'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v',
          'libx264',
          '-b:v',
          `${config.bitrateKbps}k`,
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          basePath('.mp4'),
        ]
    logMain('record: spawning ffmpeg mp4 convert', { args: mp4Args })

    const mp4Process = spawn(ffmpegPath, mp4Args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    signal.activeProcesses.add(mp4Process)
    mp4Process.on('error', (err) => {
      logMain('record: ffmpeg mp4 convert spawn error', err)
    })
    let mp4Stderr = ''
    mp4Process.stderr!.on('data', (chunk: Buffer) => {
      mp4Stderr += chunk.toString()
    })
    const mp4Code = await awaitExitWithTimeout(
      mp4Process,
      ffmpegTimeoutMs,
      'ffmpeg mp4 convert',
    )
    signal.activeProcesses.delete(mp4Process)
    if (mp4Code !== 0) {
      logMain(`record: ffmpeg mp4 convert failed (code ${mp4Code})`, {
        stderr: mp4Stderr.slice(-2000),
      })
    }

    // Delete the .avi now that we have the .mp4
    await fsPromises.unlink(basePath('.avi')).catch(() => {})
  } else if (overlayPngPath) {
    // No MP4 conversion: burn the overlay into the .avi itself.
    const overlaidPath = basePath('-overlaid.avi')
    const aviOverlayArgs = [
      '-i',
      basePath('.avi'),
      '-i',
      overlayPngPath,
      '-filter_complex',
      overlayFilter,
      '-map',
      '[outv]',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-b:v',
      `${config.bitrateKbps}k`,
      '-c:a',
      'copy',
      overlaidPath,
    ]
    const aviProcess = spawn(ffmpegPath, aviOverlayArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    signal.activeProcesses.add(aviProcess)
    aviProcess.on('error', (err) => {
      logMain('record: ffmpeg avi overlay spawn error', err)
    })
    let aviStderr = ''
    aviProcess.stderr!.on('data', (chunk: Buffer) => {
      aviStderr += chunk.toString()
    })
    const aviCode = await awaitExitWithTimeout(
      aviProcess,
      ffmpegTimeoutMs,
      'ffmpeg avi overlay',
    )
    signal.activeProcesses.delete(aviProcess)
    if (aviCode === 0) {
      await fsPromises.rename(overlaidPath, basePath('.avi')).catch((err) => {
        logMain('record: avi overlay rename failed', err)
      })
    } else {
      logMain(`record: ffmpeg avi overlay failed (code ${aviCode})`, {
        stderr: aviStderr.slice(-2000),
      })
      await fsPromises.unlink(overlaidPath).catch(() => {})
    }
  }

  // 6. Delete intermediates
  await cleanupIntermediates()

  // 7. Validate the final output actually exists and is non-empty. An ffmpeg
  // step can fail (or time out) yet leave a 0-byte or missing final file; without
  // this check that clip was counted as a success, inflating the usage stats and
  // producing the "holes" seen when forensically recounting a run. A real output
  // is the only thing that returns true.
  const finalOutput = config.convertToMp4 ? basePath('.mp4') : basePath('.avi')
  try {
    const st = await fsPromises.stat(finalOutput)
    if (st.size === 0) throw new Error('empty output')
  } catch {
    logMain('record: final output missing or empty', {
      finalOutput,
      replay: replay.path,
    })
    onError?.(
      `Error: clip produced no output file: ${path.basename(replay.path)}`,
    )
    await fsPromises.unlink(finalOutput).catch(() => {})
    return false
  }

  return true
}

const processReplays = async (
  replays: ReplayInterface[],
  config: ConfigInterface & { numProcesses: number; gameMusicOn: boolean },
  eventEmitter: (_msg: string) => void,
  signal: VideoSignal,
  workerStatuses: VideoWorkerStatus[],
  onClipEncoded?: (_replay: ReplayInterface) => void,
  onClipFailed?: (_replay: ReplayInterface) => void,
) => {
  const queue = [...replays]
  const total = replays.length
  const progress = { recorded: 0, encoded: 0 }
  // Clips that failed every attempt (not stop/cancel) — surfaced to the user and
  // written to failures.json so a run that silently drops clips is visible.
  const failures: ReplayInterface[] = []

  const emitStatus = () => {
    if (progress.recorded < total) {
      eventEmitter(`recording ${progress.recorded}/${total}`)
    } else {
      eventEmitter(`encoding ${progress.encoded}/${total}`)
    }
  }
  emitStatus()

  const onRecorded = () => {
    progress.recorded += 1
    emitStatus()
  }
  const MAX_ATTEMPTS = 2 // one retry on a genuine failure
  const worker = async (workerIndex: number) => {
    let replay = queue.shift()
    while (replay !== undefined) {
      if (signal.stopped || signal.cancelled) break

      // A failed clip after recording (e.g. merge error) already bumped the
      // recorded counter; guard so a retry that re-records doesn't count twice.
      let recordedCounted = false
      const onRecordedOnce = () => {
        workerStatuses[workerIndex].phase = 'encoding'
        if (!recordedCounted) {
          recordedCounted = true
          onRecorded()
        }
      }

      let ok = false
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal.stopped || signal.cancelled) break
        workerStatuses[workerIndex] = {
          replayPath: replay.path,
          phase: 'recording',
          replayIndex: replay.index,
        }
        // eslint-disable-next-line no-await-in-loop
        ok = await processOneReplay(
          replay,
          config,
          signal,
          onRecordedOnce,
          eventEmitter,
        )
        if (ok || signal.stopped || signal.cancelled) break
        logMain('record: clip failed, retrying', {
          replay: replay.path,
          attempt,
        })
      }

      if (!ok && (signal.stopped || signal.cancelled)) break
      if (ok) {
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

  const workers = []
  for (let i = 0; i < config.numProcesses; i++) workers.push(worker(i))
  await Promise.all(workers)

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
      .catch(() => {})
  }

  // Concatenate the finished clips into a single video. Runs on a normal finish
  // AND on Stop — Stop means "keep completed clips": it lets the in-flight clip
  // finish and kills nothing, so every per-clip final on disk is complete and
  // safe to concat (partial `-unmerged`/`-merged` intermediates are filtered out
  // below regardless). Only Cancel — which kills active processes and can leave a
  // half-written clip — skips concatenation.
  if (config.concatenate && !signal.cancelled) {
    console.log('Concatenating clips...')
    eventEmitter('Concatenating clips...')

    const ext = config.convertToMp4 ? '.mp4' : '.avi'
    const outputFiles = (await fsPromises.readdir(config.outputPath))
      .filter(
        (f) =>
          f.endsWith(ext) && !f.includes('-unmerged') && !f.includes('-merged'),
      )
      .sort()

    if (outputFiles.length > 1) {
      const concatListPath = path.resolve(config.outputPath, 'concat_list.txt')
      const concatLines = outputFiles.map(
        (f) => `file '${path.resolve(config.outputPath, f)}'`,
      )
      await fsPromises.writeFile(concatListPath, concatLines.join('\n'))

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

      const concatProcess = spawn(ffmpegPath, concatArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      signal.activeProcesses.add(concatProcess)
      concatProcess.on('error', (err) => {
        logMain('record: ffmpeg concat spawn error', err)
      })
      let concatStderr = ''
      concatProcess.stderr!.on('data', (chunk: Buffer) => {
        concatStderr += chunk.toString()
      })
      const concatCode = await exit(concatProcess)
      signal.activeProcesses.delete(concatProcess)
      if (concatCode !== 0) {
        logMain(`record: ffmpeg concat failed (code ${concatCode})`, {
          stderr: concatStderr.slice(-2000),
        })
      }

      // Clean up concat list
      await fsPromises.unlink(concatListPath).catch(() => {})
    }
  }

  eventEmitter(
    failures.length > 0
      ? `Done — ${failures.length} clip(s) failed (see failures.json) :)`
      : 'Done :)',
  )
  setTimeout(
    () => {
      eventEmitter('')
    },
    failures.length > 0 ? 6000 : 2000,
  )
}

// Resolves the three Dolphin ini paths (game settings, graphics, dolphin)
// for the active platform.
const resolveDolphinIniPaths = (config: ConfigInterface) => {
  // Linux
  if (os.type() === 'Linux') {
    const dolphinDirname = path.resolve(getAppDataPath(), 'SlippiPlayback')
    return {
      gameSettingsPath: path.join(dolphinDirname, 'GameSettings', 'GALE01.ini'),
      graphicsSettingsPath: path.join(dolphinDirname, 'Config', 'GFX.ini'),
      dolphinSettingsPath: path.join(dolphinDirname, 'Config', 'Dolphin.ini'),
    }
  }
  // Windows
  const dolphinDirname = path.dirname(config.dolphinPath)
  return {
    gameSettingsPath: path.join(
      dolphinDirname,
      'User',
      'GameSettings',
      'GALE01.ini',
    ),
    graphicsSettingsPath: path.join(
      dolphinDirname,
      'User',
      'Config',
      'GFX.ini',
    ),
    dolphinSettingsPath: path.join(
      dolphinDirname,
      'User',
      'Config',
      'Dolphin.ini',
    ),
  }
}

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
  const lines = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
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
  const lines = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
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

// Writes only the GALE01.ini gecko codes from the current config. Used by the
// play window so toggling rendering options (Hide HUD, etc.) takes effect on
// playback without needing to run a recording first.
export const writeGeckoCodes = async (config: ConfigInterface) => {
  const { gameSettingsPath } = resolveDolphinIniPaths(config)
  try {
    await fsPromises.mkdir(path.dirname(gameSettingsPath), { recursive: true })
  } catch {
    // directory likely already exists
  }
  await fsPromises.writeFile(
    gameSettingsPath,
    buildGeckoSettings(config).join('\n'),
  )
}

const configureDolphin = async (
  config: ConfigInterface,
  eventEmitter: (_msg: string) => void,
) => {
  logMain('configureDolphin: starting', {
    dolphinPath: config.dolphinPath,
    ssbmIsoPath: config.ssbmIsoPath,
    platform: os.type(),
  })
  eventEmitter('Configuring Dolphin...')
  const { gameSettingsPath, graphicsSettingsPath, dolphinSettingsPath } =
    resolveDolphinIniPaths(config)

  // Windows: ensure the game settings file exists before reading it
  if (os.type() !== 'Linux') {
    try {
      await fsPromises.access(gameSettingsPath)
    } catch {
      eventEmitter('Creating game settings file')
      await fsPromises.writeFile(gameSettingsPath, '')
    }
  }

  try {
    await fsPromises.access(gameSettingsPath)
  } catch {
    eventEmitter('Error: could not find game settings file')
    throw new Error('Error: could not find game settings file')
  }

  // Game settings (gecko codes)
  let newSettings: string[] = buildGeckoSettings(config)
  await fsPromises.writeFile(gameSettingsPath, newSettings.join('\n'))

  // Graphics settings
  let rl = readline.createInterface({
    input: fs.createReadStream(graphicsSettingsPath),
    crlfDelay: Infinity,
  })
  newSettings = []
  const aspectRatioSetting = config.widescreen !== false ? 6 : 5
  // eslint-disable-next-line no-restricted-syntax
  for await (const line of rl) {
    if (line.startsWith('AspectRatio')) {
      newSettings.push(`AspectRatio = ${aspectRatioSetting}`)
    } else if (line.startsWith('InternalResolutionFrameDumps')) {
      newSettings.push(`InternalResolutionFrameDumps = True`)
    } else if (line.startsWith('BitrateKbps')) {
      newSettings.push(`BitrateKbps = ${config.bitrateKbps}`)
    } else if (line.startsWith('EFBScale')) {
      newSettings.push(`EFBScale = ${config.resolution}`)
    } else {
      newSettings.push(line)
    }
  }
  await fsPromises.writeFile(graphicsSettingsPath, newSettings.join('\n'))

  // Dolphin settings
  rl = readline.createInterface({
    input: fs.createReadStream(dolphinSettingsPath),
    crlfDelay: Infinity,
  })
  newSettings = []
  // eslint-disable-next-line no-restricted-syntax
  for await (const line of rl) {
    if (line.startsWith('DumpFrames ')) {
      newSettings.push(`DumpFrames = True`)
    } else if (line.startsWith('DumpFramesSilent ')) {
      newSettings.push(`DumpFramesSilent = True`)
    } else if (line.startsWith('DumpAudio ')) {
      newSettings.push(`DumpAudio = True`)
    } else if (line.startsWith('DumpAudioSilent ')) {
      newSettings.push(`DumpAudioSilent = True`)
    } else {
      newSettings.push(line)
    }
  }
  await fsPromises.writeFile(dolphinSettingsPath, newSettings.join('\n'))
}

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
): VideoJobController => {
  const signal: VideoSignal = {
    stopped: false,
    cancelled: false,
    activeProcesses: new Set(),
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
    if (signal.activeProcesses.size > 0) {
      logMain(`record: force-killing ${signal.activeProcesses.size} process(es)`, { reason }) // prettier-ignore
    }
    signal.activeProcesses.forEach((p) => killTree(p))
    signal.activeProcesses.clear()
  }

  const promise = (async () => {
    try {
      await fsPromises
        .access(config.ssbmIsoPath)
        .catch((err) => {
          if (err.code === 'ENOENT') {
            throw new Error(
              `Error: Could not read SSBM iso from path ${config.ssbmIsoPath}. `,
            )
          } else {
            throw err
          }
        })
        .then(() => fsPromises.access(config.dolphinPath))
        .catch((err) => {
          if (err.code === 'ENOENT') {
            throw new Error(
              `Error: Could not open Dolphin from path ${config.dolphinPath}. `,
            )
          } else {
            throw err
          }
        })
        .then(() => configureDolphin(config, eventEmitter))
        .then(() =>
          processReplays(
            replays,
            config,
            eventEmitter,
            signal,
            workerStatuses,
            onClipEncoded,
            onClipFailed,
          ),
        )
        .catch((err) => {
          logMain('slpToVideo: error', err)
          eventEmitter(`${err} — Check ${getLogPath()}/main.log`)
          throw new Error(err)
        })

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
