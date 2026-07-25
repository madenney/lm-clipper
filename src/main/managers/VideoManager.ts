import { app, BrowserWindow, IpcMainEvent, shell } from 'electron'
import { spawn, execFile, ChildProcess } from 'child_process'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import { characters } from '../../constants/characters'
import { stages } from '../../constants/stages'
import { GAME_START_FRAME, FRAME_MAX } from '../../constants/frames'
import { track } from '../telemetry'
import {
  ArchiveInterface,
  ClipInterface,
  FileInterface,
  ConfigInterface,
  ReplayInterface,
} from '../../constants/types'
import Archive from '../../models/Archive'
import slpToVideo, { VideoJobController, writeGeckoCodes } from '../slpToVideo'
import {
  detectPlaybackDolphin,
  detectMeleeIso,
  detectSlippiReplayDir,
} from '../slippiDetect'
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
  // hasStart/hasEnd already proved these are numbers; assert past the
  // separate-boolean narrowing limitation so the result is {number, number}.
  const startFrame = hasStart ? payload.startFrame! : GAME_START_FRAME
  const endFrame = hasEnd
    ? payload.endFrame!
    : typeof payload.lastFrame === 'number' && payload.lastFrame > 0
      ? payload.lastFrame
      : FRAME_MAX
  return { startFrame, endFrame }
}

export default class VideoManager {
  private mainWindow: BrowserWindow
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void
  private getConfig: () => ConfigInterface
  private consoleManager: ConsoleManager

  activeVideoJob: VideoJobController | null
  // True when the current video job's promise rejection was caused by the user
  // pressing Stop/Cancel (vs a real ffmpeg/Dolphin failure) — lets us surface
  // genuine errors instead of silently swallowing them as "stopped".
  private videoStopRequested = false
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
      lastClipOffset,
      dolphinCutoff,
      disableScreenShake,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
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

    if (slice) finalResults = finalResults.slice(0, slice)

    const replays: ReplayInterface[] = []
    finalResults.forEach(
      (result: ClipInterface | FileInterface, index: number) => {
        const hasStart =
          typeof result.startFrame === 'number' && result.startFrame !== 0
        const hasEnd =
          typeof result.endFrame === 'number' && result.endFrame !== 0
        const startFrame = hasStart ? result.startFrame : GAME_START_FRAME
        const endFrame = hasEnd
          ? result.endFrame
          : (result as FileInterface).lastFrame || FRAME_MAX

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
          startFrame:
            adjustedStart < GAME_START_FRAME ? GAME_START_FRAME : adjustedStart,
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

    // Anonymous usage: report rendered clips in checkpoints instead of a single
    // ping at the very end. A long multi-hundred-clip render that is stopped,
    // hits a per-clip ffmpeg error, or has its process killed (terminal crash,
    // reboot) would otherwise report *nothing* — even though the clips landed on
    // disk. We flush a running delta every CHECKPOINT_CLIPS, plus a final flush
    // in the `finally` below, so at most the last un-flushed chunk is ever lost.
    //
    // Each event carries a delta (not a running total) tagged with a shared
    // renderId; the server sums `clips`/`durationSec` and counts distinct
    // renderIds, so the several pings roll up to one render with the right
    // totals. Footage per clip is derived from its frame span (Melee is locked
    // to 60fps; the 60-frame lead-in slpToVideo adds is trimmed straight back
    // off), which is deterministic and free — no probe that can silently zero.
    const CHECKPOINT_CLIPS = 50
    const renderId = crypto.randomBytes(8).toString('hex')
    let pendingClips = 0
    let pendingFootageSec = 0
    const flushUsage = (final: boolean) => {
      if (pendingClips === 0) return
      const clips = pendingClips
      const durationSec = Math.round(pendingFootageSec * 100) / 100
      pendingClips = 0
      pendingFootageSec = 0
      track('video_created', { clips, durationSec, renderId, final })
    }
    const onClipEncoded = (replay: ReplayInterface) => {
      pendingClips += 1
      pendingFootageSec += Math.max(0, replay.endFrame - replay.startFrame) / 60
      if (pendingClips >= CHECKPOINT_CLIPS) flushUsage(false)
    }

    console.log('Replays: ', replays)
    console.log('Config: ', videoConfig)
    this.mainWindow.webContents.send(
      'videoOutputPath',
      videoConfig.outputPath.replace(/\/+$/, ''),
    )
    this.consoleManager.startConsole('recording', 'Recording')
    this.videoStopRequested = false
    this.activeVideoJob = slpToVideo(
      replays,
      videoConfig,
      (msg: string) => {
        this.mainWindow.webContents.send('videoMsg', msg)
        if (msg) this.consoleManager.pushConsoleLog(msg.startsWith('Error') ? 'error' : 'info', msg) // prettier-ignore
      },
      onClipEncoded,
    )
    let stopped = false
    try {
      await this.activeVideoJob.promise
    } catch (err) {
      stopped = true
      logMain('generateVideo: error', err)
      if (!this.videoStopRequested) {
        // A real ffmpeg/Dolphin failure, not a user Stop/Cancel — surface it
        // instead of letting the job silently vanish with no completion modal.
        const m =
          (err as { message?: string })?.message || 'Video generation failed'
        this.mainWindow.webContents.send('videoMsg', `Error: ${m}`)
        this.consoleManager.pushConsoleLog(
          'error',
          `Video generation failed: ${m}`,
        )
      }
    } finally {
      this.consoleManager.stopConsole()
      this.activeVideoJob = null
      this.mainWindow.webContents.send('videoJobFinished')
      // Report clips from the last (un-checkpointed) chunk. Runs on every exit
      // path — clean finish, Stop/Cancel, or ffmpeg error — so a partial render
      // still reports what it produced. Only a hard process kill loses this.
      flushUsage(true)
    }
    // Send completion details to renderer for the "recording complete" modal
    if (!stopped && videoConfig.outputPath) {
      try {
        const ext = videoConfig.convertToMp4 ? '.mp4' : '.avi'
        const allFiles = (await fsPromises.readdir(videoConfig.outputPath))
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
            const stat = await fsPromises.stat(
              path.resolve(videoConfig.outputPath, f),
            )
            totalSize += stat.size
          } catch {
            // skip
          }
        }

        // Total duration: the merged "final" file when concatenating, otherwise
        // the sum of every individual clip. (Previously this probed only the
        // last clip, so the modal reported a single ~5s clip as the total.)
        let duration: number | null = null
        try {
          // Probe with ffmpeg, not ffprobe: only ffmpeg is bundled (see the
          // extraResources blocks in package.json), so a packaged build has no
          // ffprobe to spawn and every duration came back null.
          //
          // `ffmpeg -i <file>` with no output file prints the container header
          // to stderr and then exits non-zero ("At least one output file must
          // be specified"). That exit code is expected — parse stderr either way.
          const ffmpegBin = getFFMPEGPath()
          const probeDuration = (file: string) =>
            new Promise<number | null>((resolve) => {
              execFile(
                ffmpegBin,
                ['-i', path.resolve(videoConfig.outputPath, file)],
                { timeout: 10000 },
                (_err, _stdout, stderr) => {
                  // e.g. "  Duration: 00:00:07.57, start: 0.000000, bitrate: ..."
                  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(
                    stderr || '',
                  )
                  if (!m) return resolve(null)
                  const dur =
                    parseInt(m[1], 10) * 3600 +
                    parseInt(m[2], 10) * 60 +
                    parseFloat(m[3])
                  resolve(Number.isFinite(dur) ? dur : null)
                },
              )
            })

          const finalFile = allFiles.find((f) => f.startsWith('final'))
          if (finalFile) {
            // Concatenated output — the single merged file is the full length.
            duration = await probeDuration(finalFile)
          } else if (clips.length > 0) {
            // Separate clips — sum them all, with bounded concurrency so we
            // don't spawn hundreds of probe processes at once.
            const CONCURRENCY = 16
            let total = 0
            let any = false
            for (let i = 0; i < clips.length; i += CONCURRENCY) {
              const batch = clips.slice(i, i + CONCURRENCY)
              // eslint-disable-next-line no-await-in-loop
              const durs = await Promise.all(batch.map(probeDuration))
              for (const d of durs) {
                if (d != null) {
                  total += d
                  any = true
                }
              }
            }
            duration = any ? total : null
          }
        } catch {
          // Probe unavailable or unreadable — leave duration null
        }

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
    }
    return reply(event, 'generateVideo', requestId)
  }

  stopVideo(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.activeVideoJob) {
      this.videoStopRequested = true
      this.activeVideoJob.stop()
    }
    return reply(event, 'stopVideo', requestId)
  }

  cancelVideo(event: IpcMainEvent, data?: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    if (this.activeVideoJob) {
      this.videoStopRequested = true
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
      startFrame:
        adjustedStart < GAME_START_FRAME ? GAME_START_FRAME : adjustedStart,
      endFrame: adjustedEnd,
    }

    if (lastClipOffset) {
      replay.endFrame += lastClipOffset
    }

    try {
      const job = slpToVideo([replay], videoConfig, (msg: string) => {
        this.mainWindow.webContents.send('videoMsg', msg)
      })
      await job.promise
    } catch (error) {
      console.error('[recordClip] error:', error)
      this.mainWindow.webContents.send(
        'videoMsg',
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

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

    const items = await archive.getItemsByIds?.(payload.filterId, numericIds)
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

    if (!payload.path) {
      reportError?.('Error: No replay path provided.')
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

    // Apply current gecko/rendering toggles (Hide HUD, widescreen, etc.) so the
    // play window reflects the latest settings instead of whatever a prior
    // recording last wrote to GALE01.ini.
    try {
      await writeGeckoCodes(config)
    } catch (err) {
      logMain('playClipAsync: failed to write gecko codes', err)
    }

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

    // Clean up leftover audio dump files so Dolphin doesn't prompt the user
    const dolphinDirname = path.dirname(dolphinPath)
    for (const dumpDir of [
      path.join(dolphinDirname, 'User', 'Dump', 'Audio'),
      path.join(app.getPath('appData'), 'SlippiPlayback', 'Dump', 'Audio'),
    ]) {
      for (const file of ['dtkdump.wav', 'dspdump.wav']) {
        await fsPromises.unlink(path.join(dumpDir, file)).catch(() => {})
      }
    }

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
        // Single settle path: a spawn 'error' can fire WITHOUT a later 'exit',
        // which would otherwise leave this promise (and the whole playback
        // queue) hung forever. Both 'exit' and 'error' funnel through finish().
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          if (staleTimer) clearTimeout(staleTimer)
          if (this.activePlaybackProcess === dolphinProcess) {
            this.activePlaybackProcess = null
          }
          fsPromises.unlink(filePath).catch(() => {})
          fsPromises.rmdir(tmpDir).catch(() => {})
          this.activeTmpDirs.delete(tmpDir)
          resolve()
        }
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

        // Resolve on spawn error too, so a Dolphin that errors without exiting
        // can't wedge the playback queue.
        dolphinProcess.on('error', () => finish())
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
          finish()
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

    try {
      await this.playClipAsync(payload, (msg) => {
        this.mainWindow.webContents.send('videoMsg', msg)
      })
    } catch (error) {
      console.error('[playClip] error:', error)
    }

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
      startFrame: GAME_START_FRAME,
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

    // Clean up leftover audio dump files so Dolphin doesn't prompt the user
    const testDolphinDir = path.dirname(dolphinPath)
    for (const dumpDir of [
      path.join(testDolphinDir, 'User', 'Dump', 'Audio'),
      path.join(app.getPath('appData'), 'SlippiPlayback', 'Dump', 'Audio'),
    ]) {
      for (const file of ['dtkdump.wav', 'dspdump.wav']) {
        await fsPromises.unlink(path.join(dumpDir, file)).catch(() => {})
      }
    }

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
        fsPromises.writeFile(logFilePath, logContent).catch(() => {})

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
    return reply(event, 'detectDolphinPath', requestId, detectPlaybackDolphin())
  }

  async detectIsoPath(event: IpcMainEvent, data: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    return reply(event, 'detectIsoPath', requestId, detectMeleeIso())
  }

  async detectSlippiReplays(event: IpcMainEvent, data: RequestEnvelope<null>) {
    const { requestId } = unpackRequest<null>(data)
    return reply(
      event,
      'detectSlippiReplays',
      requestId,
      detectSlippiReplayDir(),
    )
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

    // On Windows, spawning `dolphin -h` opens a blocking GUI dialog.
    // Validate by checking the path instead.
    if (os.platform() === 'win32') {
      const lower = dolphinPath.toLowerCase().replace(/\\/g, '/')
      if (lower.includes('/playback/')) {
        return reply(event, 'validateDolphinPath', requestId, {
          valid: true,
          message: 'Slippi Dolphin Playback detected.',
        })
      }
      if (lower.includes('slippi') && !lower.includes('playback')) {
        return reply(event, 'validateDolphinPath', requestId, {
          valid: false,
          message:
            'This appears to be Slippi Dolphin Online/Netplay, not the Playback build. The Playback build is in a "playback" folder.',
        })
      }
      return reply(event, 'validateDolphinPath', requestId, {
        valid: false,
        message:
          'Could not confirm this is the Playback build. Make sure the path includes a "playback" folder.',
      })
    }

    // On Linux/macOS, spawn dolphin -h and check for playback-specific flags
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
            'This appears to be Slippi Dolphin Online/Netplay, not the Playback build. Lunar Clipper requires the Playback build.',
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
      this.videoStopRequested = true
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
