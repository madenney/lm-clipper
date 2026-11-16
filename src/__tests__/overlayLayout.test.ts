/**
 * The overlay label's layout, checked on the pixels a recording gets (the
 * owner's rules, 2026-11-15): the capitals sit in the middle of the box (as
 * much room above them as below the baseline), the box touches the video's
 * edges on the sides it is anchored to, descenders stay inside it, and its
 * height does not depend on what the label says.
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
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { renderOverlayPng } from '../main/overlayRenderer'
import type { OverlayPosition } from '../constants/types'

// Other fonts when the machine has them (very different metrics: a serif, a
// font with a deep descent, an all-capitals display face, a script).
const EXTRA_FONTS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
  '/usr/share/fonts-sil-annapurna/woff2/AnnapurnaSIL-Bold.woff2',
  '/usr/share/fonts/opentype/urw-base35/Z003-MediumItalic.otf',
  '/usr/share/fonts/truetype/tlwg/Purisa-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
].filter((f) => fs.existsSync(f))
const FONTS: (string | null)[] = [null, ...EXTRA_FONTS]
const POSITIONS: OverlayPosition[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]
// 1080p, 1x native, 3x, widescreen off at 2x, 4x.
const VIDEOS: [number, number][] = [
  [1920, 1080],
  [940, 528],
  [2816, 1584],
  [1286, 1056],
  [3756, 2112],
]

let tmp: string
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-'))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

let drawn = 0
jest.setTimeout(120000)

type Bounds = { top: number; bottom: number; left: number; right: number }
type Seen = { width: number; height: number; box: Bounds; ink: Bounds }

/** Render a label and find the box (anything drawn) and the ink (the white text). */
async function draw(
  text: string,
  width: number,
  height: number,
  position: OverlayPosition,
  fontSize: number,
  fontPath: string | null = null,
): Promise<Seen> {
  drawn += 1
  const file = path.join(tmp, `label-${drawn}.png`)
  expect(
    await renderOverlayPng(text, width, height, position, file, {
      fontPath,
      fontSize,
    }),
  ).toBe(true)
  const image = await loadImage(fs.readFileSync(file))
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  fs.unlinkSync(file)
  const none = (): Bounds => ({ top: -1, bottom: -1, left: width, right: -1 })
  const box = none()
  const ink = none()
  const grow = (b: Bounds, x: number, y: number) => {
    if (b.top < 0) b.top = y
    b.bottom = y
    if (x < b.left) b.left = x
    if (x > b.right) b.right = x
  }
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      if (data[i + 3] > 128) {
        grow(box, x, y)
        if (data[i] > 150) grow(ink, x, y)
      }
    }
  return { width, height, box, ink }
}

const isTop = (p: OverlayPosition) => p.startsWith('top')
const isLeft = (p: OverlayPosition) => p.endsWith('left')

/** Rows of box above the ink and below it. */
const room = (s: Seen) => ({
  above: s.ink.top - s.box.top,
  below: s.box.bottom - s.ink.bottom,
})

describe.each(FONTS)('font %s', (fontPath) => {
  describe.each(VIDEOS)('on a %ix%i video', (width, height) => {
    it.each(POSITIONS)(
      '%s: capitals centred, box on the edges',
      async (pos) => {
        const wrong: string[] = []
        for (const size of [10, 24, 48, 120]) {
          // eslint-disable-next-line no-await-in-loop
          const s = await draw('HHH', width, height, pos, size, fontPath)
          const capHeight = s.ink.bottom - s.ink.top + 1
          const { above, below } = room(s)
          const where = `size ${size}`
          // As much room above the capitals as below the baseline (a pixel of
          // rounding, a little more on very large text).
          if (Math.abs(above - below) > Math.max(1, capHeight * 0.04))
            wrong.push(`${where}: ${above} px above the text, ${below} below`)
          if (above <= 0) wrong.push(`${where}: no room above the text`)
          // No gap between the box and the video's edges it is anchored to.
          const edgeY = isTop(pos) ? s.box.top : height - 1 - s.box.bottom
          const edgeX = isLeft(pos) ? s.box.left : width - 1 - s.box.right
          if (edgeY !== 0) wrong.push(`${where}: ${edgeY} px gap, top/bottom`)
          if (edgeX !== 0) wrong.push(`${where}: ${edgeX} px gap at the side`)
          // And the box does not run across the whole video.
          if (s.box.right - s.box.left >= width - 1)
            wrong.push(`${where}: the box spans the whole width`)
        }
        expect(wrong).toEqual([])
      },
    )
  })

  it('descenders stay inside the box, and the box is the same height whatever the text', async () => {
    for (const pos of POSITIONS)
      for (const size of [16, 24, 72]) {
        // eslint-disable-next-line no-await-in-loop
        const caps = await draw('HHH', 1920, 1080, pos, size, fontPath)
        // eslint-disable-next-line no-await-in-loop
        const deep = await draw('gypsy jpq', 1920, 1080, pos, size, fontPath)
        // eslint-disable-next-line no-await-in-loop
        const digits = await draw(
          '2026-11-15 19:55',
          1920,
          1080,
          pos,
          size,
          fontPath,
        )
        expect(deep.box.bottom).toBeGreaterThan(deep.ink.bottom)
        expect(deep.ink.top).toBeGreaterThan(deep.box.top)
        const h = (s: Seen) => s.box.bottom - s.box.top
        expect([h(deep), h(digits)]).toEqual([h(caps), h(caps)])
      }
  })
})

it('takes the same share of the picture at every resolution', async () => {
  const share = async (width: number, height: number) => {
    const s = await draw('HHH 2026', width, height, 'top-left', 24)
    return (s.box.bottom + 1) / height
  }
  const at1080 = await share(1920, 1080)
  for (const [w, h] of VIDEOS)
    // eslint-disable-next-line no-await-in-loop
    // Within a few pixels on the smallest video (a row is 0.2% of 528).
    expect(Math.abs((await share(w, h)) - at1080)).toBeLessThan(0.006)
})
