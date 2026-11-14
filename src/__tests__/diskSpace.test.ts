/**
 * @jest-environment node
 *
 * The recorder's disk sizing, scratch folders and Windows-tolerant file moves
 * (src/main/diskSpace.ts).
 */
jest.mock('../main/logger', () => ({ logMain: jest.fn() }))

/* eslint-disable import/first */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  GiB,
  cleanupStaleTempDirs,
  dolphinTempRoot,
  isAsciiPath,
  clipFootageSec,
  driveLabel,
  dumpBytesPerMin,
  dumpCodecProblem,
  dumpCodecsAvailable,
  dumpPlanFor,
  estimateRecordingDiskBytes,
  isDiskFullError,
  isDiskFullText,
  moveFile,
  preflightRecordingDisk,
  retryFs,
  scratchDirFor,
  scratchRootFor,
  stripQuotes,
  withLastFrames,
} from '../main/diskSpace'

const GB = 1e9
const cfg = (over: Record<string, unknown> = {}): any => ({
  resolution: 4,
  widescreen: true,
  bitrateKbps: 50000,
  convertToMp4: true,
  concatenate: false,
  keepLosslessMaster: false,
  recordingFormat: 'auto',
  numProcesses: 1,
  ...over,
})
// A clip of exactly one minute of dumped footage (the 60-frame lead-in included).
const oneMinute = (index = 0): any => ({
  index,
  path: `/r/${index}.slp`,
  startFrame: 1000,
  endFrame: 1000 - 60 + 3600,
})

describe('dump rates', () => {
  it('uses the measured rates: utvideo 3.1 GB/min at 2x and 9.5 at 3x, ffv1 3.8 at 2x', () => {
    expect(dumpBytesPerMin(cfg({ resolution: 4 })) / GB).toBeCloseTo(3.1)
    expect(dumpBytesPerMin(cfg({ resolution: 6 })) / GB).toBeCloseTo(9.5)
    expect(
      dumpBytesPerMin(cfg({ resolution: 4, recordingFormat: 'lossless' })) / GB,
    ).toBeCloseTo(3.8)
  })

  it('scales by pixel count, and native FFV1 is small', () => {
    // 4x = (4/3)^2 of 3x.
    expect(dumpBytesPerMin(cfg({ resolution: 7 })) / GB).toBeCloseTo(
      9.5 * (16 / 9),
    )
    // native is FFV1 (utvideo needs an even width): a quarter of 2x.
    expect(dumpBytesPerMin(cfg({ resolution: 2 })) / GB).toBeCloseTo(0.95)
    const between = dumpBytesPerMin(cfg({ resolution: 5 })) / GB
    expect(between).toBeGreaterThan(3.1)
    expect(between).toBeLessThan(9.5)
  })

  it('sizes mpeg4 from its bitrate', () => {
    // 150 Mb/s for a minute.
    expect(dumpBytesPerMin(cfg({ recordingFormat: 'draft' }))).toBe(
      (150000 * 1000 * 60) / 8,
    )
  })
})

describe('dump codec per platform', () => {
  it('Linux keeps UT Video above native, FFV1 at native', () => {
    expect(dumpPlanFor(cfg({ resolution: 4 }), false).dumpCodec).toBe('utvideo')
    expect(dumpPlanFor(cfg({ resolution: 2 }), false).dumpCodec).toBe('ffv1')
  })

  it('REGRESSION: Windows never picks a codec its Dolphin lacks (UT Video wrote no clips at all)', () => {
    for (const resolution of [2, 3, 4, 5, 6, 7, 8])
      for (const recordingFormat of ['auto', 'lossless', 'draft']) {
        const plan = dumpPlanFor(cfg({ resolution, recordingFormat }), true)
        expect(dumpCodecsAvailable(true)).toContain(plan.dumpCodec)
      }
    expect(
      dumpPlanFor(cfg({ resolution: 4, recordingFormat: 'draft' }), true)
        .dumpCodec,
    ).toBe('mpeg4')
  })

  it('sizes Windows "Fast" as MPEG-4 at 150 Mb/s (1.125 GB/min), not FFV1', () => {
    for (const resolution of [4, 6])
      expect(dumpBytesPerMin(cfg({ resolution }), true) / GB).toBeCloseTo(1.125)
    expect(dumpBytesPerMin(cfg({ resolution: 2 }), true) / GB).toBeCloseTo(0.95)
  })

  it('Windows "Fast": MPEG-4 at 150 Mb/s above native, FFV1 at native', () => {
    for (const resolution of [3, 4, 5, 6, 7])
      expect(dumpPlanFor(cfg({ resolution }), true)).toEqual({
        dumpCodec: 'mpeg4',
        bitrateKbps: 150000,
      })
    expect(dumpPlanFor(cfg({ resolution: 2 }), true)).toEqual({
      dumpCodec: 'ffv1',
    })
    // Lossless stays lossless on every platform.
    expect(
      dumpPlanFor(cfg({ resolution: 4, recordingFormat: 'lossless' }), true),
    ).toEqual({ dumpCodec: 'ffv1' })
  })

  it('names the codec when it is unavailable', () => {
    expect(dumpCodecProblem('utvideo', true)).toMatch(
      /Windows cannot record with the utvideo codec \(it has ffv1 and mpeg4 only\)/,
    )
    expect(dumpCodecProblem('ffv1', true)).toBeNull()
    expect(dumpCodecProblem('utvideo', false)).toBeNull()
  })
})

describe('estimateRecordingDiskBytes', () => {
  it('needs scratch for the N longest clips at once, output for every final', () => {
    const replays = [oneMinute(1), oneMinute(2), oneMinute(3)]
    const one = estimateRecordingDiskBytes(replays, cfg({ numProcesses: 1 }))
    const two = estimateRecordingDiskBytes(replays, cfg({ numProcesses: 2 }))
    expect(two.scratchBytes).toBeCloseTo(one.scratchBytes * 2)
    // Scratch holds the dump (3.1 GB) + wav + the final, padded.
    expect(one.scratchBytes / GB).toBeGreaterThan(3.1)
    expect(one.scratchBytes / GB).toBeLessThan(5)
    // Output: three finals at 50 Mb/s (+ audio), padded.
    expect(one.outputBytes / GB).toBeCloseTo(
      (3 * 1.2 * ((50128 * 1000 * 60) / 8)) / GB,
    )
  })

  it('adds the concat copy and kept masters to the output', () => {
    const replays = [oneMinute(1), oneMinute(2)]
    const base = estimateRecordingDiskBytes(replays, cfg())
    const concat = estimateRecordingDiskBytes(
      replays,
      cfg({ concatenate: true }),
    )
    expect(concat.outputBytes).toBeCloseTo(base.outputBytes * 2)
    const master = estimateRecordingDiskBytes(
      replays,
      cfg({ keepLosslessMaster: true }),
    )
    expect((master.outputBytes - base.outputBytes) / GB).toBeGreaterThan(
      2 * 3.1,
    )
  })

  it('sizes whole-game clips from lastFrame, or assumes a long game', () => {
    const whole: any = { index: 0, path: 'x', startFrame: -123, endFrame: 0 }
    expect(clipFootageSec({ ...whole, lastFrame: 3600 })).toBeCloseTo(
      (3600 - 1 + 123) / 60,
    )
    expect(clipFootageSec(whole)).toBe(240)
  })
})

describe('preflightRecordingDisk', () => {
  const dirs = { scratch: '/scratch/run', output: '/out' }
  const io = (scratchFree: number, outputFree: number, same = false) => ({
    free: async (p: string) =>
      p.startsWith('/scratch') ? scratchFree : outputFree,
    device: async (p: string) => (same || p.startsWith('/out') ? 1 : 2),
  })
  const many = Array.from({ length: 4 }, (_, i) => oneMinute(i))

  it('passes when both drives have room', async () => {
    const r = await preflightRecordingDisk(
      many,
      cfg({ numProcesses: 2 }),
      dirs,
      io(100 * GiB, 100 * GiB),
    )
    expect(r.ok).toBe(true)
    expect(r.fallback).toBeUndefined()
  })

  it('falls back to Fast draft when lossless dumps do not fit in scratch', async () => {
    const r = await preflightRecordingDisk(
      many,
      cfg({ numProcesses: 4 }),
      dirs,
      io(10 * GiB, 100 * GiB),
    )
    expect(r.ok).toBe(true)
    expect(r.fallback).toEqual({ recordingFormat: 'draft' })
    expect(r.message).toMatch(/Fast draft/)
  })

  it('then fewer workers, and keeps lossless when a lossless master is wanted', async () => {
    const r = await preflightRecordingDisk(
      many,
      cfg({ numProcesses: 4, keepLosslessMaster: true }),
      dirs,
      io(6 * GiB, 100 * GiB),
    )
    expect(r.ok).toBe(true)
    expect(r.fallback).toEqual({ numProcesses: 1 })
    expect(r.message).toMatch(/1 at a time instead of 4/)
  })

  it('refuses with a clear message when nothing fits', async () => {
    const r = await preflightRecordingDisk(
      many,
      cfg({ numProcesses: 2 }),
      dirs,
      io(100 * GiB, 1.5 * GiB),
    )
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Not enough disk space/)
    expect(r.message).toMatch(/\/out/)
    expect(r.needBytes).toBeGreaterThan(r.freeBytes)
  })

  it('adds scratch and output together when they share a drive', async () => {
    const free = 7 * GiB
    const apart = await preflightRecordingDisk(
      [oneMinute(1)],
      cfg({ concatenate: false }),
      dirs,
      io(free, free),
    )
    const same = await preflightRecordingDisk(
      [oneMinute(1)],
      cfg({ concatenate: false }),
      dirs,
      io(free, free, true),
    )
    expect(same.needBytes).toBeGreaterThan(apart.needBytes)
  })

  it('skips the check when free space is unknown', async () => {
    const r = await preflightRecordingDisk(many, cfg(), dirs, {
      free: async () => null,
      device: async () => null,
    })
    expect(r.ok).toBe(true)
  })

  it('reads whole-game lengths from the replay footer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-'))
    const slp = path.join(dir, 'g.slp')
    const footer = Buffer.concat([
      Buffer.alloc(1000),
      Buffer.from('lastFramel'),
      Buffer.from([0, 0, 0x1c, 0x20]), // 7200
      Buffer.from('}'),
    ])
    fs.writeFileSync(slp, footer)
    const [r] = await withLastFrames([
      { index: 0, path: slp, startFrame: -123, endFrame: 0 } as any,
    ])
    expect(r.lastFrame).toBe(7200)
  })
})

describe("Dolphin's folders on Windows (no non-ASCII paths)", () => {
  const made: string[] = []
  const mkdir = (d: string) => {
    made.push(d)
  }
  it('keeps an ASCII temp folder, and any temp folder off Windows', () => {
    expect(
      dolphinTempRoot({ platform: 'win32', tmp: 'C:\\Users\\Jo\\Temp', mkdir }),
    ).toBe('C:\\Users\\Jo\\Temp')
    expect(
      dolphinTempRoot({ platform: 'linux', tmp: '/tmp/josé', mkdir }),
    ).toBe('/tmp/josé')
    expect(made).toEqual([])
  })

  it("moves a non-ASCII temp folder to the user's own folder under ProgramData", () => {
    const a = dolphinTempRoot({
      platform: 'win32',
      tmp: 'C:\\Users\\José\\AppData\\Local\\Temp',
      programData: 'C:\\ProgramData',
      user: 'José',
      mkdir,
    })
    const b = dolphinTempRoot({
      platform: 'win32',
      tmp: 'C:\\Users\\Дмитрий\\AppData\\Local\\Temp',
      programData: 'C:\\ProgramData',
      user: 'Дмитрий',
      mkdir,
    })
    expect(a).toMatch(/^C:\\ProgramData\\Lunar Clipper\\tmp-[0-9a-f]{10}$/)
    expect(isAsciiPath(a) && isAsciiPath(b)).toBe(true)
    expect(a).not.toBe(b)
    expect(made).toEqual([a, b])
  })

  it('stays in the temp folder when the other one cannot be made', () => {
    const tmp = 'C:\\Users\\José\\AppData\\Local\\Temp'
    expect(
      dolphinTempRoot({
        platform: 'win32',
        tmp,
        user: 'José',
        mkdir: () => {
          throw new Error('EPERM')
        },
      }),
    ).toBe(tmp)
  })
})

describe('scratch folder', () => {
  it('defaults under the temp folder, one per run', () => {
    const a = scratchDirFor({})
    const b = scratchDirFor({})
    expect(a.startsWith(path.join(os.tmpdir(), 'lm-clipper-scratch'))).toBe(
      true,
    )
    expect(a).not.toBe(b)
  })

  it('honours scratchPath, quotes stripped', () => {
    expect(scratchDirFor({ scratchPath: '"/fast/disk"' }, 'r1')).toBe(
      path.resolve('/fast/disk', 'lm-clipper-scratch', 'r1'),
    )
    expect(scratchRootFor({ scratchPath: '  ' })).toBe(
      path.join(os.tmpdir(), 'lm-clipper-scratch'),
    )
  })

  it('strips Copy-as-path quotes', () => {
    expect(stripQuotes('"C:\\ffmpeg\\ffmpeg.exe"')).toBe(
      'C:\\ffmpeg\\ffmpeg.exe',
    )
    expect(stripQuotes(" 'x' ")).toBe('x')
    expect(stripQuotes('plain')).toBe('plain')
  })
})

describe('messages', () => {
  it('names Windows drives by letter', () => {
    expect(driveLabel('D:\\Videos\\out', 'win32')).toBe('D:\\')
    expect(driveLabel('/home/me/out', 'linux')).toBe('/home/me/out')
  })

  it('recognises a full disk from Node and from ffmpeg', () => {
    expect(isDiskFullError({ code: 'ENOSPC' })).toBe(true)
    expect(isDiskFullError(new Error('boom'))).toBe(false)
    expect(
      isDiskFullText('av_interleaved_write_frame(): No space left on device'),
    ).toBe(true)
    expect(isDiskFullText('There is not enough space on the disk.')).toBe(true)
  })
})

describe('file operations', () => {
  it('retries a locked file (EBUSY) with backoff', async () => {
    let calls = 0
    const r = await retryFs(
      async () => {
        calls += 1
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        return 'done'
      },
      'test',
      6,
      1,
    )
    expect(r).toBe('done')
    expect(calls).toBe(3)
  })

  it('does not retry other errors', async () => {
    let calls = 0
    await expect(
      retryFs(
        async () => {
          calls += 1
          throw Object.assign(new Error('nope'), { code: 'ENOENT' })
        },
        'test',
        6,
        1,
      ),
    ).rejects.toThrow('nope')
    expect(calls).toBe(1)
  })

  it('moves across drives (EXDEV) by copy then delete', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'))
    const src = path.join(dir, 'a.mp4')
    const dst = path.join(dir, 'b.mp4')
    fs.writeFileSync(src, 'video')
    const real = fs.promises.rename
    const spy = jest
      .spyOn(fs.promises, 'rename')
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      })
      .mockImplementation(real)
    try {
      await moveFile(src, dst)
    } finally {
      spy.mockRestore()
    }
    expect(fs.readFileSync(dst, 'utf8')).toBe('video')
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.existsSync(`${dst}.partial`)).toBe(false)
  })
})

describe('cleanupStaleTempDirs', () => {
  it('removes old recorder temp folders, keeps new ones and what is not ours', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'))
    const mk = (rel: string, ageMs: number) => {
      const p = path.join(tmp, rel)
      fs.mkdirSync(p, { recursive: true })
      const t = (Date.now() - ageMs) / 1000
      fs.utimesSync(p, t, t)
      return p
    }
    const hour = 60 * 60 * 1000
    const oldProfile = mk('lmclip-dolphin-abc', 2 * hour)
    const oldPreview = mk('lm-clipper-xyz', 2 * hour)
    const oldTest = mk('lm-clipper-test-1', 2 * hour)
    const freshProfile = mk('lmclip-dolphin-new', 60 * 1000)
    const workflow = mk('lm-clipper-workflow-123', 2 * hour)
    const oldRun = mk('lm-clipper-scratch/run-old', 2 * hour)
    const newRun = mk('lm-clipper-scratch/run-new', 60 * 1000)
    fs.utimesSync(
      path.join(tmp, 'lm-clipper-scratch'),
      (Date.now() - 2 * hour) / 1000,
      (Date.now() - 2 * hour) / 1000,
    )
    const other = mk('something-else', 2 * hour)

    const removed = await cleanupStaleTempDirs({ tmpDir: tmp })
    expect(removed).toBe(4)
    for (const gone of [oldProfile, oldPreview, oldTest, oldRun])
      expect(fs.existsSync(gone)).toBe(false)
    for (const kept of [freshProfile, workflow, newRun, other])
      expect(fs.existsSync(kept)).toBe(true)
  })
})
