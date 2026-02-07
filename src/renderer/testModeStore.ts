import { useSyncExternalStore } from 'react'

export type TestModeInfo = {
  tileSize: number
  imageSize: number
  variantLabel: string
  processLabel: string
  taskLabel: string
  debugLines: string[]
}

const defaultInfo: TestModeInfo = {
  tileSize: 0,
  imageSize: 0,
  variantLabel: '',
  processLabel: '',
  taskLabel: '',
  debugLines: [],
}

let currentInfo = defaultInfo
const listeners = new Set<() => void>()

const areStringArraysEqual = (left: string[], right: string[]) => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

export const setTestModeInfo = (next: Partial<TestModeInfo>) => {
  const merged: TestModeInfo = { ...currentInfo, ...next }
  if (
    merged.tileSize === currentInfo.tileSize &&
    merged.imageSize === currentInfo.imageSize &&
    merged.variantLabel === currentInfo.variantLabel &&
    merged.processLabel === currentInfo.processLabel &&
    merged.taskLabel === currentInfo.taskLabel &&
    areStringArraysEqual(merged.debugLines, currentInfo.debugLines)
  ) {
    return
  }
  currentInfo = merged
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = () => currentInfo

export const useTestModeInfo = () =>
  useSyncExternalStore(subscribe, getSnapshot)
