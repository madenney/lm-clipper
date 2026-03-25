import { app, BrowserWindow, IpcMainEvent, shell } from 'electron'
import { spawn, execFile, ChildProcess } from 'child_process'
import https from 'https'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import { shuffleArray } from '../../lib'
import { characters } from '../../constants/characters'
import { stages } from '../../constants/stages'
import {
  ArchiveInterface,
  ClipInterface,
  FileInterface,
  ConfigInterface,
  ReplayInterface,
} from '../../constants/types'
import Archive from '../../models/Archive'
import slpToVideo, { VideoJobController } from '../slpToVideo'
import { updateEfbScale, createOutputDirectory, getFFMPEGPath } from '../util'
import { getMetaData } from '../db'
import { logMain, getLogPath } from '../logger'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import type ConsoleManager from './ConsoleManager'

type ClipPayload = {
  path?: string
  startFrame?: number
  endFrame?: number
  lastFrame?: number
}

const resolveClipFrames = (payload: ClipPayload) => {
  const hasStart =
    typeof payload.startFrame === 'number' && payload.startFrame !== 0
  const hasEnd = typeof payload.endFrame === 'number' && payload.endFrame !== 0
  const startFrame = hasStart ? payload.startFrame : -123
  const endFrame = hasEnd
    ? payload.endFrame
    : typeof payload.lastFrame === 'number' && payload.lastFrame > 0
      ? payload.lastFrame
      : 99999
  return { startFrame, endFrame }
}

export default class VideoManager {
  private mainWindow: BrowserWindow
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void
  private getConfig: () => ConfigInterface
  private consoleManager: ConsoleManager

  activeVideoJob: VideoJobController | null
  activePlaybackProcess: ChildProcess | null
  playbackAborted: boolean
  activeTmpDirs: Set<string>

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getArchive: () => ArchiveInterface | null
      setArchive: (_archive: ArchiveInterface | null) => void
      getConfig: () => ConfigInterface
      consoleManager: ConsoleManager
    },
  ) {
    this.mainWindow = mainWindow
    this.getArchive = deps.getArchive
    this.setArchive = deps.setArchive
    this.getConfig = deps.getConfig
    this.consoleManager = deps.consoleManager

    this.activeVideoJob = null
    this.activePlaybackProcess = null
    this.playbackAborted = false
    this.activeTmpDirs = new Set()
  }

  async generateVideo(
    event: IpcMainEvent,
    data?: RequestEnvelope<{ filterId: string; selectedIds: string[] }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      selectedIds: string[]
    }>(data)
    const archive = this.getArchive()
    if (!archive || !archive.getAllItems) {
      this.mainWindow.webContents.send('videoMsg', 'No archive loaded.')
      return reply(event, 'generateVideo', requestId)
    }

    const config = this.getConfig()
    const {
      numCPUs,
      dolphinPath,
      ssbmIsoPath,
      gameMusic,
      hideHud,
      hideTags,
      hideNames,
      fixedCamera,
      enableChants,
      bitrateKbps,
      resolution,
      outputPath,
      addStartFrames,
      addEndFrames,
      slice,
      shuffle,
      lastClipOffset,
      dolphinCutoff,
      disableScreenShake,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      overlaySource,
    } = config

    const effectiveNumCPUs = numCPUs || 1

    try {
      await fsPromises.mkdir(outputPath, { recursive: true })
    } catch (err) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Could not create output directory ${outputPath} `,
      )
      return reply(event, 'generateVideo', requestId)
    }

    const outputDirectory = createOutputDirectory(outputPath)

    const videoConfig = {
      ...config,
      outputPath: outputDirectory,
      numProcesses: effectiveNumCPUs,
      dolphinPath: path.resolve(dolphinPath),
      ssbmIsoPath: path.resolve(ssbmIsoPath),
      gameMusicOn: gameMusic,
      hideHud,
      hideTags,
      hideNames,
      overlaySource,
      disableScreenShake,
      disableChants: !enableChants,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      fixedCamera,
      bitrateKbps,
      resolution,
      dolphinCutoff,
    }

    const metadata = await getMetaData(archive.path)
    const newArchive = new Archive(metadata)
    this.setArchive(newArchive)

    const filterId = payload?.filterId || 'files'
    const selectedIds = payload?.selectedIds || []

    let finalResults: any[]
    if (selectedIds.length > 0) {
      const numericIds = selectedIds
        .map((id) => parseInt(id, 10))
        .filter((n) => !Number.isNaN(n))
      finalResults = await newArchive.getItemsByIds(filterId, numericIds)
    } else {
      finalResults = await newArchive.getAllItems(filterId)
    }

    if (!finalResults || finalResults.length === 0) {
      this.mainWindow.webContents.send('videoMsg', 'No clips to generate.')
      return reply(event, 'generateVideo', requestId)
    }

    if (shuffle) finalResults = shuffleArray(finalResults)
    if (slice) finalResults = finalResults.slice(0, slice)

    const replays: ReplayInterface[] = []
    finalResults.forEach(
      (result: ClipInterface | FileInterface, index: number) => {
        const hasStart =
          typeof result.startFrame === 'number' && result.startFrame !== 0
        const hasEnd =
          typeof result.endFrame === 'number' && result.endFrame !== 0
        const startFrame = hasStart ? result.startFrame : -123
        const endFrame = hasEnd
          ? result.endFrame
          : (result as FileInterface).lastFrame || 99999

        const adjustedStart = startFrame - addStartFrames
        const adjustedEnd = endFrame + addEndFrames

        // Extract metadata for filename pattern
        const p1 =
          ('comboer' in result && result.comboer) ||
          ('players' in result && result.players?.[0]) ||
          undefined
        const p2 =
          ('comboee' in result && result.comboee) ||
          ('players' in result && result.players?.[1]) ||
          undefined
        const stageInfo = stages[result.stage as keyof typeof stages] as
          | { shortName?: string; name?: string }
          | undefined
        const combo = 'combo' in result ? result.combo : undefined
        const startedAt = result.startedAt
          ? new Date(result.startedAt * 1000)
          : undefined

        replays.push({
          index,
          path: result.path,
          startFrame: adjustedStart < -123 ? -123 : adjustedStart,
          endFrame: adjustedEnd,
          meta: {
            character1: p1
              ? characters[p1.characterId]?.shortName ||
                characters[p1.characterId]?.name
              : undefined,
            character2: p2
              ? characters[p2.characterId]?.shortName ||
                characters[p2.characterId]?.name
              : undefined,
            player1:
              p1?.displayName || p1?.connectCode || p1?.nametag || undefined,
            player2:
              p2?.displayName || p2?.connectCode || p2?.nametag || undefined,
            stage: stageInfo?.shortName || stageInfo?.name || undefined,
            date: startedAt
              ? `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, '0')}-${String(startedAt.getDate()).padStart(2, '0')}`
              : undefined,
            time: startedAt
              ? `${String(startedAt.getHours()).padStart(2, '0')}${String(startedAt.getMinutes()).padStart(2, '0')}`
              : undefined,
            didKill: combo?.didKill,
            damage:
              combo &&
              typeof combo.startPercent === 'number' &&
              typeof combo.endPercent === 'number'
                ? Math.round(combo.endPercent - combo.startPercent)
                : undefined,
            moves: combo?.moves?.length,
          },
        })
      },
    )
    if (lastClipOffset && replays.length > 0) {
      replays[replays.length - 1].endFrame += lastClipOffset
    }

    console.log('Replays: ', replays)
    console.log('Config: ', videoConfig)
    this.mainWindow.webContents.send(
      'videoOutputPath',
      videoConfig.outputPath.replace(/\/+$/, ''),
    )
    this.consoleManager.startConsole('recording', 'Recording')
    this.activeVideoJob = slpToVideo(replays, videoConfig, (msg: string) => {
      this.mainWindow.webContents.send('videoMsg', msg)
      if (msg) this.consoleManager.pushConsoleLog(msg.startsWith('Error') ? 'error' : 'info', msg) // prettier-ignore
    })
    let stopped = false
    try {
      await this.activeVideoJob.promise
    } catch (err) {
      stopped = true
      logMain('generateVideo: error', err)
    } finally {
      this.consoleManager.stopConsole()
      this.activeVideoJob = null
      this.mainWindow.webContents.send('videoJobFinished')
    }
    // Send completion details to renderer for the "recording complete" modal
    let completedClipCount = 0
    let completedDuration: number | null = null
    if (!stopped && videoConfig.outputPath) {
      try {
        const ext = videoConfig.convertToMp4 ? '.mp4' : '.avi'
        const allFiles = fs
          .readdirSync(videoConfig.outputPath)
          .filter(
            (f) =>
              f.endsWith(ext) &&
              !f.includes('-unmerged') &&
              !f.includes('-merged'),
          )
          .sort()
        const clips = allFiles.filter((f) => !f.startsWith('final'))
        let totalSize = 0
        for (const f of allFiles) {
          try {
            totalSize += fs.statSync(
              path.resolve(videoConfig.outputPath, f),
            ).size
          } catch {
            // skip
          }
        }

        // Try to get video duration via ffprobe
        let duration: number | null = null
        const playFile =
          allFiles.find((f) => f.startsWith('final')) ||
          allFiles[allFiles.length - 1]
        if (playFile) {
          try {
            const ffmpegDir = path.dirname(getFFMPEGPath())
            const ffprobePath =
              ffmpegDir === '.'
                ? 'ffprobe'
                : path.resolve(
                    ffmpegDir,
                    `ffprobe${process.platform === 'win32' ? '.exe' : ''}`,
                  )
            const probePath = path.resolve(videoConfig.outputPath, playFile)
            duration = await new Promise<number | null>((resolve) => {
              execFile(
                ffprobePath,
                [
                  '-v',
                  'quiet',
                  '-print_format',
                  'json',
                  '-show_format',
                  probePath,
                ],
                { timeout: 10000 },
                (err, stdout) => {
                  if (err) return resolve(null)
                  try {
                    const info = JSON.parse(stdout)
                    const dur = parseFloat(info?.format?.duration)
                    resolve(Number.isFinite(dur) ? dur : null)
                  } catch {
                    resolve(null)
                  }
                },
              )
            })
          } catch {
            // ffprobe not available, skip duration
          }
        }

        completedClipCount = clips.length
        completedDuration = duration
        this.mainWindow.webContents.send('videoCompleted', {
          outputPath: videoConfig.outputPath,
          files: allFiles,
          totalSize,
          clipCount: clips.length,
          duration,
        })
      } catch {
        // If we can't read the dir, just skip the modal
      }
      if (config.autoOpenOutputFolder) {
        shell.openPath(videoConfig.outputPath).catch(() => {})
      }
      // Report anonymous usage stats
      if (config.sendAnonymousUsage !== false) {
        this.reportUsage(completedClipCount, completedDuration)
      }
    }
    return reply(event, 'generateVideo', requestId)
  }

  private reportUsage(clips: number, durationSec: number | null) {
    const body = JSON.stringify({
      event: 'video_created',
      data: {
        clips,
        durationSec: durationSec ?? 0,
      },
    })
    const req = https.request('https://www.lunarmelee.com/api/app-usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    })
    req.on('error', () => {}) // silently ignore failures
    req.write(body)
    req.end()
  }

  stopVideo(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.activeVideoJob) {
      this.activeVideoJob.stop()
    }
    return reply(event, 'stopVideo', requestId)
  }

  cancelVideo(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.activeVideoJob) {
      this.activeVideoJob.cancel()
    }
    return reply(event, 'cancelVideo', requestId)
  }

  async recordClip(event: IpcMainEvent, data: RequestEnvelope<ClipPayload>) {
    const { requestId, payload } = unpackRequest<ClipPayload>(data)
    if (!payload?.path) {
      this.mainWindow.webContents.send('videoMsg', 'No clip selected.')
      return reply(event, 'recordClip', requestId)
    }

    const config = this.getConfig()
    const {
      numCPUs,
      dolphinPath,
      ssbmIsoPath,
      gameMusic,
      hideHud,
      hideTags,
      hideNames,
      fixedCamera,
      enableChants,
      bitrateKbps,
      resolution,
      outputPath,
      addStartFrames,
      addEndFrames,
      lastClipOffset,
      dolphinCutoff,
      disableScreenShake,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      overlaySource,
    } = config

    const effectiveNumCPUs = numCPUs || 1

    try {
      await fsPromises.access(payload.path)
    } catch {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Replay file not found: ${payload.path}`,
      )
      return reply(event, 'recordClip', requestId)
    }

    try {
      await fsPromises.mkdir(outputPath, { recursive: true })
    } catch (err) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Could not create output directory ${outputPath} `,
      )
      return reply(event, 'recordClip', requestId)
    }

    const outputDirectory = createOutputDirectory(outputPath)

    const videoConfig = {
      ...config,
      outputPath: outputDirectory,
      numProcesses: effectiveNumCPUs,
      dolphinPath: path.resolve(dolphinPath),
      ssbmIsoPath: path.resolve(ssbmIsoPath),
      gameMusicOn: gameMusic,
      hideHud,
      hideTags,
      hideNames,
      overlaySource,
      disableScreenShake,
      disableChants: !enableChants,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      fixedCamera,
      bitrateKbps,
      resolution,
      dolphinCutoff,
    }

    const { startFrame, endFrame } = resolveClipFrames(payload)
    const adjustedStart = startFrame - addStartFrames
    const adjustedEnd = endFrame + addEndFrames
    const replay: ReplayInterface = {
      index: 0,
      path: payload.path,
      startFrame: adjustedStart < -123 ? -123 : adjustedStart,
      endFrame: adjustedEnd,
    }

    if (lastClipOffset) {
      replay.endFrame += lastClipOffset
    }

    const job = slpToVideo([replay], videoConfig, (msg: string) => {
      this.mainWindow.webContents.send('videoMsg', msg)
    })
    await job.promise

    return reply(event, 'recordClip', requestId)
  }

  async playClips(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string; selectedIds: string[] }>,
  ) {
    const { payload } = unpackRequest<{
      filterId: string
      selectedIds: string[]
    }>(data)
    const archive = this.getArchive()
    if (!archive || !payload?.selectedIds?.length) return

    const numericIds = payload.selectedIds
      .map((id) => parseInt(id, 10))
      .filter((n) => !Number.isNaN(n))
    if (numericIds.length === 0) return

    const items = await archive.getItemsByIds(payload.filterId, numericIds)
    if (!items || items.length === 0) return

    const playable = items.filter(
      (item) => 'path' in item && Boolean(item.path),
    )
    if (playable.length === 0) return

    this.playbackAborted = false
    this.mainWindow.webContents.send('playbackStarted')

    for (const item of playable) {
      if (this.playbackAborted) break
      const clipPayload: ClipPayload = {
        path: item.path as string,
        startFrame:
          'startFrame' in item ? (item.startFrame as number) : undefined,
        endFrame: 'endFrame' in item ? (item.endFrame as number) : undefined,
        lastFrame: 'lastFrame' in item ? (item.lastFrame as number) : undefined,
      }
      await this.playClipAsync(clipPayload)
    }

    this.mainWindow.webContents.send('playbackDone')
  }

  stopPlayback() {
    this.playbackAborted = true
    if (this.activePlaybackProcess) {
      try {
        this.activePlaybackProcess.kill()
      } catch (_) {
        // empty
      }
    }
  }

  private async playClipAsync(
    payload: ClipPayload,
    reportError?: (_msg: string) => void,
  ): Promise<void> {
    const config = this.getConfig()
    const { dolphinPath, ssbmIsoPath } = config
    if (!dolphinPath || !ssbmIsoPath) {
      reportError?.('Error: dolphinPath or ssbmIsoPath not set.')
      return
    }

    try {
      await fsPromises.access(dolphinPath)
    } catch {
      reportError?.(`Error: Could not open Dolphin from path ${dolphinPath}. `)
      logMain('playClipAsync: Dolphin not found', { dolphinPath })
      return
    }

    try {
      await fsPromises.access(ssbmIsoPath)
    } catch {
      reportError?.(`Error: Could not access ISO from path ${ssbmIsoPath}. `)
      logMain('playClipAsync: ISO not found', { ssbmIsoPath })
      return
    }

    try {
      await fsPromises.access(payload.path)
    } catch {
      reportError?.(`Error: Could not access replay ${payload.path}. `)
      logMain('playClipAsync: replay file not found', {
        path: payload.path,
      })
      return
    }

    const { startFrame, endFrame } = resolveClipFrames(payload)
    const { addStartFrames, addEndFrames, playbackResolution } = config
    const adjustedStart = startFrame - addStartFrames
    const adjustedEnd = endFrame + addEndFrames
    const dolphinConfig = {
      mode: 'normal',
      replay: payload.path,
      startFrame: adjustedStart,
      endFrame: adjustedEnd,
      isRealTimeMode: false,
      commandId: crypto.randomBytes(12).toString('hex'),
    }

    await updateEfbScale(dolphinPath, playbackResolution ?? 2)

    const tmpDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lm-clipper-'),
    )
    this.activeTmpDirs.add(tmpDir)
    const filePath = path.resolve(tmpDir, 'dolphinConfig.json')
    await fsPromises.writeFile(filePath, JSON.stringify(dolphinConfig))

    const args = [
      '-i',
      filePath,
      ...(config.fullscreen !== false ? ['-b'] : []),
      '-e',
      path.resolve(ssbmIsoPath),
      '--cout',
    ]

    logMain('playClipAsync: spawning Dolphin', {
      dolphinPath: path.resolve(dolphinPath),
      args,
      configJson: dolphinConfig,
    })

    try {
      if (this.activePlaybackProcess) {
        try {
          this.activePlaybackProcess.kill()
        } catch (_) {
          // empty
        }
      }

      const dolphinProcess = spawn(path.resolve(dolphinPath), args)
      this.activePlaybackProcess = dolphinProcess

      let dolphinStderr = ''
      dolphinProcess.stderr.setEncoding('utf8')
      dolphinProcess.stderr.on('data', (chunk: string) => {
        dolphinStderr += chunk
      })

      dolphinProcess.on('error', (err) => {
        logMain('playClipAsync: Dolphin spawn error', err)
        reportError?.(
          `Error launching Dolphin: ${err.message}. Check ${getLogPath()}/main.log`,
        )
      })

      await new Promise<void>((resolve) => {
        let targetEndFrame: number = Infinity
        let staleTimer: ReturnType<typeof setTimeout> | null = null
        const stdoutLines: string[] = []
        let killedReason = ''
        const resetStaleTimer = () => {
          if (staleTimer) clearTimeout(staleTimer)
          staleTimer = setTimeout(() => {
            killedReason = 'stale timer (no CURRENT_FRAME for 1s)'
            dolphinProcess.kill()
          }, 1000)
        }

        dolphinProcess.stdout.setEncoding('utf8')
        dolphinProcess.stdout.on('data', (chunk: string) => {
          const lines = chunk.split('\r\n')
          lines.forEach((line: string) => {
            if (stdoutLines.length < 50 && line.trim()) {
              stdoutLines.push(line)
            }
            if (line.includes('[PLAYBACK_END_FRAME]')) {
              const match = /\[PLAYBACK_END_FRAME\] ([0-9]+)/.exec(line)
              if (match?.[1])
                targetEndFrame = Math.min(
                  targetEndFrame,
                  parseInt(match[1], 10),
                )
            } else if (line.includes('[GAME_END_FRAME]')) {
              const match = /\[GAME_END_FRAME\] ([0-9]+)/.exec(line)
              if (match?.[1])
                targetEndFrame = Math.min(
                  targetEndFrame,
                  parseInt(match[1], 10),
                )
            } else if (
              targetEndFrame !== Infinity &&
              line.includes(`[CURRENT_FRAME] ${targetEndFrame}`)
            ) {
              killedReason = `reached target end frame ${targetEndFrame}`
              dolphinProcess.kill()
            } else if (line.includes('[CURRENT_FRAME]')) {
              resetStaleTimer()
            }
          })
        })

        dolphinProcess.on('exit', (code, signal) => {
          logMain('playClipAsync: Dolphin exited', {
            code,
            signal,
            killedReason: killedReason || 'unknown',
            stdoutLines,
            stderr: dolphinStderr.slice(-2000),
          })
          if (code !== 0 && code !== null) {
            reportError?.(
              `Dolphin exited with code ${code}. Check ${getLogPath()}/main.log`,
            )
          }
          if (this.activePlaybackProcess === dolphinProcess) {
            this.activePlaybackProcess = null
          }
          if (staleTimer) clearTimeout(staleTimer)
          fsPromises.unlink(filePath).catch(() => {})
          fsPromises.rmdir(tmpDir).catch(() => {})
          this.activeTmpDirs.delete(tmpDir)
          resolve()
        })
      })
    } catch (err) {
      logMain('playClipAsync: spawn failed', err)
      reportError?.('Error: Failed to launch Dolphin.')
    }
  }

  async playClip(event: IpcMainEvent, data: RequestEnvelope<ClipPayload>) {
    const { requestId, payload } = unpackRequest<ClipPayload>(data)
    if (!payload?.path) {
      this.mainWindow.webContents.send('videoMsg', 'No clip selected.')
      return reply(event, 'playClip', requestId)
    }

    this.playbackAborted = false
    this.mainWindow.webContents.send('playbackStarted')

    await this.playClipAsync(payload, (msg) => {
      this.mainWindow.webContents.send('videoMsg', msg)
    })

    this.mainWindow.webContents.send('playbackDone')
    return reply(event, 'playClip', requestId)
  }

  async testDolphin() {
    const config = this.getConfig()
    const { dolphinPath, ssbmIsoPath } = config
    if (!dolphinPath || !ssbmIsoPath) {
      this.mainWindow.webContents.send(
        'videoMsg',
        'Error: Set Dolphin and ISO paths first.',
      )
      return
    }

    try {
      await fsPromises.access(dolphinPath)
    } catch {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: Dolphin not found at ${dolphinPath}`,
      )
      return
    }

    try {
      await fsPromises.access(ssbmIsoPath)
    } catch {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: ISO not found at ${ssbmIsoPath}`,
      )
      return
    }

    // Resolve test .slp from assets
    const RESOURCES_PATH = app.isPackaged
      ? path.join(process.resourcesPath, 'assets')
      : path.join(__dirname, '../../assets')
    const testSlp = path.join(RESOURCES_PATH, 'test.slp')

    try {
      await fsPromises.access(testSlp)
    } catch {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: test.slp not found at ${testSlp}`,
      )
      return
    }

    const dolphinDolphinConfig = {
      mode: 'normal',
      replay: testSlp,
      startFrame: -123,
      endFrame: 3600,
      isRealTimeMode: true,
      commandId: crypto.randomBytes(12).toString('hex'),
    }

    const tmpDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'lm-clipper-test-'),
    )
    this.activeTmpDirs.add(tmpDir)
    const configFile = path.resolve(tmpDir, 'testDolphinConfig.json')
    await fsPromises.writeFile(configFile, JSON.stringify(dolphinDolphinConfig))

    this.mainWindow.webContents.send('videoMsg', 'Launching Dolphin test...')

    try {
      const dolphinProcess = spawn(path.resolve(dolphinPath), [
        '-i',
        configFile,
        ...(config.fullscreen !== false ? ['-b'] : []),
        '-e',
        path.resolve(ssbmIsoPath),
        '--cout',
      ])

      const logLines: string[] = []
      const addLog = (line: string) => {
        logLines.push(line)
        console.log('[Dolphin test]', line)
      }

      dolphinProcess.stdout?.on('data', (d: Buffer) => {
        d.toString()
          .split('\n')
          .forEach((l) => {
            if (l.trim()) addLog(`stdout: ${l.trim()}`)
          })
      })

      dolphinProcess.stderr?.on('data', (d: Buffer) => {
        d.toString()
          .split('\n')
          .forEach((l) => {
            if (l.trim()) addLog(`stderr: ${l.trim()}`)
          })
      })

      dolphinProcess.on('error', (err) => {
        addLog(`spawn error: ${err.message}`)
        this.mainWindow.webContents.send(
          'videoMsg',
          `Dolphin error: ${err.message}`,
        )
      })

      dolphinProcess.on('exit', (code) => {
        fsPromises.unlink(configFile).catch(() => {})
        fsPromises.rmdir(tmpDir).catch(() => {})
        this.activeTmpDirs.delete(tmpDir)
        const logFilePath = path.join(
          os.tmpdir(),
          'lm-clipper-dolphin-test.log',
        )
        const logContent = [
          `Dolphin test log - ${new Date().toISOString()}`,
          `Exit code: ${code}`,
          `Dolphin path: ${dolphinPath}`,
          `ISO path: ${ssbmIsoPath}`,
          `Test replay: ${testSlp}`,
          '',
          ...logLines,
        ].join('\n')
        fs.writeFileSync(logFilePath, logContent)

        if (code !== 0 && logLines.length > 0) {
          const lastErr = logLines[logLines.length - 1]
          this.mainWindow.webContents.send(
            'videoMsg',
            `Dolphin failed (code ${code}): ${lastErr} — Log: ${logFilePath}`,
          )
        } else if (code !== 0) {
          this.mainWindow.webContents.send(
            'videoMsg',
            `Dolphin exited with code ${code}. Log: ${logFilePath}`,
          )
        } else {
          this.mainWindow.webContents.send(
            'videoMsg',
            `Dolphin test finished. Log: ${logFilePath}`,
          )
          setTimeout(() => {
            this.mainWindow.webContents.send('videoMsg', '')
          }, 5000)
        }
      })
    } catch (err: any) {
      this.mainWindow.webContents.send(
        'videoMsg',
        `Failed to launch Dolphin: ${err.message}`,
      )
    }
  }

  async detectDolphinPath(event: IpcMainEvent, data: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    const candidates: string[] = []
    const platform = os.platform()

    if (platform === 'linux') {
      candidates.push(
        path.join(
          app.getPath('appData'),
          'Slippi Launcher',
          'playback',
          'Slippi_Playback-x86_64.AppImage',
        ),
      )
    } else if (platform === 'win32') {
      candidates.push(
        path.join(
          app.getPath('appData'),
          'Slippi Launcher',
          'playback',
          'Slippi Dolphin.exe',
        ),
      )
    } else if (platform === 'darwin') {
      candidates.push(
        path.join(
          app.getPath('appData'),
          'Slippi Launcher',
          'playback',
          'Slippi Dolphin.app',
        ),
      )
    }

    for (const candidate of candidates) {
      try {
        await fsPromises.access(candidate)
        return reply(event, 'detectDolphinPath', requestId, candidate)
      } catch {
        // not found, try next
      }
    }

    return reply(event, 'detectDolphinPath', requestId, null)
  }

  async validateDolphinPath(
    event: IpcMainEvent,
    data: RequestEnvelope<string>,
  ) {
    const { requestId, payload: dolphinPath } = unpackRequest<string>(data)

    if (!dolphinPath) {
      return reply(event, 'validateDolphinPath', requestId, {
        valid: false,
        message: 'No path provided.',
      })
    }

    try {
      await fsPromises.access(dolphinPath)
    } catch {
      return reply(event, 'validateDolphinPath', requestId, {
        valid: false,
        message: 'File does not exist at this path.',
      })
    }

    try {
      const output = await new Promise<string>((resolve, reject) => {
        const proc = spawn(dolphinPath, ['-h'], { timeout: 10000 })
        let out = ''
        proc.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString()
        })
        proc.stderr?.on('data', (chunk: Buffer) => {
          out += chunk.toString()
        })
        proc.on('close', () => resolve(out))
        proc.on('error', (err) => reject(err))
      })

      if (output.includes('--hide-seekbar')) {
        return reply(event, 'validateDolphinPath', requestId, {
          valid: true,
          message: 'Slippi Dolphin Playback detected.',
        })
      }

      // Has Slippi flags but not playback-specific ones -- likely the netplay build
      if (output.includes('slippi') || output.includes('Slippi')) {
        return reply(event, 'validateDolphinPath', requestId, {
          valid: false,
          message:
            'This appears to be Slippi Dolphin Online/Netplay, not the Playback build. LM Clipper requires the Playback build.',
        })
      }

      return reply(event, 'validateDolphinPath', requestId, {
        valid: false,
        message:
          'This does not appear to be Slippi Dolphin Playback. Make sure you select the Playback build, not regular Dolphin.',
      })
    } catch {
      return reply(event, 'validateDolphinPath', requestId, {
        valid: false,
        message:
          'Could not run this file. Make sure it is an executable Dolphin binary.',
      })
    }
  }

  async validateIsoPath(event: IpcMainEvent, data: RequestEnvelope<string>) {
    const { requestId, payload: isoPath } = unpackRequest<string>(data)

    if (!isoPath) {
      return reply(event, 'validateIsoPath', requestId, {
        valid: false,
        message: 'No path provided.',
      })
    }

    try {
      await fsPromises.access(isoPath)
    } catch {
      return reply(event, 'validateIsoPath', requestId, {
        valid: false,
        message: 'File does not exist at this path.',
      })
    }

    try {
      const fd = await fsPromises.open(isoPath, 'r')
      const buf = Buffer.alloc(6)
      await fd.read(buf, 0, 6, 0)
      await fd.close()
      const gameId = buf.toString('ascii')

      if (gameId === 'GALE01') {
        return reply(event, 'validateIsoPath', requestId, {
          valid: true,
          message: 'NTSC Melee ISO detected (GALE01).',
        })
      }

      if (gameId === 'GALP01') {
        return reply(event, 'validateIsoPath', requestId, {
          valid: false,
          message:
            'This is a PAL Melee ISO (GALP01). Slippi requires the NTSC version (GALE01).',
        })
      }

      if (gameId === 'GALJ01') {
        return reply(event, 'validateIsoPath', requestId, {
          valid: false,
          message:
            'This is a Japanese Melee ISO (GALJ01). Slippi requires the NTSC version (GALE01).',
        })
      }

      return reply(event, 'validateIsoPath', requestId, {
        valid: false,
        message: `This does not appear to be a Melee ISO (got game ID "${gameId}"). Select an NTSC SSBM ISO (GALE01).`,
      })
    } catch {
      return reply(event, 'validateIsoPath', requestId, {
        valid: false,
        message: 'Could not read this file. Make sure it is a valid .iso file.',
      })
    }
  }

  cleanup() {
    // Kill active video job
    if (this.activeVideoJob) {
      this.activeVideoJob.cancel()
      this.activeVideoJob = null
    }

    // Kill playback
    this.playbackAborted = true
    if (this.activePlaybackProcess) {
      try {
        this.activePlaybackProcess.kill()
      } catch (_) {
        // empty
      }
      this.activePlaybackProcess = null
    }

    // Clean up temp directories
    for (const dir of this.activeTmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (_) {
        // empty
      }
    }
    this.activeTmpDirs.clear()
  }
}
