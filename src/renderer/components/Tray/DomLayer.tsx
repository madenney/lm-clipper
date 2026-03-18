/**
 * DomLayer Component
 *
 * Renders clips as DOM elements for modes 'full' and 'mode2'.
 * Optimized for responsiveness:
 * - Layout updates are instant (CSS only)
 * - Clip rendering uses React.memo to prevent unnecessary re-renders
 * - Virtualized in full mode (only visible clips rendered)
 */

import React, {
  useMemo,
  useRef,
  useEffect,
  useState,
  useCallback,
  memo,
  type CSSProperties,
} from 'react'
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
  onClipMouseDown: (
    _index: number,
    _clipId: string,
    _event: React.MouseEvent,
  ) => void
  onClipMouseEnter: (_index: number) => void
  onClipDoubleClick?: (_index: number, _clipId: string) => void
  onClipPlay?: (_payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  }) => void
  onClipRecord?: (_clipId: string) => void
  onBackgroundClick: () => void
  startIndex?: number // For pagination - offset to add to local indices
  reorderActive?: boolean
  reorderDraggingIds?: Set<string> | null
  reorderInsertIndex?: number | null
  onReorderInsertIndexChange?: (_index: number | null) => void
}

type LayoutInfo = {
  cellSize: number
  padding: number
  totalRows: number
  totalHeight: number
}

const SCROLL_BUFFER = 2 // Extra rows to render above/below viewport

// Memoized clip wrapper to prevent re-renders when only position changes
const MemoClip = memo(
  function MemoClip({
    data,
    size,
    mode,
    style,
    isSelected,
    onMouseDown,
    onDoubleClick,
    onMouseEnter,
    onPlay,
    onRecord,
  }: {
    data: ClipData
    size: number
    mode: ClipMode
    style: CSSProperties
    isSelected: boolean
    onMouseDown: (_e: React.MouseEvent) => void
    onDoubleClick?: (_e: React.MouseEvent) => void
    onMouseEnter: () => void
    onPlay?: (_payload: {
      path: string
      startFrame?: number
      endFrame?: number
      lastFrame?: number
    }) => void
    onRecord?: () => void
  }) {
    return (
      <Clip
        data={data}
        size={size}
        mode={mode}
        style={style}
        isSelected={isSelected}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onMouseEnter={onMouseEnter}
        onPlay={onPlay}
        onRecord={onRecord}
      />
    )
  },
  (prev, next) => {
    // Only re-render if data, size, mode, or selection changes
    // Don't compare handlers - they use refs so always call current handler
    return (
      prev.data === next.data &&
      prev.size === next.size &&
      prev.mode === next.mode &&
      prev.isSelected === next.isSelected &&
      prev.style.opacity === next.style.opacity &&
      prev.style.transform === next.style.transform
    )
  },
)

export function DomLayer({
  clips,
  mode,
  clipSize,
  gap,
  columns,
  trayWidth: _trayWidth,
  trayHeight,
  visible,
  selectedIds,
  onClipMouseDown,
  onClipMouseEnter,
  onClipDoubleClick,
  onClipPlay,
  onClipRecord,
  onBackgroundClick,
  startIndex = 0,
  reorderActive = false,
  reorderDraggingIds = null,
  reorderInsertIndex = null,
  onReorderInsertIndexChange,
}: DomLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  // Calculate layout - memoized for performance
  const layout = useMemo((): LayoutInfo => {
    if (mode === 'full') {
      // Full mode: vertical list, full width rows with proper padding
      const padding = 16
      const rowHeight = clipSize + padding
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

      const firstVisible = Math.max(
        0,
        Math.floor((scrollTop - padding) / cellSize) - SCROLL_BUFFER,
      )
      const lastVisible =
        Math.ceil((scrollTop + trayHeight) / cellSize) + SCROLL_BUFFER

      return {
        start: firstVisible,
        end: Math.min(lastVisible + 1, clips.length),
      }
    }

    // Grid modes: virtualize by row
    const { cellSize, padding } = layout
    if (cellSize <= 0 || columns <= 0) return { start: 0, end: clips.length }

    const firstRow = Math.max(
      0,
      Math.floor((scrollTop - padding) / cellSize) - SCROLL_BUFFER,
    )
    const lastRow =
      Math.ceil((scrollTop + trayHeight) / cellSize) + SCROLL_BUFFER

    return {
      start: firstRow * columns,
      end: Math.min((lastRow + 1) * columns, clips.length),
    }
  }, [mode, scrollTop, trayHeight, layout, clips.length])

  // Container styles - update instantly on prop changes
  const containerStyle: CSSProperties = useMemo(
    () => ({
      display: visible ? 'block' : 'none',
      overflowY: 'auto',
      overflowX: 'hidden',
    }),
    [visible],
  )

  // Inner container (sets scroll height for virtualization)
  const innerStyle: CSSProperties = useMemo(
    () => ({
      position: 'relative',
      width: '100%',
      height: layout.totalHeight,
      minHeight: layout.totalHeight,
    }),
    [layout.totalHeight],
  )

  // Track reorder insert position from mouse
  const onReorderInsertIndexChangeRef = useRef(onReorderInsertIndexChange)
  onReorderInsertIndexChangeRef.current = onReorderInsertIndexChange

  useEffect(() => {
    if (!reorderActive || !containerRef.current) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const { cellSize, padding } = layout
      if (cellSize <= 0) return

      const mouseY = e.clientY - rect.top + container.scrollTop
      const mouseX = e.clientX - rect.left

      if (mode === 'full') {
        const idx = Math.round((mouseY - padding) / cellSize)
        onReorderInsertIndexChangeRef.current?.(
          Math.max(0, Math.min(idx, clips.length)),
        )
      } else {
        const row = Math.floor((mouseY - padding) / cellSize)
        const col = Math.round((mouseX - padding) / cellSize)
        const clampedCol = Math.max(0, Math.min(col, columns))
        const idx = row * columns + clampedCol
        onReorderInsertIndexChangeRef.current?.(
          Math.max(0, Math.min(idx, clips.length)),
        )
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    return () => document.removeEventListener('mousemove', handleMouseMove)
  }, [reorderActive, layout, mode, columns, clips.length])

  // Store handlers in refs so callbacks don't go stale
  const onClipMouseDownRef = useRef(onClipMouseDown)
  onClipMouseDownRef.current = onClipMouseDown
  const onClipMouseEnterRef = useRef(onClipMouseEnter)
  onClipMouseEnterRef.current = onClipMouseEnter
  const onClipDoubleClickRef = useRef(onClipDoubleClick)
  onClipDoubleClickRef.current = onClipDoubleClick
  const onClipPlayRef = useRef(onClipPlay)
  onClipPlayRef.current = onClipPlay
  const onClipRecordRef = useRef(onClipRecord)
  onClipRecordRef.current = onClipRecord

  // Memoize the rendered clips to prevent unnecessary re-renders
  const renderedClips = useMemo(() => {
    if (clips.length === 0) return null
    if (mode !== 'full' && columns <= 0) return null

    const { cellSize, padding } = layout
    const result: JSX.Element[] = []

    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      const clip = clips[i]
      if (!clip) continue

      const clipId =
        'id' in clip && clip.id != null
          ? String(clip.id)
          : 'path' in clip && clip.path
            ? clip.path
            : String(i)

      const key = clipId ? `${clipId}-${i}` : `clip-${i}`
      const isSelected = selectedIds.has(clipId)
      const isDragging = reorderActive && reorderDraggingIds?.has(clipId)

      // Create stable callbacks that use refs
      // Add startIndex to get global index for pagination support
      const globalIndex = startIndex + i
      const handleMouseDown = (e: React.MouseEvent) => {
        onClipMouseDownRef.current(globalIndex, clipId, e)
      }
      const handleMouseEnter = () => {
        onClipMouseEnterRef.current(globalIndex)
      }
      const handleDoubleClick = onClipDoubleClickRef.current
        ? () => onClipDoubleClickRef.current?.(globalIndex, clipId)
        : undefined
      const handlePlay = onClipPlayRef.current
        ? (payload: {
            path: string
            startFrame?: number
            endFrame?: number
            lastFrame?: number
          }) => onClipPlayRef.current?.(payload)
        : undefined
      const handleRecord = onClipRecordRef.current
        ? () => onClipRecordRef.current?.(clipId)
        : undefined

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
              opacity: isDragging ? 0.4 : undefined,
              transform: isDragging ? 'scale(0.95)' : undefined,
              transition: isDragging
                ? 'opacity 150ms ease, transform 150ms ease'
                : undefined,
            }}
            isSelected={isSelected}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            onMouseEnter={handleMouseEnter}
            onPlay={handlePlay}
            onRecord={handleRecord}
          />,
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
              opacity: isDragging ? 0.4 : undefined,
              transform: isDragging ? 'scale(0.95)' : undefined,
              transition: isDragging
                ? 'opacity 150ms ease, transform 150ms ease'
                : undefined,
            }}
            isSelected={isSelected}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            onMouseEnter={handleMouseEnter}
            onPlay={handlePlay}
            onRecord={handleRecord}
          />,
        )
      }
    }

    return result
  }, [
    clips,
    columns,
    layout,
    visibleRange.start,
    visibleRange.end,
    clipSize,
    mode,
    selectedIds,
    startIndex,
    reorderActive,
    reorderDraggingIds,
  ])

  return (
    <div
      ref={containerRef}
      className={`dom-layer${reorderActive ? ' dom-layer--reordering' : ''}`}
      style={containerStyle}
      onScroll={handleScroll}
      onClick={(e) => {
        if (
          e.target === e.currentTarget ||
          e.target === containerRef.current?.firstElementChild
        ) {
          onBackgroundClick()
        }
      }}
    >
      <div style={innerStyle}>
        {renderedClips}
        {reorderActive &&
          reorderInsertIndex !== null &&
          reorderInsertIndex >= 0 && (
            <div
              className="reorder-indicator"
              style={(() => {
                const { cellSize, padding } = layout
                if (mode === 'full') {
                  return {
                    position: 'absolute' as const,
                    top: padding + reorderInsertIndex * cellSize - 2,
                    left: padding,
                    right: padding,
                    height: 3,
                  }
                }
                const row = Math.floor(reorderInsertIndex / columns)
                const col = reorderInsertIndex % columns
                if (col === 0 && reorderInsertIndex > 0) {
                  // End of previous row — show horizontal bar at row boundary
                  const prevRow = row - 1
                  return {
                    position: 'absolute' as const,
                    top: padding + prevRow * cellSize + clipSize + gap / 2 - 1,
                    left: padding,
                    width: columns * cellSize - gap,
                    height: 3,
                  }
                }
                return {
                  position: 'absolute' as const,
                  top: padding + row * cellSize,
                  left: padding + col * cellSize - gap / 2 - 1,
                  width: 3,
                  height: clipSize,
                }
              })()}
            />
          )}
      </div>
    </div>
  )
}

export default DomLayer
