/**
 * @jest-environment node
 *
 * Windows-path coverage for the Dolphin `--user` profile builders. The one
 * platform difference is the SOURCE layout: on Windows the real profile lives
 * under `<dolphinDir>/User/Config` (portable), not `~/.config/SlippiPlayback`.
 * resolveDolphinIniPaths() branches on os.type(), so here we force it to
 * Windows and point config.dolphinPath at a fixture install, then assert the
 * builders read that layout and still write a correct `<userDir>/Config`
 * profile (the DEST layout is platform-independent — Dolphin's `--user` root).
 *
 * This verifies the half of the Windows risk that is testable off-Windows: our
 * path resolution + build logic. Whether Windows Dolphin itself honours
 * `--user` + Sys-relative-to-binary still needs a real Windows run.
 */
jest.mock('os', () => {
  const real = jest.requireActual('os')
  return { ...real, type: () => 'Windows_NT' }
})
jest.mock('electron', () => ({ app: {} }))
jest.mock('../main/util', () => ({ getFFMPEGPath: () => 'ffmpeg' }))
jest.mock('../main/overlayRenderer', () => ({ renderOverlayPng: jest.fn() }))

/* eslint-disable import/first */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildWorkerProfile, buildPlaybackProfile } from '../main/slpToVideo'

const GFX = [
  '[Settings]',
  'AspectRatio = 2',
  'EFBScale = 4',
  'UseFFV1 = True',
  '',
].join('\n')
const DOLPHIN = ['[Movie]', 'DumpFrames = False', 'DumpAudio = False', ''].join(
  '\n',
)

let installDir: string
let config: any

beforeAll(() => {
  // Fixture "portable Windows install": <installDir>/User/Config/*.ini
  installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winst-'))
  const userConfig = path.join(installDir, 'User', 'Config')
  fs.mkdirSync(userConfig, { recursive: true })
  fs.writeFileSync(path.join(userConfig, 'GFX.ini'), GFX)
  fs.writeFileSync(path.join(userConfig, 'Dolphin.ini'), DOLPHIN)
  fs.writeFileSync(path.join(userConfig, 'Logger.ini'), '[Logger]\nX = 1\n')
  config = {
    dolphinPath: path.join(installDir, 'Dolphin.exe'),
    resolution: 7,
    bitrateKbps: 50000,
    widescreen: true,
    playbackResolution: 2,
    customGeckoCodes: [],
  }
})

it('recording reads the Windows User/Config layout and builds a valid profile', async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winrec-'))
  await buildWorkerProfile(config, userDir)
  const gfx = fs.readFileSync(path.join(userDir, 'Config/GFX.ini'), 'utf8')
  const dol = fs.readFileSync(path.join(userDir, 'Config/Dolphin.ini'), 'utf8')
  expect(gfx).toContain('EFBScale = 7')
  expect(gfx).toContain('UseFFV1 = True') // preserved from Windows source
  expect(dol).toContain('DumpFrames = True')
  expect(fs.existsSync(path.join(userDir, 'GameSettings/GALE01.ini'))).toBe(
    true,
  )
})

it('playback reads the Windows User/Config layout and builds a valid profile', async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winplay-'))
  await buildPlaybackProfile(config, userDir)
  const gfx = fs.readFileSync(path.join(userDir, 'Config/GFX.ini'), 'utf8')
  const dol = fs.readFileSync(path.join(userDir, 'Config/Dolphin.ini'), 'utf8')
  expect(fs.existsSync(path.join(userDir, 'Config/Logger.ini'))).toBe(true) // copied
  expect(gfx).toContain('EFBScale = 2') // playback resolution
  expect(gfx).toContain('UseFFV1 = True')
  expect(dol).toContain('DumpFrames = False')
})
