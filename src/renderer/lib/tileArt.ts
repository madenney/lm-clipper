/**
 * The far-out view's tile art (docs/tray-v2.md): what the GPU (and the CPU
 * fallback) draw a clip with from ~24 px up to the DOM grid, so 40-120 px tiles
 * look like the grid's cards without one DOM element per clip.
 *
 *  - icons: the default-costume character icons plus the two arrows and a
 *    "vs", one image of ICON_CELL squares (ICON_COLS per row);
 *  - stages: every stage picture cropped square like the card's `object-fit:
 *    cover`, stacked top to bottom (one texture-array layer each);
 *  - STAGE_INFO: per stage id, its layer;
 *  - CARD_LAYOUTS: where the icons go, per kind of step (arrow, versus).
 *
 * Built once per session (the view remounts each time the zoom crosses the grid)
 * and shared by every view. Geometry mirrors Clip.css so the switch to the DOM
 * grid at 120 px doesn't jump.
 */
import type { PlayerInterface } from '../../constants/types'
import {
  arrowImages,
  resolveCharacterImage,
  resolveStageImage,
} from './clipAssets'
import { clamp01 } from '../../lib/format'

export const ICON_CELL = 64
export const ICON_COLS = 8
export const NUM_CHARS = 26
/** Atlas cells after the characters: the card's arrow, dark and light, and
 *  the "vs" between a game's players. */
export const ARROW_DARK = NUM_CHARS
export const ARROW_LIGHT = NUM_CHARS + 1
export const VS_CELL = NUM_CHARS + 2
export const ICON_ROWS = Math.ceil((NUM_CHARS + 3) / ICON_COLS)
/** One stage picture's side in the stage layers (tiles go up to 120 px, x2 for HiDPI). */
export const STAGE_CELL = 256
export const STAGE_IDS = 64

/** A rectangle in tile fractions: [left, top, right, bottom]. */
export type Rect = [number, number, number, number]

/**
 * How a card places its two icons, by what the step's rows are:
 *  - arrow: combos, edgeguards, highlights, pressure, phantoms (char1 -> char2);
 *  - versus: a game (the Replays step) or any row without a direction.
 */
export type CardLayout = 'arrow' | 'versus'
/** The shader's number for each layout (uLayout). */
export const CARD_LAYOUT_IDS: Record<CardLayout, number> = {
  arrow: 0,
  versus: 1,
}

export type CardIcons = {
  /** The attacker (or a game's first player), on the left. */
  char1: Rect
  /** The victim (or the second player), on the right. */
  char2: Rect
  /** What sits between them: the arrow or the "vs", its atlas cell and opacity. */
  mid: Rect
  midCell: number
  midAlpha: number
  /** The dark rounded backing behind all three, so they read on bright stages. */
  chip: Rect
  /** The backing's corner radius, in tile fractions (a pill). */
  chipRadius: number
}

/** The arrow's opacity (the light arrow: every card's backing is dark). */
export const ARROW_ALPHA = 0.8

/**
 * Where a card puts its icons. Clip.tsx places the DOM card's icons from these
 * and the GPU and CPU tiles below 120 px draw them from these, so crossing
 * 120 px doesn't jump. Both: two equal 26% icons, 22% from the top, centred,
 * on one dark pill. arrow: a 9% arrow 3% from each icon, on their middle line.
 * versus: a "vs" in a 20% square centred on the 15% between the icons (its
 * edges run under the icons' transparent margins), so the letters are big and
 * the glyph still fits its atlas cell whole.
 */
export const CARD_LAYOUTS: Record<CardLayout, CardIcons> = (() => {
  const char = 0.26
  const arrow = 0.09
  const gap = 0.03
  const top = 0.22
  const left = (1 - (char * 2 + arrow + gap * 2)) / 2
  const a = left + char + gap
  const b = a + arrow + gap
  const at = top + (char - arrow) / 2
  const char1: Rect = [left, top, left + char, top + char]
  const char2: Rect = [b, top, b + char, top + char]
  const chip: Rect = [0.135, 0.19, 0.865, 0.51]
  const chipRadius = (chip[3] - chip[1]) / 2
  const vs = 0.2
  const vl = (left + char + b - vs) / 2 // centred on the space between the icons
  const vt = top + (char - vs) / 2
  return {
    arrow: {
      char1,
      char2,
      mid: [a, at, a + arrow, at + arrow],
      midCell: ARROW_LIGHT,
      midAlpha: ARROW_ALPHA,
      chip,
      chipRadius,
    },
    versus: {
      char1,
      char2,
      mid: [vl, vt, vl + vs, vt + vs],
      midCell: VS_CELL,
      midAlpha: 1,
      chip,
      chipRadius,
    },
  }
})()

/**
 * The "vs" glyph: its font size as a share of the vs rect's side, its weight
 * and its dark outline (a share of the font size), so it stands out.
 */
export const VS_FONT = 0.555
export const VS_WEIGHT = 900
export const VS_STROKE = 0.12

/**
 * Filter types whose rows a step's cards take their layout from: the nearest
 * one at or above the step decides (a Sort under a combo parser shows combos).
 */
const PRODUCER_LAYOUT: Record<string, CardLayout> = {
  files: 'versus',
  slpParser: 'arrow',
  lunarClips: 'arrow',
  earlyQuitOut: 'arrow',
  highlight: 'arrow',
  phantom: 'arrow',
  pressure: 'arrow',
  edgeguard: 'arrow',
}

/** The card layout of the step at `index` in a project's filter list. */
export function cardLayoutForStep(
  filters: readonly { type: string }[] | undefined,
  index: number,
): CardLayout {
  if (!filters) return 'versus'
  for (let i = Math.min(index, filters.length - 1); i >= 0; i -= 1) {
    const layout = PRODUCER_LAYOUT[filters[i].type]
    if (layout) return layout
  }
  return 'versus'
}

/**
 * The card's look beyond the icons, shared by the GPU and CPU drawings so the
 * switch to the DOM grid at 120 px doesn't jump: the stage is dimmed
 * (dimAt), the info strip covers the bottom `strip` of the card
 * (fading in with the tile size: no text is drawn below 120 px), the edge is
 * a quiet line, hover a light 1 px edge and the selection a 3 px blue edge
 * over a light blue tint.
 */
export const CARD_LOOK = {
  /** The stage's dimming: dimColor over it, `dimTop` opaque at the top,
   *  `dimMid` at 60% down, `dimBottom` at the bottom (Clip.css .clip-bg::after).
   *  Light enough that stages stay recognisable (Battlefield vs FD): the icons
   *  have their own backing and the text its own strip. */
  dimColor: [9 / 255, 12 / 255, 10 / 255] as const,
  dimTop: 0.3,
  dimMid: 0.36,
  dimBottom: 0.6,
  strip: 0.21,
  stripAlpha: 0.92,
  /** Tile sizes (CSS px) over which the strip fades in. */
  stripFrom: 56,
  stripTo: 96,
  stripColor: [10 / 255, 14 / 255, 12 / 255] as const,
  chipColor: [6 / 255, 9 / 255, 7 / 255] as const,
  chipAlpha: 0.66,
  edgeColor: [0x2f / 255, 0x3a / 255, 0x34 / 255] as const,
  selectColor: [0x4c / 255, 0x8d / 255, 1] as const,
  hoverColor: [227 / 255, 236 / 255, 230 / 255] as const,
  hoverAlpha: 0.55,
  selectTint: 0.16,
  /** Corner radius, CSS px (Clip.css .clip--mode2 border-radius). */
  radius: 6,
  /** The tone ring (Clip.css .clip--tone-kill / -hot .clip-accent): a kill
   *  red, a standout edgeguard gold, `ringAlpha` over the card, `ringWidth`
   *  CSS px wide just inside the card's 1 px edge. */
  killColor: [229 / 255, 72 / 255, 77 / 255] as const,
  hotColor: [227 / 255, 179 / 255, 65 / 255] as const,
  ringAlpha: 0.85,
  ringWidth: 1.5,
  /** Tile sizes (CSS px) over which the ring gives way to tinting the whole
   *  tile (a 1.5 px ring on a 4 px tile can't be seen; a red pixel can). */
  tintFrom: 6,
  tintTo: 4.5,
}

/** How dark the dimming is at `y` (0 = top of the card, 1 = bottom). Far out
 *  the tiles are thumbnails: the stage's colour is the cue, so the GPU view
 *  dims half as much there and reaches the card's dimming with the strip
 *  (dimScale). */
export const dimAt = (y: number): number =>
  y < 0.6
    ? CARD_LOOK.dimTop + ((CARD_LOOK.dimMid - CARD_LOOK.dimTop) * y) / 0.6
    : CARD_LOOK.dimMid +
      ((CARD_LOOK.dimBottom - CARD_LOOK.dimMid) * (y - 0.6)) / 0.4

/** The share of the card's dimming a tile with this much strip gets. */
export const dimScale = (strip: number): number => 0.5 + 0.5 * strip

/** How much of the info strip a tile of this size (CSS px) shows (0..1). */
export const stripAmount = (tileCss: number): number =>
  Math.max(
    0,
    Math.min(
      1,
      (tileCss - CARD_LOOK.stripFrom) /
        (CARD_LOOK.stripTo - CARD_LOOK.stripFrom),
    ),
  )

/**
 * How a tile of this size (CSS px) is drawn: `icons` fades in the attacker's
 * icon over the stage colour (10-18 px), `card` fades in the card look (stage
 * art, both icons, backing, border) from 24 to 32 px, `strip` the card's empty
 * info strip (stripAmount). A kill / standout clip has the card's thin ring
 * (`ring`) down to 6 px; below that the ring fades into tinting the whole
 * tile (`tint`), which also colours the several-clips-per-pixel blend.
 */
export function tileLook(tileCss: number): {
  icons: number
  card: number
  strip: number
  ring: number
  tint: number
} {
  const tint = clamp01(
    (CARD_LOOK.tintFrom - tileCss) / (CARD_LOOK.tintFrom - CARD_LOOK.tintTo),
  )
  return {
    icons: clamp01((tileCss - 10) / 8),
    card: clamp01((tileCss - 24) / 8),
    strip: stripAmount(tileCss),
    ring: 1 - tint,
    tint,
  }
}

/** Overview tones (main/overview.ts TONE_*): top two bits of the first byte. */
export const TONE_KILL = 1
export const TONE_HOT = 2

/** A tone's ring colour, or null for none. */
export const toneColor = (tone: number) =>
  tone === TONE_KILL
    ? CARD_LOOK.killColor
    : tone === TONE_HOT
      ? CARD_LOOK.hotColor
      : null

/**
 * How much of the pixel [e - 0.5, e + 0.5] (e = its centre's distance in from
 * the tile's edge, device px) the band [from, to) covers: the ring's
 * antialiased coverage, the same sum the GPU does.
 */
export const bandCover = (e: number, from: number, to: number) =>
  Math.max(0, Math.min(to, e + 0.5) - Math.max(from, e - 0.5))

/**
 * Per stage id: its layer in the stage art. Ids sharing a picture share a layer.
 */
export function stageLayers(): { info: Int32Array; urls: string[] } {
  const info = new Int32Array(STAGE_IDS)
  const urls: string[] = []
  for (let id = 0; id < STAGE_IDS; id += 1) {
    const url = resolveStageImage(id) || ''
    let layer = url ? urls.indexOf(url) : 0
    if (url && layer < 0) {
      layer = urls.length
      urls.push(url)
    }
    info[id] = Math.max(0, layer)
  }
  return { info, urls }
}

export type TileArt = {
  icons: HTMLCanvasElement
  /** STAGE_CELL wide, one STAGE_CELL square per layer; null if no picture loaded. */
  stages: HTMLCanvasElement | null
  layers: number
  stageInfo: Int32Array
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    if (!url) {
      resolve(null)
      return
    }
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })

/**
 * The "vs" glyph in its atlas cell, in the card's font and weight with the same
 * dark outline as the DOM card's (Clip.css .clip-vs), so 120 px doesn't jump.
 */
function drawVs(ctx: CanvasRenderingContext2D | null) {
  if (!ctx) return
  const x = (VS_CELL % ICON_COLS) * ICON_CELL
  const y = Math.floor(VS_CELL / ICON_COLS) * ICON_CELL
  let family = 'sans-serif'
  try {
    family = getComputedStyle(document.body).fontFamily || family
  } catch {
    // keep sans-serif
  }
  let size = Math.round(ICON_CELL * VS_FONT)
  ctx.save()
  // Stay inside the cell (its neighbours are the light arrow and an icon).
  ctx.beginPath()
  ctx.rect(x, y, ICON_CELL, ICON_CELL)
  ctx.clip()
  ctx.font = `${VS_WEIGHT} ${size}px ${family}`
  const w = ctx.measureText('vs').width * (1 + VS_STROKE * 2)
  if (w > ICON_CELL - 2) {
    size = Math.floor((size * (ICON_CELL - 2)) / w)
    ctx.font = `${VS_WEIGHT} ${size}px ${family}`
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  // The outline is centred on the glyph's edge: twice the DOM's outside width.
  ctx.lineWidth = size * VS_STROKE * 2
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)'
  ctx.strokeText('vs', x + ICON_CELL / 2, y + ICON_CELL / 2)
  ctx.fillStyle = '#ffffff'
  ctx.fillText('vs', x + ICON_CELL / 2, y + ICON_CELL / 2)
  // The cell is shrunk ~3x on screen, which greys thin white strokes into the
  // outline: fatten the letters a little so they stay as bright as the DOM's.
  ctx.lineWidth = size * 0.06
  ctx.strokeStyle = '#ffffff'
  ctx.strokeText('vs', x + ICON_CELL / 2, y + ICON_CELL / 2)
  ctx.restore()
}

async function buildTileArt(): Promise<TileArt> {
  const icons = document.createElement('canvas')
  icons.width = ICON_CELL * ICON_COLS
  icons.height = ICON_CELL * ICON_ROWS
  const ictx = icons.getContext('2d')
  const cell = (n: number, img: HTMLImageElement | null) => {
    if (!img || !ictx) return
    ictx.drawImage(
      img,
      (n % ICON_COLS) * ICON_CELL,
      Math.floor(n / ICON_COLS) * ICON_CELL,
      ICON_CELL,
      ICON_CELL,
    )
  }
  const { info, urls } = stageLayers()
  const charUrl = (c: number) =>
    resolveCharacterImage({
      characterId: c,
      characterColor: 0,
    } as PlayerInterface) || ''
  const [chars, arrows, stageImgs] = await Promise.all([
    Promise.all(
      Array.from({ length: NUM_CHARS }, (_, c) => loadImage(charUrl(c))),
    ),
    Promise.all([loadImage(arrowImages.dark), loadImage(arrowImages.light)]),
    Promise.all(urls.map(loadImage)),
  ])
  chars.forEach((img, c) => cell(c, img))
  cell(ARROW_DARK, arrows[0])
  cell(ARROW_LIGHT, arrows[1])
  drawVs(ictx)

  let stages: HTMLCanvasElement | null = null
  if (stageImgs.some(Boolean)) {
    stages = document.createElement('canvas')
    stages.width = STAGE_CELL
    stages.height = STAGE_CELL * urls.length
    const sctx = stages.getContext('2d')
    stageImgs.forEach((img, layer) => {
      if (!img || !sctx) return
      // object-fit: cover in a square: the centred square of the picture.
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      sctx.drawImage(
        img,
        (img.naturalWidth - side) / 2,
        (img.naturalHeight - side) / 2,
        side,
        side,
        0,
        layer * STAGE_CELL,
        STAGE_CELL,
        STAGE_CELL,
      )
    })
  }
  return { icons, stages, layers: stages ? urls.length : 0, stageInfo: info }
}

let pending: Promise<TileArt> | null = null
let ready: TileArt | null = null

/** The tile art, built on first use and shared from then on. */
export function loadTileArt(): Promise<TileArt> {
  if (!pending)
    pending = buildTileArt().then((art) => {
      ready = art
      return art
    })
  return pending
}

/** The tile art if it's built already (a remounted view draws it at once). */
export function tileArtNow(): TileArt | null {
  return ready
}
