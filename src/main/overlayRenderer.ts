import crypto from 'crypto'
import fs, { promises as fsPromises } from 'fs'
import { createCanvas, GlobalFonts, type Canvas } from '@napi-rs/canvas'
import { OverlayPosition } from '../constants/types'
import {
  OVERLAY_FONT_SIZE_DEFAULT,
  clampOverlayFontSize,
} from '../lib/overlayStyle'
import { getAssetPath } from './util'
import { logMain } from './logger'

/**
 * Burned-in video overlay renderer: white text in a dark box in one corner of
 * the video (the look of the replay_archiver overlay). Every measure scales off
 * a 1920x1080 base, so the label takes the same share of the picture at any
 * resolution. Draws a transparent PNG at the video's exact resolution, which
 * ffmpeg's `overlay` filter composites in slpToVideo.
 *
 * Layout rules (the owner's, 2026-11-15):
 *  - The text sits in the middle of the box: the space above the capitals
 *    equals the space below the baseline. It is measured from the font (the
 *    height of "H"), not from the words, so the box and the baseline are the
 *    same for every clip of a video whatever each label says.
 *  - The box touches the video's edges on the sides it is anchored to (top or
 *    bottom, left or right): it runs past them, so there is never a gap.
 */

// Base geometry (1920x1080, text size 24). All scale with the video and the size.
const BASE_WIDTH = 1920
const BASE_HEIGHT = 1080
// The size the geometry below was tuned for; the user's size (Settings) scales
// the box with the text.
const BASE_FONT_SIZE = OVERLAY_FONT_SIZE_DEFAULT
// A label too wide for the video is drawn smaller until it fits, down to this.
const MIN_FITTED_FONT_PX = 6
// Video edge to the text, on the side the label is anchored to.
const BASE_INSET_X = 7
// The text to the box's free end.
const BASE_END_PAD_X = 8
// Above the capitals and below the baseline, at least this much.
const BASE_PAD_Y = 6
// The least room between any ink (a descender, an accent) and the box's edge.
const BASE_INK_GAP = 2
const BASE_CORNER_RADIUS = 2
const BOX_COLOR = '#202020'
const TEXT_COLOR = '#FFFFFF'
// Everything plain text is made of: the box leaves room for the tallest and the
// deepest of these whether or not this label has them, so it never changes
// height between clips.
const TALL_AND_DEEP =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789()[],;:_-|/'
const FONT_FAMILY = 'OverlayMonoBold'

let fontRegistered = false

/** Register the bundled Liberation Mono Bold font (SIL OFL 1.1, assets/PROVENANCE.md) once. Safe to call repeatedly. */
export function registerOverlayFont(): boolean {
  if (fontRegistered) return true
  try {
    const fontPath = getAssetPath('fonts', 'LiberationMono-Bold.ttf')
    const ok = Boolean(GlobalFonts.registerFromPath(fontPath, FONT_FAMILY))
    fontRegistered = ok
    if (!ok) logMain('overlay: font registration returned false', { fontPath })
    return ok
  } catch (err) {
    logMain('overlay: font registration failed', err)
    return false
  }
}

// A font the user imported (Settings > Overlay), registered under a name of its
// own. The key holds the file's size and time, so a file replaced under the same
// name is registered again instead of the old one being reused.
const userFamilies = new Map<string, string | null>()

/**
 * The family name to draw with for a font file, registering it on first use;
 * null when the file is missing or is not a font the canvas can read.
 */
export function registerUserFont(fontPath: string): string | null {
  let key = ''
  try {
    const st = fs.statSync(fontPath)
    if (!st.isFile()) return null
    key = `${fontPath}|${st.size}|${st.mtimeMs}`
  } catch {
    return null
  }
  const known = userFamilies.get(key)
  if (known !== undefined) return known
  const family = `OverlayUser_${crypto
    .createHash('sha1')
    .update(key)
    .digest('hex')
    .slice(0, 16)}`
  let ok = false
  try {
    ok = Boolean(GlobalFonts.registerFromPath(fontPath, family))
  } catch (err) {
    logMain('overlay: could not read font', { fontPath, err: String(err) })
  }
  userFamilies.set(key, ok ? family : null)
  return ok ? family : null
}

/**
 * The family to draw with: the user's font when one is chosen and loads, the
 * bundled one otherwise (a deleted or broken font never stops a recording).
 */
function overlayFamily(fontPath?: string | null): string {
  registerOverlayFont()
  return (fontPath && registerUserFont(fontPath)) || FONT_FAMILY
}

const round = (v: number) => Math.round(v)

type OverlayBox = { x0: number; y0: number; x1: number; y1: number }

/** How the label is styled: the user's font (or the bundled one) and size. */
export type OverlayStyle = {
  /** A font the user imported; without it, or when it cannot be read, the bundled font. */
  fontPath?: string | null
  /** Text size in pixels on a 1080p video (lib/overlayStyle.ts); 24 by default. */
  fontSize?: number | null
}

type Ctx2d = ReturnType<Canvas['getContext']>

/** A measurement the canvas really gave (0 is a real answer: text with no descender). */
const measured = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * Where everything goes for one text size (`size1080`: pixels on a 1080p
 * video). A bigger or smaller size is the same label zoomed about its corner.
 */
function layoutOverlay(
  ctx: Ctx2d,
  text: string,
  width: number,
  height: number,
  position: OverlayPosition,
  family: string,
  size1080: number,
) {
  const k = size1080 / BASE_FONT_SIZE
  const scaleX = (width / BASE_WIDTH) * k
  const scaleY = (height / BASE_HEIGHT) * k
  const fontSize = Math.max(1, round(BASE_FONT_SIZE * scaleY))

  ctx.font = `${fontSize}px ${family}`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  const words = ctx.measureText(text)
  const textWidth = Math.ceil(words.width)
  // Whole rows of ink above and below the baseline (what a glyph drawn on a
  // whole-pixel baseline covers).
  const rows = (v: number | undefined) => Math.ceil(measured(v, 0) - 0.01)
  // The capitals, which the text is centred on: the rows "H" really covers.
  // Usually from the baseline up; some fonts sit a little above or below it.
  const cap = ctx.measureText('H')
  const capUp = Math.max(
    1,
    rows(cap.actualBoundingBoxAscent) || round(fontSize * 0.7),
  )
  const capDown = Math.min(rows(cap.actualBoundingBoxDescent), capUp - 1)
  const reach = ctx.measureText(TALL_AND_DEEP)
  const gap = Math.ceil(BASE_INK_GAP * scaleY)
  // Equal room above the capitals and below them: the base padding, or more
  // when this font's tallest or deepest letters (or this text's own ink: an
  // accent, a glyph from another script) need it to stay inside the box.
  const padY = Math.max(
    Math.ceil(BASE_PAD_Y * scaleY),
    rows(reach.actualBoundingBoxDescent) - capDown + gap,
    rows(reach.actualBoundingBoxAscent) - capUp + gap,
    rows(words.actualBoundingBoxDescent) - capDown + gap,
    rows(words.actualBoundingBoxAscent) - capUp + gap,
  )
  const insetX = round(BASE_INSET_X * scaleX)
  const endPadX = round(BASE_END_PAD_X * scaleX)
  const radius = Math.max(1, round(BASE_CORNER_RADIUS * scaleY))
  // Past the anchored edges by more than the corner radius: the box meets the
  // video's edge square, with no gap and no rounded notch.
  const bleed = radius + 2

  const isRight = position === 'bottom-right' || position === 'top-right'
  const isTop = position === 'top-left' || position === 'top-right'

  const x = isRight ? width - insetX - textWidth : insetX
  // The capitals cover rows [baseline - capUp, baseline + capDown): padY rows of
  // box above them and padY below, the video's edge being one side of the box.
  const baseline = isTop ? padY + capUp : height - padY - capDown
  const box: OverlayBox = {
    x0: isRight ? x - endPadX : -bleed,
    x1: isRight ? width + bleed : x + textWidth + endPadX,
    y0: isTop ? -bleed : baseline - capUp - padY,
    y1: isTop ? baseline + capDown + padY : height + bleed,
  }
  return {
    box,
    x,
    baseline,
    radius,
    // The width the label needs between the video's edges.
    needed: insetX + textWidth + endPadX,
  }
}

/**
 * Draw the overlay for a width x height video onto `ctx` and return the part
 * of the box that is on the video. Text too wide for the video is drawn smaller
 * until it fits. `measureOnly` leaves the canvas untouched (the preview sizes
 * itself with it first).
 */
function drawOverlay(
  ctx: Ctx2d,
  text: string,
  width: number,
  height: number,
  position: OverlayPosition,
  family: string,
  size1080: number,
  measureOnly = false,
): OverlayBox {
  let size = size1080
  let layout = layoutOverlay(ctx, text, width, height, position, family, size)
  const minSize = (MIN_FITTED_FONT_PX * BASE_HEIGHT) / Math.max(1, height)
  for (let tries = 0; tries < 8 && layout.needed > width; tries += 1) {
    if (size <= minSize) break
    size = Math.max(minSize, size * (width / layout.needed) * 0.99)
    layout = layoutOverlay(ctx, text, width, height, position, family, size)
  }
  const { box, x, baseline, radius } = layout
  const visible: OverlayBox = {
    x0: Math.max(0, box.x0),
    y0: Math.max(0, box.y0),
    x1: Math.min(width, box.x1),
    y1: Math.min(height, box.y1),
  }
  if (measureOnly) return visible

  ctx.fillStyle = BOX_COLOR
  ctx.beginPath()
  ctx.roundRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, radius)
  ctx.fill()

  ctx.fillStyle = TEXT_COLOR
  ctx.fillText(text, x, baseline)
  return visible
}

/**
 * Render the overlay text to a transparent PNG at width x height and write it
 * to outPath. Returns true on success. Empty text is a no-op (returns false).
 */
export async function renderOverlayPng(
  text: string,
  width: number,
  height: number,
  position: OverlayPosition,
  outPath: string,
  style: OverlayStyle = {},
): Promise<boolean> {
  const trimmed = (text || '').trim()
  if (!trimmed || width <= 0 || height <= 0) return false

  const canvas = createCanvas(width, height)
  drawOverlay(
    canvas.getContext('2d'),
    trimmed,
    width,
    height,
    position,
    overlayFamily(style.fontPath),
    clampOverlayFontSize(style.fontSize ?? OVERLAY_FONT_SIZE_DEFAULT),
  )
  await fsPromises.writeFile(outPath, canvas.toBuffer('image/png'))
  return true
}

// Clear room right of and below the label in the preview picture. Its left and
// top are the video's own edges, which the box touches, so there is none there.
const PREVIEW_PAD = 6

/**
 * The overlay as it is burned into the top-left corner of a 1080p video,
 * cropped to the label: what Settings shows, drawn by the same code as a
 * recording. A PNG, or null for empty text.
 */
export function renderOverlayPreview(
  text: string,
  style: OverlayStyle = {},
): Buffer | null {
  const trimmed = (text || '').trim().slice(0, 300)
  if (!trimmed) return null
  const family = overlayFamily(style.fontPath)
  const size = clampOverlayFontSize(style.fontSize ?? OVERLAY_FONT_SIZE_DEFAULT)
  const probe = createCanvas(8, 8).getContext('2d')
  const box = drawOverlay(
    probe,
    trimmed,
    BASE_WIDTH,
    BASE_HEIGHT,
    'top-left',
    family,
    size,
    true,
  )
  const width = Math.min(BASE_WIDTH, box.x1 + PREVIEW_PAD)
  const height = Math.min(BASE_HEIGHT, box.y1 + PREVIEW_PAD)
  const canvas = createCanvas(Math.max(1, width), Math.max(1, height))
  drawOverlay(
    canvas.getContext('2d'),
    trimmed,
    BASE_WIDTH,
    BASE_HEIGHT,
    'top-left',
    family,
    size,
  )
  return canvas.toBuffer('image/png')
}
