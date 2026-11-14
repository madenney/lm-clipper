/**
 * Test runs only (scripts/win-rig's clipper-smoke suite): LM_CLIPPER_TEST_HOME
 * keeps everything this instance reads and writes under one folder, so a test
 * Clipper on a real user's PC never touches their settings, projects, library,
 * downloads or logs. Imported first by main.ts, before any module asks
 * Electron for a path. Without the variable nothing changes.
 *
 * The runner also sets APPDATA (logger.ts reads it) and TEMP/TMP (Dolphin's
 * per-clip profiles) to folders inside the test home.
 */
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

const home = process.env.LM_CLIPPER_TEST_HOME
if (home) {
  const appData = path.join(home, 'AppData')
  const dirs: [Parameters<typeof app.setPath>[0], string][] = [
    ['appData', appData],
    // Clipper's userData (Chromium's data, workspaces, shader caches).
    ['userData', path.join(appData, 'lm-clipper')],
    ['documents', path.join(home, 'Documents')],
    ['downloads', path.join(home, 'Downloads')],
    ['videos', path.join(home, 'Videos')],
    ['sessionData', path.join(appData, 'lm-clipper')],
    ['crashDumps', path.join(home, 'Crashpad')],
  ]
  for (const [name, dir] of dirs) {
    fs.mkdirSync(dir, { recursive: true })
    app.setPath(name, dir)
  }
  // The update test's relaunched app (started by the installer, so without our
  // command-line flags) is driven over DevTools through this variable.
  const cdpPort = Number(process.env.LM_CLIPPER_CDP_PORT)
  if (Number.isInteger(cdpPort) && cdpPort > 1024 && cdpPort < 65536) {
    app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort))
  }
}
