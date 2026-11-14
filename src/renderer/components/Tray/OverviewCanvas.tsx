/**
 * The tray's GPU view (docs/tray-v2.md): every tile below the DOM grid (120 px)
 * down to many clips per pixel. The overview bytes (stage + characters per clip)
 * live in a data texture and one WebGL2 shader works out, per screen pixel, which
 * clip is there and its colour. Cost is per pixel, not per clip, so 48M clips draw
 * as fast as 48, and a zoom step is one draw, not a React pass over thousands of
 * cards. From ~24 px tiles look like the grid's cards (stage art, both character
 * icons placed by the step's kind: lib/tileArt.ts); below 1 px per clip several clips blend into
 * each pixel (a density map).
 *
 * Built to work on any machine:
 *  - the texture width adapts to the GPU's limit (some Windows GPUs: 8192 or less);
 *  - a lost GPU context (driver reset, sleep) is rebuilt instead of going blank;
 *  - without WebGL2 (blocklisted GPU, Remote Desktop, some VMs) a CPU renderer
 *    draws the same picture (slower, icons only when few are on screen).
 *
 * Wheel scrolls; Ctrl/⌘+wheel zooms around the cursor (the clip under it stays
 * put). Click selects, Ctrl/⌘-click toggles, Shift-click and drag select a range;
 * double-click opens the clip.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { FiPlay, FiCircle } from 'react-icons/fi'
import { stages } from '../../../constants/stages'
import { characters } from '../../../constants/characters'
import { clipDisplayConfig } from '../../config/clipDisplay'
import {
  CARD_LAYOUT_IDS,
  CARD_LAYOUTS,
  CARD_LOOK,
  dimAt,
  dimScale,
  ICON_CELL,
  ICON_COLS,
  ICON_ROWS,
  NUM_CHARS,
  STAGE_CELL,
  TONE_HOT,
  bandCover,
  loadTileArt,
  toneColor,
  stageLayers,
  tileArtNow,
  tileLook,
  type CardLayout,
  type Rect,
  type TileArt,
} from '../../lib/tileArt'
import {
  handoffAnchor,
  scrollFor,
  writePlace,
  type ViewHandoff,
} from '../../lib/viewAnchor'
import { wheelDeltaPx, wheelZoomFactor } from '../../lib/zoomFrame'
import { splitScroll } from '../../lib/overviewScroll'
import { SelectionMask, type MaskHint } from '../../lib/overviewMask'
import { Selection } from '../../../lib/selection'
import ipcBridge from '../../ipcBridge'
import { summarizeClip } from '../Clip/cardSummary'
import { getClipPayload } from '../Clip/clipUtils'
import { tileButtonsGeometry } from '../../lib/overviewButtons'
import type { ClipData } from '../Clip/clipUtils'
import {
  OVERVIEW_BYTES,
  OVERVIEW_STAGE_NONE,
  ROW_BLOCK,
  stageOfByte,
  toneOfByte,
  overviewFor,
  type OverviewData,
} from '../../lib/overviewStore'
import {
  anchoredScroll,
  clampScroll,
  indexAt,
  overviewGap,
  overviewLayout,
  rangeOf,
} from '../../lib/overviewLayout'

export { OVERVIEW_MIN_TILE, fitTile } from '../../lib/overviewLayout'

const BG: [number, number, number] = [0.075, 0.075, 0.08]
/** Diagnostics: localStorage['lunar.overview.renderer'] = 'cpu' forces the CPU renderer. */
const FORCE_KEY = 'lunar.overview.renderer'
/** The hovered tile's details are read after the pointer rests this long, on their own read lane. */
const TIP_DELAY_MS = 60
/** The short tip (number, characters, stage) shows only if the details take longer than this. */
const TIP_FALLBACK_MS = 600
const TIP_LANE = 'overview-tip'
/** Tile size (CSS px) below which the pointer becomes a crosshair. */
const CROSSHAIR_BELOW = 24
/** A lost GPU context not restored by then is given up on (the CPU draws). */
const RESTORE_WAIT_MS = 3000
/**
 * WebGL2 failed here (shader compile/link, or a context Chromium never gave
 * back): every view this session draws on the CPU. A canvas that once had a
 * WebGL context can't give a 2D one, so the view swaps in a fresh canvas.
 */
let webglBroken = false

type Props = {
  filterId: string
  /** Changes (re-run, reorder, removal) start the overview fresh. */
  dataVersion: string
  total: number
  /** Tile size in CSS px (may be < 1). */
  tile: number
  width: number
  height: number
  selection: Selection
  /** How the cards place their icons (lib/tileArt.ts cardLayoutForStep). */
  layout?: CardLayout
  /** The new selection and the clip last clicked (where Single opens). */
  onSelectionChange: (_next: Selection, _anchor: number) => void
  /**
   * Ctrl/⌘+wheel: multiply the parent's live tile size by this. The parent
   * coalesces it to one update per frame, so a factor (not a size from this
   * render's possibly stale `tile`) keeps every tick of a fast pinch.
   */
  onZoom: (_factor: number) => void
  onOpen?: (_index: number) => void
  /** The hover buttons (same payload / id as the grid card's). */
  onClipPlay?: (_payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  }) => void
  onClipRecord?: (_clipId: string) => void
  /** Shared with the DOM grid (lib/viewAnchor.ts): this view starts where the
   *  grid was and leaves where it is, so crossing 120 px keeps your place. */
  handoff?: ViewHandoff
  /** The clips on screen, [first, last) ("Select visible"). */
  onVisibleRange?: (_first: number, _last: number) => void
  /**
   * Off: the DOM grid or Single is showing. The tray keeps this view mounted
   * but hidden then, so crossing 120 px reuses its GPU textures and selection
   * marks (re-uploading 21M clips took ~250-540 ms). Hidden it draws nothing,
   * reports nothing and starts no reads; shown again it starts where the other
   * view was (`handoff`).
   */
  active?: boolean
}

/* --------------------------------- colours -------------------------------- */

function palette(): Float32Array {
  const out = new Float32Array(64 * 3)
  const colors = clipDisplayConfig.stageColors as Record<string, string>
  for (let i = 0; i < 64; i += 1) {
    const tag = (stages as Record<number, { tag?: string }>)[i]?.tag
    const hex = (tag && colors[tag]) || colors.default
    const v = parseInt(hex.slice(1), 16)
    out[i * 3] = ((v >> 16) & 255) / 255
    out[i * 3 + 1] = ((v >> 8) & 255) / 255
    out[i * 3 + 2] = (v & 255) / 255
  }
  return out
}
const PALETTE = palette()
/** Per stage id: its art layer (lib/tileArt.ts stageLayers). */
const STAGE_INFO = stageLayers().info

/* ------------------------------- what to draw ------------------------------ */

type Frame = {
  w: number // device px
  h: number
  dpr: number
  tile: number // device px
  gap: number // device px
  scroll: number // device px
  cols: number
  total: number
  loaded: number
  icons: number // 0..1, the far-out icon (lib/tileArt.ts tileLook)
  card: number // 0..1, the card look
  strip: number // 0..1, the card's info strip (lib/tileArt.ts stripAmount)
  ring: number // 0..1, the kill / standout ring (lib/tileArt.ts tileLook)
  tint: number // 0..1, far out: the whole tile in the tone's colour
  layout: CardLayout
  hover: number
  rangeA: number // drag preview, -1 = none
  rangeB: number
  /** Marks are the rows left out (Select All): selected = not marked. */
  invert: boolean
}

/* ---------------------------------- WebGL --------------------------------- */

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

/** A rect as GLSL floats. */
const glRect = (x: Rect) => x.map((v) => v.toFixed(4)).join(', ')
const glVec3 = (x: readonly number[]) =>
  `vec3(${x.map((v) => v.toFixed(4)).join(', ')})`
const glF = (v: number) => v.toFixed(4)
/** CARD_LAYOUTS as a GLSL function: uLayout -> the rects to draw. */
const glLayouts = () => {
  const one = (k: CardLayout) => {
    const L = CARD_LAYOUTS[k]
    return `Icons(vec4(${glRect(L.char1)}), vec4(${glRect(L.char2)}), vec4(${glRect(L.mid)}), ${L.midCell}, ${glF(L.midAlpha)}, vec4(${glRect(L.chip)}), ${glF(L.chipRadius)})`
  }
  return `struct Icons { vec4 char1; vec4 char2; vec4 mid; int midCell; float midAlpha; vec4 chip; float rad; };
Icons layoutIcons(int l) {
  if (l == ${CARD_LAYOUT_IDS.versus}) return ${one('versus')};
  return ${one('arrow')};
}`
}

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2DArray;
uniform usampler2D uData;
uniform usampler2D uSel;
uniform sampler2D uAtlas;
uniform sampler2DArray uStages;
uniform vec3 uPalette[64];
uniform int uStageInfo[64];
uniform vec3 uBg;
uniform vec2 uSize;
uniform float uTile;
uniform float uGap;
uniform int uFirstRow;
uniform float uScrollFrac;
uniform int uCols;
uniform int uCount;
uniform int uLoaded;
uniform int uTexW;
uniform float uIcons;
uniform float uCard;
uniform float uStrip;
uniform int uArt;
uniform int uLayout;
uniform float uDpr;
uniform int uHover;
uniform int uRangeA;
uniform int uRangeB;
uniform int uInvert;
uniform float uRing;
uniform float uRingW;
uniform float uTint;
out vec4 outColor;

const vec3 BLUE = ${glVec3(CARD_LOOK.selectColor)};
const vec3 KILL = ${glVec3(CARD_LOOK.killColor)};
const vec3 HOT = ${glVec3(CARD_LOOK.hotColor)};
const float RING_A = ${glF(CARD_LOOK.ringAlpha)};
const vec2 ICONS = vec2(${ICON_COLS}.0, ${ICON_ROWS}.0);

ivec2 at(int i) { return ivec2(i % uTexW, i / uTexW); }
// The first byte: stage in the low 6 bits (63 = none), tone in the top 2.
uint stageOf(uint b) { uint s = b & 63u; return s < 63u ? s : 0u; }
uint toneOf(uint b) { return b >> 6u; }
vec3 toneColor(uint t) { return t == ${TONE_HOT}u ? HOT : KILL; }
vec3 stageColor(uint b) { return uPalette[stageOf(b)]; }
// How much of this pixel (centre e device px in from the edge) the band [a, b) covers.
float band(float e, float a, float b) { return max(0.0, min(b, e + 0.5) - max(a, e - 0.5)); }
bool selected(int i) {
  if (uRangeA >= 0 && i >= uRangeA && i <= uRangeB) return true;
  return (texelFetch(uSel, at(i), 0).r > 0u) != (uInvert == 1);
}
// Far out (below ~6 px) a kill / standout tints the whole tile: no ring shows there.
vec3 clipColor(int i) {
  bool sel = selected(i);
  vec3 c = uBg + 0.06;
  if (i < uLoaded) {
    uint b = texelFetch(uData, at(i), 0).r;
    c = stageColor(b);
    uint t = toneOf(b);
    if (uTint > 0.0 && t > 0u && !sel) c = mix(c, toneColor(t), RING_A * uTint);
  }
  return sel ? mix(c, BLUE, 0.65) : c;
}
// One atlas icon in rect r (tile fractions) at uv; g = uv per device pixel.
vec4 icon(int cell, vec2 uv, vec4 r, float g) {
  vec2 q = (uv - r.xy) / (r.zw - r.xy);
  if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) return vec4(0.0);
  vec2 c = vec2(float(cell % ${ICON_COLS}), float(cell / ${ICON_COLS}));
  vec2 d = g / (r.zw - r.xy) / ICONS;
  return textureGrad(uAtlas, (c + q) / ICONS, vec2(d.x, 0.0), vec2(0.0, d.y));
}
vec3 over(vec3 c, vec4 i) { return mix(c, i.rgb, i.a); }

// Far out: stage colour, the attacker's icon fading in (10-18 px).
vec3 mosaic(int idx, vec2 local) {
  vec3 c = clipColor(idx);
  if (uIcons > 0.0 && idx < uLoaded) {
    uint ch = texelFetch(uData, at(idx), 0).g;
    if (ch < ${NUM_CHARS}u) {
      vec2 uv = (local - uGap) / (uTile - uGap);
      vec2 inset = (uv - 0.12) / 0.76;
      if (all(greaterThanEqual(inset, vec2(0.0))) && all(lessThanEqual(inset, vec2(1.0)))) {
        vec2 cell = vec2(float(int(ch) % ${ICON_COLS}), float(int(ch) / ${ICON_COLS}));
        vec4 ic = texture(uAtlas, (cell + inset) / ICONS);
        c = mix(c, ic.rgb, ic.a * uIcons);
      }
    }
  }
  // The card's kill / standout ring, at the tile's edge (the selection wins).
  if (uRing > 0.0 && idx < uLoaded) {
    uint t = toneOf(texelFetch(uData, at(idx), 0).r);
    if (t > 0u && !selected(idx)) {
      float e = min(min(local.x, local.y) - uGap, min(uTile - local.x, uTile - local.y));
      c = mix(c, toneColor(t), RING_A * uRing * band(e, 0.0, uRingW));
    }
  }
  if (idx == uHover) c = mix(c, vec3(1.0), 0.3);
  return c;
}

// From ~24 px: the grid's card (Clip.css .clip--mode2): the stage dimmed,
// both icons on one dark pill with the arrow between them (a game's players
// with a "vs"; CARD_LAYOUTS), the (empty) info strip from ~56 px,
// a quiet 1 px edge, 6 px corners; hover = light 1 px edge, selected = blue
// tint + 3 px blue edge. Constants: lib/tileArt.ts CARD_LOOK.
${glLayouts()}
float rbox(vec2 p, vec4 r, float rad) {
  vec2 c = (r.xy + r.zw) * 0.5;
  vec2 q = abs(p - c) - ((r.zw - r.xy) * 0.5 - rad);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
vec3 card(int idx, vec2 local, out bool outside) {
  float inner = uTile - uGap;
  vec2 p = local - uGap;
  float rad = min(${glF(CARD_LOOK.radius)} * uDpr, inner * 0.25);
  vec2 k = clamp(p, vec2(rad), vec2(inner - rad));
  float dc = length(p - k);
  outside = dc > rad;
  float edge = dc > 0.0 ? rad - dc : min(min(p.x, p.y), min(inner - p.x, inner - p.y));
  vec2 uv = p / inner;
  float g = 1.0 / inner;
  vec3 c = uBg + 0.06;
  uint tone = 0u;
  if (idx < uLoaded) {
    uvec3 d = texelFetch(uData, at(idx), 0).rgb;
    int info = uStageInfo[int(stageOf(d.r))];
    tone = toneOf(d.r);
    c = stageColor(d.r);
    if (uArt == 1)
      c = textureGrad(uStages, vec3(uv, float(info & 255)), vec2(g, 0.0), vec2(0.0, g)).rgb;
    float dim = uv.y < 0.6
      ? ${glF(CARD_LOOK.dimTop)} + ${glF(CARD_LOOK.dimMid - CARD_LOOK.dimTop)} * uv.y / 0.6
      : ${glF(CARD_LOOK.dimMid)} + ${glF(CARD_LOOK.dimBottom - CARD_LOOK.dimMid)} * (uv.y - 0.6) / 0.4;
    c = mix(c, ${glVec3(CARD_LOOK.dimColor)}, dim * (0.5 + 0.5 * uStrip));
    bool c1 = d.g < ${NUM_CHARS}u;
    bool c2 = d.b < ${NUM_CHARS}u;
    Icons L = layoutIcons(uLayout);
    if (c1 || c2) {
      float chipA = clamp(0.5 - rbox(uv, L.chip, L.rad) / g, 0.0, 1.0);
      c = mix(c, ${glVec3(CARD_LOOK.chipColor)}, ${glF(CARD_LOOK.chipAlpha)} * chipA);
    }
    if (c1) c = over(c, icon(int(d.g), uv, L.char1, g));
    if (c1 || c2) c = over(c, icon(L.midCell, uv, L.mid, g) * vec4(1.0, 1.0, 1.0, L.midAlpha));
    if (c2) c = over(c, icon(int(d.b), uv, L.char2, g));
    if (uStrip > 0.0 && uv.y > ${glF(1 - CARD_LOOK.strip)})
      c = mix(c, ${glVec3(CARD_LOOK.stripColor)}, ${glF(CARD_LOOK.stripAlpha)} * uStrip);
  }
  // Kill / standout: the card's thin ring just inside its 1 px edge
  // (Clip.css .clip-accent), under the selection's 3 px edge.
  if (tone > 0u) c = mix(c, toneColor(tone), RING_A * band(edge, uDpr, uDpr + uRingW));
  bool sel = selected(idx);
  if (sel) c = mix(c, ${glVec3(CARD_LOOK.selectColor)}, ${glF(CARD_LOOK.selectTint)});
  if (sel && edge < 3.0 * uDpr) c = ${glVec3(CARD_LOOK.selectColor)};
  else if (idx == uHover && edge < uDpr) c = mix(c, ${glVec3(CARD_LOOK.hoverColor)}, ${glF(CARD_LOOK.hoverAlpha)});
  else if (edge < uDpr) c = ${glVec3(CARD_LOOK.edgeColor)};
  return c;
}

// The scroll comes as the first row on screen (int) plus the px into it, so rows
// stay exact deep in a huge list (lib/overviewScroll.ts): p.y is measured from
// the first row's top and never grows past the screen.
void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y + uScrollFrac);
  if (uTile >= 1.0) {
    int col = int(floor(p.x / uTile));
    float ry = floor(p.y / uTile);
    vec2 local = vec2(p.x - float(col) * uTile, p.y - ry * uTile);
    int idx = (uFirstRow + int(ry)) * uCols + col;
    if (col >= uCols || idx >= uCount || local.x < uGap || local.y < uGap) { outColor = vec4(uBg, 1.0); return; }
    vec3 c = uCard < 1.0 ? mosaic(idx, local) : uBg;
    if (uCard > 0.0) {
      bool outside;
      vec3 k = card(idx, local, outside);
      c = mix(c, outside ? uBg : k, uCard);
    }
    outColor = vec4(c, 1.0);
    return;
  }
  float span = 1.0 / uTile;
  int n = int(min(4.0, ceil(span)));
  vec3 sum = vec3(0.0);
  float hits = 0.0;
  for (int sy = 0; sy < 4; sy++) {
    if (sy >= n) break;
    for (int sx = 0; sx < 4; sx++) {
      if (sx >= n) break;
      vec2 q = (p + (vec2(float(sx), float(sy)) + 0.5) / float(n) - 0.5) / uTile;
      int col = int(floor(q.x));
      int idx = (uFirstRow + int(floor(q.y))) * uCols + col;
      if (col >= 0 && col < uCols && idx >= 0 && idx < uCount) { sum += clipColor(idx); hits += 1.0; }
    }
  }
  outColor = vec4(mix(uBg, hits > 0.0 ? sum / hits : uBg, hits / float(n * n)), 1.0);
}`

type Gl = {
  gl: WebGL2RenderingContext
  prog: WebGLProgram
  shaders: WebGLShader[]
  buf: WebGLBuffer | null
  u: Record<string, WebGLUniformLocation | null>
  data: WebGLTexture
  sel: WebGLTexture
  atlas: WebGLTexture
  stages: WebGLTexture
  /** The stage art is uploaded (until then cards show the stage colour). */
  art: boolean
  texW: number
  maxRows: number
  rows: number
  /** The overview the data texture holds (another one is uploaded afresh). */
  source: OverviewData | null
  uploaded: number
  /** The selection texture was just (re)allocated: upload all of it. */
  selStale: boolean
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(log || 'shader failed')
  }
  return sh
}

function initGl(canvas: HTMLCanvasElement, maxTexOverride?: number): Gl | null {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: false,
  })
  if (!gl) return null
  const prog = gl.createProgram()!
  const shaders: WebGLShader[] = []
  try {
    shaders.push(compile(gl, gl.VERTEX_SHADER, VERT))
    shaders.push(compile(gl, gl.FRAGMENT_SHADER, FRAG))
    shaders.forEach((sh) => gl.attachShader(prog, sh))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(prog) || 'link failed')
  } catch (err) {
    // Free what was made and the context: this canvas is done with WebGL.
    shaders.forEach((sh) => gl.deleteShader(sh))
    gl.deleteProgram(prog)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    throw err
  }
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  )
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const u: Record<string, WebGLUniformLocation | null> = {}
  for (const name of [
    'uData',
    'uSel',
    'uAtlas',
    'uStages',
    'uPalette',
    'uStageInfo',
    'uBg',
    'uSize',
    'uTile',
    'uGap',
    'uFirstRow',
    'uScrollFrac',
    'uCols',
    'uCount',
    'uLoaded',
    'uTexW',
    'uIcons',
    'uCard',
    'uStrip',
    'uArt',
    'uLayout',
    'uDpr',
    'uHover',
    'uRangeA',
    'uRangeB',
    'uInvert',
    'uRing',
    'uRingW',
    'uTint',
  ])
    u[name] = gl.getUniformLocation(prog, name)
  gl.uniform3fv(u.uPalette, PALETTE)
  gl.uniform3f(u.uBg, ...BG)
  gl.uniform1i(u.uData, 0)
  gl.uniform1i(u.uSel, 1)
  gl.uniform1i(u.uAtlas, 2)
  gl.uniform1i(u.uStages, 3)
  gl.uniform1iv(u.uStageInfo, STAGE_INFO)
  // The widest texture rows this GPU allows, as a divisor of the store's row block.
  const maxTex = Math.min(
    maxTexOverride ?? Infinity,
    gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
  )
  let texW = ROW_BLOCK
  while (texW > maxTex) texW /= 2
  const mk = (unit: number) => {
    const t = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    return t
  }
  const data = mk(0)
  const sel = mk(1)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8UI,
    1,
    1,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_BYTE,
    new Uint8Array(1),
  )
  const atlas = mk(2)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(4),
  )
  gl.activeTexture(gl.TEXTURE3)
  const stageTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, stageTex)
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    gl.RGBA,
    1,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(4),
  )
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  return {
    gl,
    prog,
    shaders,
    buf,
    u,
    data,
    sel,
    atlas,
    stages: stageTex,
    art: false,
    texW,
    maxRows: maxTex,
    rows: 0,
    source: null,
    uploaded: 0,
    selStale: true,
  }
}

/**
 * Free the GPU memory (the data texture alone is ~63 MB at 21M clips) and, once
 * the canvas has left the page, the context itself: the tray remounts this view
 * every time the zoom crosses 120 px, and browsers keep only ~16 live contexts.
 */
function glRelease(g: Gl, canvas: HTMLCanvasElement) {
  const { gl } = g
  if (!gl.isContextLost()) {
    gl.deleteTexture(g.data)
    gl.deleteTexture(g.sel)
    gl.deleteTexture(g.atlas)
    gl.deleteTexture(g.stages)
    gl.deleteBuffer(g.buf)
    g.shaders.forEach((sh) => {
      gl.detachShader(g.prog, sh)
      gl.deleteShader(sh)
    })
    gl.deleteProgram(g.prog)
  }
  const lose = gl.getExtension('WEBGL_lose_context')
  // React may run the cleanup and set up again on the same canvas (Strict Mode,
  // a fast remount); only a canvas that is really gone loses its context.
  setTimeout(() => {
    if (!canvas.isConnected) lose?.loseContext()
  }, 0)
}

/** The icons (mipmapped 2D atlas) and the stage art (one array layer per picture). */
function glUploadArt(g: Gl, art: TileArt) {
  const { gl } = g
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, g.atlas)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, art.icons)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  if (!art.stages || art.layers <= 0) return
  // Separate layers, so shrinking one picture never bleeds in its neighbours.
  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, g.stages)
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    gl.RGBA,
    STAGE_CELL,
    STAGE_CELL,
    art.layers,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    art.stages,
  )
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY)
  gl.texParameteri(
    gl.TEXTURE_2D_ARRAY,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  )
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  g.art = true
}

/** Upload new overview rows and the changed selection rows; returns how many clips the GPU has. */
function glSync(g: Gl, data: OverviewData, sel: SelectionMask) {
  const { gl, texW } = g
  if (g.source !== data) {
    // Another table, or this one read afresh (a removal, a reorder): its rows
    // and marks go up from the start.
    g.source = data
    g.uploaded = 0
    g.selStale = true
  }
  const rowsNeeded = Math.min(
    g.maxRows,
    Math.max(1, Math.ceil(data.ids.length / texW)),
  )
  if (rowsNeeded > g.rows) {
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, g.data)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB8UI,
      texW,
      rowsNeeded,
      0,
      gl.RGB_INTEGER,
      gl.UNSIGNED_BYTE,
      null,
    )
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, g.sel)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      texW,
      rowsNeeded,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      null,
    )
    g.rows = rowsNeeded
    g.uploaded = 0
    g.selStale = true
  }
  const capacity = g.rows * texW
  const loaded = Math.min(data.count, capacity)
  if (loaded > g.uploaded) {
    const from = Math.floor(g.uploaded / texW)
    const to = Math.ceil(loaded / texW)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, g.data)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      from,
      texW,
      to - from,
      gl.RGB_INTEGER,
      gl.UNSIGNED_BYTE,
      data.packed.subarray(
        from * texW * OVERVIEW_BYTES,
        to * texW * OVERVIEW_BYTES,
      ),
    )
    g.uploaded = loaded
  }
  // Only the texture rows whose marks changed (a chunk's new rows, a click).
  const dirty = sel.takeDirtyRows(texW, g.rows)
  const band: [number, number] | null = g.selStale ? [0, g.rows] : dirty
  const { mask } = sel
  if (band && mask.length >= band[1] * texW) {
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, g.sel)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      band[0],
      texW,
      band[1] - band[0],
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      mask.subarray(band[0] * texW, band[1] * texW),
    )
    g.selStale = false
  }
  return loaded
}

function glDraw(g: Gl, f: Frame) {
  const { gl, u } = g
  gl.viewport(0, 0, f.w, f.h)
  gl.uniform2f(u.uSize, f.w, f.h)
  gl.uniform1f(u.uTile, f.tile)
  gl.uniform1f(u.uGap, f.gap)
  const { firstRow, frac } = splitScroll(f.scroll, f.tile)
  gl.uniform1i(u.uFirstRow, firstRow)
  gl.uniform1f(u.uScrollFrac, frac)
  gl.uniform1i(u.uCols, f.cols)
  gl.uniform1i(u.uCount, f.total)
  gl.uniform1i(u.uLoaded, f.loaded)
  gl.uniform1i(u.uTexW, g.texW)
  gl.uniform1f(u.uIcons, f.icons)
  gl.uniform1f(u.uCard, f.card)
  gl.uniform1f(u.uStrip, f.strip)
  gl.uniform1i(u.uArt, g.art ? 1 : 0)
  gl.uniform1i(u.uLayout, CARD_LAYOUT_IDS[f.layout])
  gl.uniform1f(u.uDpr, f.dpr)
  gl.uniform1i(u.uHover, f.hover)
  gl.uniform1i(u.uRangeA, f.rangeA)
  gl.uniform1i(u.uRangeB, f.rangeB)
  gl.uniform1i(u.uInvert, f.invert ? 1 : 0)
  gl.uniform1f(u.uRing, f.ring)
  gl.uniform1f(u.uRingW, Math.max(1, CARD_LOOK.ringWidth * f.dpr))
  gl.uniform1f(u.uTint, f.tint)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

/* ------------------------------ CPU fallback ------------------------------ */

/** The same picture without WebGL2: per-pixel colours into an ImageData, icons
 *  drawn on top when few enough tiles are on screen. Exported for tests. */
export function cpuDraw(
  ctx: CanvasRenderingContext2D,
  f: Frame,
  data: OverviewData,
  mask: Uint8Array,
  art: TileArt | null,
) {
  const img = ctx.createImageData(f.w, f.h)
  const px = new Uint32Array(img.data.buffer)
  const bg =
    (255 << 24) |
    (Math.round(BG[2] * 255) << 16) |
    (Math.round(BG[1] * 255) << 8) |
    Math.round(BG[0] * 255)
  const isSel = (i: number) =>
    !!mask[i] !== f.invert || (f.rangeA >= 0 && i >= f.rangeA && i <= f.rangeB)
  const toneAt = (i: number) =>
    i < f.loaded ? toneOfByte(data.packed[i * OVERVIEW_BYTES]) : 0
  const ringW = Math.max(1, CARD_LOOK.ringWidth * f.dpr)
  /** Mix a tone's colour over c by `a`. */
  const toned = (c: number[], tone: number, a: number) => {
    const t = toneColor(tone)
    if (!t || a <= 0) return c
    return [
      c[0] + (t[0] - c[0]) * a,
      c[1] + (t[1] - c[1]) * a,
      c[2] + (t[2] - c[2]) * a,
    ]
  }
  const colorOf = (i: number) => {
    let r: number
    let g: number
    let b: number
    const sel = isSel(i)
    if (i < f.loaded) {
      const s = stageOfByte(data.packed[i * OVERVIEW_BYTES])
      const k = (s < OVERVIEW_STAGE_NONE ? s : 0) * 3
      r = PALETTE[k]
      g = PALETTE[k + 1]
      b = PALETTE[k + 2]
      // Far out a kill / standout tints the whole tile (no ring shows).
      if (f.tint > 0 && !sel)
        [r, g, b] = toned([r, g, b], toneAt(i), CARD_LOOK.ringAlpha * f.tint)
    } else {
      r = BG[0] + 0.06
      g = BG[1] + 0.06
      b = BG[2] + 0.06
    }
    if (sel) {
      r = r * 0.35 + 0.23 * 0.65
      g = g * 0.35 + 0.48 * 0.65
      b = b * 0.35 + 0.65
    }
    if (i === f.hover) {
      r = r * 0.7 + 0.3
      g = g * 0.7 + 0.3
      b = b * 0.7 + 0.3
    }
    return [r, g, b]
  }
  const pack = (c: number[]) =>
    (255 << 24) |
    (Math.round(c[2] * 255) << 16) |
    (Math.round(c[1] * 255) << 8) |
    Math.round(c[0] * 255)
  if (f.tile >= 1) {
    for (let y = 0; y < f.h; y += 1) {
      const py = y + f.scroll
      const row = Math.floor(py / f.tile)
      const ly = py - row * f.tile
      for (let x = 0; x < f.w; x += 1) {
        const col = Math.floor(x / f.tile)
        const lx = x - col * f.tile
        const idx = row * f.cols + col
        if (col >= f.cols || idx >= f.total || lx < f.gap || ly < f.gap) {
          px[y * f.w + x] = bg
          continue
        }
        let c = colorOf(idx)
        // The kill / standout ring at the tile's edge (the selection wins).
        const tone = f.ring > 0 ? toneAt(idx) : 0
        if (tone && !isSel(idx)) {
          const e =
            Math.min(lx - f.gap, ly - f.gap, f.tile - lx - 1, f.tile - ly - 1) +
            0.5
          c = toned(
            c,
            tone,
            CARD_LOOK.ringAlpha * f.ring * bandCover(e, 0, ringW),
          )
        }
        px[y * f.w + x] = pack(c)
      }
    }
  } else {
    const n = Math.min(4, Math.ceil(1 / f.tile))
    for (let y = 0; y < f.h; y += 1) {
      for (let x = 0; x < f.w; x += 1) {
        let r = 0
        let g = 0
        let b = 0
        let hits = 0
        for (let sy = 0; sy < n; sy += 1)
          for (let sx = 0; sx < n; sx += 1) {
            const qx = (x + (sx + 0.5) / n) / f.tile
            const qy = (y + f.scroll + (sy + 0.5) / n) / f.tile
            const col = Math.floor(qx)
            const idx = Math.floor(qy) * f.cols + col
            if (col < f.cols && idx >= 0 && idx < f.total) {
              const c = colorOf(idx)
              r += c[0]
              g += c[1]
              b += c[2]
              hits += 1
            }
          }
        const cov = hits / (n * n)
        px[y * f.w + x] = hits
          ? pack([
              BG[0] + (r / hits - BG[0]) * cov,
              BG[1] + (g / hits - BG[1]) * cov,
              BG[2] + (b / hits - BG[2]) * cov,
            ])
          : bg
      }
    }
  }
  ctx.putImageData(img, 0, 0)
  // Icons (and from ~24 px the card look, simpler than the GPU's): only when
  // the tiles are big enough to see them and few enough to draw.
  if (!art || f.icons <= 0) return
  const first = Math.floor(f.scroll / f.tile) * f.cols
  const visibleRows = Math.ceil(f.h / f.tile) + 1
  if (visibleRows * f.cols > 6000) return
  const icon = (n: number, x: number, y: number, w: number) =>
    ctx.drawImage(
      art.icons,
      (n % ICON_COLS) * ICON_CELL,
      Math.floor(n / ICON_COLS) * ICON_CELL,
      ICON_CELL,
      ICON_CELL,
      x,
      y,
      w,
      w,
    )
  const card = f.card >= 0.5
  const end = Math.min(f.loaded, first + visibleRows * f.cols)
  const inner = f.tile - f.gap
  const rgb = (c: readonly number[], a = 1) =>
    `rgba(${c.map((v) => Math.round(v * 255)).join(', ')}, ${a})`
  // The card's dimming, in tile-local coordinates (the same for every tile).
  let dim: CanvasGradient | null = null
  if (card) {
    dim = ctx.createLinearGradient(0, 0, 0, inner)
    for (const y of [0, 0.6, 1])
      dim.addColorStop(y, rgb(CARD_LOOK.dimColor, dimAt(y) * dimScale(f.strip)))
  }
  const L = CARD_LAYOUTS[f.layout]
  const [cl, ct, cr, cb] = L.chip
  for (let i = first; i < end; i += 1) {
    const [first0, ch1, ch2] = data.packed.subarray(
      i * OVERVIEW_BYTES,
      i * OVERVIEW_BYTES + 3,
    )
    const stage = stageOfByte(first0)
    const x = (i % f.cols) * f.tile + f.gap
    const y = Math.floor(i / f.cols) * f.tile - f.scroll + f.gap
    if (!card) {
      if (ch1 < NUM_CHARS) {
        ctx.globalAlpha = f.icons
        icon(ch1, x + inner * 0.12, y + inner * 0.12, inner * 0.76)
        ctx.globalAlpha = 1
      }
      continue
    }
    const info =
      STAGE_INFO[
        stage < STAGE_INFO.length && stage !== OVERVIEW_STAGE_NONE ? stage : 0
      ]
    if (art.stages && art.layers > 0)
      ctx.drawImage(
        art.stages,
        0,
        (info & 255) * STAGE_CELL,
        STAGE_CELL,
        STAGE_CELL,
        x,
        y,
        inner,
        inner,
      )
    if (dim) {
      ctx.save()
      ctx.translate(x, y)
      ctx.fillStyle = dim
      ctx.fillRect(0, 0, inner, inner)
      ctx.restore()
    }
    const at = (rect: Rect, n: number) =>
      icon(
        n,
        x + rect[0] * inner,
        y + rect[1] * inner,
        (rect[2] - rect[0]) * inner,
      )
    if (ch1 < NUM_CHARS || ch2 < NUM_CHARS) {
      ctx.fillStyle = rgb(CARD_LOOK.chipColor, CARD_LOOK.chipAlpha)
      ctx.beginPath()
      ctx.roundRect(
        x + cl * inner,
        y + ct * inner,
        (cr - cl) * inner,
        (cb - ct) * inner,
        L.chipRadius * inner,
      )
      ctx.fill()
    }
    // Both icons with the arrow (or a game's "vs") between (CARD_LAYOUTS).
    if (ch1 < NUM_CHARS) at(L.char1, ch1)
    if (ch1 < NUM_CHARS || ch2 < NUM_CHARS) {
      ctx.globalAlpha = L.midAlpha
      at(L.mid, L.midCell)
      ctx.globalAlpha = 1
    }
    if (ch2 < NUM_CHARS) at(L.char2, ch2)
    if (f.strip > 0) {
      ctx.fillStyle = rgb(CARD_LOOK.stripColor, CARD_LOOK.stripAlpha * f.strip)
      const sh = CARD_LOOK.strip * inner
      ctx.fillRect(x, y + inner - sh, inner, sh)
    }
    // Kill / standout: the card's ring just inside its 1 px edge, under the
    // selection's edge.
    const ring = toneColor(toneOfByte(first0))
    if (ring) {
      ctx.strokeStyle = rgb(ring, CARD_LOOK.ringAlpha * f.ring)
      ctx.lineWidth = ringW
      ctx.strokeRect(
        x + f.dpr + ringW / 2,
        y + f.dpr + ringW / 2,
        inner - 2 * f.dpr - ringW,
        inner - 2 * f.dpr - ringW,
      )
    }
    if (isSel(i)) {
      ctx.fillStyle = rgb(CARD_LOOK.selectColor, CARD_LOOK.selectTint)
      ctx.fillRect(x, y, inner, inner)
      ctx.strokeStyle = rgb(CARD_LOOK.selectColor)
      ctx.lineWidth = 3 * f.dpr
      ctx.strokeRect(
        x + 1.5 * f.dpr,
        y + 1.5 * f.dpr,
        inner - 3 * f.dpr,
        inner - 3 * f.dpr,
      )
    } else {
      ctx.strokeStyle = rgb(CARD_LOOK.edgeColor)
      ctx.lineWidth = f.dpr
      ctx.strokeRect(
        x + 0.5 * f.dpr,
        y + 0.5 * f.dpr,
        inner - f.dpr,
        inner - f.dpr,
      )
    }
  }
}

/* -------------------------------- component -------------------------------- */

const charName = (id: number) =>
  (characters as { name?: string }[])[id]?.name ?? null
const stageName = (id: number) =>
  (stages as Record<number, { name?: string }>)[id]?.name ?? null

function forcedRenderer(): string | null {
  try {
    return window.localStorage.getItem(FORCE_KEY)
  } catch {
    return null
  }
}

export default function OverviewCanvas({
  filterId,
  dataVersion,
  total,
  tile,
  width,
  height,
  selection,
  onSelectionChange,
  onZoom,
  onOpen,
  onClipPlay,
  onClipRecord,
  handoff,
  onVisibleRange,
  active = true,
  layout: cardLayout = 'versus',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnsRef = useRef<HTMLDivElement>(null)
  // Bumped to swap in a fresh <canvas> (falling back to the CPU renderer).
  const [canvasKey, setCanvasKey] = useState(0)
  const glRef = useRef<Gl | null>(null)
  const ctx2dRef = useRef<CanvasRenderingContext2D | null>(null)
  // Built once per session (lib/tileArt.ts): a remount draws the cards at once.
  const artRef = useRef<TileArt | null>(tileArtNow())
  const cpuKeyRef = useRef('')
  const data = useMemo(
    () => overviewFor(filterId, dataVersion),
    [filterId, dataVersion],
  )
  const [, setTick] = useState(0)
  const layout = overviewLayout(tile, width, total)
  // Start where the DOM grid was (crossing 120 px).
  const [scroll, setScroll] = useState(() => {
    const anchor = handoffAnchor(handoff)
    return anchor
      ? scrollFor(
          anchor,
          { cell: tile, padding: 0, cols: layout.cols, total },
          height,
          layout.height,
        )
      : 0
  })
  const [hover, setHover] = useState<{
    idx: number
    x: number
    y: number
  } | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const [renderer, setRenderer] = useState<'gpu' | 'cpu' | 'none'>('gpu')
  const [glLost, setGlLost] = useState(false)
  const anchorRef = useRef<{ idx: number; fy: number; cy: number } | null>(null)
  const lastClickRef = useRef<number>(-1)
  const maxScroll = Math.max(0, layout.height - height)

  // The selection as a per-clip mask (index space). Selection changes made here
  // leave a hint (which rows they touched) so only those rows are re-marked; new
  // chunks are marked as they arrive (the draw effect), never the whole list.
  // Hidden (the grid or Single showing) nothing is marked: shown again, the
  // marks are redone only if the selection or the table changed meanwhile.
  const maskRef = useRef<SelectionMask | null>(null)
  if (!maskRef.current) maskRef.current = new SelectionMask()
  const hintRef = useRef<{ next: Selection; hint: MaskHint } | null>(null)
  const markedRef = useRef<{ selection: Selection; data: OverviewData } | null>(
    null,
  )
  useEffect(() => {
    if (!active) return
    const m = maskRef.current!
    const h = hintRef.current
    hintRef.current = null
    m.attach(data, data.ids.length)
    const marked = markedRef.current
    if (marked && marked.selection === selection && marked.data === data) return
    m.select(
      data.ids,
      data.count,
      selection,
      h && h.next === selection ? h.hint : null,
    )
    markedRef.current = { selection, data }
  }, [selection, data, active])

  // Load (and keep loading as a running filter grows).
  useEffect(() => {
    if (!active) return undefined
    const off = data.subscribe(() => setTick((t) => t + 1))
    data.load(total)
    return off
  }, [data, total, active])

  // Keep the clip under the cursor in place across a zoom; otherwise clamp.
  // Shown again, start where the other view was (crossing 120 px, Single).
  const wasActiveRef = useRef(active)
  useLayoutEffect(() => {
    const entering = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (!active) {
      setHover(null)
      return
    }
    const a = anchorRef.current
    anchorRef.current = null
    const from = entering ? handoffAnchor(handoff) : null
    if (from) {
      setScroll(
        scrollFor(
          from,
          { cell: tile, padding: 0, cols: layout.cols, total },
          height,
          layout.height,
        ),
      )
      return
    }
    setScroll((s) =>
      clampScroll(
        a ? anchoredScroll(a.idx, a.fy, a.cy, tile, layout.cols) : s,
        layout.height,
        height,
      ),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tile, width, height, total])

  // Renderer setup: WebGL2, or the CPU fallback. Rebuilt after a lost context;
  // on a fresh canvas (canvasKey) when WebGL2 fails or never comes back.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    let alive = true
    let lostTimer: ReturnType<typeof setTimeout> | null = null
    const forced = forcedRenderer()
    // Given up on this canvas: its (deliberately) lost context is ignored.
    let gaveUp = false
    const toCpu = () => {
      gaveUp = true
      webglBroken = true
      glRef.current = null
      setGlLost(false)
      setCanvasKey((k) => k + 1)
    }
    const setup = () => {
      glRef.current = null
      ctx2dRef.current = null
      let failed = false
      if (forced !== 'cpu' && !webglBroken) {
        try {
          const maxTex =
            Number(
              (window as unknown as { __LUNAR_MAX_TEX__?: number })
                .__LUNAR_MAX_TEX__,
            ) || undefined
          glRef.current = initGl(canvas, maxTex)
        } catch (err) {
          console.warn(
            '[overview] WebGL2 setup failed, using the CPU renderer:',
            err,
          )
          glRef.current = null
          failed = true
        }
      }
      if (glRef.current) {
        setRenderer('gpu')
        if (artRef.current) glUploadArt(glRef.current, artRef.current)
      } else if (failed) {
        // This canvas has a WebGL context now and can't give a 2D one.
        toCpu()
        return
      } else {
        ctx2dRef.current = canvas.getContext('2d')
        setRenderer(ctx2dRef.current ? 'cpu' : 'none')
        setGlLost(false)
      }
      setTick((t) => t + 1)
    }
    setup()
    if (!artRef.current)
      loadTileArt()
        .then((art) => {
          if (!alive) return
          artRef.current = art
          if (glRef.current) glUploadArt(glRef.current, art)
          setTick((t) => t + 1)
        })
        .catch(() => {})
    const lost = (e: Event) => {
      if (!alive || gaveUp) return
      e.preventDefault() // ask for a restore
      glRef.current = null
      setGlLost(true)
      // Chromium stops restoring after repeated GPU resets: draw on the CPU.
      if (lostTimer) clearTimeout(lostTimer)
      lostTimer = setTimeout(() => {
        if (alive) toCpu()
      }, RESTORE_WAIT_MS)
    }
    const restored = () => {
      if (lostTimer) clearTimeout(lostTimer)
      lostTimer = null
      setGlLost(false)
      setup()
    }
    canvas.addEventListener('webglcontextlost', lost)
    canvas.addEventListener('webglcontextrestored', restored)
    return () => {
      alive = false
      if (lostTimer) clearTimeout(lostTimer)
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', restored)
      if (glRef.current) glRelease(glRef.current, canvas)
      glRef.current = null
      ctx2dRef.current = null
      cpuKeyRef.current = ''
    }
  }, [canvasKey])

  // Draw (every render; drawing is one pass, uploads are incremental).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || glLost || !active) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const m = maskRef.current!
    m.attach(data, data.ids.length)
    m.extend(data.ids, data.count)
    const g = glRef.current
    const loaded = g ? glSync(g, data, m) : data.count
    const [ra, rb] = drag ? rangeOf(drag.from, drag.to) : [-1, -1]
    const frame: Frame = {
      w,
      h,
      dpr,
      tile: tile * dpr,
      gap: overviewGap(tile, dpr),
      scroll: Math.round(scroll * dpr),
      cols: layout.cols,
      total,
      loaded,
      ...tileLook(tile),
      layout: cardLayout,
      hover: hover ? hover.idx : -1,
      rangeA: ra,
      rangeB: rb,
      invert: m.invert,
    }
    if (g) glDraw(g, frame)
    else if (ctx2dRef.current) {
      // The CPU renderer is slow: redraw only when the picture changes (hovering
      // moves the tooltip, it doesn't repaint).
      const key = JSON.stringify({
        ...frame,
        hover: -1,
        v: data.version,
        m: m.version,
        a: !!artRef.current,
      })
      if (key !== cpuKeyRef.current) {
        cpuKeyRef.current = key
        cpuDraw(
          ctx2dRef.current,
          { ...frame, hover: -1 },
          data,
          m.mask,
          artRef.current,
        )
      }
    }
  })

  const pointIndex = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const rect = canvasRef.current!.getBoundingClientRect()
      return indexAt(
        e.clientX - rect.left,
        e.clientY - rect.top,
        tile,
        layout.cols,
        scroll,
        total,
      )
    },
    [tile, layout.cols, scroll, total],
  )

  // Where this view is, for the DOM grid to start from (lib/viewAnchor.ts), and
  // what's on screen.
  const handoffRef = useRef(handoff)
  handoffRef.current = handoff
  const visibleRef = useRef(onVisibleRange)
  visibleRef.current = onVisibleRange
  useEffect(() => {
    // Hidden, the grid (or Single) owns the shared place.
    if (!active) return
    writePlace(handoff, {
      scroll,
      grid: { cell: tile, padding: 0, cols: layout.cols, total },
    })
    // (A row scrolled exactly to the top counts as on screen despite rounding.)
    const first = Math.min(
      total,
      Math.floor(scroll / tile + 1e-6) * layout.cols,
    )
    const last = Math.min(
      total,
      Math.ceil((scroll + height) / tile) * layout.cols,
    )
    visibleRef.current?.(first, last)
  }, [active, handoff, scroll, tile, layout.cols, total, height])

  // What the wheel listener reads: it is attached once, not on every zoom.
  const wheelRef = useRef({ scroll, tile, layout, total, height, onZoom })
  wheelRef.current = { scroll, tile, layout, total, height, onZoom }

  // Wheel: scroll, or zoom around the cursor (native listener so it can preventDefault).
  useEffect(() => {
    const canvas = canvasRef.current
    const root = rootRef.current
    if (!canvas || !root) return undefined
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const w = wheelRef.current
      if (e.ctrlKey || e.metaKey) {
        // The anchor comes from what is drawn (the rendered tile and scroll);
        // several ticks in one frame all keep the same clip under the cursor.
        const fy = (cy + w.scroll) / w.tile
        const row = Math.floor(fy)
        const col = Math.min(
          w.layout.cols - 1,
          Math.max(0, Math.floor(cx / w.tile)),
        )
        anchorRef.current = {
          idx: Math.max(0, Math.min(w.total - 1, row * w.layout.cols + col)),
          fy: fy - row,
          cy,
        }
        if (handoffRef.current) handoffRef.current.focus = { x: cx, y: cy }
        w.onZoom(wheelZoomFactor(e))
      } else {
        // Line-mode wheels (some Windows mice) report lines, not pixels.
        const dy = wheelDeltaPx(e, w.height)
        setScroll((s) => clampScroll(s + dy, w.layout.height, w.height))
      }
    }
    // On the whole view, so the pointer over a hover button still scrolls/zooms.
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [canvasKey])

  const idOf = (i: number) =>
    i >= 0 && i < data.count ? String(data.ids[i]) : null
  // Tell the mask which rows a change touched (see maskRef), then hand it up.
  const changeSelection = (next: Selection, anchor: number, hint: MaskHint) => {
    hintRef.current = { next, hint }
    onSelectionChange(next, anchor)
  }
  // A range is bits by id (lib/selection.ts): millions of rows cost a few MB.
  const selectRange = (a: number, b: number, add: boolean) => {
    const [lo, hi] = rangeOf(a, Math.min(b, data.count - 1))
    const range = data.ids.subarray(lo, hi + 1)
    const next = add ? selection.with(range, true) : Selection.of(range)
    changeSelection(next, a, { lo, hi, keep: add })
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const idx = pointIndex(e)
    if (idx < 0) {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !selection.isEmpty)
        onSelectionChange(Selection.none(), -1)
      return
    }
    const startY = e.clientY
    const startX = e.clientX
    let dragging = false
    const move = (ev: MouseEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5)
        return
      dragging = true
      const to = pointIndex(ev)
      if (to >= 0) setDrag({ from: idx, to })
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (dragging) {
        const to = pointIndex(ev)
        setDrag(null)
        selectRange(idx, to >= 0 ? to : idx, ev.ctrlKey || ev.metaKey)
        lastClickRef.current = idx
        return
      }
      const id = idOf(idx)
      if (!id) return
      if (ev.shiftKey && lastClickRef.current >= 0) {
        selectRange(lastClickRef.current, idx, ev.ctrlKey || ev.metaKey)
      } else if (ev.ctrlKey || ev.metaKey) {
        const next = selection.toggle(id)
        changeSelection(next, idx, { lo: idx, hi: idx, keep: true })
        lastClickRef.current = idx
      } else {
        changeSelection(Selection.of([id]), idx, {
          lo: idx,
          hi: idx,
          keep: false,
        })
        lastClickRef.current = idx
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const hovered = hover && hover.idx < data.count ? hover.idx : -1
  const tip = (() => {
    if (hovered < 0) return null
    const b = data.packed.subarray(
      hovered * OVERVIEW_BYTES,
      hovered * OVERVIEW_BYTES + 3,
    )
    const who = [charName(b[1]), charName(b[2])].filter(Boolean).join(' → ')
    const s = stageOfByte(b[0])
    const where = s === OVERVIEW_STAGE_NONE ? null : stageName(s)
    return `#${(hovered + 1).toLocaleString()} · ${[who, where].filter(Boolean).join(' · ')}`
  })()
  // The hovered clip's full details (the grid card's tooltip): one row read from
  // the project after the pointer rests a moment, kept for the hover's lifetime.
  const [detail, setDetail] = useState<{
    key: string
    label: string
    item: ClipData
  } | null>(null)
  const detailCache = useRef(
    new Map<string, { label: string; item: ClipData }>(),
  )
  const [slowKey, setSlowKey] = useState<string | null>(null)
  const detailKey =
    hovered >= 0 ? `${filterId}|${dataVersion}|${hovered}` : null
  useEffect(() => {
    if (!detailKey) return undefined
    const cached = detailCache.current.get(detailKey)
    if (cached !== undefined) {
      setDetail({ key: detailKey, ...cached })
      return undefined
    }
    const timer = setTimeout(() => {
      ipcBridge.getResults(
        { filterId, offset: hovered, limit: 1, lane: TIP_LANE },
        (response: { items?: ClipData[]; stale?: boolean }) => {
          const item = response?.items?.[0]
          if (!item || response.stale) return
          let label: string
          try {
            // The clip's place in the step leads, as on the quick tip.
            label = `#${(hovered + 1).toLocaleString()} · ${summarizeClip(item).label}`
          } catch {
            return
          }
          const cache = detailCache.current
          if (cache.size > 500) cache.clear()
          cache.set(detailKey, { label, item })
          setDetail({ key: detailKey, label, item })
        },
      )
    }, TIP_DELAY_MS)
    // Only if the details are slow does the short tip show meanwhile, so the
    // tooltip doesn't flash from one to the other.
    const slow = setTimeout(() => setSlowKey(detailKey), TIP_FALLBACK_MS)
    return () => {
      clearTimeout(timer)
      clearTimeout(slow)
    }
  }, [detailKey, filterId, hovered])
  const tipText =
    detail && detail.key === detailKey
      ? detail.label
      : slowKey === detailKey
        ? tip
        : null

  // Play / Record over the hovered tile (a DOM overlay; none while dragging).
  const rowItem = detail && detail.key === detailKey ? detail.item : null
  const showBtns =
    active &&
    !drag &&
    hovered >= 0 &&
    tile >= clipDisplayConfig.features.gpuButtons.minSize &&
    !!(onClipPlay || onClipRecord)
  const btnGeo = showBtns
    ? tileButtonsGeometry(
        hovered,
        layout.cols,
        tile,
        scroll,
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      )
    : null
  const playPayload = rowItem ? getClipPayload(rowItem) : null
  const recordId = rowItem
    ? 'id' in rowItem && rowItem.id != null
      ? String(rowItem.id)
      : 'path' in rowItem && rowItem.path
        ? rowItem.path
        : idOf(hovered) || ''
    : ''

  const thumb =
    layout.height > height ? Math.max(24, (height / layout.height) * height) : 0
  const selectedCount = selection.count
  // A GPU with small textures (some older/integrated ones) holds fewer clips.
  const gpuCapacity = glRef.current
    ? glRef.current.maxRows * glRef.current.texW
    : Infinity
  const capped = renderer === 'gpu' && total > gpuCapacity

  return (
    <div
      ref={rootRef}
      className={`overview${active ? '' : ' is-hidden'}`}
      style={{ width, height, display: active ? undefined : 'none' }}
      aria-hidden={!active || undefined}
    >
      <canvas
        key={canvasKey}
        ref={canvasRef}
        // A hand on cards you can make out; the crosshair only once tiles are
        // too small to see as cards and a click picks a spot.
        className={`overview-canvas${tile < CROSSHAIR_BELOW ? ' overview-canvas--fine' : ''}`}
        style={{ width, height }}
        // A picture to a screen reader: the keyboard route is the toolbar above (Select visible,
        // Select All, Grid / Single) and the arrow keys once zoomed in to the grid.
        aria-label="Overview of every clip in this step. With the keyboard, use the Select visible, Select All and Single buttons above, or zoom in to the grid."
        onMouseDown={onMouseDown}
        onMouseMove={(e) => {
          if (drag) return
          const rect = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          const idx =
            tile >= 4 ? indexAt(x, y, tile, layout.cols, scroll, total) : -1
          setHover(idx >= 0 ? { idx, x, y } : null)
        }}
        onMouseLeave={(e) => {
          // Onto a hover button: still this tile.
          if (
            e.relatedTarget instanceof Node &&
            btnsRef.current?.contains(e.relatedTarget)
          )
            return
          setHover(null)
        }}
        onDoubleClick={(e) => {
          const idx = pointIndex(e)
          if (idx >= 0) onOpen?.(idx)
        }}
      />
      {thumb > 0 && (
        <div
          className="overview-scrollbar"
          onMouseDown={(e) => {
            const track = e.currentTarget.getBoundingClientRect()
            const move = (ev: MouseEvent) => {
              const f =
                (ev.clientY - track.top - thumb / 2) /
                Math.max(1, track.height - thumb)
              setScroll(clampScroll(f * maxScroll, layout.height, height))
            }
            move(e.nativeEvent)
            const up = () => {
              window.removeEventListener('mousemove', move)
              window.removeEventListener('mouseup', up)
            }
            window.addEventListener('mousemove', move)
            window.addEventListener('mouseup', up)
          }}
        >
          <div
            className="overview-thumb"
            style={{
              height: thumb,
              top: maxScroll ? (scroll / maxScroll) * (height - thumb) : 0,
            }}
          />
        </div>
      )}
      {btnGeo && (
        <div
          ref={btnsRef}
          className="overview-btns"
          data-testid="overview-btns"
          style={{
            left: btnGeo.left,
            top: btnGeo.top,
            width: btnGeo.size,
            height: btnGeo.size,
          }}
          onMouseLeave={(e) => {
            if (e.relatedTarget === canvasRef.current) return
            setHover(null)
          }}
        >
          <div
            className="overview-btns-row"
            style={{
              right: btnGeo.right,
              bottom: btnGeo.bottom,
              gap: btnGeo.gap,
              ['--btn' as string]: `${btnGeo.btn}px`,
            }}
          >
            {onClipPlay && (
              <button
                type="button"
                className="overview-btn overview-btn--play"
                title="Play in Dolphin"
                aria-label="Play clip"
                disabled={!playPayload}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  if (playPayload) onClipPlay(playPayload)
                }}
              >
                <FiPlay />
              </button>
            )}
            {onClipRecord && (
              <button
                type="button"
                className="overview-btn overview-btn--record"
                title="Record clip"
                aria-label="Record clip"
                disabled={!rowItem}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  if (rowItem) onClipRecord(recordId)
                }}
              >
                <FiCircle />
              </button>
            )}
          </div>
        </div>
      )}
      {tipText && hover && (
        <div
          className="overview-tip"
          style={{
            // Kept on screen: left of the pointer near the right edge, above it
            // near the bottom (the tip is up to ~3 lines, ~360 px wide).
            // With the hover buttons it sits just below (or above) the tile, so
            // it never covers them.
            left: Math.max(
              4,
              Math.min(btnGeo ? btnGeo.left : hover.x + 14, width - 364),
            ),
            top: btnGeo
              ? btnGeo.top + btnGeo.size + 80 > height
                ? Math.max(4, btnGeo.top - 74)
                : btnGeo.top + btnGeo.size + 6
              : hover.y + 80 > height
                ? Math.max(4, hover.y - 70)
                : hover.y + 14,
          }}
        >
          {tipText}
        </div>
      )}
      <div className="overview-status">
        {renderer === 'none'
          ? 'This computer can’t draw the overview.'
          : glLost
            ? 'Graphics reset: redrawing…'
            : data.error
              ? data.error
              : data.count < total
                ? `Loading ${data.count.toLocaleString()} / ${total.toLocaleString()}`
                : capped
                  ? `Showing the first ${gpuCapacity.toLocaleString()} of ${total.toLocaleString()} (this computer's graphics limit)`
                  : `${total.toLocaleString()} clips · ${layout.cols.toLocaleString()} per row${selectedCount ? ` · ${selectedCount.toLocaleString()} selected` : ''}${renderer === 'cpu' ? ' · basic graphics' : ''}`}
      </div>
    </div>
  )
}
