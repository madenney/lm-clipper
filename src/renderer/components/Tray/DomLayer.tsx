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
  useLayoutEffect,
  useState,
  useCallback,
  useId,
  memo,
  type CSSProperties,
} from 'react'
import { Clip, type ClipData } from '../Clip'
import type { ClipMode } from '../../config/clipDisplay'
import type { Selection } from '../../../lib/selection'
import {
  SCROLL_BUFFER,
  buildRange,
  screenRange,
  spacerBlocks,
} from '../../lib/domGrid'
import {
  anchorAt,
  handoffAnchor,
  scrollFor,
  writePlace,
  type Grid,
  type ViewHandoff,
} from '../../lib/viewAnchor'
import {
  physicalFor,
  scrollAreaHeight,
  scrollStep,
} from '../../lib/scrollSpace'
import { gridKeyTarget, scrollToShow } from '../../lib/gridKeys'
import { getClipPayload } from '../Clip/clipUtils'
import './DomLayer.css'

type DomLayerProps = {
  clips: ClipData[]
  mode: ClipMode
  clipSize: number
  gap: number
  columns: number
  trayWidth: number
  trayHeight: number
  /** Off: renders nothing and reports no range (the GPU overview is showing). */
  visible: boolean
  selection: Selection
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
  /** Position of clips[0] in the whole list (the loaded window's start). */
  startIndex?: number
  /** Every result's count: the grid's scroll height covers them all, rows not
   *  loaded yet show placeholders (tray-v2.md). Defaults to the loaded clips. */
  total?: number
  /** What's on screen (global positions [first, last)), so the parent can load
   *  the rows around it. */
  onVisibleRange?: (_first: number, _last: number) => void
  reorderActive?: boolean
  reorderDraggingIds?: Set<string> | null
  reorderInsertIndex?: number | null
  onReorderInsertIndexChange?: (_index: number | null) => void
  /** Shared with the GPU view (lib/viewAnchor.ts): the grid starts where that
   *  view was, keeps the clip under the cursor across its own zooms and leaves
   *  where it is. */
  handoff?: ViewHandoff
}

type LayoutInfo = {
  cellSize: number
  padding: number
  totalRows: number
  totalHeight: number
}

// Memoized clip wrapper to prevent re-renders when only position changes
const MemoClip = memo(
  function MemoClip({
    data,
    size,
    mode,
    style,
    isSelected,
    kbdActive,
    domId,
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
    kbdActive?: boolean
    domId?: string
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
        kbdActive={kbdActive}
        domId={domId}
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
      prev.kbdActive === next.kbdActive &&
      prev.domId === next.domId &&
      // Moves when the scroll area re-bases (lib/scrollSpace.ts).
      prev.style.top === next.style.top &&
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
  selection,
  onClipMouseDown,
  onClipMouseEnter,
  onClipDoubleClick,
  onClipPlay,
  onClipRecord,
  onBackgroundClick,
  startIndex = 0,
  total: totalProp,
  onVisibleRange,
  reorderActive = false,
  reorderDraggingIds = null,
  reorderInsertIndex = null,
  onReorderInsertIndexChange,
  handoff,
}: DomLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const total = Math.max(totalProp ?? 0, startIndex + clips.length)
  // The grid's geometry for lib/viewAnchor.ts (cell = tile + gap, padded by gap).
  const grid: Grid = {
    cell: clipSize + gap,
    padding: gap,
    cols: columns,
    total,
  }
  const contentHeight =
    (columns > 0 ? Math.ceil(total / columns) : 0) * grid.cell + gap * 2
  // Start where the GPU view was (crossing 120 px), or at the top.
  const [scrollTop, setScrollTop] = useState(() => {
    const anchor = mode !== 'full' ? handoffAnchor(handoff) : null
    return anchor ? scrollFor(anchor, grid, trayHeight, contentHeight) : 0
  })
  // The scroll as last set or seen (state lags a frame behind the scroll event).
  // Logical px: a huge list scrolls further than the browser's ~33.5M px limit
  // (lib/scrollSpace.ts); tiles are placed at their top - offset.
  const scrollRef = useRef(scrollTop)
  const [offset, setOffset] = useState(0)
  const offsetRef = useRef(0)
  // The physical scroll last seen or set.
  const physRef = useRef(0)

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
    const totalRows = columns > 0 ? Math.ceil(total / columns) : 0
    const totalHeight = totalRows * cellSize + padding * 2

    return { cellSize, padding, totalRows, totalHeight }
  }, [mode, clipSize, gap, columns, clips.length, total])

  // Put the grid at a logical scroll (its physical scroll at the same fraction).
  const scrollToLogical = useCallback(
    (logical: number) => {
      const container = containerRef.current
      const phys = physicalFor(logical, layout.totalHeight, trayHeight)
      if (container && container.scrollTop !== phys) container.scrollTop = phys
      physRef.current = phys
      offsetRef.current = logical - phys
      scrollRef.current = logical
      setOffset(offsetRef.current)
    },
    [layout.totalHeight, trayHeight],
  )
  const geometryRef = useRef({ content: layout.totalHeight, view: trayHeight })
  geometryRef.current = { content: layout.totalHeight, view: trayHeight }

  // Handle scroll - throttled via RAF
  const scrollRafRef = useRef<number | null>(null)
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (container) {
      // Every event (not per frame): steps are classified by their size.
      const { content, view } = geometryRef.current
      const phys = container.scrollTop
      const step = scrollStep(
        physRef.current,
        phys,
        offsetRef.current,
        content,
        view,
      )
      if (step.rebase !== null) container.scrollTop = step.rebase
      physRef.current = step.rebase ?? phys
      offsetRef.current = step.offset
      scrollRef.current = step.logical
    }
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      setOffset(offsetRef.current)
      setScrollTop(scrollRef.current)
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

  // Keep your place (lib/viewAnchor.ts): on mount, scroll to where the other
  // view was; when the tile size or columns change (zoom, resize), put the clip
  // that was under the cursor (or at the top) back where it was.
  const gridRef = useRef<Grid | null>(null)
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || mode === 'full') return
    const prev = gridRef.current
    gridRef.current = grid
    let next = scrollRef.current
    // The clip at the zoom's cursor in the grid as it was drawn.
    const anchor =
      prev && handoff ? anchorAt(scrollRef.current, handoff.focus, prev) : null
    if (anchor) next = scrollFor(anchor, grid, trayHeight, contentHeight)
    scrollToLogical(next)
    if (next !== scrollTop) setScrollTop(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.cell, grid.padding, columns, mode])
  // A list that grows or shrinks (a running filter, a removal) past the scroll
  // area's limit: the same logical place, physical scroll re-fitted.
  const fitsRef = useRef(
    scrollAreaHeight(layout.totalHeight) >= layout.totalHeight,
  )
  useLayoutEffect(() => {
    const fits = scrollAreaHeight(layout.totalHeight) >= layout.totalHeight
    if (mode === 'full' || (fits && fitsRef.current && offsetRef.current === 0))
      return
    fitsRef.current = fits
    scrollToLogical(
      Math.min(scrollRef.current, Math.max(0, layout.totalHeight - trayHeight)),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.totalHeight])
  // Where the grid is now, for the next zoom or the GPU view.
  useEffect(() => {
    if (mode === 'full') return
    writePlace(handoff, { scroll: scrollRef.current, grid })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, mode, scrollTop, grid.cell, grid.padding, columns, total])

  // Calculate visible range for virtualization
  const visibleRange = useMemo(() => {
    if (clips.length === 0 && total === 0) return { start: 0, end: 0 }

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

    // Grid modes: virtualize by row (global positions), capped at
    // MAX_DOM_TILES whatever the screen size (lib/domGrid.ts).
    if (!visible) return { start: 0, end: 0 }
    return buildRange({
      scrollTop,
      trayHeight,
      cellSize: layout.cellSize,
      padding: layout.padding,
      columns,
      total,
    })
  }, [
    visible,
    mode,
    scrollTop,
    trayHeight,
    layout,
    clips.length,
    total,
    startIndex,
    columns,
  ])

  // Tell the parent what's on screen (without the render buffer).
  const onVisibleRangeRef = useRef(onVisibleRange)
  onVisibleRangeRef.current = onVisibleRange
  useEffect(() => {
    if (!visible || mode === 'full' || columns <= 0 || layout.cellSize <= 0)
      return
    const { first, last } = screenRange({
      scrollTop,
      trayHeight,
      cellSize: layout.cellSize,
      padding: layout.padding,
      columns,
      total,
    })
    onVisibleRangeRef.current?.(first, last)
  }, [visible, mode, scrollTop, trayHeight, layout, columns, total])

  // Container styles - update instantly on prop changes
  const containerStyle: CSSProperties = useMemo(
    () => ({
      overflowY: 'auto',
      overflowX: 'hidden',
    }),
    [],
  )

  // Inner container (sets scroll height for virtualization), never past the
  // browser's limit (lib/scrollSpace.ts).
  const innerStyle: CSSProperties = useMemo(() => {
    const height =
      mode === 'full'
        ? layout.totalHeight
        : scrollAreaHeight(layout.totalHeight)
    return { position: 'relative', width: '100%', height, minHeight: height }
  }, [mode, layout.totalHeight])

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

      const mouseY = e.clientY - rect.top + scrollRef.current
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
        // Global position, kept inside the loaded window (the drop reorders it).
        onReorderInsertIndexChangeRef.current?.(
          Math.max(startIndex, Math.min(idx, startIndex + clips.length)),
        )
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    return () => document.removeEventListener('mousemove', handleMouseMove)
  }, [reorderActive, layout, mode, columns, clips.length, startIndex])

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

  // Keyboard: the grid is one tab stop and a listbox of cards. Arrow keys move a highlighted
  // card, Enter opens it in Single, Space toggles it, P plays and R records it. This only
  // runs after the keyboard focused the grid (`kbd`): a click also focuses it, and then ↑/↓
  // must keep stepping the filter list (Tray's shortcut).
  const listId = useId()
  const optionId = (index: number) => `${listId}-clip-${index}`
  const [kbd, setKbd] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const pointerDownRef = useRef(false)
  const showIndex = (index: number) => {
    const next = scrollToShow(
      index,
      columns,
      layout.cellSize,
      layout.padding,
      clipSize,
      scrollRef.current,
      trayHeight,
    )
    if (next !== scrollRef.current) {
      scrollToLogical(next)
      setScrollTop(next)
    }
  }
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mode === 'full' || !kbd || e.ctrlKey || e.metaKey || e.altKey) return
    const first = screenRange({
      scrollTop: scrollRef.current,
      trayHeight,
      cellSize: layout.cellSize,
      padding: layout.padding,
      columns,
      total,
    }).first
    const current = Math.min(Math.max(0, total - 1), activeIndex ?? first)
    const target = gridKeyTarget(e.key, current, columns, total)
    if (target !== null) {
      e.preventDefault()
      setActiveIndex(target)
      showIndex(target)
      return
    }
    const clip = clips[current - startIndex]
    if (!clip) return
    const clipId =
      'id' in clip && clip.id != null
        ? String(clip.id)
        : 'path' in clip && clip.path
          ? clip.path
          : ''
    const key = e.key.toLowerCase()
    if (e.key === 'Enter') {
      e.preventDefault()
      onClipDoubleClickRef.current?.(current, clipId)
    } else if (e.key === ' ') {
      e.preventDefault()
      // The same as a ctrl-click: toggle this card.
      onClipMouseDownRef.current(current, clipId, {
        button: 0,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        clientX: 0,
        clientY: 0,
      } as React.MouseEvent)
    } else if (key === 'p') {
      const payload = getClipPayload(clip)
      if (payload && onClipPlayRef.current) {
        e.preventDefault()
        onClipPlayRef.current(payload)
      }
    } else if (key === 'r' && onClipRecordRef.current) {
      e.preventDefault()
      onClipRecordRef.current(clipId)
    }
  }

  // Memoize the rendered clips to prevent unnecessary re-renders
  const renderedClips = useMemo(() => {
    if (!visible) return null
    if (clips.length === 0 && total === 0) return null
    if (mode !== 'full' && columns <= 0) return null

    const { cellSize, padding } = layout
    const result: JSX.Element[] = []

    // Positions not loaded yet (scrolled past the window): one placeholder
    // block per gap, not one element per tile.
    if (mode !== 'full') {
      const loadedFrom = Math.max(visibleRange.start, startIndex)
      const loadedTo = Math.min(visibleRange.end, startIndex + clips.length)
      const gaps: [number, number][] =
        loadedTo > loadedFrom
          ? [
              [visibleRange.start, loadedFrom],
              [loadedTo, visibleRange.end],
            ]
          : [[visibleRange.start, visibleRange.end]]
      for (const [from, to] of gaps) {
        spacerBlocks(from, to, columns, cellSize, padding, clipSize).forEach(
          (rect) =>
            result.push(
              <div
                key={`ph-${from}-${rect.top}`}
                className="dom-placeholder"
                style={{
                  position: 'absolute',
                  ...rect,
                  top: rect.top - offset,
                  ['--cell' as string]: `${cellSize}px`,
                  ['--tile' as string]: `${clipSize}px`,
                }}
              />,
            ),
        )
      }
    }

    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      const clip = mode === 'full' ? clips[i] : clips[i - startIndex]
      if (!clip) continue

      const clipId =
        'id' in clip && clip.id != null
          ? String(clip.id)
          : 'path' in clip && clip.path
            ? clip.path
            : String(i)

      const key = clipId ? `${clipId}-${i}` : `clip-${i}`
      const isSelected = selection.has(clipId)
      const isDragging = reorderActive && reorderDraggingIds?.has(clipId)

      // Callbacks get the clip's position in the whole list.
      const globalIndex = mode === 'full' ? startIndex + i : i
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
        const top = padding + row * cellSize - offset
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
            kbdActive={kbd && activeIndex === globalIndex}
            domId={optionId(globalIndex)}
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
    visible,
    clips,
    columns,
    layout,
    kbd,
    activeIndex,
    visibleRange.start,
    visibleRange.end,
    clipSize,
    mode,
    selection,
    startIndex,
    reorderActive,
    reorderDraggingIds,
    offset,
  ])

  if (!visible) return null

  return (
    <div
      ref={containerRef}
      className={`dom-layer${reorderActive ? ' dom-layer--reordering' : ''}`}
      style={containerStyle}
      onScroll={handleScroll}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={mode === 'full' ? undefined : 0}
      role={mode === 'full' ? undefined : 'listbox'}
      aria-label={mode === 'full' ? undefined : 'Clips'}
      aria-multiselectable={mode === 'full' ? undefined : true}
      aria-activedescendant={
        kbd &&
        activeIndex !== null &&
        activeIndex >= visibleRange.start &&
        activeIndex < visibleRange.end
          ? optionId(activeIndex)
          : undefined
      }
      onKeyDown={handleKeyDown}
      onMouseDown={() => {
        pointerDownRef.current = true
        setKbd(false)
      }}
      onMouseUp={() => {
        pointerDownRef.current = false
      }}
      onFocus={() => {
        if (pointerDownRef.current) return
        setKbd(true)
        // Start on the first card on screen.
        setActiveIndex(
          (prev) =>
            prev ??
            screenRange({
              scrollTop: scrollRef.current,
              trayHeight,
              cellSize: layout.cellSize,
              padding: layout.padding,
              columns,
              total,
            }).first,
        )
      }}
      onBlur={() => setKbd(false)}
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
                    top:
                      padding +
                      prevRow * cellSize +
                      clipSize +
                      gap / 2 -
                      1 -
                      offset,
                    left: padding,
                    width: columns * cellSize - gap,
                    height: 3,
                  }
                }
                return {
                  position: 'absolute' as const,
                  top: padding + row * cellSize - offset,
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
