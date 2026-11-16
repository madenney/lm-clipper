/**
 * Fonts for the video overlay: importing a file keeps Clipper's own copy after
 * checking it really is a font, the chosen name can never reach outside the
 * fonts folder, and the label is drawn in the chosen font by the same code for
 * the Settings preview and for a recording.
 */
jest.mock('../main/util', () => {
  // eslint-disable-next-line global-require
  const nodePath = require('path')
  return {
    getAssetPath: (...p: string[]) =>
      nodePath.join(__dirname, '..', '..', 'assets', ...p),
  }
})
jest.mock('../main/logger', () => ({ logMain: jest.fn() }))

/* eslint-disable import/first */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  OVERLAY_FONT_EXTS,
  importOverlayFonts,
  listOverlayFonts,
  overlayFontPath,
  overlayFontsDir,
  removeOverlayFont,
} from '../main/overlayFonts'
import {
  registerUserFont,
  renderOverlayPng,
  renderOverlayPreview,
} from '../main/overlayRenderer'
import { config as defaults } from '../constants/defaults'
import { clampOverlayFontSize } from '../lib/overlayStyle'

const BUNDLED = path.join(
  __dirname,
  '..',
  '..',
  'assets',
  'fonts',
  'LiberationMono-Bold.ttf',
)
// A font that is not the bundled one, to show the choice changes the drawing.
// Whatever the machine has; the cases that need it are skipped without one.
const OTHER = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
].find((f) => fs.existsSync(f))
const describeOther = OTHER ? describe : describe.skip

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
let tmp: string
let dir: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-'))
  dir = overlayFontsDir(path.join(tmp, 'userData'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const source = (name: string, from: string | Buffer = BUNDLED) => {
  const file = path.join(tmp, 'downloads', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (typeof from === 'string') fs.copyFileSync(from, file)
  else fs.writeFileSync(file, from)
  return file
}

describe('importing a font', () => {
  it('keeps its own copy, listed by the file name', async () => {
    const res = await importOverlayFonts(dir, [source('My Font-Bold.ttf')])
    expect(res.failed).toEqual([])
    expect(res.imported).toEqual([
      { file: 'My Font-Bold.ttf', name: 'My Font-Bold' },
    ])
    expect(await listOverlayFonts(dir)).toEqual(res.imported)
    // The original can go: the copy is what is used.
    fs.rmSync(path.join(tmp, 'downloads'), { recursive: true })
    const kept = overlayFontPath(dir, 'My Font-Bold.ttf')!
    expect(fs.readFileSync(kept).equals(fs.readFileSync(BUNDLED))).toBe(true)
    expect(registerUserFont(kept)).toMatch(/^OverlayUser_[0-9a-f]{16}$/)
  })

  it('refuses what is not a font, and says why', async () => {
    const res = await importOverlayFonts(dir, [
      source('notes.txt', Buffer.from('hello')),
      source('fake.ttf', Buffer.from('this is not a font at all')),
      source('empty.otf', Buffer.alloc(0)),
      path.join(tmp, 'downloads', 'gone.ttf'),
    ])
    expect(res.imported).toEqual([])
    expect(res.failed.map((f) => f.name)).toEqual([
      'notes.txt',
      'fake.ttf',
      'empty.otf',
      'gone.ttf',
    ])
    expect(res.failed[0].reason).toMatch(/not a font file/)
    expect(res.failed[1].reason).toMatch(/could not be read as a font/)
    expect(await listOverlayFonts(dir)).toEqual([])
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
  })

  it('refuses a file too big to be a font before reading it', async () => {
    const big = source('big.ttf')
    const loads = jest.fn(() => true)
    const realStat = fs.promises.stat
    const spy = jest
      .spyOn(fs.promises, 'stat')
      .mockImplementation(async (p: any, ...rest: any[]) => {
        const st: any = await (realStat as any)(p, ...rest)
        if (p === big) Object.defineProperty(st, 'size', { value: 65 << 20 })
        return st
      })
    const res = await importOverlayFonts(dir, [big], loads)
    spy.mockRestore()
    expect(res.failed[0].reason).toMatch(/too big/)
    expect(loads).not.toHaveBeenCalled()
  })

  it('does not copy the same font twice, and keeps both of two with one name', async () => {
    const first = await importOverlayFonts(dir, [source('Brand.ttf')])
    const again = await importOverlayFonts(dir, [source('Brand.ttf')])
    expect(again.imported).toEqual(first.imported)
    expect(fs.readdirSync(dir)).toEqual(['Brand.ttf'])

    const different = Buffer.concat([
      fs.readFileSync(BUNDLED),
      Buffer.from('changed'),
    ])
    const third = await importOverlayFonts(
      dir,
      [source('Brand.ttf', different)],
      () => true,
    )
    expect(third.imported).toEqual([
      { file: 'Brand (2).ttf', name: 'Brand (2)' },
    ])
    expect(fs.readdirSync(dir).sort()).toEqual(['Brand (2).ttf', 'Brand.ttf'])
  })

  it('lists only fonts, in name order', async () => {
    fs.mkdirSync(dir, { recursive: true })
    for (const name of [
      'b10.ttf',
      'b2.woff2',
      'A.otf',
      'c.ttf.partial',
      '.hidden.ttf',
      'readme.txt',
    ])
      fs.writeFileSync(path.join(dir, name), 'x')
    fs.mkdirSync(path.join(dir, 'folder.ttf'))
    expect((await listOverlayFonts(dir)).map((f) => f.file)).toEqual([
      'A.otf',
      'b2.woff2',
      'b10.ttf',
    ])
    expect(await listOverlayFonts(path.join(tmp, 'nope'))).toEqual([])
  })
})

// Windows cannot hold such a name to begin with.
const describeAwkward = process.platform === 'win32' ? describe.skip : describe
describeAwkward('an awkward file name', () => {
  it('gets a safe one', async () => {
    const res = await importOverlayFonts(
      dir,
      [source('wéird:name*?<>|.OTF')],
      () => true,
    )
    expect(res.imported).toEqual([
      { file: 'wéird_name_____.otf', name: 'wéird_name_____' },
    ])
  })
})

describe('the chosen font', () => {
  it('is only ever a font file inside the folder', () => {
    expect(overlayFontPath(dir, 'Brand.ttf')).toBe(path.join(dir, 'Brand.ttf'))
    for (const bad of [
      '',
      null,
      undefined,
      '../../etc/passwd',
      '../outside.ttf',
      'sub/inner.ttf',
      path.join(tmp, 'elsewhere.ttf'),
      'script.exe',
      '.hidden.ttf',
      5 as any,
    ])
      expect(overlayFontPath(dir, bad)).toBeNull()
  })

  it('every listed kind is accepted by name', () => {
    for (const ext of OVERLAY_FONT_EXTS)
      expect(overlayFontPath(dir, `Font${ext.toUpperCase()}`)).not.toBeNull()
  })

  it('removing deletes the copy and nothing else', async () => {
    await importOverlayFonts(dir, [source('Brand.ttf')])
    const outside = source('outside.ttf')
    expect(await removeOverlayFont(dir, '../downloads/outside.ttf')).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
    expect(await removeOverlayFont(dir, 'Brand.ttf')).toBe(true)
    expect(await listOverlayFonts(dir)).toEqual([])
    expect(await removeOverlayFont(dir, 'Brand.ttf')).toBe(false)
  })

  it('a new install uses the bundled font', () => {
    expect(defaults.overlayFont).toBe('')
  })
})

describe('drawing the label', () => {
  const text = '2026-11-15 14:02 - Fox vs Marth'

  it('the preview is a small picture of the label', () => {
    const png = renderOverlayPreview(text)!
    expect(png.subarray(0, 4).equals(PNG)).toBe(true)
    // PNG header: width and height at bytes 16 and 20.
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)]
    expect(w).toBeGreaterThan(200)
    expect(w).toBeLessThan(1000)
    expect(h).toBeGreaterThan(20)
    expect(h).toBeLessThan(80)
    expect(renderOverlayPreview('   ')).toBeNull()
  })

  const sizeOf = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)]

  it('the default size draws what it always has', () => {
    const normal = renderOverlayPreview(text)!
    expect(renderOverlayPreview(text, { fontSize: 24 })!.equals(normal)).toBe(
      true,
    )
    expect(defaults.overlayFontSize).toBe(24)
    // A stored value that is not a size is the default, never a crash.
    for (const bad of [null, undefined, NaN, 'big' as any])
      expect(
        renderOverlayPreview(text, { fontSize: bad })!.equals(normal),
      ).toBe(true)
  })

  it('a bigger size is the same label, bigger', () => {
    const [w, h] = sizeOf(renderOverlayPreview(text)!)
    const [w2, h2] = sizeOf(renderOverlayPreview(text, { fontSize: 48 })!)
    // 6 px of clear margin right of and below the label; the label doubles.
    expect((w2 - 6) / (w - 6)).toBeGreaterThan(1.9)
    expect((w2 - 6) / (w - 6)).toBeLessThan(2.1)
    expect((h2 - 6) / (h - 6)).toBeGreaterThan(1.8)
    expect((h2 - 6) / (h - 6)).toBeLessThan(2.2)
    const [ws, hs] = sizeOf(renderOverlayPreview(text, { fontSize: 12 })!)
    expect(ws).toBeLessThan(w)
    expect(hs).toBeLessThan(h)
  })

  it('a size outside the range is brought into it', () => {
    expect(clampOverlayFontSize(4)).toBe(10)
    expect(clampOverlayFontSize(999)).toBe(120)
    expect(clampOverlayFontSize('36')).toBe(36)
    expect(clampOverlayFontSize(30.6)).toBe(31)
    expect(clampOverlayFontSize(undefined)).toBe(24)
    expect(
      renderOverlayPreview(text, { fontSize: 5000 })!.equals(
        renderOverlayPreview(text, { fontSize: 120 })!,
      ),
    ).toBe(true)
  })

  it('text too long for the video is made smaller until it fits', () => {
    const long = 'Grand Finals - '.repeat(12).trim()
    const [, shortH] = sizeOf(renderOverlayPreview('Fox', { fontSize: 120 })!)
    const [longW, longH] = sizeOf(
      renderOverlayPreview(long, { fontSize: 120 })!,
    )
    expect(longW).toBeLessThanOrEqual(1920)
    expect(longH).toBeLessThan(shortH * 0.7)
  })

  it('a font that is gone or broken falls back to the bundled one', () => {
    const normal = renderOverlayPreview(text)!
    expect(
      renderOverlayPreview(text, {
        fontPath: path.join(dir, 'gone.ttf'),
      })!.equals(normal),
    ).toBe(true)
    const broken = source('broken.ttf', Buffer.from('nope'))
    expect(registerUserFont(broken)).toBeNull()
    expect(
      renderOverlayPreview(text, { fontPath: broken })!.equals(normal),
    ).toBe(true)
  })
})

describeOther('drawing the label in an imported font', () => {
  const text = '2026-11-15 14:02 - Fox vs Marth'

  it('changes the preview', async () => {
    const res = await importOverlayFonts(dir, [OTHER!])
    expect(res.failed).toEqual([])
    const font = overlayFontPath(dir, res.imported[0].file)
    const mine = renderOverlayPreview(text, { fontPath: font })!
    expect(mine.subarray(0, 4).equals(PNG)).toBe(true)
    expect(mine.equals(renderOverlayPreview(text)!)).toBe(false)
  })

  it('and the recording, at the video size', async () => {
    const res = await importOverlayFonts(dir, [OTHER!])
    const font = overlayFontPath(dir, res.imported[0].file)
    const a = path.join(tmp, 'default.png')
    const b = path.join(tmp, 'mine.png')
    expect(await renderOverlayPng(text, 1280, 720, 'bottom-left', a)).toBe(true)
    expect(
      await renderOverlayPng(text, 1280, 720, 'bottom-left', b, {
        fontPath: font,
      }),
    ).toBe(true)
    const [pa, pb] = [fs.readFileSync(a), fs.readFileSync(b)]
    expect([pb.readUInt32BE(16), pb.readUInt32BE(20)]).toEqual([1280, 720])
    expect(pa.equals(pb)).toBe(false)
    expect(await renderOverlayPng('', 1280, 720, 'bottom-left', a)).toBe(false)
  })
})
