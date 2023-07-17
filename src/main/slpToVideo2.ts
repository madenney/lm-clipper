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
import os from 'os'
import path from 'path'
import readline from 'readline'
import { SlippiGame } from '@slippi/slippi-js'

import { pad } from '../lib'
import { getFFMPEGPath } from './util'
import { ConfigInterface, ReplayInterface } from '../constants/types'

const ffmpegPath = getFFMPEGPath()

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
      const metadata = game.getMetadata()
      if (!metadata || !metadata.lastFrame) return false
      const dolphinConfig = {
        mode: 'normal',
        replay: replay.path,
        startFrame:
          replay.startFrame - 60 < -123 ? -123 : replay.startFrame - 60,
        endFrame: Math.min(replay.endFrame, metadata.lastFrame - 1),
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
  // eslint-disable-next-line no-unused-vars
  onSpawn?: (process_: ChildProcessWithoutNullStreams) => void
) => {
  const numTasks = argsArray.length
  let count = 0
  eventEmitter(`${count}/${numTasks}`)
  const worker = async () => {
    let args
    while ((args = argsArray.pop()) !== undefined) {
      const process_ = spawn(command, args, options)
      const exitPromise = exit(process_)
      if (onSpawn) {
        await onSpawn(process_)
      }
      await exitPromise
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
      } else if (line.includes(`[CURRENT_FRAME] ${endFrame}`)) {
        process.kill()
      }
    })
  })
}

const processReplays = async (
  replays: ReplayInterface[],
  config: ConfigInterface,
  eventEmitter: (msg: string) => void
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
    if (config.resolution === '2x' && !config.widescreenOff) {
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
    killDolphinOnEndFrame
  )

  // Merge video and audio files
  console.log('Merging video and audio...')
  eventEmitter('Merging video and audio...')
  eventEmitter(ffmpegPath.path)
  await executeCommandsInQueue(
    ffmpegPath,
    ffmpegMergeArgsArray,
    config.numProcesses,
    { stdio: 'ignore' },
    (msg: string) => {
      eventEmitter(`Merging video and audio... ${msg}`)
    }
  )

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
    }
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
  const dolphinDirname = path.dirname(config.dolphinPath)
  let gameSettingsPath = path.join(
    dolphinDirname,
    'User',
    'GameSettings',
    'GALE01.ini'
  )
  let graphicsSettingsPath = path.join(
    dolphinDirname,
    'User',
    'Config',
    'GFX.ini'
  )
  let dolphinSettingsPath = path.join(
    dolphinDirname,
    'User',
    'Config',
    'Dolphin.ini'
  )
  if (!fs.existsSync(gameSettingsPath)) {
    const altDir = path.resolve(app.getPath('appData'), 'SlippiPlayback')
    gameSettingsPath = path.join(altDir, 'GameSettings', 'GALE01.ini')
    graphicsSettingsPath = path.join(altDir, 'Config', 'GFX.ini')
    dolphinSettingsPath = path.join(altDir, 'Config', 'Dolphin.ini')
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

const slpToVideo = async (
  replays: ReplayInterface[],
  config: ConfigInterface,
  eventEmitter: (msg: string) => void
) => {
  await fsPromises
    .access(config.ssbmIsoPath)
    .catch((err) => {
      if (err.code === 'ENOENT') {
        throw new Error(
          `Could not read SSBM iso from path ${config.ssbmIsoPath}. `
        )
      } else {
        throw err
      }
    })
    .then(() => fsPromises.access(config.dolphinPath))
    .catch((err) => {
      if (err.code === 'ENOENT') {
        throw new Error(
          `Could not open Dolphin from path ${config.dolphinPath}. `
        )
      } else {
        throw err
      }
    })
    .then(() => configureDolphin(config, eventEmitter))
    .then(() => generateDolphinConfigs(replays, config, eventEmitter))
    .then(() => processReplays(replays, config, eventEmitter))
    .catch((err) => {
      console.error(err)
    })
}

export default slpToVideo
