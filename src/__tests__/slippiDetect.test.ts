/**
 * @jest-environment node
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  flatpakConfigDirs,
  resolveAppBundle,
  resolveDolphinExecutable,
  stripPathQuotes,
} from '../main/slippiDetect'

jest.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

describe('stripPathQuotes', () => {
  it('removes quotes and spaces around a pasted path', () => {
    expect(stripPathQuotes('"C:\\Slippi\\Slippi Dolphin.exe"')).toBe(
      'C:\\Slippi\\Slippi Dolphin.exe',
    )
    expect(stripPathQuotes("  '/home/me/a b.iso'  ")).toBe('/home/me/a b.iso')
    expect(stripPathQuotes('/plain/path')).toBe('/plain/path')
    expect(stripPathQuotes('"unbalanced')).toBe('"unbalanced')
  })
})

describe('macOS .app resolution', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-app-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const makeBundle = (exe: string, plist: boolean) => {
    const app = path.join(root, 'Slippi Dolphin.app')
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', exe), '')
    if (plist)
      fs.writeFileSync(
        path.join(app, 'Contents', 'Info.plist'),
        `<plist><dict><key>CFBundleExecutable</key>\n<string>${exe}</string></dict></plist>`,
      )
    return app
  }

  it("uses Info.plist's CFBundleExecutable", () => {
    const app = makeBundle('Slippi Dolphin', true)
    expect(resolveAppBundle(app)).toBe(
      path.join(app, 'Contents', 'MacOS', 'Slippi Dolphin'),
    )
    expect(resolveDolphinExecutable(`"${app}/"`)).toBe(
      path.join(app, 'Contents', 'MacOS', 'Slippi Dolphin'),
    )
  })

  it('falls back to the file in Contents/MacOS', () => {
    const app = makeBundle('Dolphin', false)
    expect(resolveAppBundle(app)).toBe(
      path.join(app, 'Contents', 'MacOS', 'Dolphin'),
    )
  })

  it('leaves other paths alone', () => {
    expect(resolveDolphinExecutable('/x/Slippi_Playback-x86_64.AppImage')).toBe(
      '/x/Slippi_Playback-x86_64.AppImage',
    )
    // a .app we can't read stays as given
    expect(resolveAppBundle(path.join(root, 'Missing.app'))).toBe(
      path.join(root, 'Missing.app'),
    )
  })
})

describe('flatpakConfigDirs', () => {
  it("lists each Flatpak app's config folder", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'))
    try {
      fs.mkdirSync(path.join(home, '.var', 'app', 'com.slippi.Launcher'), {
        recursive: true,
      })
      expect(flatpakConfigDirs(home)).toEqual([
        path.join(home, '.var', 'app', 'com.slippi.Launcher', 'config'),
      ])
      expect(flatpakConfigDirs(path.join(home, 'none'))).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
