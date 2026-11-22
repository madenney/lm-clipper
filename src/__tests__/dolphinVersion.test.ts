// Clipper refuses a playback Dolphin older than 3.5.2 (replay Gecko codes: https://khang06.github.io/slippirce/).
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  clearDolphinVersionCache,
  dolphinVersionProblem,
  parseDolphinVersion,
  versionAtLeast,
} from '../main/dolphinVersion'

describe('playback Dolphin version gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-dv-'))
  const exe = path.join(dir, 'Slippi Dolphin.exe')
  fs.writeFileSync(exe, 'x')
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => clearDolphinVersionCache())

  it('reads versions and compares them', () => {
    expect(parseDolphinVersion('3.5.2\r\n')).toEqual([3, 5, 2])
    expect(parseDolphinVersion('Slippi Dolphin 3.7.0-abc')).toEqual([3, 7, 0])
    expect(parseDolphinVersion('')).toBeNull()
    expect(versionAtLeast([3, 5, 2])).toBe(true)
    expect(versionAtLeast([3, 5, 1])).toBe(false)
    expect(versionAtLeast([3, 4, 9])).toBe(false)
    expect(versionAtLeast([2, 9, 9])).toBe(false)
    expect(versionAtLeast([4, 0, 0])).toBe(true)
    expect(versionAtLeast([3, 10, 0])).toBe(true)
  })

  it('allows 3.5.2 and newer, refuses older and unreadable', async () => {
    expect(await dolphinVersionProblem(exe, async () => '3.5.2\n')).toBeNull()
    clearDolphinVersionCache()
    expect(await dolphinVersionProblem(exe, async () => '3.7.0\n')).toBeNull()
    clearDolphinVersionCache()
    expect(await dolphinVersionProblem(exe, async () => '3.4.4\n')).toMatch(
      /3\.4\.4.*3\.5\.2/,
    )
    expect(await dolphinVersionProblem(exe, async () => '')).toMatch(
      /could not read/,
    )
  })

  it('remembers a good answer, never a bad one', async () => {
    const run = jest.fn(async () => '3.5.2')
    await dolphinVersionProblem(exe, run)
    await dolphinVersionProblem(exe, run)
    expect(run).toHaveBeenCalledTimes(1)
    clearDolphinVersionCache()
    const bad = jest.fn(async () => '3.0.0')
    await dolphinVersionProblem(exe, bad)
    await dolphinVersionProblem(exe, bad)
    expect(bad).toHaveBeenCalledTimes(2)
  })

  it('reads the real Dolphin on this machine, when there is one', async () => {
    const real = path.join(
      os.homedir(),
      '.config/Slippi Launcher/playback/Slippi_Playback-x86_64.AppImage',
    )
    if (process.platform !== 'linux' || !fs.existsSync(real)) return
    expect(await dolphinVersionProblem(real)).toBeNull()
  }, 30_000)
})
