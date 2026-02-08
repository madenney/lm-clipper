import { stages } from '../../constants/stages'
import { zoomConfig } from '../zoomConfig'

export const hexToUint32 = (hex: string) => {
  const cleaned = hex.replace('#', '')
  if (cleaned.length !== 6) return 0xff000000
  const value = parseInt(cleaned, 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return (0xff << 24) | (b << 16) | (g << 8) | r
}

export const hexToRgbaFloat = (hex: string) => {
  const cleaned = hex.replace('#', '')
  if (cleaned.length !== 6) return [0.2, 0.2, 0.2, 1]
  const value = parseInt(cleaned, 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return [r / 255, g / 255, b / 255, 1]
}

export const resolveStageColorHex = (
  stageId: number,
  palette: string[],
  cache: Map<number, string>,
) => {
  const cached = cache.get(stageId)
  if (cached) return cached
  const entry = stages[stageId as keyof typeof stages] as
    | { tag?: string }
    | undefined
  const stageTag = entry?.tag
  const solidColors: Record<string, string> = zoomConfig.stageSolidColors
  let color =
    stageTag && stageTag in solidColors ? solidColors[stageTag] : undefined
  if (!color) {
    color = palette.length
      ? palette[Math.abs(stageId) % palette.length]
      : '#333333'
  }
  cache.set(stageId, color)
  return color
}

export const resolveStageColorUint = (
  stageId: number,
  palette: string[],
  hexCache: Map<number, string>,
  uintCache: Map<number, number>,
) => {
  const cached = uintCache.get(stageId)
  if (cached != null) return cached
  const color = resolveStageColorHex(stageId, palette, hexCache)
  const converted = hexToUint32(color)
  uintCache.set(stageId, converted)
  return converted
}
