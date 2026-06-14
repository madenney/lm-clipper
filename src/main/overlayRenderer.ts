import { promises as fsPromises } from 'fs'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { OverlayPosition } from '../constants/types'
import { getAssetPath } from './util'
import { logMain } from './logger'

/**
 * Burned-in video overlay renderer. Ports the look of the replay_archiver
 * overlay (white Courier Bold in a dark rounded box, bottom-left) and the
 * resolution-independent scaling of video_tools (every dimension scales off a
 * 1920x1080 base). Draws a transparent PNG at the video's exact resolution
 * which is then composited with ffmpeg's `overlay` filter in slpToVideo.
 */

// Base geometry constants from video_tools/generate_overlay.py (1920x1080 base)
const BASE_WIDTH = 1920
const BASE_HEIGHT = 1080
const BASE_FONT_SIZE = 24
const BASE_LEFT_MARGIN = 7
const BASE_RIGHT_MARGIN = 6
const BASE_EDGE_MARGIN = 5
const BASE_TEXT_OFFSET_Y = -1
const BASE_PADDING_X = 4
const BASE_PADDING_Y = 2
const BASE_RECT_OUTER = 10
const BASE_RECT_INNER = 4
const BASE_RECT_TOP = 3
const BASE_RECT_BOTTOM = 5
const BOX_COLOR = '#202020'
const TEXT_COLOR = '#FFFFFF'
const CORNER_RADIUS = 2
const FONT_FAMILY = 'OverlayCourierBold'

let fontRegistered = false

/** Register the bundled Courier Bold font once. Safe to call repeatedly. */
export function registerOverlayFont(): boolean {
  if (fontRegistered) return true
  try {
    const fontPath = getAssetPath('fonts', 'cour_bold.ttf')
    const ok = Boolean(GlobalFonts.registerFromPath(fontPath, FONT_FAMILY))
    fontRegistered = ok
    if (!ok) logMain('overlay: font registration returned false', { fontPath })
    return ok
  } catch (err) {
    logMain('overlay: font registration failed', err)
    return false
  }
}

const round = (v: number) => Math.round(v)

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
): Promise<boolean> {
  const trimmed = (text || '').trim()
  if (!trimmed || width <= 0 || height <= 0) return false

  registerOverlayFont()

  const scaleX = width / BASE_WIDTH
  const scaleY = height / BASE_HEIGHT
  const fontSize = Math.max(1, round(BASE_FONT_SIZE * scaleY))
  const paddingX = round(BASE_PADDING_X * scaleX)
  const paddingY = round(BASE_PADDING_Y * scaleY)
  const textOffsetY = round(BASE_TEXT_OFFSET_Y * scaleY)
  const leftMargin = round(BASE_LEFT_MARGIN * scaleX)
  const rightMargin = round(BASE_RIGHT_MARGIN * scaleX)
  const edgeMargin = round(BASE_EDGE_MARGIN * scaleY)
  const rectOuter = round(BASE_RECT_OUTER * scaleX)
  const rectInner = round(BASE_RECT_INNER * scaleX)
  const rectTop = round(BASE_RECT_TOP * scaleY)
  const rectBottom = round(BASE_RECT_BOTTOM * scaleY)

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.font = `${fontSize}px ${FONT_FAMILY}`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  const metrics = ctx.measureText(trimmed)
  const ascent =
    metrics.actualBoundingBoxAscent || metrics.fontBoundingBoxAscent || fontSize
  const descent =
    metrics.actualBoundingBoxDescent ||
    metrics.fontBoundingBoxDescent ||
    fontSize * 0.25
  const textWidth = Math.ceil(metrics.width)
  const textHeight = Math.ceil(ascent + descent)

  const isRight = position === 'bottom-right' || position === 'top-right'
  const isTop = position === 'top-left' || position === 'top-right'

  // Top-left corner of the text (PIL-style coordinates)
  const x = isRight ? width - textWidth - rightMargin - rectInner : leftMargin
  const y = isTop
    ? edgeMargin + rectTop
    : height - textHeight - edgeMargin + textOffsetY

  // Background rounded rectangle around the text
  const rectX0 = x - rectOuter - paddingX
  const rectY0 = y - rectTop - paddingY
  const rectX1 = x + textWidth + rectInner + paddingX
  const rectY1 = y + textHeight + rectBottom + paddingY

  ctx.fillStyle = BOX_COLOR
  ctx.beginPath()
  ctx.roundRect(rectX0, rectY0, rectX1 - rectX0, rectY1 - rectY0, CORNER_RADIUS)
  ctx.fill()

  // Draw text (baseline sits ascent px below the top-left y)
  ctx.fillStyle = TEXT_COLOR
  ctx.fillText(trimmed, x, y + ascent)

  const buffer = canvas.toBuffer('image/png')
  await fsPromises.writeFile(outPath, buffer)
  return true
}
