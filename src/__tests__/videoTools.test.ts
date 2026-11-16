/**
 * Video Tools, main-process half: which files it lists, which it accepts from
 * the window, where a result goes, the ffmpeg arguments, and the real job on
 * generated footage (when ffmpeg is installed; skipped otherwise): combine,
 * compress one video, cancel.
 */
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

/* eslint-disable import/first */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import {
  COMPRESS_AUDIO_KBPS,
  compressedBytes,
  freeVideoPath,
  partialPathFor,
  planVideoJob,
  resolveVideoFiles,
  scanVideoFolders,
  videoJobArgs,
  videoKind,
} from '../main/videoTools'
import {
  concatClips,
  listConcatInputs,
  probeFilesInfo,
} from '../main/slpToVideo'
import { AUDIO_KBPS, estimateBytes } from '../renderer/lib/videoTools'

const touch = (file: string, bytes = 10) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(bytes, 1))
}

describe('which files are videos', () => {
  it('tells clips from finished results and hides work files', () => {
    expect(videoKind('0001_Fox_vs_Falco.mp4')).toBe('clip')
    expect(videoKind('clip.AVI')).toBe('clip')
    expect(videoKind('final.mp4')).toBe('finished')
    expect(videoKind('final_2.mp4')).toBe('finished')
    expect(videoKind('stitched.avi')).toBe('finished')
    expect(videoKind('0001-compressed.mp4')).toBe('finished')
    expect(videoKind('final-compressed_3.mp4')).toBe('finished')
    // A player called Finalizer is still a clip.
    expect(videoKind('finalizer_vs_fox.mp4')).toBe('clip')
    for (const hidden of [
      'clip-unmerged.avi',
      'clip-merged.avi',
      'clip.master.avi',
      'final.partial.mp4',
      'clip.mp4.partial',
      'notes.txt',
      'manifest.json',
      'audio.wav',
    ])
      expect(videoKind(hidden)).toBeNull()
  })
})

describe('listing the output folder', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-scan-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('lists every folder with a video: one clip, nested, and the root', async () => {
    touch(path.join(root, 'output_2', 'b.mp4'), 20)
    touch(path.join(root, 'output_2', 'a.mp4'), 30)
    touch(path.join(root, 'output_2', 'final.mp4'), 50)
    touch(path.join(root, 'output_2', 'final.partial.mp4'))
    touch(path.join(root, 'output_2', 'manifest.json'))
    touch(path.join(root, 'output_1', 'only.mp4'))
    touch(path.join(root, 'output_3', 'FD', '0001.mp4'))
    touch(path.join(root, 'empty', 'readme.txt'))
    touch(path.join(root, '.hidden', 'x.mp4'))
    touch(path.join(root, 'stitched.mp4'), 70)

    const folders = await scanVideoFolders(root)
    const by = Object.fromEntries(folders.map((f) => [f.name, f]))
    expect(Object.keys(by).sort()).toEqual([
      '',
      'output_1',
      'output_2',
      'output_3/FD',
    ])
    expect(by['']).toMatchObject({
      isRoot: true,
      clips: [],
      finished: ['stitched.mp4'],
    })
    expect(by.output_2).toMatchObject({
      isRoot: false,
      path: path.join(root, 'output_2'),
      clips: ['a.mp4', 'b.mp4'],
      finished: ['final.mp4'],
      sizes: { 'a.mp4': 30, 'b.mp4': 20, 'final.mp4': 50 },
    })
    expect(by.output_1.clips).toEqual(['only.mp4'])
    expect(by['output_3/FD'].path).toBe(path.join(root, 'output_3', 'FD'))
  })

  it('lists a clip once when it left both an .avi and an .mp4', async () => {
    touch(path.join(root, 'run', 'a.avi'))
    touch(path.join(root, 'run', 'a.mp4'))
    touch(path.join(root, 'old', 'a.avi'))
    touch(path.join(root, 'old', 'b.avi'))
    const folders = await scanVideoFolders(root)
    expect(folders.find((f) => f.name === 'run')?.clips).toEqual(['a.mp4'])
    expect(folders.find((f) => f.name === 'old')?.clips).toEqual([
      'a.avi',
      'b.avi',
    ])
  })

  it('answers with nothing for a missing folder', async () => {
    expect(await scanVideoFolders(path.join(root, 'nope'))).toEqual([])
    expect(await scanVideoFolders('')).toEqual([])
  })

  it('a result being written is not joined by a recording either', async () => {
    touch(path.join(root, 'a.mp4'))
    touch(path.join(root, 'b.mp4'))
    touch(path.join(root, 'stitched.partial.mp4'))
    const inputs = await listConcatInputs(root, '.mp4')
    expect(inputs.map((f) => path.basename(f))).toEqual(['a.mp4', 'b.mp4'])
  })
})

describe('what the window may send', () => {
  const root = path.resolve('/videos/out')
  const item = (folder: string, name: string) => ({ folder, name })

  it('keeps video files inside the output root, in order, once each', () => {
    const { files, folders } = resolveVideoFiles(root, [
      item(path.join(root, 'output_1'), 'b.mp4'),
      item(path.join(root, 'output_1'), 'a.mp4'),
      item(path.join(root, 'output_1'), 'b.mp4'),
      item(root, 'stitched.mp4'),
    ])
    expect(files).toEqual([
      path.join(root, 'output_1', 'b.mp4'),
      path.join(root, 'output_1', 'a.mp4'),
      path.join(root, 'stitched.mp4'),
    ])
    expect([...folders]).toEqual([path.join(root, 'output_1'), root])
  })

  it('drops anything outside the root or that is not a video', () => {
    const { files } = resolveVideoFiles(root, [
      item('/etc', 'passwd'),
      item('/videos/outside', 'a.mp4'),
      item(`${root}-other`, 'a.mp4'),
      item(path.join(root, 'output_1'), '../../../etc/shadow.mp4'),
      item(path.join(root, 'output_1'), 'config.json'),
      item(path.join(root, 'output_1'), 'x.partial.mp4'),
      item(path.dirname(root), path.basename(root)),
      null as any,
      { folder: 5, name: 'a.mp4' } as any,
    ])
    // `../../../etc/shadow.mp4` is reduced to its file name inside the folder.
    expect(files).toEqual([path.join(root, 'output_1', 'shadow.mp4')])
  })
})

describe('where a result goes', () => {
  const root = path.resolve('/videos/out')
  const run = path.join(root, 'output_4')
  const f = (...names: string[]) => names.map((n) => path.join(run, n))

  it('several clips of one folder: final in that folder', () => {
    expect(
      planVideoJob(root, f('a.mp4', 'b.mp4'), new Set([run]), false),
    ).toEqual({
      ok: true,
      mode: 'combine',
      outDir: run,
      baseName: 'final',
      ext: '.mp4',
    })
  })

  it('several folders, or the output folder itself: stitched in the root', () => {
    const other = path.join(root, 'output_5', 'c.mp4')
    expect(
      planVideoJob(
        root,
        [...f('a.mp4'), other],
        new Set([run, path.dirname(other)]),
        false,
      ),
    ).toMatchObject({ outDir: root, baseName: 'stitched' })
    expect(
      planVideoJob(
        root,
        [path.join(root, 'x.mp4'), path.join(root, 'y.mp4')],
        new Set([root]),
        false,
      ),
    ).toMatchObject({ outDir: root, baseName: 'stitched' })
  })

  it('one video: compressed beside it, never a plain copy', () => {
    expect(planVideoJob(root, f('final.avi'), new Set([run]), true)).toEqual({
      ok: true,
      mode: 'compress',
      outDir: run,
      baseName: 'final-compressed',
      ext: '.mp4',
    })
    const plain = planVideoJob(root, f('final.mp4'), new Set([run]), false)
    expect(plain.ok).toBe(false)
  })

  it("a compressed result is .mp4; a copy keeps the clips' format", () => {
    expect(
      planVideoJob(root, f('a.avi', 'b.avi'), new Set([run]), false),
    ).toMatchObject({ ext: '.avi', mode: 'combine' })
    expect(
      planVideoJob(root, f('a.avi', 'b.avi'), new Set([run]), true),
    ).toMatchObject({ ext: '.mp4', mode: 'combine-compress' })
  })

  it('refuses nothing selected and mixed formats', () => {
    expect(planVideoJob(root, [], new Set(), true).ok).toBe(false)
    const mixed = planVideoJob(root, f('a.avi', 'b.mp4'), new Set([run]), true)
    expect(mixed).toMatchObject({ ok: false })
    expect((mixed as { error: string }).error).toMatch(/different formats/)
  })

  it('never takes a name in use, by a video or by one being written', () => {
    const taken = new Set([
      path.join(run, 'final.mp4'),
      path.join(run, 'final_2.partial.mp4'),
    ])
    expect(freeVideoPath(run, 'final', '.mp4', (p) => taken.has(p))).toBe(
      path.join(run, 'final_3.mp4'),
    )
    expect(freeVideoPath(run, 'final', '.mp4', () => false)).toBe(
      path.join(run, 'final.mp4'),
    )
  })

  it('writes under a name that keeps the extension last', () => {
    expect(partialPathFor(path.join(run, 'final.mp4'))).toBe(
      path.join(run, 'final.partial.mp4'),
    )
    expect(videoKind(path.basename(partialPathFor('/x/a.b.avi')))).toBeNull()
  })
})

describe('ffmpeg arguments', () => {
  const base = { sourceIsMp4: true, bitrateKbps: 15000 }

  it('Original quality is a stream copy', () => {
    const a = videoJobArgs('/t/list.txt', '/o/final.partial.mp4', {
      ...base,
      compress: false,
    }).join(' ')
    expect(a).toContain('-f concat -safe 0 -i /t/list.txt')
    expect(a).toContain('-c:v copy -c:a copy')
    expect(a).not.toContain('libx264')
    expect(a.endsWith('-y /o/final.partial.mp4')).toBe(true)
  })

  it('.avi clips get AAC audio when copied', () => {
    const a = videoJobArgs('/t/l.txt', '/o/final.partial.avi', {
      ...base,
      sourceIsMp4: false,
      compress: false,
    }).join(' ')
    expect(a).toContain('-c:v copy')
    expect(a).toContain('-c:a aac')
  })

  it('compressing re-encodes at the asked bitrate, ready to stream', () => {
    const a = videoJobArgs('/t/l.txt', '/o/x.partial.mp4', {
      ...base,
      compress: true,
      videoKbps: 2000,
    }).join(' ')
    expect(a).toContain('-c:v libx264 -b:v 2000k')
    expect(a).toContain(`-b:a ${COMPRESS_AUDIO_KBPS}k`)
    expect(a).toContain('-movflags +faststart')
    expect(a).not.toContain('-c:v copy')
  })

  it('the window estimates the size the job is checked against', () => {
    expect(AUDIO_KBPS).toBe(COMPRESS_AUDIO_KBPS)
    expect(estimateBytes(4000, 123, 90)).toBe(compressedBytes(4000, 90))
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const describeFfmpeg = hasFfmpeg ? describe : describe.skip

describeFfmpeg('the job on real footage', () => {
  let root: string
  let run: string
  const opts = { convertToMp4: true, bitrateKbps: 15000 }
  const durationOf = (file: string) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file], {
      encoding: 'utf8',
    })
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr)
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
  }
  const makeClip = (file: string, seconds: number, noisy = false) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      noisy
        ? `testsrc2=size=640x360:rate=60:duration=${seconds},noise=alls=40:allf=t`
        : `testsrc2=size=320x180:rate=60:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-b:v',
      noisy ? '12000k' : '1500k',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-y',
      file,
    ])
  }
  const names = (dir: string) => fs.readdirSync(dir).sort()

  beforeAll(() => {
    if (!hasFfmpeg) return
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-job-'))
    run = path.join(root, 'output_1')
    makeClip(path.join(run, 'a.mp4'), 2)
    makeClip(path.join(run, 'b.mp4'), 3)
  })
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it('reads the real running time of a selection', async () => {
    const info = await probeFilesInfo([
      path.join(run, 'a.mp4'),
      path.join(run, 'b.mp4'),
    ])
    expect(info.seconds).toBeGreaterThan(4.8)
    expect(info.seconds).toBeLessThan(5.3)
    expect(info.bitrateKbps).toBeGreaterThan(0)
    expect(await probeFilesInfo([])).toEqual({ seconds: 0, bitrateKbps: 0 })
  })

  it('combines clips in the given order and leaves only the result', async () => {
    const output = path.join(run, 'final.mp4')
    const seen: number[] = []
    const res = await concatClips(
      [path.join(run, 'b.mp4'), path.join(run, 'a.mp4')],
      output,
      opts,
      (p) => seen.push(p),
    )
    expect(res).toEqual({ ok: true })
    expect(durationOf(output)).toBeGreaterThan(4.8)
    expect(durationOf(output)).toBeLessThan(5.3)
    expect(seen[0]).toBe(0)
    expect(seen[seen.length - 1]).toBe(100)
    expect(names(run)).toEqual(['a.mp4', 'b.mp4', 'final.mp4'])
  }, 60000)

  it('compresses one video on its own', async () => {
    const big = path.join(root, 'big', 'final.mp4')
    makeClip(big, 3, true)
    const output = path.join(root, 'big', 'final-compressed.mp4')
    const res = await concatClips([big], output, {
      ...opts,
      compress: true,
      videoKbps: 1000,
    })
    expect(res).toEqual({ ok: true })
    expect(durationOf(output)).toBeGreaterThan(2.8)
    expect(fs.statSync(output).size).toBeLessThan(fs.statSync(big).size / 3)
    expect(names(path.dirname(big))).toEqual([
      'final-compressed.mp4',
      'final.mp4',
    ])
  }, 60000)

  it('one video is not copied, and nothing is not a job', async () => {
    const a = path.join(run, 'a.mp4')
    expect((await concatClips([a], path.join(run, 'x.mp4'), opts)).ok).toBe(
      false,
    )
    expect((await concatClips([], path.join(run, 'x.mp4'), opts)).ok).toBe(
      false,
    )
    expect(fs.existsSync(path.join(run, 'x.mp4'))).toBe(false)
  })

  it('a cancelled job leaves nothing behind', async () => {
    const dir = path.join(root, 'long')
    makeClip(path.join(dir, 'long.mp4'), 40, true)
    const job = new AbortController()
    const output = path.join(dir, 'long-compressed.mp4')
    const done = concatClips(
      [path.join(dir, 'long.mp4')],
      output,
      { ...opts, compress: true, videoKbps: 8000, signal: job.signal },
      (p) => {
        if (p > 0) job.abort()
      },
    )
    // In case the first progress line never comes on a very fast machine.
    const fallback = setTimeout(() => job.abort(), 1500)
    const res = await done
    clearTimeout(fallback)
    expect(res).toEqual({ ok: false, cancelled: true })
    expect(names(dir)).toEqual(['long.mp4'])
  }, 90000)

  it('a failed job says so and leaves nothing behind', async () => {
    const dir = path.join(root, 'broken')
    touch(path.join(dir, 'a.mp4'), 2000)
    touch(path.join(dir, 'b.mp4'), 2000)
    const res = await concatClips(
      [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')],
      path.join(dir, 'final.mp4'),
      opts,
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not make the video/)
    expect(names(dir)).toEqual(['a.mp4', 'b.mp4'])
  }, 30000)
})
