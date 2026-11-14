/**
 * @jest-environment node
 *
 * Windows keeps the real Slippi Playback profile portable, under
 * `<dolphinDir>/User/Config`, not ~/.config/SlippiPlayback. Clipper resolves it
 * (realProfileOf) and hands it to buildProfile as sourceProfile; this checks
 * that path off Windows. Whether Windows Dolphin itself honours `--user` still
 * needs a real Windows run before a release.
 */
jest.mock('os', () => {
  const real = jest.requireActual('os')
  return { ...real, type: () => 'Windows_NT' }
})
jest.mock('electron', () => ({ app: {} }))
jest.mock('../main/util', () => ({
  getFFMPEGPath: () => 'ffmpeg',
  getAssetPath: () => '/assets',
}))
jest.mock('../main/overlayRenderer', () => ({ renderOverlayPng: jest.fn() }))

/* eslint-disable import/first */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildProfile } from 'slippi-dolphin-runner'
import { recordHideOptions, recordProfileOptions } from '../main/slpToVideo'

it('records from the Windows User/Config layout', async () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winst-'))
  const userConfig = path.join(installDir, 'User', 'Config')
  fs.mkdirSync(userConfig, { recursive: true })
  fs.writeFileSync(
    path.join(userConfig, 'GFX.ini'),
    '[Settings]\nEFBScale = 4\nMarker = windows-source\n',
  )
  fs.writeFileSync(
    path.join(userConfig, 'Dolphin.ini'),
    '[Movie]\nDumpFrames = False\n',
  )
  const opts = recordProfileOptions({
    dolphinPath: path.join(installDir, 'Dolphin.exe'),
    resolution: 2,
    widescreen: true,
    customGeckoCodes: [],
  } as any)
  expect(opts.sourceProfile?.root).toBe(path.join(installDir, 'User'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winprof-'))
  await buildProfile(dir, opts)
  const gfx = fs.readFileSync(path.join(dir, 'Config', 'GFX.ini'), 'utf8')
  expect(gfx).toContain('Marker = windows-source')
  expect(gfx).toMatch(/UseFFV1 = True/)
})

it('records on Windows with OGL (DX11 drops dump frames), vsync off, and MPEG-4 at 150 Mb/s instead of UT Video', () => {
  const base = {
    dolphinPath: path.join(os.tmpdir(), 'Dolphin.exe'),
    widescreen: true,
    customGeckoCodes: [],
  }
  const o = recordProfileOptions({ ...base, resolution: 4 } as any)
  expect(o.gfxBackend).toBe('OGL')
  expect(o.vsync).toBe(false)
  expect(o.dumpCodec).toBe('mpeg4')
  expect(o.bitrateKbps).toBe(150000)
  // Native stays lossless FFV1 (fast enough there).
  expect(
    recordProfileOptions({ ...base, resolution: 2 } as any).dumpCodec,
  ).toBe('ffv1')
  // Shown windows (Hide Recording Windows off) don't inherit Slippi's VSync (1.0x cap).
  const shown = recordProfileOptions({
    ...base,
    resolution: 2,
    hideRecordingWindows: false,
  } as any)
  expect(shown.vsync).toBe(false)
  expect(shown.gfxBackend).toBe('OGL')
})

it('hides Windows recordings by default: hide on the profile, the launcher on record()', () => {
  const base = {
    dolphinPath: path.join(os.tmpdir(), 'Dolphin.exe'),
    widescreen: true,
    customGeckoCodes: [],
    resolution: 4,
  }
  const o = recordProfileOptions(base as any)
  expect(o.hide).toBe(true)
  expect(o.pauseOnFocusLost).toBe(false)
  expect(
    recordHideOptions(base as any, undefined, () => 'C:\\L\\x.exe'),
  ).toEqual({ hide: true, hideLauncherPath: 'C:\\L\\x.exe' })
  const off = { ...base, hideRecordingWindows: false }
  expect(recordProfileOptions(off as any).hide).toBeUndefined()
  expect(recordHideOptions(off as any)).toEqual({})
})

it('writes the Windows hide ini: one small main window, not fullscreen', async () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winhide-'))
  fs.mkdirSync(path.join(installDir, 'User', 'Config'), { recursive: true })
  fs.writeFileSync(
    path.join(installDir, 'User', 'Config', 'Dolphin.ini'),
    '[Display]\nFullscreen = True\nRenderToMain = False\n',
  )
  fs.writeFileSync(path.join(installDir, 'User', 'Config', 'GFX.ini'), '')
  const opts = recordProfileOptions({
    dolphinPath: path.join(installDir, 'Dolphin.exe'),
    resolution: 4,
    widescreen: true,
    customGeckoCodes: [],
  } as any)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winhideprof-'))
  await buildProfile(dir, { ...opts, platform: 'win32' } as any)
  const ini = fs.readFileSync(path.join(dir, 'Config', 'Dolphin.ini'), 'utf8')
  expect(ini).toMatch(/RenderToMain = True/)
  expect(ini).toMatch(/Fullscreen = False/)
})
