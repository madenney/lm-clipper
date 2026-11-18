/**
 * @jest-environment node
 *
 * A whole recording run (src/main/slpToVideo.ts default export) with Dolphin
 * replaced by a fake record(): scratch handling, the single encode, and the
 * run stopping itself with one message instead of failing clip after clip.
 */
const mockRecord = jest.fn()
const mockHeal = jest.fn()
jest.mock('electron', () => ({ app: {} }))
jest.mock('../main/util', () => ({
  getFFMPEGPath: () => 'ffmpeg',
  getAssetPath: (...p: string[]) => `/assets/${p.join('/')}`,
}))
jest.mock('../main/overlayRenderer', () => ({ renderOverlayPng: jest.fn() }))
jest.mock('../main/logger', () => ({
  logMain: jest.fn(),
  getLogPath: () => '/logs',
}))
jest.mock('@slippi/slippi-js', () => ({
  SlippiGame: jest.fn().mockImplementation(() => ({
    getMetadata: () => ({ lastFrame: 600 }),
    getLatestFrame: () => ({ frame: 600 }),
    getGameEnd: () => ({ gameEndMethod: 2 }),
  })),
}))
jest.mock('slippi-dolphin-runner', () => {
  const real = jest.requireActual('slippi-dolphin-runner')
  return {
    ...real,
    buildProfile: jest.fn().mockResolvedValue(undefined),
    realProfileExists: () => true,
    healRealProfile: (...a: unknown[]) => mockHeal(...a),
    record: (...a: unknown[]) => mockRecord(...a),
  }
})

/* eslint-disable import/first */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import slpToVideo, {
  GAME_ENDING_FRAMES,
  GAME_ENDING_TAIL_MS,
  resetHideNotice,
} from '../main/slpToVideo'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const describeFfmpeg = hasFfmpeg ? describe : describe.skip

let root: string
let scratchParent: string
let fixture: { avi: string; wav: string }

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'))
  // A Melee header (isoCheck.ts reads it); far smaller than a disc.
  fs.writeFileSync(path.join(root, 'melee.iso'), 'GALE01')
  fs.writeFileSync(path.join(root, 'dolphin'), 'bin')
  for (let i = 0; i < 4; i++)
    fs.writeFileSync(path.join(root, `${i}.slp`), 'slp')
  scratchParent = path.join(root, 'scratch')
  if (!hasFfmpeg) return
  // A dump as long as the clips below ask for: frames 40..600 = ~9.3 s.
  fixture = {
    avi: path.join(root, 'fixture.avi'),
    wav: path.join(root, 'fixture.wav'),
  }
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc=size=320x180:rate=60:duration=9.5',
    '-c:v', 'utvideo', fixture.avi,
  ]) // prettier-ignore
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=sample_rate=48000:duration=9.5', '-ac', '2', fixture.wav,
  ]) // prettier-ignore
})

beforeEach(() => {
  mockRecord.mockReset()
  mockHeal.mockReset().mockResolvedValue(undefined)
})

const replays = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    path: path.join(root, `${i % 4}.slp`),
    startFrame: 100,
    endFrame: 0,
  }))

const run = (over: Record<string, unknown> = {}) => {
  const outputPath = fs.mkdtempSync(path.join(root, 'out-'))
  const msgs: string[] = []
  const job = slpToVideo(
    replays((over.clips as number) ?? 2),
    {
      outputPath,
      ssbmIsoPath: path.join(root, 'melee.iso'),
      dolphinPath: path.join(root, 'dolphin'),
      resolution: 2,
      widescreen: true,
      bitrateKbps: 2000,
      videoPreset: 'ultrafast',
      convertToMp4: true,
      concatenate: false,
      outputFilenamePattern: '{index}',
      customGeckoCodes: [],
      texturePacks: [],
      numProcesses: 1,
      gameMusicOn: true,
      scratchPath: scratchParent,
      ...over,
    } as any,
    (m) => msgs.push(m),
  )
  return { job, msgs, outputPath }
}

const fakeDump = async (_p: unknown, _slp: string, o: any) => {
  const avi = path.join(o.outDir, `${o.baseName}.avi`)
  const wav = path.join(o.outDir, `${o.baseName}.wav`)
  fs.copyFileSync(fixture.avi, avi)
  fs.copyFileSync(fixture.wav, wav)
  return { avi, wav, lastFrame: 600, stalled: false, diagnostic: null }
}

const scratchLeft = () =>
  fs.existsSync(path.join(scratchParent, 'lm-clipper-scratch'))
    ? fs.readdirSync(path.join(scratchParent, 'lm-clipper-scratch'))
    : []

describeFfmpeg('with ffmpeg', () => {
  // Real ffmpeg encodes: slow when the whole suite runs at once.
  jest.setTimeout(30_000)

  it('records into scratch, moves only the final clip out, cleans scratch', async () => {
    mockRecord.mockImplementation(fakeDump)
    mockHeal.mockRejectedValue(
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    )
    const { job, outputPath } = run({ keepLosslessMaster: true })
    await job.promise
    const outputs = fs.readdirSync(outputPath).sort()
    expect(outputs).toEqual([
      '0001.master.avi',
      '0001.master.wav',
      '0001.mp4',
      '0002.master.avi',
      '0002.master.wav',
      '0002.mp4',
    ])
    // Dolphin wrote into the scratch folder, never the output folder.
    for (const call of mockRecord.mock.calls)
      expect(call[2].outDir.startsWith(scratchParent)).toBe(true)
    expect(scratchLeft()).toEqual([])
  })

  it('Include the GAME! ending: records past the last frame and cuts the clip after "GAME!"', async () => {
    // Dolphin runs on into "Waiting for game": a dump well past the ending.
    const longAvi = path.join(root, 'long.avi')
    const longWav = path.join(root, 'long.wav')
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc=size=320x180:rate=60:duration=15', '-c:v', 'utvideo', longAvi,
    ]) // prettier-ignore
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=sample_rate=48000:duration=15', '-ac', '2', longWav,
    ]) // prettier-ignore
    mockRecord.mockImplementation(async (_p: unknown, _slp: string, o: any) => {
      const avi = path.join(o.outDir, `${o.baseName}.avi`)
      const wav = path.join(o.outDir, `${o.baseName}.wav`)
      fs.copyFileSync(longAvi, avi)
      fs.copyFileSync(longWav, wav)
      return { avi, wav, lastFrame: 600, stalled: false, diagnostic: null }
    })
    const { job, outputPath } = run({ clips: 1, includeGameEnding: true })
    await job.promise
    const o = mockRecord.mock.calls[0][2]
    expect(o.ignoreGameEnd).toBe(true)
    expect(o.afterEndMs).toBe(GAME_ENDING_TAIL_MS)
    expect(o.lastFrame).toBe(600)
    expect(o.endFrame).toBeGreaterThan(600 + GAME_ENDING_FRAMES)
    // Frames 40 (the lead-in) to 600 + the ending, less the 1 s lead-in.
    const sec = Number(
      execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
        path.join(outputPath, '0001.mp4'),
      ]).toString(),
    ) // prettier-ignore
    expect(sec).toBeCloseTo((600 + GAME_ENDING_FRAMES - 40) / 60 - 1, 1)
  })

  it('without it: the clip stops at the last frame, as before', async () => {
    mockRecord.mockImplementation(fakeDump)
    const { job } = run({ clips: 1 })
    await job.promise
    const o = mockRecord.mock.calls[0][2]
    expect(o.ignoreGameEnd).toBeUndefined()
    expect(o.afterEndMs).toBeUndefined()
    expect(o.endFrame).toBe(599)
  })
})

it('stops after 3 no-frame attempts: "Dolphin isn\'t starting"', async () => {
  mockRecord.mockRejectedValue(
    Object.assign(new Error('Dolphin produced no video for x.slp'), {
      code: 'no-video',
      exitCode: 3,
      stderrTail: ['', 'Failed to init GPU'],
    }),
  )
  const { job, outputPath } = run({ clips: 10 })
  await expect(job.promise).rejects.toThrow(
    /Stopped: Dolphin isn't starting \(last error: Failed to init GPU, exit code 3\)/,
  )
  expect(mockRecord).toHaveBeenCalledTimes(3)
  expect(fs.readdirSync(outputPath)).toEqual(['failures.json'])
  expect(scratchLeft()).toEqual([])
})

it('stops the run on a full disk instead of retrying every clip', async () => {
  mockRecord.mockRejectedValue(
    Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
    }),
  )
  const { job } = run({ clips: 10 })
  await expect(job.promise).rejects.toThrow(/Stopped: disk full on /)
  expect(mockRecord).toHaveBeenCalledTimes(1)
})

describe('missing Dolphin or ISO', () => {
  it.each([
    ['Dolphin', { dolphinPath: '/nowhere/dolphin' }, /Could not open Dolphin/],
    ['ISO', { ssbmIsoPath: '/nowhere/melee.iso' }, /Could not read SSBM iso/],
  ])(
    '%s: one "Error: " prefix in the progress line',
    async (_n, over, what) => {
      const { job, msgs } = run(over)
      const err = await job.promise.then(
        () => null,
        (e: Error) => e,
      )
      expect(err?.message).toMatch(what)
      expect(err?.message).not.toMatch(/^Error:/)
      const shown = msgs.find((m) => what.test(m))
      expect(shown).toMatch(/^Error: Could not/)
      expect(shown).not.toMatch(/Error: Error:/)
      expect(mockRecord).not.toHaveBeenCalled()
    },
  )
})

describe('Hide Recording Windows', () => {
  const failingHidden = async (_p: unknown, _slp: string, o: any) => {
    o.onWarning?.({
      code: 'hide-session-unsupported',
      detail: 'no supported way to hide a window on wlroots/wayland',
    })
    throw Object.assign(new Error('Dolphin produced no video for x.slp'), {
      code: 'no-video',
    })
  }
  const runWithNotes = (over: Record<string, unknown> = {}) => {
    const notes: string[] = []
    const job = slpToVideo(
      replays(10),
      {
        outputPath: fs.mkdtempSync(path.join(root, 'out-')),
        ssbmIsoPath: path.join(root, 'melee.iso'),
        dolphinPath: path.join(root, 'dolphin'),
        resolution: 2,
        customGeckoCodes: [],
        texturePacks: [],
        numProcesses: 1,
        gameMusicOn: true,
        scratchPath: scratchParent,
        ...over,
      } as any,
      () => {},
      undefined,
      undefined,
      (n) => notes.push(n),
    )
    return { job, notes }
  }

  beforeEach(() => resetHideNotice())

  it('asks record() to hide, and notes a failure once per session, not per clip', async () => {
    mockRecord.mockImplementation(failingHidden)
    const first = runWithNotes()
    await expect(first.job.promise).rejects.toThrow(/Dolphin isn't starting/)
    expect(mockRecord).toHaveBeenCalledTimes(3)
    expect(mockRecord.mock.calls[0][2].hide).toBe(true)
    expect(first.notes).toHaveLength(1)
    expect(first.notes[0]).toMatch(
      /could not be hidden.*hide-session-unsupported/,
    )
    // The next run in the same session stays quiet.
    const second = runWithNotes()
    await expect(second.job.promise).rejects.toThrow(/Dolphin isn't starting/)
    expect(second.notes).toEqual([])
  })

  it('with the setting off: no hide asked for, no note', async () => {
    mockRecord.mockImplementation(failingHidden)
    const { job, notes } = runWithNotes({ hideRecordingWindows: false })
    await expect(job.promise).rejects.toThrow(/Dolphin isn't starting/)
    expect(mockRecord.mock.calls[0][2].hide).toBeUndefined()
    expect(notes).toEqual([])
  })
})
