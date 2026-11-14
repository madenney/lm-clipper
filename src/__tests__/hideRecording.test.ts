/**
 * @jest-environment node
 *
 * Hide Recording Windows: which OS hides (slpToVideo recordHideFor), where the
 * Windows launcher is in a dev run vs a packaged one (hideLauncher.ts), what
 * counts as "couldn't hide", and that a Windows build must ship the launcher
 * (.erb/scripts/check-bundled-binaries.js).
 */
jest.mock('electron', () => ({ app: {} }))
jest.mock('../main/util', () => ({
  getFFMPEGPath: () => 'ffmpeg',
  getAssetPath: (...p: string[]) => `/assets/${p.join('/')}`,
}))
jest.mock('../main/overlayRenderer', () => ({ renderOverlayPng: jest.fn() }))

/* eslint-disable import/first, global-require */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  hideFailure,
  recordHideFor,
  recordHideOptions,
} from '../main/slpToVideo'
import {
  HIDE_LAUNCHER_EXE,
  resolveHideLauncherPath,
} from '../main/hideLauncher'

const APP_DIR = path.resolve(__dirname, '..', '..')
const pkg = require('../../package.json')
const {
  checkBundledBinaries,
} = require('../../.erb/scripts/check-bundled-binaries')

const cfg = (over: Record<string, unknown> = {}) =>
  ({ dolphinPath: '/d', resolution: 4, ...over }) as any

describe('recordHideFor', () => {
  it('hides on Windows and Linux by default, never on macOS (unverified there)', () => {
    expect(recordHideFor(cfg(), 'win32')).toBe(true)
    expect(recordHideFor(cfg(), 'linux')).toBe(true)
    expect(recordHideFor(cfg(), 'darwin')).toBe(false)
  })

  it('is off everywhere when the setting is off', () => {
    for (const p of ['win32', 'linux', 'darwin'] as const)
      expect(recordHideFor(cfg({ hideRecordingWindows: false }), p)).toBe(false)
  })

  it('passes the launcher only on Windows', () => {
    const launcher = () => 'C:\\app\\resources\\hidden-launcher\\x.exe'
    expect(recordHideOptions(cfg(), 'win32', launcher)).toEqual({
      hide: true,
      hideLauncherPath: launcher(),
    })
    expect(recordHideOptions(cfg(), 'linux', launcher)).toEqual({ hide: true })
    expect(recordHideOptions(cfg(), 'darwin', launcher)).toEqual({})
  })
})

describe('resolveHideLauncherPath', () => {
  it('packaged: resources/hidden-launcher, outside app.asar', () => {
    const resources = path.join('/opt', 'Lunar Clipper', 'resources')
    const p = resolveHideLauncherPath({
      packaged: true,
      resourcesPath: resources,
      appPath: path.join(resources, 'app.asar'),
    })
    expect(p).toBe(path.join(resources, 'hidden-launcher', HIDE_LAUNCHER_EXE))
    expect(p).not.toMatch(/app\.asar/)
  })

  it("dev: the runner's own copy in node_modules, which exists", () => {
    const p = resolveHideLauncherPath({ packaged: false, appPath: APP_DIR })
    expect(p).toBe(
      path.join(
        APP_DIR,
        'node_modules',
        'slippi-dolphin-runner',
        'native',
        'win',
        'bin',
        HIDE_LAUNCHER_EXE,
      ),
    )
    expect(fs.existsSync(p)).toBe(true)
  })

  it('the packaged path is where electron-builder copies it (build.win.extraResources)', () => {
    const entry = pkg.build.win.extraResources.find(
      (e: { to: string }) => e.to === `hidden-launcher/${HIDE_LAUNCHER_EXE}`,
    )
    expect(entry).toBeTruthy()
    expect(fs.existsSync(path.join(APP_DIR, entry.from))).toBe(true)
  })
})

describe('hideFailure', () => {
  it('counts warnings that mean windows showed, not optional extras', () => {
    expect(hideFailure([])).toBeNull()
    expect(hideFailure([{ code: 'hide-native-unavailable' }])).toBeNull()
    expect(hideFailure([{ code: 'dump-codec-fallback' }])).toBeNull()
    for (const code of [
      'hide-desktop-unavailable',
      'hide-session-unsupported',
      'hide-failed',
      'placement-no-wm',
    ])
      expect(
        hideFailure([{ code: 'hide-native-unavailable' }, { code }])?.code,
      ).toBe(code)
  })
})

describe('check-bundled-binaries: the Windows launcher', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-'))
  const LAUNCHER = {
    from: 'node_modules/slippi-dolphin-runner/native/win/bin/lunar-hidden-launcher.exe',
    to: 'hidden-launcher/lunar-hidden-launcher.exe',
  }
  const check = (platformKey: string, extraResources: unknown[]) =>
    checkBundledBinaries({
      platformKey,
      arch: 'x64',
      extraResources,
      projectDir,
    })

  it('fails a Windows build whose extraResources leave the launcher out', () => {
    expect(check('win', []).problems.join('\n')).toMatch(
      /hidden-launcher\/lunar-hidden-launcher\.exe: not in build\.win\.extraResources/,
    )
  })

  it('fails when the launcher file is missing, passes when it is there', () => {
    expect(check('win', [LAUNCHER]).problems.join('\n')).toMatch(
      /lunar-hidden-launcher\.exe: missing/,
    )
    const file = path.join(projectDir, LAUNCHER.from)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from([0x4d, 0x5a, 0x90, 0, 1, 2, 3]))
    expect(check('win', [LAUNCHER]).problems).toEqual([])
  })

  it('does not ask Linux or macOS builds for it', () => {
    expect(check('linux', []).problems).toEqual([])
    expect(check('mac', []).problems).toEqual([])
  })

  it("the real package.json's Windows build lists it", () => {
    expect(pkg.build.win.extraResources).toContainEqual(LAUNCHER)
  })
})
