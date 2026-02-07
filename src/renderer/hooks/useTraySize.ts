import { useState, useEffect, useRef, type MutableRefObject } from 'react'

export type TraySizeResult = {
  trayWidth: number
  trayHeight: number
  resultsTop: number
  traySizeRef: React.MutableRefObject<{ width: number; height: number }>
  resultsTopRef: React.MutableRefObject<number>
  refreshResultsTop: () => void
}

export const useTraySize = (
  trayRef: MutableRefObject<HTMLDivElement | null>,
  resultsRef: MutableRefObject<HTMLDivElement | null>,
  totalResults: number
): TraySizeResult => {
  const [trayWidth, setTrayWidth] = useState(0)
  const [trayHeight, setTrayHeight] = useState(0)
  const [resultsTop, setResultsTop] = useState(0)
  const traySizeRef = useRef({ width: 0, height: 0 })
  traySizeRef.current = { width: trayWidth, height: trayHeight }
  const resultsTopRef = useRef(0)
  resultsTopRef.current = resultsTop

  const refreshResultsTop = () => {
    setResultsTop(resultsRef.current?.offsetTop ?? 0)
  }

  useEffect(() => {
    const node = trayRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const updateSize = () => {
      setTrayWidth(node.clientWidth)
      setTrayHeight(node.clientHeight)
      setResultsTop(resultsRef.current?.offsetTop ?? 0)
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setResultsTop(resultsRef.current?.offsetTop ?? 0)
  }, [totalResults])

  return { trayWidth, trayHeight, resultsTop, traySizeRef, resultsTopRef, refreshResultsTop }
}
