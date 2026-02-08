/**
 * GpuLayer Component
 *
 * Renders clips using WebGL for modes 'mode3' and 'mode4'.
 * - Mode 3: stage textures + character icons (future)
 * - Mode 4: solid colored squares based on stage
 *
 * Uses the existing WebGL worker infrastructure.
 *
 * NOTE: Selection functionality is implemented (selectedIds, onClipClick props)
 * but currently disabled. To enable, pass these props from Tray.tsx.
 * We can enable this later if needed.
 */

import React, { useRef, useEffect, useCallback, useMemo, useState, type CSSProperties } from 'react'
import { debugLog } from '../../debugLog'
import type { ClipMode } from '../../config/clipDisplay'
import { clipDisplayConfig } from '../../config/clipDisplay'
import { stages } from '../../../constants/stages'

type GpuLayerProps = {
  clips: { id: string; stage: number }[] // Light data with IDs
  mode: ClipMode
  clipSize: number
  gap: number
  columns: number
  trayWidth: number
  trayHeight: number
  visible: boolean
  // Selection props - implemented but disabled for now, can enable later
  selectedIds?: Set<string>
  onClipClick?: (index: number, clipId: string, event: React.MouseEvent) => void
}

// Stage color palette for GPU rendering
const buildStageColorPalette = (): Float32Array => {
  const maxStages = 64
  const palette = new Float32Array(maxStages * 4)
  const defaultColors = clipDisplayConfig.stageColors

  for (let i = 0; i < maxStages; i++) {
    const stageInfo = stages[i as keyof typeof stages] as { tag?: string } | undefined
    const tag = stageInfo?.tag
    const colorHex = (tag && tag in defaultColors)
      ? defaultColors[tag as keyof typeof defaultColors]
      : defaultColors.default

    // Parse hex color
    const hex = colorHex.replace('#', '')
    const r = parseInt(hex.slice(0, 2), 16) / 255
    const g = parseInt(hex.slice(2, 4), 16) / 255
    const b = parseInt(hex.slice(4, 6), 16) / 255

    palette[i * 4] = r
    palette[i * 4 + 1] = g
    palette[i * 4 + 2] = b
    palette[i * 4 + 3] = 1.0
  }

  return palette
}

export function GpuLayer({
  clips,
  mode,
  clipSize,
  gap,
  columns,
  trayWidth,
  trayHeight,
  visible,
  selectedIds,
  onClipClick,
}: GpuLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const drawRafRef = useRef<number | null>(null)
  const paletteRef = useRef<Float32Array | null>(null)
  const canvasTransferredRef = useRef(false)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  // Check WebGL support
  const canUseWebgl = useMemo(() => {
    if (typeof OffscreenCanvas === 'undefined') return false
    if (typeof HTMLCanvasElement === 'undefined') return false
    return 'transferControlToOffscreen' in HTMLCanvasElement.prototype
  }, [])

  // Build color palette once
  const stageColorPalette = useMemo(() => buildStageColorPalette(), [])

  // DEBUG
  useEffect(() => {
    debugLog('[GpuLayer] state', { visible, clips: clips.length, mode, canUseWebgl, workerExists: !!workerRef.current, transferred: canvasTransferredRef.current })
  }, [visible, clips.length, mode, canUseWebgl])

  // Initialize worker - only once, don't depend on visible
  useEffect(() => {
    debugLog('[GpuLayer] Init effect', { canUseWebgl, canvas: !!canvasRef.current, worker: !!workerRef.current, transferred: canvasTransferredRef.current })
    if (!canUseWebgl) return
    const canvas = canvasRef.current
    if (!canvas || workerRef.current || canvasTransferredRef.current) return

    try {
      // Mark as transferred before attempting (prevents double-transfer in StrictMode)
      canvasTransferredRef.current = true
      debugLog('[GpuLayer] Creating worker and transferring canvas')

      const worker = new Worker(
        new URL('../../workers/trayWebglWorker.ts', import.meta.url),
        { type: 'module' }
      )

      const offscreen = canvas.transferControlToOffscreen()
      worker.postMessage(
        { type: 'init', canvas: offscreen, dpr: window.devicePixelRatio || 1 },
        [offscreen]
      )

      // Send palette
      worker.postMessage({ type: 'palette', colors: stageColorPalette })
      paletteRef.current = stageColorPalette

      // Listen for worker logs
      worker.onmessage = (e) => {
        if (e.data?.type === 'log') {
          debugLog('[GpuWorker]', e.data)
        }
      }

      workerRef.current = worker
      debugLog('[GpuLayer] Worker initialized successfully')

      return () => {
        worker.terminate()
        workerRef.current = null
      }
    } catch (err) {
      debugLog('[GpuLayer] Failed to initialize WebGL worker', { error: String(err) })
    }
  }, [canUseWebgl, stageColorPalette])

  // Send clip data to worker
  useEffect(() => {
    const worker = workerRef.current
    if (!worker || !visible || clips.length === 0) return

    // Build stage ID array
    const stageIds = new Float32Array(clips.length)
    const stageLayers = new Float32Array(clips.length)

    for (let i = 0; i < clips.length; i++) {
      stageIds[i] = clips[i].stage
      stageLayers[i] = 0 // Default layer
    }

    worker.postMessage({
      type: 'data',
      offset: 0,
      limit: clips.length,
      stageIds,
      stageLayers,
    })
  }, [clips, visible])

  // Draw function
  const draw = useCallback(() => {
    const worker = workerRef.current
    if (!worker || !visible) {
      debugLog('[GpuLayer] draw() skipped', { worker: !!worker, visible })
      return
    }

    const cellSize = clipSize + gap
    const padding = gap

    const drawParams = {
      type: 'draw',
      width: Math.floor(trayWidth),
      height: Math.floor(trayHeight),
      columns,
      cell: cellSize,
      padding,
      scrollOffset: 0, // No scroll in GPU modes
      offset: 0,
      limit: clips.length,
      tileSize: clipSize,
      variantSize: clipSize,
      useSolid: true,     // Use solid colors (not textures)
      useFallback: false, // Use actual stage IDs from buffer, not index-based
      layerCount: 1,
    }
    debugLog('[GpuLayer] draw()', drawParams)
    worker.postMessage(drawParams)
  }, [visible, clipSize, gap, columns, trayWidth, trayHeight, clips.length, mode])

  // Schedule draw on RAF
  const scheduleDraw = useCallback(() => {
    if (drawRafRef.current != null) return
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = null
      draw()
    })
  }, [draw])

  // Redraw when params change
  useEffect(() => {
    if (visible && workerRef.current) {
      scheduleDraw()
    }
  }, [visible, clipSize, gap, columns, trayWidth, trayHeight, clips.length, scheduleDraw])

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (drawRafRef.current != null) {
        cancelAnimationFrame(drawRafRef.current)
      }
    }
  }, [])

  // Calculate grid position from mouse coordinates
  const getClipAtPosition = useCallback((x: number, y: number): { index: number; id: string } | null => {
    const cellSize = clipSize + gap
    const padding = gap

    const col = Math.floor((x - padding) / cellSize)
    const row = Math.floor((y - padding) / cellSize)

    if (col < 0 || col >= columns || row < 0) return null

    const index = row * columns + col
    if (index < 0 || index >= clips.length) return null

    return { index, id: clips[index].id }
  }, [clipSize, gap, columns, clips])

  // Handle click on overlay (only if selection enabled)
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!onClipClick) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const hit = getClipAtPosition(x, y)
    if (hit) {
      onClipClick(hit.index, hit.id, e)
    }
  }, [getClipAtPosition, onClipClick])

  // Handle mouse move for hover effect
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const hit = getClipAtPosition(x, y)
    setHoverIndex(hit ? hit.index : null)
  }, [getClipAtPosition])

  const handleMouseLeave = useCallback(() => {
    setHoverIndex(null)
  }, [])

  // Selection enabled check
  const selectionEnabled = !!selectedIds && !!onClipClick

  // Generate hover overlay (only if selection enabled)
  const hoverOverlay = useMemo(() => {
    if (!selectionEnabled) return null
    if (hoverIndex === null || hoverIndex >= clips.length) return null
    // Don't show hover if already selected
    if (selectedIds!.has(clips[hoverIndex].id)) return null

    const cellSize = clipSize + gap
    const padding = gap
    const row = Math.floor(hoverIndex / columns)
    const col = hoverIndex % columns
    const top = padding + row * cellSize
    const left = padding + col * cellSize

    return (
      <div
        style={{
          position: 'absolute',
          top,
          left,
          width: clipSize,
          height: clipSize,
          outline: '2px solid #3a7bff',
          outlineOffset: '-2px',
          pointerEvents: 'none',
        }}
      />
    )
  }, [selectionEnabled, hoverIndex, clips, clipSize, gap, columns, selectedIds])

  // Generate selection overlay elements (only if selection enabled)
  const selectionOverlays = useMemo(() => {
    if (!selectionEnabled || selectedIds!.size === 0) return null

    const cellSize = clipSize + gap
    const padding = gap
    const overlays: JSX.Element[] = []

    for (let i = 0; i < clips.length; i++) {
      if (!selectedIds!.has(clips[i].id)) continue

      const row = Math.floor(i / columns)
      const col = i % columns
      const top = padding + row * cellSize
      const left = padding + col * cellSize

      // Skip if off-screen
      if (top > trayHeight || left > trayWidth) continue

      overlays.push(
        <div
          key={clips[i].id}
          style={{
            position: 'absolute',
            top,
            left,
            width: clipSize,
            height: clipSize,
            background: 'rgba(58, 123, 255, 0.25)',
            outline: '2px solid #3a7bff',
            outlineOffset: '-2px',
            pointerEvents: 'none',
          }}
        />
      )
    }

    return overlays
  }, [selectionEnabled, selectedIds, clips, clipSize, gap, columns, trayWidth, trayHeight])

  const containerStyle: CSSProperties = {
    display: visible ? 'block' : 'none',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  }

  const canvasStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    imageRendering: 'pixelated',
  }

  const overlayStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    cursor: 'pointer',
  }

  if (!canUseWebgl) {
    return (
      <div style={containerStyle}>
        <div style={{ padding: 20, color: '#666' }}>
          WebGL not supported
        </div>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <canvas
        ref={canvasRef}
        style={canvasStyle}
      />
      {/* Click detection and selection overlay - only rendered if selection enabled */}
      {selectionEnabled && (
        <div
          style={overlayStyle}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {hoverOverlay}
          {selectionOverlays}
        </div>
      )}
    </div>
  )
}

export default GpuLayer
