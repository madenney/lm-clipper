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

import { pad } from '../lib'
import { getFFMPEGPath } from './util'
import { logMain, getLogPath } from './logger'
import { ConfigInterface, ReplayInterface } from '../constants/types'

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

const exit = (process: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    process.on('exit', (code) => resolve(code))
  })

const killDolphinOnEndFrame = (proc: ChildProcessWithoutNullStreams) => {
  let endFrame = Infinity
  const rl = readline.createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    if (line.includes('[PLAYBACK_END_FRAME]')) {
      const match = /\[PLAYBACK_END_FRAME\] ([0-9]+)/.exec(line)
      if (match?.[1]) endFrame = Math.min(endFrame, parseInt(match[1], 10))
    } else if (line.includes('[GAME_END_FRAME]')) {
      const match = /\[GAME_END_FRAME\] ([0-9]+)/.exec(line)
      if (match?.[1]) endFrame = Math.min(endFrame, parseInt(match[1], 10))
    } else if (
      endFrame !== Infinity &&
      line.includes(`[CURRENT_FRAME] ${endFrame}`)
    ) {
      proc.kill()
    }
  })
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
): string => {
  const m = replay.meta || {}
  const unsafeChars = /[<>:"/\\|?*\x00-\x1f]/g // eslint-disable-line no-control-regex
  const sanitize = (s: string) => s.replace(unsafeChars, '_').trim()

  const vars: Record<string, string> = {
    character1: sanitize(m.character1 || 'Unknown'),
    character2: sanitize(m.character2 || 'Unknown'),
    player1: sanitize(m.player1 || 'P1'),
    player2: sanitize(m.player2 || 'P2'),
    stage: sanitize(m.stage || 'Unknown'),
    date: m.date || 'unknown-date',
    time: m.time || '0000',
    index: pad(replay.index, 4),
    kills: m.didKill ? 'kill' : 'nokill',
    damage: m.damage !== undefined ? String(m.damage) : '0',
    moves: m.moves !== undefined ? String(m.moves) : '0',
  }

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
  const resolvedName = resolveFilenamePattern(outputPattern, replay)
  // resolvedName may contain path separators for folder structure
  const outputDir = path.resolve(config.outputPath, path.dirname(resolvedName))
  const fileBasename = path.basename(resolvedName)

  // Ensure output subdirectories exist
  await fsPromises.mkdir(outputDir, { recursive: true })

  const basePath = (suffix: string) =>
    path.resolve(outputDir, `${fileBasename}${suffix}`)

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
    startFrame: replay.startFrame - 60 < -123 ? -123 : replay.startFrame - 60,
    endFrame,
    isRealTimeMode: false,
    commandId: `${crypto.randomBytes(12).toString('hex')}`,
  }
  await fsPromises.writeFile(basePath('.json'), JSON.stringify(dolphinConfig))

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
  killDolphinOnEndFrame(dolphinProcess)
  const dolphinExitCode = await dolphinExit
  signal.activeProcesses.delete(dolphinProcess)

  logMain('record: Dolphin exited', {
    code: dolphinExitCode,
    stderr: dolphinStderr.slice(-2000),
    replay: replay.path,
  })

  if (signal.stopped || signal.cancelled) return false

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
  const mergeCode = await exit(mergeProcess)
  signal.activeProcesses.delete(mergeProcess)
  if (mergeCode !== 0) {
    logMain(`record: ffmpeg merge failed (code ${mergeCode})`, {
      stderr: mergeStderr.slice(-2000),
    })
  }

  if (signal.stopped || signal.cancelled) return false

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
  const trimCode = await exit(trimProcess)
  signal.activeProcesses.delete(trimProcess)
  if (trimCode !== 0) {
    logMain(`record: ffmpeg trim failed (code ${trimCode})`, {
      stderr: trimStderr.slice(-2000),
    })
  }

  if (signal.stopped || signal.cancelled) return false

  // 5. Convert to MP4 (optional)
  if (config.convertToMp4) {
    const mp4Args = [
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
    const mp4Code = await exit(mp4Process)
    signal.activeProcesses.delete(mp4Process)
    if (mp4Code !== 0) {
      logMain(`record: ffmpeg mp4 convert failed (code ${mp4Code})`, {
        stderr: mp4Stderr.slice(-2000),
      })
    }

    // Delete the .avi now that we have the .mp4
    await fsPromises.unlink(basePath('.avi')).catch(() => {})
  }

  // 6. Delete intermediates
  await Promise.all([
    fsPromises.unlink(basePath('.json')).catch(() => {}),
    fsPromises.unlink(basePath('-unmerged.avi')).catch(() => {}),
    fsPromises.unlink(basePath('-unmerged.wav')).catch(() => {}),
    fsPromises.unlink(basePath('-merged.avi')).catch(() => {}),
  ])

  return true
}

const processReplays = async (
  replays: ReplayInterface[],
  config: ConfigInterface & { numProcesses: number; gameMusicOn: boolean },
  eventEmitter: (_msg: string) => void,
  signal: VideoSignal,
  workerStatuses: VideoWorkerStatus[],
) => {
  const queue = [...replays]
  const total = replays.length
  const progress = { recorded: 0, encoded: 0 }

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
  const worker = async (workerIndex: number) => {
    let replay = queue.shift()
    while (replay !== undefined) {
      if (signal.stopped || signal.cancelled) break
      workerStatuses[workerIndex] = {
        replayPath: replay.path,
        phase: 'recording',
        replayIndex: replay.index,
      }
      const ok = await processOneReplay(
        replay,
        config,
        signal,
        () => {
          workerStatuses[workerIndex].phase = 'encoding'
          onRecorded()
        },
        eventEmitter,
      )
      if (!ok && (signal.stopped || signal.cancelled)) break
      if (ok) {
        progress.encoded += 1
        emitStatus()
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

  // Concatenate all output clips into a single video
  if (config.concatenate && !signal.stopped && !signal.cancelled) {
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

  eventEmitter('Done :)')
  setTimeout(() => {
    eventEmitter('')
  }, 2000)
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
  let gameSettingsPath = null
  let graphicsSettingsPath = null
  let dolphinSettingsPath = null

  // Linux
  if (os.type() === 'Linux') {
    const dolphinDirname = path.resolve(getAppDataPath(), 'SlippiPlayback')
    gameSettingsPath = path.join(dolphinDirname, 'GameSettings', 'GALE01.ini')
    graphicsSettingsPath = path.join(dolphinDirname, 'Config', 'GFX.ini')
    dolphinSettingsPath = path.join(dolphinDirname, 'Config', 'Dolphin.ini')

    // Windows
  } else {
    const dolphinDirname = path.dirname(config.dolphinPath)
    gameSettingsPath = path.join(
      dolphinDirname,
      'User',
      'GameSettings',
      'GALE01.ini',
    )
    graphicsSettingsPath = path.join(
      dolphinDirname,
      'User',
      'Config',
      'GFX.ini',
    )
    dolphinSettingsPath = path.join(
      dolphinDirname,
      'User',
      'Config',
      'Dolphin.ini',
    )

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

  // Game settings
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

  let newSettings: string[] = ['[Gecko]']

  // Inline definitions for codes not in the playback GALE01r2.ini
  if (config.freezeFD) {
    newSettings.push('$Freeze FD Background')
    newSettings.push('0421AAE0 48000008')
  }
  if (config.centerHud) {
    newSettings.push('$Center Align 2P HUD')
    newSettings.push('C216E9AC 00000009')
    newSettings.push('887F0061 2C030003')
    newSettings.push('41820030 887F0085')
    newSettings.push('2C030003 41820024')
    newSettings.push('887F00A9 2C030003')
    newSettings.push('40820018 887F00CD')
    newSettings.push('2C030003 4082000C')
    newSettings.push('38600002 4800000C')
    newSettings.push('887F0000 5463F77E')
    newSettings.push('60000000 00000000')
  }
  if (config.flashRedLCancel) {
    newSettings.push('$Flash Red Failed L-Cancel A')
    newSettings.push('C20C0148 0000000C')
    newSettings.push('387F0488 899E0564')
    newSettings.push('2C0C00D4 41820008')
    newSettings.push('4800004C 39800091')
    newSettings.push('999E0564 3D80437F')
    newSettings.push('919E0518 3D80C200')
    newSettings.push('919E0524 3D800000')
    newSettings.push('919E051C 919E0520')
    newSettings.push('919E0528 919E052C')
    newSettings.push('919E0530 3D80C280')
    newSettings.push('919E0534 3D80800C')
    newSettings.push('618C0150 7D8903A6')
    newSettings.push('4E800420 00000000')
    newSettings.push('$Flash Red Failed L-Cancel B')
    newSettings.push('C208D690 00000009')
    newSettings.push('3D808048 818C9D30')
    newSettings.push('558C443E 2C0C0208')
    newSettings.push('40820020 818DB61C')
    newSettings.push('898C0000 8965000C')
    newSettings.push('7C0C5800 4182000C')
    newSettings.push('88A5067F 48000018')
    newSettings.push('88A5067F 2C050007')
    newSettings.push('4180000C 398000D4')
    newSettings.push('99830564 00000000')
  }

  // Write custom code definitions
  newSettings.push(...geckoDefinitions)

  newSettings.push('[Gecko_Enabled]')
  if (!config.gameMusicOn) newSettings.push('$Optional: Game Music OFF')
  if (config.hideHud) newSettings.push('$Optional: Hide HUD')
  if (config.hideTags) newSettings.push('$Optional: Hide Tags')
  if (config.fixedCamera) newSettings.push('$Optional: Fixed Camera Always')
  if (config.widescreen !== false)
    newSettings.push('$Optional: Widescreen 16:9')
  if (config.disableScreenShake)
    newSettings.push('$Optional: Disable Screen Shake')
  if (config.noElectricSFX) newSettings.push('$Optional: No Electric SFX')
  if (config.noCrowdNoise) newSettings.push('$Optional: Prevent Crowd Noises')
  if (!config.enableChants)
    newSettings.push('$Optional: Prevent Character Crowd Chants')
  if (config.disableMagnifyingGlass)
    newSettings.push('$Optional: Disable Magnifying-glass HUD')
  if (config.freezeFD) newSettings.push('$Freeze FD Background')
  if (config.centerHud) newSettings.push('$Center Align 2P HUD')
  if (config.developMode) newSettings.push('$Optional: Enable Develop Mode')
  if (config.flashRedLCancel) {
    newSettings.push('$Flash Red Failed L-Cancel A')
    newSettings.push('$Flash Red Failed L-Cancel B')
  }
  // Enable custom gecko codes
  for (const gc of customGeckoCodes) {
    if (gc.name && gc.code && gc.enabled) {
      newSettings.push(`$${gc.name}`)
    }
  }

  newSettings.push('[Gecko_Disabled]')
  if (config.hideNames) newSettings.push('$Optional: Show Player Names')
  // Disabled custom gecko codes
  for (const gc of customGeckoCodes) {
    if (gc.name && gc.code && !gc.enabled) {
      newSettings.push(`$${gc.name}`)
    }
  }

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

  const promise = (async () => {
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
        processReplays(replays, config, eventEmitter, signal, workerStatuses),
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
  })()

  return {
    stop: () => {
      signal.stopped = true
    },
    cancel: () => {
      signal.cancelled = true
      signal.activeProcesses.forEach((p) => {
        try {
          p.kill()
        } catch (_) {
          /* already dead */
        }
      })
      signal.activeProcesses.clear()
    },
    promise,
    getWorkerStatus: () => workerStatuses,
  }
}

export default slpToVideo
