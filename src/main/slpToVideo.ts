/* eslint-disable no-unused-vars */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-cond-assign */
/* eslint-disable no-underscore-dangle */
/*

Where the magic happens.

If you're here to see how to convert slp to mp4, I recommend starting here:
https://github.com/kevinsung/slp-to-video

*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
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
  activeProcesses: Set<ChildProcessWithoutNullStreams>
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

const generateDolphinConfigs = async (
  replays: ReplayInterface[],
  config: ConfigInterface,
  eventEmitter: (msg: string) => void
) => {
  eventEmitter('Generating Dolphin config files')
  await Promise.all(
    replays.map((replay) => {
      let game
      try {
        game = new SlippiGame(replay.path)
      } catch (e) {
        console.log('Broken file: ', replay.path)
        return false
      }

      let endFrame = 0
      const metadata = game.getMetadata()
      const emptyObject = {}
      if(JSON.stringify(emptyObject) == JSON.stringify(metadata)){
        if(!replay.endFrame) throw new Error("Cannot record full length games without metadata")
        endFrame = replay.endFrame
      } else {
        if (!metadata || !metadata.lastFrame) return false
        endFrame = Math.min(replay.endFrame, metadata.lastFrame - 1)
      }
      const dolphinConfig = {
        mode: 'normal',
        replay: replay.path,
        startFrame:
          replay.startFrame - 60 < -123 ? -123 : replay.startFrame - 60,
        endFrame: endFrame,
        isRealTimeMode: false,
        commandId: `${crypto.randomBytes(12).toString('hex')}`,
      }
      return fsPromises.writeFile(
        path.join(config.outputPath, `${pad(replay.index, 4)}.json`),
        JSON.stringify(dolphinConfig)
      )
    })
  )
}

const exit = (process: ChildProcessWithoutNullStreams) =>
  new Promise((resolve) => {
    process.on('exit', resolve)
  })

const executeCommandsInQueue = async (
  command: string,
  argsArray: string[][],
  numWorkers: number,
  options: { [key: string]: any },
  eventEmitter: (msg: string) => void,
  signal: VideoSignal,
  // eslint-disable-next-line no-unused-vars
  onSpawn?: (process_: ChildProcessWithoutNullStreams) => void
) => {
  const numTasks = argsArray.length
  let count = 0
  eventEmitter(`${count}/${numTasks}`)
  const worker = async () => {
    let args
    while ((args = argsArray.pop()) !== undefined) {
      if (signal.stopped || signal.cancelled) break
      const process_ = spawn(command, args, options)
      signal.activeProcesses.add(process_)
      const exitPromise = exit(process_)
      if (onSpawn) {
        await onSpawn(process_)
      }
      await exitPromise
      signal.activeProcesses.delete(process_)
      if (signal.cancelled) break
      count += 1
      eventEmitter(`${count}/${numTasks}`)
    }
  }
  const workers = []
  while (workers.length < numWorkers) {
    workers.push(worker())
  }
  while (workers.length > 0) {
    await workers.pop()
  }
}

const killDolphinOnEndFrame = (process: ChildProcessWithoutNullStreams) => {
  let endFrame: string | number | null = Infinity
  process.stdout.setEncoding('utf8')
  process.stdout.on('data', (data) => {
    const lines = data.split('\r\n')
    lines.forEach((line: string) => {
      if (line.includes(`[PLAYBACK_END_FRAME]`)) {
        const regex = /\[PLAYBACK_END_FRAME\] ([0-9]*)/
        const match = regex.exec(line)
        endFrame = match && match[1] ? match[1] : Infinity
      } else if (line.includes('[GAME_END_FRAME]')) {
        process.kill()
      } else if (line.includes(`[CURRENT_FRAME] ${endFrame}`)) {
        process.kill()
      }
    })
  })
}

const processReplays = async (
  replays: ReplayInterface[],
  config: ConfigInterface,
  eventEmitter: (msg: string) => void,
  signal: VideoSignal
) => {
  const dolphinArgsArray: string[][] = []
  const ffmpegMergeArgsArray: string[][] = []
  const ffmpegTrimArgsArray: string[][] = []
  // const ffmpegOverlayArgsArray = []
  let promises: Promise<any>[] = []

  replays.forEach((replay) => {
    const fileBasename = pad(replay.index, 4)

    // arguments for dolphin recording
    dolphinArgsArray.push([
      '-i',
      path.resolve(config.outputPath, `${fileBasename}.json`),
      '-o',
      `${fileBasename}-unmerged`,
      `--output-directory=${config.outputPath}`,
      '-b',
      '-e',
      config.ssbmIsoPath,
      '--cout',
    ])

    // Arguments for ffmpeg merging
    const ffmpegMergeArgs = [
      '-i',
      path.resolve(config.outputPath, `${fileBasename}-unmerged.avi`),
      '-i',
      path.resolve(config.outputPath, `${fileBasename}-unmerged.wav`),
      '-b:v',
      `${config.bitrateKbps}k`,
    ]
    if (config.resolution === 4 && !config.widescreenOff) {
      // Slightly upscale to 1920x1080
      ffmpegMergeArgs.push('-vf')
      ffmpegMergeArgs.push('scale=1920:1080')
    }
    ffmpegMergeArgs.push(
      path.resolve(config.outputPath, `${fileBasename}-merged.avi`)
    )
    ffmpegMergeArgsArray.push(ffmpegMergeArgs)

    // Arguments for ffmpeg trimming
    ffmpegTrimArgsArray.push([
      '-ss',
      '1',
      '-i',
      path.resolve(config.outputPath, `${fileBasename}-merged.avi`),
      '-c',
      'copy',
    ])

    // Arguments for adding overlays
    // if(replay.overlayPath){
    //   ffmpegTrimArgsArray[ffmpegTrimArgsArray.length - 1].push(
    //     path.resolve(config.outputPath, `${fileBasename}-pre-overlay.avi`)
    //     ffmpegOverlayArgsArray.push([
    //         "-i",
    //         path.resolve(config.outputPath,`${fileBasename}-pre-overlay.avi`),
    //         "-i",
    //         replay.overlayPath,
    //         "-b:v",
    //         `${config.bitrateKbps}k`,
    //         "-filter_complex",
    //         "[0:v][1:v] overlay",
    //         path.resolve(config.outputPath,`${fileBasename}.avi`),
    //       ])
    //     } else {
    ffmpegTrimArgsArray[ffmpegTrimArgsArray.length - 1].push(
      path.resolve(config.outputPath, `${fileBasename}.avi`)
    )
    //    }
  })

  // Dump frames to video and audio
  console.log('Recording video and audio...')
  eventEmitter('Recording video and audio...')
  await executeCommandsInQueue(
    config.dolphinPath,
    dolphinArgsArray,
    config.numProcesses,
    {},
    (msg: string) => {
      eventEmitter(`Recording video and audio... ${msg}`)
    },
    signal,
    killDolphinOnEndFrame
  )

  if (signal.stopped || signal.cancelled) return

  // Merge video and audio files
  console.log('Merging video and audio...')
  eventEmitter('Merging video and audio...')
  await executeCommandsInQueue(
    ffmpegPath,
    ffmpegMergeArgsArray,
    config.numProcesses,
    { stdio: 'ignore' },
    (msg: string) => {
      eventEmitter(`Merging video and audio... ${msg}`)
    },
    signal
  )

  if (signal.stopped || signal.cancelled) return

  // Trim buffer frames
  console.log('Trimming off buffer frames...')
  eventEmitter('Trimming off buffer frames...')
  await executeCommandsInQueue(
    ffmpegPath,
    ffmpegTrimArgsArray,
    config.numProcesses,
    { stdio: 'ignore' },
    (msg: string) => {
      eventEmitter(`Trimming off buffer frames... ${msg}`)
    },
    signal
  )

  // Add overlays
  // console.log("Adding overlays...")
  // await executeCommandsInQueue(
  //   "ffmpeg",
  //   ffmpegOverlayArgsArray,
  //   config.numProcesses,
  //   { stdio: "ignore" },
  //   eventEmitter
  // )

  // Delete unmerged video and audio files
  console.log('Deleting unmerged audio and video files...')
  eventEmitter('Deleting unmerged audio and video files...')
  promises = []
  const unmergedFiles = fs
    .readdirSync(config.outputPath)
    .filter((f) => f.includes('-unmerged'))
  unmergedFiles.forEach((file) => {
    promises.push(fsPromises.unlink(path.resolve(config.outputPath, file)))
  })
  await Promise.all(promises)

  // Delete untrimmed video and audio files
  console.log('Deleting untrimmed audio and video files...')
  eventEmitter('Deleting untrimmed audio and video files...')
  promises = []
  const untrimmedFiles = fs
    .readdirSync(config.outputPath)
    .filter((f) => f.includes('-merged'))
  untrimmedFiles.forEach((file) => {
    promises.push(fsPromises.unlink(path.resolve(config.outputPath, file)))
  })
  await Promise.all(promises)

  // Delete pre-overlay video files
  // console.log('Deleting pre-overlay video files...')
  // promises = []
  // const preOverlayFiles = fs
  //   .readdirSync(config.outputPath)
  //   .filter((f) => f.includes('-pre-overlay'))
  // preOverlayFiles.forEach((file) => {
  //   promises.push(fsPromises.unlink(path.resolve(config.outputPath, file)))
  // })
  // await Promise.all(promises)

  // Delete overlays
  // console.log('Deleting overlays...')
  // promises = []
  // const overlays = fs.readdirSync(config.outputPath).filter(f => f.includes('.png'));
  // overlays.forEach((file) => {
  //   promises.push(fsPromises.unlink(path.resolve(config.outputPath, file)))
  // })
  // await Promise.all(promises)

  // Delete dolphin config json files
  console.log('Deleting dolphin config files...')
  eventEmitter('Deleting dolphin config files...')
  promises = []
  const dolphinConfigFiles = fs
    .readdirSync(config.outputPath)
    .filter((f) => f.endsWith('.json'))
  dolphinConfigFiles.forEach((file) => {
    promises.push(fsPromises.unlink(path.resolve(config.outputPath, file)))
  })
  await Promise.all(promises)

  // Concatenate all output clips into a single video
  if (config.concatenate && !signal.stopped && !signal.cancelled) {
    console.log('Concatenating clips...')
    eventEmitter('Concatenating clips...')

    const outputFiles = fs
      .readdirSync(config.outputPath)
      .filter((f) => f.endsWith('.avi') && !f.includes('-unmerged') && !f.includes('-merged'))
      .sort()

    if (outputFiles.length > 1) {
      const concatListPath = path.resolve(config.outputPath, 'concat_list.txt')
      const concatLines = outputFiles.map(
        (f) => `file '${path.resolve(config.outputPath, f)}'`
      )
      await fsPromises.writeFile(concatListPath, concatLines.join('\n'))

      const finalPath = path.resolve(config.outputPath, 'final.avi')
      const concatProcess = spawn(ffmpegPath, [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c:v', 'copy',
        '-b:v', `${config.bitrateKbps}k`,
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-fflags', '+genpts',
        finalPath,
      ], { stdio: 'ignore' })

      signal.activeProcesses.add(concatProcess)
      await exit(concatProcess)
      signal.activeProcesses.delete(concatProcess)

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
  if(os.type() == "Linux"){
    const dolphinDirname = path.resolve(getAppDataPath(), 'SlippiPlayback')
    gameSettingsPath = path.join(dolphinDirname, 'GameSettings', 'GALE01.ini')
    graphicsSettingsPath = path.join(dolphinDirname, 'Config', 'GFX.ini')
    dolphinSettingsPath = path.join(dolphinDirname, 'Config', 'Dolphin.ini')

  // Windows
  } else { 
    const dolphinDirname = path.dirname(config.dolphinPath)
    gameSettingsPath = path.join( dolphinDirname, 'User', 'GameSettings', 'GALE01.ini' )
    graphicsSettingsPath = path.join(dolphinDirname, 'User', 'Config', 'GFX.ini')
    dolphinSettingsPath = path.join(dolphinDirname, 'User', 'Config', 'Dolphin.ini' )

    if (!fs.existsSync(gameSettingsPath)) {
      eventEmitter('Creating game settings file');
      try {
        const fd = fs.openSync(gameSettingsPath, 'a');
        fs.closeSync(fd); 
      } catch (err) {
        throw err;
      }
    }
  }

  if (!fs.existsSync(gameSettingsPath)) {
    eventEmitter('Error: could not find game settings file')
    throw new Error('Error: could not find game settings file')
  }

  // Game settings
  let newSettings = ['[Gecko]', '[Gecko_Enabled]']
  if (!config.gameMusicOn) newSettings.push('$Optional: Game Music OFF')
  if (config.hideHud) newSettings.push('$Optional: Hide HUD')
  if (config.hideTags) newSettings.push('$Optional: Hide Tags')
  if (config.fixedCamera) newSettings.push('$Optional: Fixed Camera Always')
  if (!config.widescreenOff) newSettings.push('$Optional: Widescreen 16:9')
  if (config.disableScreenShake)
    newSettings.push('$Optional: Disable Screen Shake')
  if (config.noElectricSFX) newSettings.push('$Optional: No Electric SFX')
  if (config.noCrowdNoise) newSettings.push('$Optional: Prevent Crowd Noises')
  if (!config.enableChants)
    newSettings.push('$Optional: Prevent Character Crowd Chants')
  if (config.disableMagnifyingGlass)
    newSettings.push('$Optional: Disable Magnifying-glass HUD')
  // newSettings.push("$Optional: Force 2P Center HUD")
  // if (config.hideNeutralFalco) newSettings.push("$Optional: Hide Neutral Falco")
  // if (true) newSettings.push("$Optional: Hide Neutral Falco")
  // if (true) newSettings.push("$Optional: Turn Green When Actionable")
  // if (true) newSettings.push("$Optional: DI Draw1")
  // if (true) newSettings.push("$Optional: DI Draw")

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
  config: ConfigInterface,
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
      .then(() => generateDolphinConfigs(replays, config, eventEmitter))
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
        try { p.kill() } catch (_) { /* already dead */ }
      })
      signal.activeProcesses.clear()
    },
    promise,
  }
}

export default slpToVideo
