/**
 * useClipMode Hook
 *
 * Determines the current clip display mode based on zoom size and visible count.
 * Returns mode and related display settings.
 */

import { useMemo } from 'react'
import {
  getClipMode,
  isFeatureVisible,
  getGapSize,
  isDomMode,
  isGpuMode,
  isScrollable,
  type ClipMode,
} from '../config/clipDisplay'

type UseClipModeParams = {
  zoomSize: number
  totalClips: number
  trayWidth: number
  trayHeight: number
}

type ClipModeResult = {
  mode: ClipMode
  isDom: boolean
  isGpu: boolean
  canScroll: boolean

  // Layout
  clipSize: number
  gap: number
  columns: number
  visibleCount: number

  // Features
  showButtons: boolean
  showText: boolean
  showCharIcons: boolean
  showBorders: boolean
  showGaps: boolean
}

/**
 * Calculate grid layout
 */
const calculateLayout = (
  clipSize: number,
  gap: number,
  trayWidth: number,
  trayHeight: number,
  totalClips: number,
) => {
  const cellSize = clipSize + gap
  const padding = gap

  // Available space
  const availableWidth = Math.max(0, trayWidth - padding * 2)
  const availableHeight = Math.max(0, trayHeight - padding * 2)

  // Calculate columns (at least 1)
  const columns =
    cellSize > 0
      ? Math.max(1, Math.floor((availableWidth + gap) / cellSize))
      : 1

  // Calculate rows that fit in viewport
  const rowsInView =
    cellSize > 0 ? Math.max(1, Math.ceil(availableHeight / cellSize)) : 1

  // Total visible clips (capped at total)
  const visibleCount = Math.min(columns * rowsInView, totalClips)

  return { columns, visibleCount }
}

export const useClipMode = ({
  zoomSize,
  totalClips,
  trayWidth,
  trayHeight,
}: UseClipModeParams): ClipModeResult => {
  return useMemo(() => {
    // Feature visibility first - determines if we show gaps
    const showButtons = isFeatureVisible('buttons', zoomSize)
    const showText = isFeatureVisible('text', zoomSize)
    const showCharIcons = isFeatureVisible('charIcons', zoomSize)
    const showBorders = isFeatureVisible('borders', zoomSize)
    const showGaps = isFeatureVisible('gaps', zoomSize)

    // Calculate gap - only if gaps are enabled
    const gap = showGaps ? getGapSize(zoomSize) : 0

    // Calculate layout with the actual gap that will be used
    const { columns, visibleCount } = calculateLayout(
      zoomSize,
      gap,
      trayWidth,
      trayHeight,
      totalClips,
    )

    // Determine mode
    const mode = getClipMode(zoomSize, visibleCount)

    // Mode flags
    const isDom = isDomMode(mode)
    const isGpu = isGpuMode(mode)
    const canScroll = isScrollable(mode)

    // In full mode, clip takes full available width
    const padding = gap
    const availableWidth = Math.max(0, trayWidth - padding * 2)
    const effectiveClipSize = mode === 'full' ? availableWidth : zoomSize

    return {
      mode,
      isDom,
      isGpu,
      canScroll,
      clipSize: effectiveClipSize,
      gap,
      columns,
      visibleCount,
      showButtons,
      showText,
      showCharIcons,
      showBorders,
      showGaps,
    }
  }, [zoomSize, totalClips, trayWidth, trayHeight])
}

export default useClipMode
