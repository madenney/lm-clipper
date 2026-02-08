/* eslint-disable no-await-in-loop */
/*

Where the magic happens.

If you're here to see how to convert slp to mp4, I recommend starting here:
https://github.com/kevinsung/slp-to-video

*/

import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { app } from 'electron'
import crypto from 'crypto'
import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import readline from 'readline'
import { SlippiGame } from '@slippi/slippi-js'
import os from 'os'

import { pad } from '../lib'
import { getFFMPEGPath } from './util'
import { ConfigInterface, ReplayInterface } from '../constants/types'

export type VideoJobController = {
  stop: () => void
  cancel: () => void
  promise: Promise<void>
}

type VideoSignal = {
  stopped: boolean
  cancelled: boolean
  activeProcesses: Set<ChildProcess>
}

const ffmpegPath = getFFMPEGPath()

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
    } else if (endFrame !== Infinity && line.includes(`[CURRENT_FRAME] ${endFrame}`)) {
      proc.kill()
    }
  })
}

const processOneReplay = async (
  replay: ReplayInterface,
  config: ConfigInterface & { numProcesses: number; gameMusicOn: boolean },
  signal: VideoSignal
): Promise<boolean> => {
  const fileBasename = pad(replay.index, 4)
  const basePath = (suffix: string) =>
    path.resolve(config.outputPath, `${fileBasename}${suffix}`)

  // 1. Write JSON config for this replay
  let game
  try {
    game = new SlippiGame(replay.path)
  } catch (e) {
    console.log('Broken file: ', replay.path)
    return false
  }

  const metadata = game.getMetadata()
  const gameLastFrame =
    metadata?.lastFrame ?? game.getLatestFrame()?.frame

  let endFrame: number
  if (gameLastFrame) {
    endFrame =
      replay.endFrame > 0
        ? Math.min(replay.endFrame, gameLastFrame - 1)
        : gameLastFrame - 1
  } else if (replay.endFrame > 0) {
    endFrame = replay.endFrame
  } else {
    console.log('Cannot determine game length:', replay.path)
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
    `--output-directory=${config.outputPath}`,
    '-b',
    '-e',
    config.ssbmIsoPath,
    '--cout',
  ]
  const dolphinProcess = spawn(config.dolphinPath, dolphinArgs, {})
  signal.activeProcesses.add(dolphinProcess)
  const dolphinExit = exit(dolphinProcess)
  killDolphinOnEndFrame(dolphinProcess)
  await dolphinExit
  signal.activeProcesses.delete(dolphinProcess)

  if (signal.stopped || signal.cancelled) return false

  // 3. Merge video and audio with ffmpeg
  const ffmpegMergeArgs = [
    '-i',
    basePath('-unmerged.avi'),
    '-i',
    basePath('-unmerged.wav'),
    '-b:v',
    `${config.bitrateKbps}k`,
  ]
  if (config.resolution === 4 && !config.widescreenOff) {
    ffmpegMergeArgs.push('-vf', 'scale=1920:1080')
  }
  ffmpegMergeArgs.push(basePath('-merged.avi'))

  const mergeProcess = spawn(ffmpegPath, ffmpegMergeArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  signal.activeProcesses.add(mergeProcess)
  let mergeStderr = ''
  mergeProcess.stderr!.on('data', (chunk: Buffer) => {
    mergeStderr += chunk.toString()
  })
  const mergeCode = await exit(mergeProcess)
  signal.activeProcesses.delete(mergeProcess)
  if (mergeCode !== 0) {
    console.log(`ffmpeg merge failed (code ${mergeCode}):`, mergeStderr.slice(-500))
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

  const trimProcess = spawn(ffmpegPath, ffmpegTrimArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  signal.activeProcesses.add(trimProcess)
  let trimStderr = ''
  trimProcess.stderr!.on('data', (chunk: Buffer) => {
    trimStderr += chunk.toString()
  })
  const trimCode = await exit(trimProcess)
  signal.activeProcesses.delete(trimProcess)
  if (trimCode !== 0) {
    console.log(`ffmpeg trim failed (code ${trimCode}):`, trimStderr.slice(-500))
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
    const mp4Process = spawn(ffmpegPath, mp4Args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    signal.activeProcesses.add(mp4Process)
    let mp4Stderr = ''
    mp4Process.stderr!.on('data', (chunk: Buffer) => {
      mp4Stderr += chunk.toString()
    })
    const mp4Code = await exit(mp4Process)
    signal.activeProcesses.delete(mp4Process)
    if (mp4Code !== 0) {
      console.log(`ffmpeg mp4 convert failed (code ${mp4Code}):`, mp4Stderr.slice(-500))
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
  eventEmitter: (msg: string) => void,
  signal: VideoSignal
) => {
  const queue = [...replays]
  let completed = 0

  eventEmitter(`0/${replays.length} clips`)

  const worker = async () => {
    let replay
    while ((replay = queue.shift()) !== undefined) {
      if (signal.stopped || signal.cancelled) break
      const ok = await processOneReplay(replay, config, signal)
      if (!ok && (signal.stopped || signal.cancelled)) break
      if (ok) {
        completed += 1
        eventEmitter(`${completed}/${replays.length} clips`)
      }
    }
  }

  const workers = []
  for (let i = 0; i < config.numProcesses; i++) workers.push(worker())
  await Promise.all(workers)

  // Concatenate all output clips into a single video
  if (config.concatenate && !signal.stopped && !signal.cancelled) {
    console.log('Concatenating clips...')
    eventEmitter('Concatenating clips...')

    const ext = config.convertToMp4 ? '.mp4' : '.avi'
    const outputFiles = fs
      .readdirSync(config.outputPath)
      .filter(
        (f) =>
          f.endsWith(ext) &&
          !f.includes('-unmerged') &&
          !f.includes('-merged')
      )
      .sort()

    if (outputFiles.length > 1) {
      const concatListPath = path.resolve(
        config.outputPath,
        'concat_list.txt'
      )
      const concatLines = outputFiles.map(
        (f) => `file '${path.resolve(config.outputPath, f)}'`
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
          '128k'
        )
      }
      concatArgs.push(finalPath)

      const concatProcess = spawn(ffmpegPath, concatArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      signal.activeProcesses.add(concatProcess)
      let concatStderr = ''
      concatProcess.stderr!.on('data', (chunk: Buffer) => {
        concatStderr += chunk.toString()
      })
      const concatCode = await exit(concatProcess)
      signal.activeProcesses.delete(concatProcess)
      if (concatCode !== 0) {
        console.log(`ffmpeg concat failed (code ${concatCode}):`, concatStderr.slice(-500))
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
  eventEmitter: (msg: string) => void
) => {
  eventEmitter('Configuring Dolphin...')
  let gameSettingsPath = null
  let graphicsSettingsPath = null
  let dolphinSettingsPath = null

  // Linux
  if (os.type() == 'Linux') {
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
      'GALE01.ini'
    )
    graphicsSettingsPath = path.join(
      dolphinDirname,
      'User',
      'Config',
      'GFX.ini'
    )
    dolphinSettingsPath = path.join(
      dolphinDirname,
      'User',
      'Config',
      'Dolphin.ini'
    )

    if (!fs.existsSync(gameSettingsPath)) {
      eventEmitter('Creating game settings file')
      try {
        const fd = fs.openSync(gameSettingsPath, 'a')
        fs.closeSync(fd)
      } catch (err) {
        throw err
      }
    }
  }

  if (!fs.existsSync(gameSettingsPath)) {
    eventEmitter('Error: could not find game settings file')
    throw new Error('Error: could not find game settings file')
  }

  // Game settings
  let newSettings: string[] = ['[Gecko]', '[Gecko_Enabled]']
  if (!config.gameMusicOn) newSettings.push('$Optional: Game Music OFF')
  if (config.hideHud) newSettings.push('$Optional: Hide HUD')
  if (config.hideTags) newSettings.push('$Optional: Hide Tags')
  if (config.fixedCamera) newSettings.push('$Optional: Fixed Camera Always')
  if (!config.widescreenOff) newSettings.push('$Optional: Widescreen 16:9')
  if (config.disableScreenShake)
    newSettings.push('$Optional: Disable Screen Shake')
  if (config.noElectricSFX) newSettings.push('$Optional: No Electric SFX')
  if (config.noCrowdNoise)
    newSettings.push('$Optional: Prevent Crowd Noises')
  if (!config.enableChants)
    newSettings.push('$Optional: Prevent Character Crowd Chants')
  if (config.disableMagnifyingGlass)
    newSettings.push('$Optional: Disable Magnifying-glass HUD')

  newSettings.push('[Gecko_Disabled]')
  if (config.hideNames) newSettings.push('$Optional: Show Player Names')

  await fsPromises.writeFile(gameSettingsPath, newSettings.join('\n'))

  // Graphics settings
  let rl = readline.createInterface({
    input: fs.createReadStream(graphicsSettingsPath),
    crlfDelay: Infinity,
  })
  newSettings = []
  const aspectRatioSetting = config.widescreenOff ? 5 : 6
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
  eventEmitter: (msg: string) => void
): VideoJobController => {
  const signal: VideoSignal = {
    stopped: false,
    cancelled: false,
    activeProcesses: new Set(),
  }

  const promise = (async () => {
    await fsPromises
      .access(config.ssbmIsoPath)
      .catch((err) => {
        if (err.code === 'ENOENT') {
          throw new Error(
            `Error: Could not read SSBM iso from path ${config.ssbmIsoPath}. `
          )
        } else {
          throw err
        }
      })
      .then(() => fsPromises.access(config.dolphinPath))
      .catch((err) => {
        if (err.code === 'ENOENT') {
          throw new Error(
            `Error: Could not open Dolphin from path ${config.dolphinPath}. `
          )
        } else {
          throw err
        }
      })
      .then(() => configureDolphin(config, eventEmitter))
      .then(() => processReplays(replays, config, eventEmitter, signal))
      .catch((err) => {
        eventEmitter(`${err}`)
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
  }
}

export default slpToVideo
