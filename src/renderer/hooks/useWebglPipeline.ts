import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type MutableRefObject,
} from 'react'
import { perfLog } from '../perfLogger'
import { stageVariantSizes } from '../stageVariant'
import {
  stageVariantLayersBySize,
  stageVariantBaseNames,
} from '../stageVariantAssets'
import { roundNumber, type Layout } from '../lib/layoutMath'

type DebugFns = {
  logZoomTrace: (
    _event: string,
    _meta?: Record<string, string | number | boolean | null>,
  ) => void
  setTaskLabel: (_label: string) => void
}

type Range = { offset: number; limit: number }

const loadStageBitmap = (url: string) =>
  new Promise<ImageBitmap | null>((resolve) => {
    if (!url) {
      resolve(null)
      return
    }
    const image = new Image()
    image.onload = async () => {
      try {
        resolve(await createImageBitmap(image))
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = url
  })

export type UseWebglPipelineParams = {
  canUseWebglWorker: boolean
  stageColorPalette: Float32Array
  trayRef: MutableRefObject<HTMLDivElement | null>
  traySizeRef: MutableRefObject<{ width: number; height: number }>
  resultsTopRef: MutableRefObject<number>
  layoutRef: MutableRefObject<Layout>
  visibleRangeRef: MutableRefObject<Range>
  windowRangeRef: MutableRefObject<Range>
  webglDataRangeRef: MutableRefObject<Range>
  displayZoomRef: MutableRefObject<number>
  variantBucketRef: MutableRefObject<number | null>
  debugRef: MutableRefObject<DebugFns>
}

export const useWebglPipeline = (params: UseWebglPipelineParams) => {
  const {
    canUseWebglWorker,
    stageColorPalette,
    trayRef,
    traySizeRef,
    resultsTopRef,
    layoutRef,
    visibleRangeRef,
    windowRangeRef,
    webglDataRangeRef,
    displayZoomRef,
    variantBucketRef,
    debugRef,
  } = params

  const [webglCanvasNode, setWebglCanvasNode] =
    useState<HTMLCanvasElement | null>(null)
  const [webglTextureVersion, setWebglTextureVersion] = useState(0)
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const webglWorkerRef = useRef<Worker | null>(null)
  const webglDrawRafRef = useRef<number | null>(null)
  const webglTextureSizesRef = useRef<Set<number>>(new Set())
  const webglTexturesLoadingRef = useRef(false)

  const setWebglCanvasRef = useCallback((node: HTMLCanvasElement | null) => {
    webglCanvasRef.current = node
    setWebglCanvasNode(node)
  }, [])

  const drawWebgl = () => {
    const worker = webglWorkerRef.current
    if (!worker) return
    const size = traySizeRef.current
    const rTop = resultsTopRef.current
    const width = Math.max(0, Math.floor(size.width))
    const height = Math.max(0, Math.floor(size.height - rTop))
    const { columns, cell, padding } = layoutRef.current
    const scrollTop = trayRef.current?.scrollTop || 0
    const scrollOffset = Math.max(0, scrollTop - rTop)
    const visible = visibleRangeRef.current
    const windowRangeValue = windowRangeRef.current
    const limit = Math.min(visible.limit, windowRangeValue.limit)
    const { offset } = visible
    const dataRange = webglDataRangeRef.current
    const tileSize = displayZoomRef.current
    const variantSize = variantBucketRef.current || stageVariantSizes[0] || 1
    const useSolid = false
    const visibleEnd = offset + limit
    const dataEnd = dataRange.offset + dataRange.limit
    const useFallback =
      dataRange.limit <= 0 || offset < dataRange.offset || visibleEnd > dataEnd
    const drawLimit = useFallback ? visible.limit : limit
    const layerCount =
      stageVariantLayersBySize.get(variantSize)?.length ||
      stageVariantBaseNames.length ||
      0
    debugRef.current.logZoomTrace('draw_webgl', {
      width,
      height,
      columns,
      cell: roundNumber(cell, 2),
      padding,
      scrollOffset: roundNumber(scrollOffset, 2),
      offset,
      limit: drawLimit,
      tileSize: roundNumber(tileSize, 2),
      variantSize,
      useSolid,
      useFallback,
    })
    worker.postMessage({
      type: 'draw',
      width,
      height,
      columns,
      cell,
      padding,
      scrollOffset,
      offset,
      limit: drawLimit,
      tileSize,
      variantSize,
      useSolid,
      useFallback,
      layerCount,
    })
  }

  const scheduleWebglDraw = () => {
    if (webglDrawRafRef.current != null) return
    webglDrawRafRef.current = window.requestAnimationFrame(() => {
      webglDrawRafRef.current = null
      drawWebgl()
    })
  }

  // Worker init
  useEffect(() => {
    if (!canUseWebglWorker || !webglCanvasNode) return
    if (webglWorkerRef.current) return
    const worker = new Worker(
      new URL('../workers/trayWebglWorker.ts', import.meta.url),
      { type: 'module' },
    )
    const offscreen = webglCanvasNode.transferControlToOffscreen()
    worker.onmessage = (event) => {
      const { data } = event
      if (data?.type === 'perf')
        perfLog.duration(data.name, data.durationMs, data.meta)
      if (data?.type === 'error')
        perfLog.event('webgl_error', { message: data.message })
    }
    worker.postMessage(
      { type: 'init', canvas: offscreen, dpr: window.devicePixelRatio || 1 },
      [offscreen],
    )
    webglWorkerRef.current = worker
    return () => {
      worker.terminate()
      webglWorkerRef.current = null
      webglTextureSizesRef.current.clear()
      webglTexturesLoadingRef.current = false
    }
  }, [canUseWebglWorker, webglCanvasNode])

  // Palette push
  useEffect(() => {
    const worker = webglWorkerRef.current
    if (!worker) return
    worker.postMessage({ type: 'palette', colors: stageColorPalette })
  }, [stageColorPalette, webglCanvasNode])

  // Texture loading
  useEffect(() => {
    if (!canUseWebglWorker) return
    const worker = webglWorkerRef.current
    if (!worker || webglTexturesLoadingRef.current) return
    if (webglTextureSizesRef.current.size >= stageVariantSizes.length) return

    let cancelled = false
    const run = async () => {
      webglTexturesLoadingRef.current = true
      debugRef.current.setTaskLabel('loading textures')
      for (const size of stageVariantSizes) {
        if (cancelled) break
        if (webglTextureSizesRef.current.has(size)) continue
        const layers = stageVariantLayersBySize.get(size) || []
        if (layers.length === 0) continue
        const fallbackUrl = layers.find((layer) => layer.url)?.url || ''
        const bitmaps: ImageBitmap[] = []
        for (const layer of layers) {
          const url = layer.url || fallbackUrl
          const bitmap = await loadStageBitmap(url)
          if (bitmap) bitmaps.push(bitmap)
        }
        if (bitmaps.length !== layers.length) continue
        worker.postMessage({ type: 'textures', size, bitmaps }, bitmaps)
        webglTextureSizesRef.current.add(size)
        setWebglTextureVersion((prev) => prev + 1)
        debugRef.current.setTaskLabel(`loaded textures ${size}px`)
      }
      webglTexturesLoadingRef.current = false
      if (!cancelled) debugRef.current.setTaskLabel('idle')
    }
    run()
    return () => {
      cancelled = true
    }
  }, [canUseWebglWorker])

  return {
    webglCanvasNode,
    setWebglCanvasRef,
    webglWorkerRef,
    webglDrawRafRef,
    webglTextureSizesRef,
    webglTexturesLoadingRef,
    webglTextureVersion,
    scheduleWebglDraw,
    drawWebgl,
  }
}
