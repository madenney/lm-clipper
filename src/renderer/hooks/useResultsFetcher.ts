import { useState, useEffect, useRef, type MutableRefObject } from 'react'
import ipcBridge from 'renderer/ipcBridge'
import type { ClipInterface, FileInterface, LiteItem } from '../../constants/types'
import { zoomConfig } from '../zoomConfig'
import { perfLog } from '../perfLogger'
import { stageLayerById } from '../stageVariantAssets'
import { roundNumber } from '../lib/layoutMath'

type DebugFns = {
  logZoomTrace: (event: string, meta?: Record<string, string | number | boolean | null>) => void
  setTaskLabel: (label: string) => void
}

type Range = { offset: number; limit: number }

const liteResultsThreshold = 6000
const webglFetchDebounceMs = 120
const perfLogFetchThresholdMs = 8

export type UseResultsFetcherParams = {
  archive: { files: number; filters: { id: string; results: number }[] } | null
  activeFilter: { id: string; tableId: string }
  windowRange: Range
  visibleRange: Range
  pageOffset: number
  useWebglMode: boolean
  webglWanted: boolean
  renderMode: string
  webglWorkerRef: MutableRefObject<Worker | null>
  webglDataRangeRef: MutableRefObject<Range>
  scheduleWebglDrawRef: MutableRefObject<() => void>
  debugRef: MutableRefObject<DebugFns>
  visibleCountRef: MutableRefObject<number>
  showingCountStore: { set: (value: number) => void }
}

export const useResultsFetcher = (params: UseResultsFetcherParams) => {
  const {
    archive, activeFilter, windowRange, visibleRange, pageOffset,
    useWebglMode, webglWanted, renderMode,
    webglWorkerRef, webglDataRangeRef, scheduleWebglDrawRef, debugRef,
    visibleCountRef, showingCountStore,
  } = params

  type ResultItem = ClipInterface | FileInterface | LiteItem
  const [currentResults, setCurrentResults] = useState<ResultItem[]>([])
  const resultsRequestId = useRef(0)
  const webglFetchTimeoutRef = useRef<number | null>(null)

  // Clear on archive change
  useEffect(() => {
    if (!archive) {
      setCurrentResults([])
      visibleCountRef.current = 0
      showingCountStore.set(0)
    }
  }, [archive])

  // Clear DOM results when entering WebGL mode
  useEffect(() => {
    if (!useWebglMode) return
    setCurrentResults([])
    scheduleWebglDrawRef.current()
  }, [useWebglMode])

  // Main data fetch effect
  useEffect(() => {
    if (webglFetchTimeoutRef.current != null) {
      window.clearTimeout(webglFetchTimeoutRef.current)
      webglFetchTimeoutRef.current = null
    }
    if (!archive || windowRange.limit <= 0) {
      setCurrentResults([])
      debugRef.current.setTaskLabel('idle')
      return
    }
    const requestId = (resultsRequestId.current += 1)
    const run = () => {
      const dataOffset = windowRange.offset + pageOffset
      debugRef.current.setTaskLabel(`fetching ${windowRange.limit.toLocaleString()}`)
      debugRef.current.logZoomTrace('fetch_start', {
        offset: dataOffset,
        limit: windowRange.limit,
        lite: webglWanted || useWebglMode || visibleRange.limit >= liteResultsThreshold,
      })
      const fetchStart = performance.now()
      const lite = webglWanted || useWebglMode || visibleRange.limit >= liteResultsThreshold
      ipcBridge.getResults(
        {
          filterId: activeFilter.tableId,
          offset: dataOffset,
          limit: windowRange.limit,
          lite,
        },
        (response) => {
          const newResults = response?.items ?? []
          const fetchDuration = performance.now() - fetchStart
          if (fetchDuration >= perfLogFetchThresholdMs) {
            perfLog.duration('get_results', fetchDuration, {
              filterId: activeFilter.tableId,
              offset: dataOffset,
              limit: windowRange.limit,
              lite,
              webgl: useWebglMode,
            })
          }
          debugRef.current.logZoomTrace('fetch_done', {
            offset: dataOffset,
            limit: windowRange.limit,
            lite,
            durationMs: roundNumber(fetchDuration, 2),
            count: newResults.length,
          })
          if (requestId !== resultsRequestId.current) return

          if (useWebglMode) {
            const items = newResults
            const stageIds = new Float32Array(items.length)
            const stageLayers = new Float32Array(items.length)
            for (let i = 0; i < items.length; i += 1) {
              const stageId = items[i]?.stage
              const safeStage = typeof stageId === 'number' ? stageId : 0
              stageIds[i] = safeStage
              stageLayers[i] = stageLayerById[safeStage] ?? 0
            }
            webglDataRangeRef.current = { offset: windowRange.offset, limit: items.length }
            const worker = webglWorkerRef.current
            if (worker) {
              worker.postMessage(
                { type: 'data', offset: windowRange.offset, limit: items.length, stageIds, stageLayers },
                [stageIds.buffer, stageLayers.buffer]
              )
            }
            scheduleWebglDrawRef.current()
            setCurrentResults([])
            debugRef.current.setTaskLabel(`rendering ${items.length.toLocaleString()}`)
            debugRef.current.logZoomTrace('render_webgl_data', { count: items.length })
            window.requestAnimationFrame(() => {
              if (requestId !== resultsRequestId.current) return
              debugRef.current.setTaskLabel('idle')
            })
            return
          }

          setCurrentResults(newResults)
          debugRef.current.setTaskLabel(`rendering ${newResults.length.toLocaleString()}`)
          debugRef.current.logZoomTrace('render_dom_data', {
            count: newResults.length,
          })
          window.requestAnimationFrame(() => {
            if (requestId !== resultsRequestId.current) return
            debugRef.current.setTaskLabel('idle')
          })
        }
      )
    }
    if (webglWanted) {
      webglFetchTimeoutRef.current = window.setTimeout(() => {
        webglFetchTimeoutRef.current = null
        debugRef.current.logZoomTrace('fetch_debounce_fire', {
          offset: windowRange.offset, limit: windowRange.limit,
        })
        run()
      }, webglFetchDebounceMs)
      debugRef.current.logZoomTrace('fetch_debounce_schedule', {
        offset: windowRange.offset, limit: windowRange.limit, delayMs: webglFetchDebounceMs,
      })
      return () => {
        if (webglFetchTimeoutRef.current != null) {
          window.clearTimeout(webglFetchTimeoutRef.current)
          webglFetchTimeoutRef.current = null
          debugRef.current.logZoomTrace('fetch_debounce_cancel', {
            offset: windowRange.offset, limit: windowRange.limit,
          })
        }
      }
    }
    run()
  }, [
    archive, activeFilter.id, activeFilter.tableId,
    windowRange.offset, windowRange.limit,
    visibleRange.limit, useWebglMode, webglWanted, renderMode, pageOffset,
  ])

  return { currentResults, webglFetchTimeoutRef, resultsRequestId }
}
