/**
 * @jest-environment node
 *
 * Drift guard between the preload SEND_CHANNELS allowlist and the channels the
 * main process actually listens on. The foot-gun: if a handler is registered
 * via `ipcMain.on('foo', ...)` but `'foo'` is NOT in preload's SEND_CHANNELS,
 * the renderer's send is silently dropped and the request hangs until the 30s
 * ipcBridge stale-reaper fires — a confusing, hard-to-trace failure.
 *
 * Both files are read as TEXT and regex-parsed (no electron import needed) so
 * this stays a fast, dependency-free unit test.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8')
}

/** Extract the channel-name string literals from a SEND_CHANNELS Set body. */
function parseSendChannels(preloadSrc: string): Set<string> {
  const m = preloadSrc.match(/SEND_CHANNELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
  if (!m) throw new Error('Could not locate SEND_CHANNELS in preload.ts')
  const body = m[1]
  const channels = new Set<string>()
  const re = /['"]([a-zA-Z0-9_-]+)['"]/g
  let hit: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((hit = re.exec(body))) channels.add(hit[1])
  return channels
}

/**
 * Extract every channel passed to `ipcMain.on(...)` / `ipcMain.once(...)`.
 * Handles both single-line (`ipcMain.on('x', ...)`) and multiline
 * (`ipcMain.on(\n  'x',\n  ...)`) registration styles by allowing whitespace
 * between the paren and the string literal.
 */
function parseRegisteredChannels(sources: string[]): Set<string> {
  const channels = new Set<string>()
  const re = /ipcMain\.(?:on|once)\(\s*['"]([a-zA-Z0-9_-]+)['"]/g
  for (const src of sources) {
    let hit: RegExpExecArray | null
    // eslint-disable-next-line no-cond-assign
    while ((hit = re.exec(src))) channels.add(hit[1])
  }
  return channels
}

const preloadSrc = read('main/preload.ts')
const controllerSrc = read('main/controller.ts')

const sendChannels = parseSendChannels(preloadSrc)
const registeredChannels = parseRegisteredChannels([controllerSrc])

describe('parsing sanity', () => {
  it('parses a non-trivial SEND_CHANNELS set', () => {
    expect(sendChannels.size).toBeGreaterThan(20)
    expect(sendChannels.has('getConfig')).toBe(true)
  })

  it('parses ipcMain.on registrations, including multiline ones', () => {
    expect(registeredChannels.size).toBeGreaterThan(20)
    // single-line form
    expect(registeredChannels.has('getConfig')).toBe(true)
    // multiline form (channel on the line after the open paren)
    expect(registeredChannels.has('getImportStatus')).toBe(true)
    expect(registeredChannels.has('runFilter')).toBe(true)
  })
})

describe('every ipcMain.on channel is allowlisted in preload SEND_CHANNELS', () => {
  it('has no channels registered in controller that are missing from preload', () => {
    const missing = [...registeredChannels].filter((c) => !sendChannels.has(c))
    expect(missing).toEqual([])
  })

  // Per-channel assertions give a precise failure message naming the offender.
  it.each([...registeredChannels].sort())(
    'channel "%s" is in SEND_CHANNELS',
    (channel) => {
      expect(sendChannels.has(channel)).toBe(true)
    },
  )
})
