/**
 * @jest-environment node
 *
 * Windows configuration from the launch review (DL-4, WIN-4, WIN-9, WIN-10,
 * WIN-11, WIN-12, WIN-13, WIN-14, WIN-15): where data lives by default, which
 * folders get a warning, the power-save hold, long replay paths, the hidden-window
 * fallback and the recording file names.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

jest.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '3.0.0' },
  powerSaveBlocker: {
    start: jest.fn(() => 7),
    stop: jest.fn(),
  },
}))

jest.mock('../main/util', () => ({
  getFFMPEGPath: () => 'ffmpeg',
  getAssetPath: (...p: string[]) => `/assets/${p.join('/')}`,
}))
jest.mock('../main/overlayRenderer', () => ({ renderOverlayPng: jest.fn() }))

// eslint-disable-next-line import/first
import { powerSaveBlocker } from 'electron'
// eslint-disable-next-line import/first
import {
  chooseDataRoot,
  cloudSyncProvider,
  isNetworkPath,
  slippiReplayFallbacks,
  storageConcern,
} from '../main/dataLocations'
// eslint-disable-next-line import/first
import { awakeHolds, holdAwake } from '../main/powerSave'
// eslint-disable-next-line import/first
import {
  WINDOWS_LONG_PATH,
  configureSlpCache,
  playableSlp,
} from '../main/slpCache'
// eslint-disable-next-line import/first
import {
  dumpFlagsAreOn,
  hideLauncherFailed,
  recordHideFor,
  resetHideFallback,
  resolveFilenamePattern,
} from '../main/slpToVideo'

describe('cloud-synced and network folders', () => {
  const env = { OneDrive: 'C:\\Users\\bob\\OneDrive' }

  it('recognises OneDrive by its environment variable and by folder names', () => {
    expect(
      cloudSyncProvider('C:\\Users\\bob\\OneDrive\\Documents', env, 'win32'),
    ).toBe('OneDrive')
    expect(
      cloudSyncProvider('c:/users/BOB/onedrive/Documents/x', env, 'win32'),
    ).toBe('OneDrive')
    expect(cloudSyncProvider('D:\\OneDrive - Contoso\\Docs', {}, 'win32')).toBe(
      'OneDrive',
    )
    expect(cloudSyncProvider('C:\\Users\\bob\\Dropbox\\x', {}, 'win32')).toBe(
      'Dropbox',
    )
    expect(
      cloudSyncProvider('/Users/b/Library/Mobile Documents/x', {}, 'darwin'),
    ).toBe('iCloud Drive')
  })

  it('does not call a local folder synced', () => {
    expect(
      cloudSyncProvider('C:\\Users\\bob\\Documents', env, 'win32'),
    ).toBeNull()
    expect(
      cloudSyncProvider('C:\\Users\\bob\\OneDriveBackup\\x', env, 'win32'),
    ).toBeNull()
    expect(cloudSyncProvider('', env, 'win32')).toBeNull()
  })

  it('a UNC path is a network path; a drive letter and \\\\?\\ are not', () => {
    expect(isNetworkPath('\\\\nas\\melee\\Library', 'win32')).toBe(true)
    expect(isNetworkPath('//nas/melee', 'win32')).toBe(true)
    expect(isNetworkPath('D:\\Library', 'win32')).toBe(false)
    expect(isNetworkPath('\\\\?\\C:\\Library', 'win32')).toBe(false)
    expect(isNetworkPath('\\\\nas\\x', 'linux')).toBe(false)
  })

  it('storageConcern says why, for both kinds', () => {
    expect(storageConcern('\\\\nas\\melee', {}, 'win32')?.kind).toBe('network')
    const cloud = storageConcern('C:\\Users\\bob\\OneDrive\\L', env, 'win32')
    expect(cloud?.kind).toBe('cloud')
    expect(cloud?.message).toMatch(/OneDrive/)
    expect(storageConcern('D:\\Lib', env, 'win32')).toBeNull()
  })
})

describe('default data location (DL-4, WIN-4, COMPAT-1)', () => {
  const base = {
    platform: 'win32' as const,
    documents: 'C:\\Users\\bob\\OneDrive\\Documents',
    localAppData: 'C:\\Users\\bob\\AppData\\Local',
    env: { OneDrive: 'C:\\Users\\bob\\OneDrive' },
  }

  it('a new install with OneDrive Documents uses %LOCALAPPDATA%', () => {
    expect(chooseDataRoot({ ...base, exists: () => false })).toBe(
      path.join('C:\\Users\\bob\\AppData\\Local', 'Lunar Clipper'),
    )
  })

  it('an existing Documents\\Lunar Clipper is never walked away from', () => {
    expect(chooseDataRoot({ ...base, exists: () => true })).toBe(
      path.join('C:\\Users\\bob\\OneDrive\\Documents', 'Lunar Clipper'),
    )
  })

  it('Documents that is not synced, or another OS, keeps the old default', () => {
    expect(
      chooseDataRoot({
        ...base,
        documents: 'C:\\Users\\bob\\Documents',
        exists: () => false,
      }),
    ).toBe(path.join('C:\\Users\\bob\\Documents', 'Lunar Clipper'))
    expect(
      chooseDataRoot({
        ...base,
        platform: 'linux',
        documents: '/home/bob/OneDrive/Documents',
        exists: () => false,
      }),
    ).toBe(path.join('/home/bob/OneDrive/Documents', 'Lunar Clipper'))
  })
})

describe('Slippi replay folder fallback (WIN-9)', () => {
  it('looks in the real Documents folder first on Windows', () => {
    expect(
      slippiReplayFallbacks(
        'C:\\Users\\bob\\OneDrive\\Documents',
        'C:\\Users\\bob',
        'win32',
      )[0],
    ).toBe(path.join('C:\\Users\\bob\\OneDrive\\Documents', 'Slippi'))
    expect(slippiReplayFallbacks('/d', '/home/bob', 'linux')).toEqual([
      path.join('/home/bob', 'Slippi'),
    ])
  })
})

describe('power-save hold (WIN-10)', () => {
  it('holds one blocker while any job is running and releases with the last', () => {
    const start = powerSaveBlocker.start as jest.Mock
    const stop = powerSaveBlocker.stop as jest.Mock
    start.mockClear()
    stop.mockClear()
    const a = holdAwake('download')
    const b = holdAwake('filter')
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(awakeHolds()).toBe(2)
    a()
    a() // twice is safe
    expect(stop).not.toHaveBeenCalled()
    b()
    expect(stop).toHaveBeenCalledWith(7)
    expect(awakeHolds()).toBe(0)
  })

  it('work goes on when the blocker is not available', () => {
    const start = powerSaveBlocker.start as jest.Mock
    start.mockImplementationOnce(() => {
      throw new Error('no power API')
    })
    const release = holdAwake('x')
    expect(() => release()).not.toThrow()
  })
})

describe('replay paths over the Windows limit (WIN-13)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-longpath-'))
    configureSlpCache({ dir: path.join(dir, 'cache') })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('hands Dolphin a copy in the short cache path, only on Windows', async () => {
    let deep = dir
    while (deep.length < WINDOWS_LONG_PATH + 20)
      deep = path.join(deep, 'a-long-folder-name-for-a-set')
    fs.mkdirSync(deep, { recursive: true })
    const replay = path.join(deep, 'game.slp')
    fs.writeFileSync(replay, '{U\x03raw[$U#l game bytes')
    const short = await playableSlp(replay, 'win32')
    expect(short).not.toBe(replay)
    expect(short.length).toBeLessThan(WINDOWS_LONG_PATH)
    expect(fs.readFileSync(short, 'utf8')).toBe('{U\x03raw[$U#l game bytes')
    // Elsewhere, and for short paths, the file is used as it is.
    expect(await playableSlp(replay, 'linux')).toBe(replay)
    const small = path.join(dir, 'small.slp')
    fs.writeFileSync(small, 'x')
    expect(await playableSlp(small, 'win32')).toBe(small)
  })
})

describe('the hidden-window launcher failing (WIN-11, REC-13)', () => {
  beforeEach(() => resetHideFallback())

  it('is recognised by its exit codes and by being blocked, only on Windows', () => {
    for (const detail of [
      'exit code 91: the hidden-window helper could not create its hidden desktop',
      'Error: spawn UNKNOWN',
      'EPERM: operation not permitted, spawn lunar-hidden-launcher.exe',
      'exit code 92',
    ])
      expect(hideLauncherFailed(detail, 'win32')).toBe(true)
    expect(hideLauncherFailed('exit code 91', 'linux')).toBe(false)
    expect(
      hideLauncherFailed('exit code 1, no output from Dolphin', 'win32'),
    ).toBe(false)
  })

  it('hiding stays requested by the setting; the fallback is per session state', () => {
    expect(recordHideFor({} as never, 'win32')).toBe(true)
    expect(
      recordHideFor({ hideRecordingWindows: false } as never, 'win32'),
    ).toBe(false)
    expect(recordHideFor({} as never, 'darwin')).toBe(false)
  })
})

describe('real Dolphin.ini is only touched when a dump flag is on (WIN-12)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ini-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it.each([
    ['[Movie]\r\nDumpFrames = False\r\nDumpAudio = False\r\n', false],
    ['[Movie]\r\nDumpFrames = True\r\n', true],
    ['[DSP]\nDumpAudioSilent=True\n', true],
    ['[Core]\nGFXBackend = OGL\n', false],
  ])('%j -> %s', async (text, on) => {
    const ini = path.join(dir, 'Dolphin.ini')
    fs.writeFileSync(ini, text)
    expect(await dumpFlagsAreOn({ dolphinIni: ini })).toBe(on)
  })

  it('a missing file or profile is no', async () => {
    expect(
      await dumpFlagsAreOn({ dolphinIni: path.join(dir, 'nope.ini') }),
    ).toBe(false)
    expect(await dumpFlagsAreOn(null)).toBe(false)
  })
})

describe('output file names (WIN-14)', () => {
  const replay = {
    index: 7,
    path: '/g.slp',
    startFrame: 1,
    endFrame: 2,
  } as never

  it('characters NTFS reads as a stream or wildcard are replaced in the pattern text too', () => {
    const out = resolveFilenamePattern('Clip: {index}', replay)
    expect(out).not.toMatch(/[:<>"|?*]/)
    expect(out).toMatch(/^Clip_ /)
    expect(resolveFilenamePattern('a?b*c|d<e>f"g', replay)).toBe(
      'a_b_c_d_e_f_g',
    )
  })

  it('invisible and direction-changing characters are dropped (a replay name can carry them)', () => {
    expect(resolveFilenamePattern('Fox\u202Egpj.exe', replay)).toBe('Foxgpj.exe')
    expect(resolveFilenamePattern('a\u200bb\ufeffc\u2066d\u007f', replay)).toBe('abcd_')
    expect(resolveFilenamePattern('../../{index}', replay)).not.toMatch(/\.\./)
  })

  it('folders in the pattern still work', () => {
    expect(resolveFilenamePattern('{index}/take: one', replay)).toMatch(
      /^[^/]+\/take_ one$/,
    )
  })
})
