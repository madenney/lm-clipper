/**
 * @jest-environment node
 *
 * The clip recorder's pieces that don't need Dolphin (src/main/slpToVideo.ts):
 * file naming, the single ffmpeg pass, timeouts, concat inputs, profiles.
 * The ffmpeg tests run the real encode on generated footage when ffmpeg is
 * installed (skipped otherwise).
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
  buildFinalEncodeArgs,
  buildProfileWithFallback,
  concatLine,
  encodeThreadsFor,
  GAME_ENDING_FRAMES,
  GAME_ENDING_REACH_FRAMES,
  gameEndingFor,
  getEffectiveFFMPEGPath,
  listConcatInputs,
  playbackProfileOptions,
  recordHardTimeoutMs,
  recordProfileOptions,
  resolveFilenamePattern,
  setFFMPEGPathOverride,
} from '../main/slpToVideo'

const replay: any = {
  index: 7,
  path: '/r/game.slp',
  startFrame: 100,
  endFrame: 400,
  meta: { character1: 'Fox', character2: 'Falco', stage: 'FD' },
}
const config = (over: Record<string, unknown> = {}): any => ({
  dolphinPath: '/opt/Slippi_Playback.AppImage',
  resolution: 4,
  bitrateKbps: 15000,
  widescreen: true,
  convertToMp4: true,
  customGeckoCodes: [],
  texturePacks: [],
  ...over,
})

describe('resolveFilenamePattern', () => {
  it('keeps pattern folders and tokens', () => {
    expect(resolveFilenamePattern('{stage}/{index}', replay)).toBe('FD/0007')
  })

  it('makes Windows reserved names and trailing dots/spaces safe', () => {
    expect(resolveFilenamePattern('CON', replay)).toBe('_CON')
    expect(resolveFilenamePattern('nul.txt', replay)).toBe('_nul.txt')
    expect(resolveFilenamePattern('com1/LPT9', replay)).toBe('_com1/_LPT9')
    expect(resolveFilenamePattern('Fox vs. ', replay)).toBe('Fox vs')
    expect(resolveFilenamePattern('console', replay)).toBe('console')
  })

  it('cannot climb out of the output folder', () => {
    expect(resolveFilenamePattern('../../{index}', replay)).toBe('_/_/0007')
    expect(resolveFilenamePattern('a\\{index}', replay)).toBe('a/0007')
  })
})

describe("the game's ending (Include the GAME! Ending)", () => {
  const on = { includeGameEnding: true }
  it('is off by default, and needs the game length', () => {
    expect(gameEndingFor({}, 0, 6805, 2)).toBeNull()
    expect(gameEndingFor({ includeGameEnding: false }, 0, 6805, 2)).toBeNull()
    expect(gameEndingFor(on, 0, undefined, 2)).toBeNull()
  })
  it('runs a clip that reaches the end of the game on through the ending', () => {
    const e = gameEndingFor(on, 0, 6805, 2)!
    expect(e.clipEndFrame).toBe(6805 + GAME_ENDING_FRAMES)
    expect(e.recordEndFrame).toBeGreaterThan(e.clipEndFrame)
    expect(e.afterEndMs).toBeGreaterThan(0)
    expect(e.afterEndMs).toBeLessThan(30_000) // the runner's frame-stall window
    expect(
      gameEndingFor(on, 6805 - GAME_ENDING_REACH_FRAMES, 6805, 2),
    ).not.toBeNull()
  })
  it('only for a game that ended on stocks or time: a quit-out has no "GAME!"', () => {
    expect(gameEndingFor(on, 0, 6805, 1)).not.toBeNull()
    expect(gameEndingFor(on, 0, 6805, 3)).not.toBeNull()
    expect(gameEndingFor(on, 0, 6805, 7)).toBeNull()
    expect(gameEndingFor(on, 0, 6805, null)).toBeNull()
    expect(gameEndingFor(on, 0, 6805, undefined)).toBeNull()
  })
  it('leaves a clip that ends earlier in the game alone', () => {
    expect(
      gameEndingFor(on, 6805 - GAME_ENDING_REACH_FRAMES - 1, 6805, 2),
    ).toBeNull()
    expect(gameEndingFor(on, 1200, 6805, 2)).toBeNull()
  })
})

describe('final encode arguments', () => {
  const base = {
    config: config(),
    avi: '/s/clip-unmerged.avi',
    wav: '/s/clip-unmerged.wav',
    overlayPng: null,
    output: '/s/final.mp4',
    threads: 4,
  }

  it('cuts to durationSec only when given (the game ending runs into "Waiting for game")', () => {
    expect(buildFinalEncodeArgs(base)).not.toContain('-t')
    const a = buildFinalEncodeArgs({ ...base, durationSec: 4.5 })
    expect(a.slice(-3)).toEqual(['-t', '4.500', '/s/final.mp4'])
  })

  it('is one pass: dump + wav in, 1 s lead-in trimmed on both, AAC out', () => {
    const a = buildFinalEncodeArgs(base)
    expect(a.join(' ')).toContain('-ss 1 -i /s/clip-unmerged.avi')
    expect(a.join(' ')).toContain('-ss 1 -i /s/clip-unmerged.wav')
    expect(a.join(' ')).toContain('-map 0:v -vf scale=1920:1080')
    expect(a.join(' ')).toContain('-map 1:a')
    expect(a.join(' ')).toContain('-c:v libx264')
    expect(a.join(' ')).toContain('-b:v 15000k')
    expect(a.join(' ')).toContain('-threads 4')
    expect(a.join(' ')).toContain('-c:a aac')
    expect(a[a.length - 1]).toBe('/s/final.mp4')
  })

  it('converts to tagged BT.709 limited-range 4:2:0 (true blacks on every player)', () => {
    const plain = buildFinalEncodeArgs(base).join(' ')
    const overlaid = buildFinalEncodeArgs({
      ...base,
      overlayPng: '/s/o.png',
    }).join(' ')
    for (const a of [plain, overlaid]) {
      expect(a).toContain(
        'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      )
      expect(a).toContain(
        '-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv',
      )
    }
  })

  it('encodes a silent track when there is no WAV', () => {
    const a = buildFinalEncodeArgs({ ...base, wav: null }).join(' ')
    expect(a).toContain('-f lavfi -i anullsrc')
    expect(a).toContain('-shortest')
  })

  it('composites the overlay as input 2, and keeps PCM for AVI output', () => {
    const a = buildFinalEncodeArgs({
      ...base,
      config: config({
        convertToMp4: false,
        videoQualityMode: 'crf',
        crf: 20,
        videoCodec: 'h265',
      }),
      overlayPng: '/s/overlay.png',
      output: '/s/final.avi',
    }).join(' ')
    expect(a).toContain('-i /s/overlay.png')
    expect(a).toContain('[b][2:v]scale2ref')
    expect(a).toContain('-map [outv]')
    expect(a).toContain('-c:v libx265')
    expect(a).toContain('-tag:v hvc1')
    expect(a).toContain('-crf 20')
    expect(a).toContain('-c:a pcm_s16le')
  })

  it('keeps native dims (even) away from 2x widescreen', () => {
    const a = buildFinalEncodeArgs({
      ...base,
      config: config({ resolution: 6 }),
    }).join(' ')
    expect(a).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  })
})

describe('timeouts and threads', () => {
  it('gives FFV1 at 2x+ far longer than other codecs', () => {
    const frames = 60 * 60 // one minute
    expect(
      recordHardTimeoutMs(config({ recordingFormat: 'lossless' }), frames),
    ).toBe(180_000 + 2000_000)
    expect(recordHardTimeoutMs(config(), frames)).toBe(180_000 + 600_000)
    // native FFV1 is fast enough for the general floor.
    expect(recordHardTimeoutMs(config({ resolution: 2 }), frames)).toBe(780_000)
  })

  it('shares the CPUs between the parallel encodes', () => {
    expect(encodeThreadsFor(4, 16)).toBe(4)
    expect(encodeThreadsFor(3, 8)).toBe(2)
    expect(encodeThreadsFor(16, 4)).toBe(1)
  })
})

describe('concat inputs', () => {
  it('lists finished clips in name order, in pattern subfolders too, nothing else', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-'))
    const touch = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true })
      fs.writeFileSync(path.join(out, rel), 'x')
    }
    ;[
      '0002.mp4',
      '0001.mp4',
      'FD/0003.mp4',
      '0001.master.avi',
      '0001.master.wav',
      '0004-unmerged.avi',
      '0004-merged.avi',
      '0004-lossless.avi',
      '0004-final.avi',
      '0005.mp4.partial',
      'final.mp4',
      'failures.json',
    ].forEach(touch)
    const files = await listConcatInputs(out, '.mp4')
    expect(files.map((f) => path.relative(out, f))).toEqual([
      '0001.mp4',
      '0002.mp4',
      path.join('FD', '0003.mp4'),
    ])
    // AVI output: masters are .avi too, and must stay out.
    const avis = await listConcatInputs(out, '.avi')
    expect(avis).toEqual([])
  })

  it('escapes apostrophes in the concat list', () => {
    expect(concatLine("/out/Mang0's combo.mp4")).toBe(
      "file '/out/Mang0'\\''s combo.mp4'",
    )
  })
})

describe('ffmpeg path override', () => {
  it('strips the quotes Windows "Copy as path" adds', () => {
    setFFMPEGPathOverride('"C:\\Tools\\ffmpeg.exe"')
    expect(getEffectiveFFMPEGPath()).toBe('C:\\Tools\\ffmpeg.exe')
    setFFMPEGPathOverride('')
    expect(getEffectiveFFMPEGPath()).toBe('ffmpeg')
  })
})

describe('profiles', () => {
  it('records with synchronous shader compilation', () => {
    expect(recordProfileOptions(config(), 0).shaderCompilationMode).toBe(0)
  })

  it('previews at real speed with vsync and their own shader cache', () => {
    const o = playbackProfileOptions(config())
    expect(o.emulationSpeed).toBe(1)
    expect(o.vsync).toBe(true)
    expect(o.shaderCacheDir).toMatch(/shader-cache[\\/]preview$/)
  })

  it('builds a fresh profile when the user has no Slippi Playback profile', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'noprof-'))
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = xdg // no SlippiPlayback in it
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'))
      await buildProfileWithFallback(dir, recordProfileOptions(config(), 0))
      const gfx = fs.readFileSync(path.join(dir, 'Config', 'GFX.ini'), 'utf8')
      expect(gfx).toMatch(/DumpCodec = utvideo/)
      expect(gfx).toMatch(/ShaderCompilationMode = 0/)
    } finally {
      process.env.XDG_CONFIG_HOME = prev
    }
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const describeFfmpeg = hasFfmpeg ? describe : describe.skip

describeFfmpeg('the single encode pass on real footage', () => {
  let dir: string
  const durationOf = (file: string) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file], {
      encoding: 'utf8',
    })
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr)
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
  }
  const hasAudio = (file: string) =>
    /Audio:/.test(
      spawnSync('ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8' })
        .stderr,
    )

  beforeAll(() => {
    if (!hasFfmpeg) return
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-'))
    // 3 s of a Dolphin-like dump: UT Video AVI + a separate PCM WAV.
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=60:duration=3',
      '-c:v',
      'utvideo',
      path.join(dir, 'clip-unmerged.avi'),
    ])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-ac',
      '2',
      path.join(dir, 'clip-unmerged.wav'),
    ])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red@0.5:size=320x180,format=rgba',
      '-frames:v',
      '1',
      path.join(dir, 'overlay.png'),
    ])
  })

  const encode = (over: Record<string, unknown>) => {
    const output = path.join(dir, `out-${Math.random()}.mp4`)
    const args = buildFinalEncodeArgs({
      config: config({ resolution: 6, videoPreset: 'ultrafast' }),
      avi: path.join(dir, 'clip-unmerged.avi'),
      wav: path.join(dir, 'clip-unmerged.wav'),
      overlayPng: null,
      output,
      threads: 2,
      ...over,
    } as any)
    execFileSync('ffmpeg', ['-loglevel', 'error', ...args])
    return output
  }

  it('drops the 1 s lead-in and keeps the audio', () => {
    const out = encode({})
    expect(durationOf(out)).toBeGreaterThan(1.9)
    expect(durationOf(out)).toBeLessThan(2.15)
    expect(hasAudio(out)).toBe(true)
  })

  it('still makes the clip, with silent audio, when the WAV is missing', () => {
    const out = encode({ wav: null })
    expect(durationOf(out)).toBeGreaterThan(1.9)
    expect(durationOf(out)).toBeLessThan(2.15)
    expect(hasAudio(out)).toBe(true)
  })

  it('stops at durationSec', () => {
    const out = encode({ durationSec: 1.2 })
    expect(durationOf(out)).toBeGreaterThan(1.1)
    expect(durationOf(out)).toBeLessThan(1.35)
  })

  it('composites the overlay in the same pass', () => {
    const out = encode({ overlayPng: path.join(dir, 'overlay.png') })
    expect(durationOf(out)).toBeGreaterThan(1.9)
  })
})
