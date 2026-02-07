/**
 * DomLayer Component
 *
 * Renders clips as DOM elements for modes 'full' and 'mode2'.
 * Optimized for responsiveness:
 * - Layout updates are instant (CSS only)
 * - Clip rendering uses React.memo to prevent unnecessary re-renders
 * - Virtualized in full mode (only visible clips rendered)
 */

import React, { useMemo, useRef, useEffect, useState, useCallback, memo, type CSSProperties } from 'react'
import { Clip, type ClipData } from '../Clip'
import type { ClipMode } from '../../config/clipDisplay'
import './DomLayer.css'

type DomLayerProps = {
  clips: ClipData[]
  mode: ClipMode
  clipSize: number
  gap: number
  columns: number
  trayWidth: number
  trayHeight: number
  visible: boolean
  selectedIds: Set<string>
  onClipMouseDown: (index: number, clipId: string, event: React.MouseEvent) => void
  onClipMouseEnter: (index: number) => void
  startIndex?: number // For pagination - offset to add to local indices
}

type LayoutInfo = {
  cellSize: number
  padding: number
  totalRows: number
  totalHeight: number
}

const SCROLL_BUFFER = 2 // Extra rows to render above/below viewport

// Memoized clip wrapper to prevent re-renders when only position changes
const MemoClip = memo(function MemoClip({
  data,
  size,
  mode,
  style,
  isSelected,
  onMouseDown,
  onMouseEnter,
}: {
  data: ClipData
  size: number
  mode: ClipMode
  style: CSSProperties
  isSelected: boolean
  onMouseDown: (e: React.MouseEvent) => void
  onMouseEnter: () => void
}) {
  return (
    <Clip
      data={data}
      size={size}
      mode={mode}
      style={style}
      isSelected={isSelected}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
    />
  )
}, (prev, next) => {
  // Only re-render if data, size, mode, or selection changes
  // Don't compare handlers - they use refs so always call current handler
  return (
    prev.data === next.data &&
    prev.size === next.size &&
    prev.mode === next.mode &&
    prev.isSelected === next.isSelected
  )
})

export function DomLayer({
  clips,
  mode,
  clipSize,
  gap,
  columns,
  trayWidth,
  trayHeight,
  visible,
  selectedIds,
  onClipMouseDown,
  onClipMouseEnter,
  startIndex = 0,
}: DomLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  // Calculate layout - memoized for performance
  const layout = useMemo((): LayoutInfo => {
    if (mode === 'full') {
      // Full mode: vertical list, full width rows
      const rowHeight = clipSize + gap
      const padding = gap
      const totalRows = clips.length
      const totalHeight = totalRows * rowHeight + padding * 2
      return { cellSize: rowHeight, padding, totalRows, totalHeight }
    }
    // Grid mode
    const cellSize = clipSize + gap
    const padding = gap
    const totalRows = columns > 0 ? Math.ceil(clips.length / columns) : 0
    const totalHeight = totalRows * cellSize + padding * 2

    return { cellSize, padding, totalRows, totalHeight }
  }, [mode, clipSize, gap, columns, clips.length])

  // Handle scroll - throttled via RAF
  const scrollRafRef = useRef<number | null>(null)
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      if (containerRef.current) {
        setScrollTop(containerRef.current.scrollTop)
      }
    })
  }, [])

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current)
      }
    }
  }, [])

  // Reset scroll when mode changes
  useEffect(() => {
    if (containerRef.current && mode !== 'full') {
      containerRef.current.scrollTop = 0
      setScrollTop(0)
    }
  }, [mode])

  // Calculate visible range for virtualization
  const visibleRange = useMemo(() => {
    if (clips.length === 0) return { start: 0, end: 0 }

    if (mode === 'full') {
      // Full mode: vertical list, 1 item per row
      const { cellSize, padding } = layout
      if (cellSize <= 0) return { start: 0, end: 0 }

      const firstVisible = Math.max(0, Math.floor((scrollTop - padding) / cellSize) - SCROLL_BUFFER)
      const lastVisible = Math.ceil((scrollTop + trayHeight) / cellSize) + SCROLL_BUFFER

      return { start: firstVisible, end: Math.min(lastVisible + 1, clips.length) }
    }

    // Mode 2: render all clips (already capped by parent)
    return { start: 0, end: clips.length }
  }, [mode, scrollTop, trayHeight, layout, clips.length])

  // Container styles - update instantly on prop changes
  const containerStyle: CSSProperties = useMemo(() => ({
    display: visible ? 'block' : 'none',
    overflowY: mode === 'full' ? 'auto' : 'hidden',
    overflowX: 'hidden',
  }), [visible, mode])

  // Inner container (sets scroll height for virtualization)
  const innerStyle: CSSProperties = useMemo(() => ({
    position: 'relative',
    width: '100%',
    height: mode === 'full' ? layout.totalHeight : 'auto',
    minHeight: mode === 'full' ? layout.totalHeight : undefined,
  }), [mode, layout.totalHeight])

  // Store handlers in refs so callbacks don't go stale
  const onClipMouseDownRef = useRef(onClipMouseDown)
  onClipMouseDownRef.current = onClipMouseDown
  const onClipMouseEnterRef = useRef(onClipMouseEnter)
  onClipMouseEnterRef.current = onClipMouseEnter

  // Memoize the rendered clips to prevent unnecessary re-renders
  const renderedClips = useMemo(() => {
    if (clips.length === 0) return null
    if (mode !== 'full' && columns <= 0) return null

    const { cellSize, padding } = layout
    const result: JSX.Element[] = []

    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      const clip = clips[i]
      if (!clip) continue

      const clipId = 'id' in clip && clip.id != null
        ? String(clip.id)
        : ('path' in clip ? clip.path : String(i))

      const key = clipId ? `${clipId}-${i}` : `clip-${i}`
      const isSelected = selectedIds.has(clipId)

      // Create stable callbacks that use refs
      // Add startIndex to get global index for pagination support
      const globalIndex = startIndex + i
      const handleMouseDown = (e: React.MouseEvent) => {
        onClipMouseDownRef.current(globalIndex, clipId, e)
      }
      const handleMouseEnter = () => {
        onClipMouseEnterRef.current(globalIndex)
      }

      if (mode === 'full') {
        // Full mode: vertical list, full width
        const top = padding + i * cellSize

        result.push(
          <MemoClip
            key={key}
            data={clip}
            size={clipSize}
            mode={mode}
            style={{
              position: 'absolute',
              top,
              left: padding,
              right: padding,
            }}
            isSelected={isSelected}
            onMouseDown={handleMouseDown}
            onMouseEnter={handleMouseEnter}
          />
        )
      } else {
        // Grid mode
        const row = Math.floor(i / columns)
        const col = i % columns
        const top = padding + row * cellSize
        const left = padding + col * cellSize

        result.push(
          <MemoClip
            key={key}
            data={clip}
            size={clipSize}
            mode={mode}
            style={{
              position: 'absolute',
              top,
              left,
            }}
            isSelected={isSelected}
            onMouseDown={handleMouseDown}
            onMouseEnter={handleMouseEnter}
          />
        )
      }
    }

    return result
  }, [clips, columns, layout, visibleRange.start, visibleRange.end, clipSize, mode, selectedIds, startIndex])

  return (
    <div
      ref={containerRef}
      className="dom-layer"
      style={containerStyle}
      onScroll={handleScroll}
    >
      <div style={innerStyle}>
        {renderedClips}
      </div>
    </div>
  )
}

export default DomLayer
