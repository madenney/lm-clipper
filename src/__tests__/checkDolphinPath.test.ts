/**
 * @jest-environment node
 *
 * The setup wizard's Dolphin check (dolphinCheck.checkDolphinPath).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { checkDolphinPath } from '../main/dolphinCheck'

jest.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  shell: {},
}))

describe('checkDolphinPath', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-dolphin-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const file = (rel: string, body = '', mode = 0o644) => {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body, { mode })
    return p
  }

  it('Windows: accepts a Playback exe and strips pasted quotes', async () => {
    const exe = file('playback/Slippi Dolphin.exe')
    const r = await checkDolphinPath(`"${exe}"`, 'win32')
    expect(r).toMatchObject({ valid: true, path: exe })
    expect(r.warning).toBeUndefined()
  })

  it('Windows: an exe outside a "playback" folder is a warning, not a refusal', async () => {
    const exe = file('Portable Slippi/Slippi Dolphin.exe')
    const r = await checkDolphinPath(exe, 'win32')
    expect(r.valid).toBe(true)
    expect(r.warning).toMatch(/Could not confirm this is the Playback build/)
    expect(r.path).toBeUndefined()
  })

  it('Windows: refuses the netplay folder and non-exe files', async () => {
    expect(
      (await checkDolphinPath(file('netplay/Slippi Dolphin.exe'), 'win32'))
        .valid,
    ).toBe(false)
    expect((await checkDolphinPath(file('notes.txt'), 'win32')).valid).toBe(
      false,
    )
  })

  it('missing file', async () => {
    expect(await checkDolphinPath(path.join(dir, 'nope'), 'linux')).toEqual({
      valid: false,
      message: 'File does not exist at this path.',
    })
  })

  if (process.platform !== 'win32') {
    it('Linux: a file that is not executable gets the chmod hint', async () => {
      const p = file('Slippi_Playback-x86_64.AppImage', '#!/bin/sh\n', 0o644)
      const r = await checkDolphinPath(p, 'linux')
      expect(r.valid).toBe(false)
      expect(r.message).toContain(`chmod +x "${p}"`)
    })

    it('Linux: recognises the Playback build from its -h output', async () => {
      const p = file(
        'dolphin',
        '#!/bin/sh\necho "  --hide-seekbar  Hide the seekbar"\n',
        0o755,
      )
      expect(await checkDolphinPath(p, 'linux')).toMatchObject({
        valid: true,
      })
    })

    it('Linux: a FUSE failure says how to fix it', async () => {
      const p = file(
        'fuse',
        '#!/bin/sh\necho "dlopen(): error loading libfuse.so.2" >&2\nexit 127\n',
        0o755,
      )
      const r = await checkDolphinPath(p, 'linux')
      expect(r.valid).toBe(false)
      expect(r.message).toMatch(/libfuse2/)
    })
  }
})
