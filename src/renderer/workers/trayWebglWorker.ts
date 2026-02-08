/// <reference lib="webworker" />

type InitPayload = {
  type: 'init'
  canvas: OffscreenCanvas
  dpr: number
}

type TexturePayload = {
  type: 'textures'
  size: number
  bitmaps: ImageBitmap[]
}

type PalettePayload = {
  type: 'palette'
  colors: Float32Array
}

type DataPayload = {
  type: 'data'
  offset: number
  limit: number
  stageIds: Float32Array
  stageLayers: Float32Array
}

type DrawPayload = {
  type: 'draw'
  width: number
  height: number
  columns: number
  cell: number
  padding: number
  scrollOffset: number
  offset: number
  limit: number
  tileSize: number
  variantSize: number
  useSolid: boolean
  useFallback: boolean
  layerCount: number
}

type WorkerMessage =
  | InitPayload
  | TexturePayload
  | PalettePayload
  | DataPayload
  | DrawPayload

type TextureEntry = {
  texture: WebGLTexture
  layers: number
}

const perfLogThresholdMs = 8
const maxStageColors = 64

let canvas: OffscreenCanvas | null = null
let gl: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null

let dpr = 1
let viewportWidth = 0
let viewportHeight = 0

let quadBuffer: WebGLBuffer | null = null
let stageLayerBuffer: WebGLBuffer | null = null
let stageIdBuffer: WebGLBuffer | null = null

const attrCorner = 0
const attrLayer = 1
const attrStageId = 2

let uniformViewport: WebGLUniformLocation | null = null
let uniformTileSize: WebGLUniformLocation | null = null
let uniformCell: WebGLUniformLocation | null = null
let uniformPadding: WebGLUniformLocation | null = null
let uniformScrollOffset: WebGLUniformLocation | null = null
let uniformColumns: WebGLUniformLocation | null = null
let uniformOffset: WebGLUniformLocation | null = null
let uniformUseSolid: WebGLUniformLocation | null = null
let uniformUseFallback: WebGLUniformLocation | null = null
let uniformLayerCount: WebGLUniformLocation | null = null
let uniformStageColors: WebGLUniformLocation | null = null
let uniformAtlas: WebGLUniformLocation | null = null

let cachedStageIds: Float32Array | null = null
let cachedStageLayers: Float32Array | null = null
let cachedRange = { offset: 0, limit: 0 }

const texturesBySize = new Map<number, TextureEntry>()
let currentVariantSize = 0

let stageColors = new Float32Array(maxStageColors * 4)

const vertexSource = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in float aLayer;
layout(location = 2) in float aStageId;

uniform vec2 uViewport;
uniform float uTileSize;
uniform float uCell;
uniform float uPadding;
uniform float uScrollOffset;
uniform int uColumns;
uniform int uOffset;
uniform bool uUseFallback;
uniform int uLayerCount;

out vec2 vUv;
flat out int vLayer;
flat out int vStageId;

void main() {
  int index = uOffset + gl_InstanceID;
  int row = index / uColumns;
  int col = index - row * uColumns;
  float x = uPadding + float(col) * uCell;
  float y = uPadding + float(row) * uCell - uScrollOffset;
  vec2 pos = vec2(x, y) + aCorner * uTileSize;
  vec2 clip = (pos / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aCorner;
  if (uUseFallback) {
    int layerCount = max(uLayerCount, 1);
    vLayer = index % layerCount;
    vStageId = index % ${maxStageColors};
  } else {
    vLayer = int(aLayer + 0.5);
    vStageId = int(aStageId + 0.5);
  }
}
`

const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec2 vUv;
flat in int vLayer;
flat in int vStageId;

uniform sampler2DArray uAtlas;
uniform bool uUseSolid;
uniform vec4 uStageColors[${maxStageColors}];

out vec4 outColor;

void main() {
  if (uUseSolid) {
    int idx = clamp(vStageId, 0, ${maxStageColors - 1});
    outColor = uStageColors[idx];
    return;
  }
  outColor = texture(uAtlas, vec3(vUv, float(vLayer)));
}
`

const postPerf = (
  name: string,
  durationMs: number,
  meta?: Record<string, any>,
) => {
  if (durationMs < perfLogThresholdMs) return
  self.postMessage({ type: 'perf', name, durationMs, meta })
}

const createShader = (type: number, source: string) => {
  if (!gl) return null
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    self.postMessage({
      type: 'error',
      message: `Shader compile failed: ${info}`,
    })
    gl.deleteShader(shader)
    return null
  }
  return shader
}

const createProgram = () => {
  if (!gl) return null
  const vertexShader = createShader(gl.VERTEX_SHADER, vertexSource)
  const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentSource)
  if (!vertexShader || !fragmentShader) return null
  const nextProgram = gl.createProgram()
  if (!nextProgram) return null
  gl.attachShader(nextProgram, vertexShader)
  gl.attachShader(nextProgram, fragmentShader)
  gl.linkProgram(nextProgram)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(nextProgram, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(nextProgram)
    self.postMessage({ type: 'error', message: `Program link failed: ${info}` })
    gl.deleteProgram(nextProgram)
    return null
  }
  return nextProgram
}

const initGl = () => {
  if (!canvas) return false
  gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: true,
  })
  if (!gl) {
    self.postMessage({ type: 'error', message: 'WebGL2 unavailable' })
    return false
  }
  program = createProgram()
  if (!program) return false

  gl.useProgram(program)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.CULL_FACE)
  gl.disable(gl.BLEND)

  quadBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  )
  gl.enableVertexAttribArray(attrCorner)
  gl.vertexAttribPointer(attrCorner, 2, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(attrCorner, 0)

  stageLayerBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, stageLayerBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, 4, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(attrLayer)
  gl.vertexAttribPointer(attrLayer, 1, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(attrLayer, 1)

  stageIdBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, stageIdBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, 4, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(attrStageId)
  gl.vertexAttribPointer(attrStageId, 1, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(attrStageId, 1)

  uniformViewport = gl.getUniformLocation(program, 'uViewport')
  uniformTileSize = gl.getUniformLocation(program, 'uTileSize')
  uniformCell = gl.getUniformLocation(program, 'uCell')
  uniformPadding = gl.getUniformLocation(program, 'uPadding')
  uniformScrollOffset = gl.getUniformLocation(program, 'uScrollOffset')
  uniformColumns = gl.getUniformLocation(program, 'uColumns')
  uniformOffset = gl.getUniformLocation(program, 'uOffset')
  uniformUseSolid = gl.getUniformLocation(program, 'uUseSolid')
  uniformUseFallback = gl.getUniformLocation(program, 'uUseFallback')
  uniformLayerCount = gl.getUniformLocation(program, 'uLayerCount')
  uniformStageColors = gl.getUniformLocation(program, 'uStageColors')
  uniformAtlas = gl.getUniformLocation(program, 'uAtlas')

  if (uniformStageColors) {
    gl.uniform4fv(uniformStageColors, stageColors)
  }

  return true
}

const updateViewport = (width: number, height: number) => {
  if (!canvas || !gl) return
  viewportWidth = Math.max(0, Math.floor(width))
  viewportHeight = Math.max(0, Math.floor(height))
  const nextWidth = Math.max(1, Math.floor(viewportWidth * dpr))
  const nextHeight = Math.max(1, Math.floor(viewportHeight * dpr))
  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth
    canvas.height = nextHeight
  }
  gl.viewport(0, 0, canvas.width, canvas.height)
  if (uniformViewport) {
    gl.uniform2f(uniformViewport, viewportWidth, viewportHeight)
  }
}

const uploadStageData = (payload: DataPayload) => {
  if (!gl || !stageLayerBuffer || !stageIdBuffer) return
  const uploadStart = performance.now()
  cachedStageIds = payload.stageIds
  cachedStageLayers = payload.stageLayers
  cachedRange = { offset: payload.offset, limit: payload.limit }

  gl.bindBuffer(gl.ARRAY_BUFFER, stageLayerBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, cachedStageLayers, gl.DYNAMIC_DRAW)

  gl.bindBuffer(gl.ARRAY_BUFFER, stageIdBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, cachedStageIds, gl.DYNAMIC_DRAW)

  const duration = performance.now() - uploadStart
  postPerf('webgl_upload', duration, { count: payload.limit })
}

const uploadTextureArray = (payload: TexturePayload) => {
  if (!gl) return
  const uploadStart = performance.now()
  const { size } = payload
  const bitmaps = payload.bitmaps.filter(Boolean)
  if (bitmaps.length === 0) return

  const texture = gl.createTexture()
  if (!texture) return
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)

  if (gl.texStorage3D) {
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.RGBA8,
      size,
      size,
      bitmaps.length,
    )
  } else {
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      gl.RGBA,
      size,
      size,
      bitmaps.length,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    )
  }

  bitmaps.forEach((bitmap, layer) => {
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      layer,
      size,
      size,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bitmap,
    )
    bitmap.close()
  })

  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  texturesBySize.set(size, { texture, layers: bitmaps.length })
  const duration = performance.now() - uploadStart
  postPerf('webgl_texture_upload', duration, { size, layers: bitmaps.length })
}

const drawFrame = (payload: DrawPayload) => {
  if (!gl || !program) return
  const drawStart = performance.now()
  updateViewport(payload.width, payload.height)

  const availableTexture = texturesBySize.get(payload.variantSize)
  const { useFallback } = payload
  const layerCount = availableTexture?.layers ?? payload.layerCount ?? 0
  if (payload.useSolid === false && !availableTexture) {
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return
  }

  const total = cachedRange.limit
  const drawOffset = useFallback
    ? payload.offset
    : payload.offset >= cachedRange.offset
      ? payload.offset
      : cachedRange.offset
  const baseOffset = useFallback
    ? 0
    : Math.max(0, drawOffset - cachedRange.offset)
  const drawable = useFallback
    ? Math.max(0, payload.limit)
    : Math.max(0, Math.min(payload.limit, total - baseOffset))

  if (drawable <= 0 || payload.columns <= 0) {
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return
  }

  gl.useProgram(program)

  if (availableTexture && payload.useSolid === false) {
    if (currentVariantSize !== payload.variantSize) {
      currentVariantSize = payload.variantSize
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, availableTexture.texture)
      if (uniformAtlas) {
        gl.uniform1i(uniformAtlas, 0)
      }
    }
  }

  if (uniformTileSize) gl.uniform1f(uniformTileSize, payload.tileSize)
  if (uniformCell) gl.uniform1f(uniformCell, payload.cell)
  if (uniformPadding) gl.uniform1f(uniformPadding, payload.padding)
  if (uniformScrollOffset)
    gl.uniform1f(uniformScrollOffset, payload.scrollOffset)
  if (uniformColumns) gl.uniform1i(uniformColumns, payload.columns)
  if (uniformOffset) gl.uniform1i(uniformOffset, drawOffset)
  if (uniformUseSolid) gl.uniform1i(uniformUseSolid, payload.useSolid ? 1 : 0)
  if (uniformUseFallback) {
    gl.uniform1i(uniformUseFallback, useFallback ? 1 : 0)
  }
  if (uniformLayerCount) {
    gl.uniform1i(uniformLayerCount, layerCount)
  }

  if (uniformStageColors) {
    gl.uniform4fv(uniformStageColors, stageColors)
  }

  const bufferOffset = useFallback ? 0 : baseOffset * 4
  if (stageLayerBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, stageLayerBuffer)
    gl.vertexAttribPointer(attrLayer, 1, gl.FLOAT, false, 0, bufferOffset)
  }
  if (stageIdBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, stageIdBuffer)
    gl.vertexAttribPointer(attrStageId, 1, gl.FLOAT, false, 0, bufferOffset)
  }

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, drawable)

  const drawDuration = performance.now() - drawStart
  postPerf('webgl_draw', drawDuration, {
    count: drawable,
    columns: payload.columns,
    tile: Math.round(payload.tileSize),
    variant: payload.variantSize,
    solid: payload.useSolid,
    fallback: useFallback,
  })
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const payload = event.data
  if (payload.type === 'init') {
    canvas = payload.canvas
    dpr = payload.dpr || 1
    const success = initGl()
    self.postMessage({
      type: 'log',
      msg: 'init',
      success,
      hasGl: !!gl,
      hasProgram: !!program,
    })
    return
  }
  if (payload.type === 'palette') {
    stageColors = payload.colors
    if (gl && program && uniformStageColors) {
      gl.useProgram(program)
      gl.uniform4fv(uniformStageColors, stageColors)
    }
    self.postMessage({
      type: 'log',
      msg: 'palette',
      count: stageColors.length / 4,
    })
    return
  }
  if (payload.type === 'textures') {
    uploadTextureArray(payload)
    return
  }
  if (payload.type === 'data') {
    uploadStageData(payload)
    self.postMessage({ type: 'log', msg: 'data', limit: payload.limit })
    return
  }
  if (payload.type === 'draw') {
    self.postMessage({
      type: 'log',
      msg: 'draw-start',
      limit: payload.limit,
      cachedLimit: cachedRange.limit,
      useSolid: payload.useSolid,
    })
    drawFrame(payload)
    self.postMessage({ type: 'log', msg: 'draw-done' })
  }
}
