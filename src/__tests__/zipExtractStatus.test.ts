/**
 * @jest-environment node
 *
 * A ZIP import shows what it's doing from the moment the ZIP wizard closes:
 * the top bar's status says "extracting" with the ZIP's name and its entries
 * done, the console runs labelled "Extracting <zip>" and logs the result, and
 * both hand over to the import (phase cleared) once the ZIP is unpacked.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import { extractZipWithStatus } from '../main/zipImportStatus'

/** A stored (uncompressed) ZIP with these files, built by hand. */
function storedZip(files: Record<string, Buffer>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(files)) {
    const fileName = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(fileName.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(fileName.length, 28)
    central.writeUInt32LE((0x81a4 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, fileName, data)
    centrals.push(central, fileName)
    offset += local.length + fileName.length + data.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function setup() {
  const sent: any[] = []
  const consoleCalls: string[] = []
  const abort = new AbortController()
  const deps = {
    signal: abort.signal,
    setStatus: (next: any) => sent.push(next),
    console: {
      startConsole: (_op: string, label: string) =>
        consoleCalls.push(`start:${label}`),
      stopConsole: () => consoleCalls.push('stop'),
      pushConsoleLog: (level: string, message: string) =>
        consoleCalls.push(`${level}:${message}`),
    },
  }
  return {
    extract: (zip: string, out: string) => extractZipWithStatus(zip, out, deps),
    statuses: () => sent,
    consoleCalls,
    abort,
  }
}

describe('ZIP extraction status', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-zip-status-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('shows "extracting <zip>" with progress, then hands over to the import', async () => {
    const zip = path.join(root, 'Big Weekly.zip')
    fs.writeFileSync(
      zip,
      storedZip({
        'a.slp': Buffer.from('one'),
        'b.slp': Buffer.from('two'),
        'notes.txt': Buffer.from('skip me'),
      }),
    )
    const { extract, statuses, consoleCalls } = setup()
    const count = await extract(zip, path.join(root, 'out'))
    expect(count).toBe(2)
    expect(fs.readdirSync(path.join(root, 'out')).sort()).toEqual([
      'a.slp',
      'b.slp',
    ])

    const all = statuses()
    // Right away, before any entry is read.
    expect(all[0]).toMatchObject({
      isImporting: true,
      phase: 'extracting',
      label: 'Big Weekly.zip',
      current: 0,
    })
    // The entries done (updates merge into the status; the last always goes out).
    expect(all).toContainEqual({ current: 3, total: 3 })
    // Then the phase is cleared for the import.
    expect(all[all.length - 1]).toMatchObject({
      phase: null,
      current: 0,
    })
    expect(consoleCalls).toEqual([
      'start:Extracting Big Weekly.zip',
      'info:Extracting Big Weekly.zip…',
      'info:Extracted 2 replays from Big Weekly.zip',
      'stop',
    ])
  })

  it('logs a ZIP that cannot be extracted and clears the status', async () => {
    const zip = path.join(root, 'empty.zip')
    fs.writeFileSync(zip, storedZip({ 'readme.txt': Buffer.from('x') }))
    const { extract, statuses, consoleCalls } = setup()
    await expect(extract(zip, path.join(root, 'out'))).rejects.toThrow(
      /No SLP or SLPZ replays/,
    )
    expect(statuses().pop()).toMatchObject({ phase: null })
    expect(consoleCalls[consoleCalls.length - 2]).toMatch(
      /^error:Could not extract empty\.zip: No SLP or SLPZ replays/,
    )
    expect(consoleCalls[consoleCalls.length - 1]).toBe('stop')
  })

  it('Cancel stops the extraction and clears the status', async () => {
    const zip = path.join(root, 'c.zip')
    fs.writeFileSync(zip, storedZip({ 'a.slp': Buffer.from('one') }))
    const { extract, statuses, consoleCalls, abort } = setup()
    const running = extract(zip, path.join(root, 'out'))
    abort.abort()
    await expect(running).rejects.toThrow()
    expect(statuses().pop()).toMatchObject({ phase: null })
    expect(consoleCalls).toContain('info:Stopped extracting c.zip')
    expect(consoleCalls[consoleCalls.length - 1]).toBe('stop')
  })
})
