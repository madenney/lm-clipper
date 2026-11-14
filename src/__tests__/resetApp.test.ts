/**
 * @jest-environment node
 *
 * Settings > Reset App touches the config only (launch review 0.1). The
 * library, My Replays and projects stay where they are; the wipe of Clipper's
 * data exists only for development builds / testMode, and never deletes for
 * good when the Trash fails.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockState = { packaged: true, trash: jest.fn(), projectDir: '' }

jest.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockState.packaged
    },
    getVersion: () => '3.0.0',
    getPath: () => os.tmpdir(),
  },
  shell: { trashItem: (...a: unknown[]) => mockState.trash(...a) },
}))
jest.mock('../main/slpToVideo', () => ({ setFFMPEGPathOverride: jest.fn() }))
jest.mock('../main/telemetry', () => ({
  track: jest.fn(),
  applyUsageConsent: jest.fn(),
}))
jest.mock('../main/dbAsync', () => ({
  closeDbAsync: jest.fn(async () => {}),
  libraryCall: jest.fn(async () => {}),
}))
jest.mock('../main/slippiDetect', () => ({
  detectPlaybackDolphin: () => '',
  detectMeleeIso: () => '',
  stripPathQuotes: (s: string) => s,
}))
jest.mock('../main/controller/helpers', () => ({
  PATH_CONFIG_KEYS: new Set<string>(),
  autoFilterThreads: () => 1,
  getDefaultProjectDir: () => mockState.projectDir,
}))

// eslint-disable-next-line import/first
import { resetApp } from '../main/controller/ipcConfig'

describe('resetApp', () => {
  let root: string
  let libraryFolder: string
  let projectDir: string
  let ctx: any

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-app-'))
    libraryFolder = path.join(root, 'Library')
    projectDir = path.join(root, 'Lunar Clipper')
    mockState.projectDir = projectDir
    fs.mkdirSync(path.join(libraryFolder, 'replays'), { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(libraryFolder, 'library.sqlite'), 'idx')
    fs.writeFileSync(path.join(libraryFolder, 'replays', 'a.slpz'), 'game')
    fs.writeFileSync(path.join(projectDir, 'mine.lunar'), 'project')
    fs.writeFileSync(path.join(root, 'lm-clipper.json'), '{"x":1}')
    mockState.packaged = true
    mockState.trash = jest.fn(async () => {})
    ctx = {
      config: {
        testMode: false,
        installId: 'abc',
        replayLibraryPath: libraryFolder,
        recentProjects: ['x'],
      },
      configPath: path.join(root, 'lm-clipper.json'),
      devBackupPath: path.join(root, 'dev.bak'),
      defaultWorkspacePath: () => path.join(projectDir, 'My Replays.lunar'),
      library: () => ({ folder: libraryFolder }),
      pickSettingsForThisComputer: jest.fn(async () => {}),
      saveConfig: jest.fn(),
      setArchiveInternal: jest.fn(),
      restartIntoConfig: jest.fn(),
      transferManager: { reset: jest.fn() },
    }
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const survives = () => {
    expect(fs.existsSync(path.join(projectDir, 'mine.lunar'))).toBe(true)
    expect(fs.existsSync(path.join(libraryFolder, 'library.sqlite'))).toBe(true)
    expect(fs.existsSync(path.join(libraryFolder, 'replays', 'a.slpz'))).toBe(
      true,
    )
  }

  it('a packaged Settings reset leaves the .lunar project and the library in place', async () => {
    await resetApp(ctx, {} as any, null)
    survives()
    expect(mockState.trash).not.toHaveBeenCalled()
    expect(ctx.transferManager.reset).not.toHaveBeenCalled()
    expect(fs.existsSync(`${ctx.configPath}.bak`)).toBe(true)
    expect(ctx.restartIntoConfig).toHaveBeenCalled()
    expect(ctx.config.recentProjects).toEqual([])
    // The library lives elsewhere on disk, so the reset keeps pointing at it.
    expect(ctx.config.replayLibraryPath).toBe(libraryFolder)
  })

  it('refuses wipeData in a packaged build without testMode', async () => {
    await resetApp(ctx, {} as any, { wipeData: true })
    survives()
    expect(mockState.trash).not.toHaveBeenCalled()
  })

  it('wipeData in testMode moves data to the Trash, never deletes for good', async () => {
    ctx.config.testMode = true
    mockState.trash = jest.fn(async () => {
      throw new Error('no Trash on this drive')
    })
    await resetApp(ctx, {} as any, { wipeData: true })
    expect(mockState.trash).toHaveBeenCalled()
    // The Trash refused every item; nothing was removed by another route.
    survives()
  })

  it('wipeData in a development build trashes the library and projects', async () => {
    mockState.packaged = false
    await resetApp(ctx, {} as any, { wipeData: true })
    const trashed = mockState.trash.mock.calls.map((c) => c[0] as string)
    expect(trashed).toContain(path.join(libraryFolder, 'library.sqlite'))
    expect(trashed).toContain(path.join(projectDir, 'mine.lunar'))
  })
})
