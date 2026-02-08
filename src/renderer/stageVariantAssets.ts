import { stages } from '../constants/stages'
import { resolveVariantBucket, stageVariantSizes } from './stageVariant'

type StageInfo = { tag?: string; img?: string }

export type StageVariantLayer = {
  baseName: string
  url: string
}

type StageVariantModule = string | { default: string }

const resolveImageModule = (value: StageVariantModule) =>
  typeof value === 'string' ? value : value?.default

const stageTagsByBaseName = new Map<string, string[]>()
Object.values(stages).forEach((stage) => {
  const stageInfo = stage as StageInfo
  if (!stageInfo.tag || !stageInfo.img) return
  const fileName = stageInfo.img.split('/').pop() || ''
  const baseName = fileName.replace(/\.[^.]+$/, '')
  if (!baseName) return
  const tags = stageTagsByBaseName.get(baseName) || []
  if (!tags.includes(stageInfo.tag)) {
    tags.push(stageInfo.tag)
    stageTagsByBaseName.set(baseName, tags)
  }
})

const baseNames = Array.from(stageTagsByBaseName.keys()).sort()
const fallbackBaseName =
  baseNames.find((name) => name === 'nonlegal') || baseNames[0] || ''
export const stageVariantBaseNames = baseNames

const urlBySizeAndBase = new Map<number, Map<string, string>>()
const context = (require as any).context(
  '../images/stages/variants',
  false,
  /\.(png|jpe?g)$/,
)
context.keys().forEach((key: string) => {
  const match = key.match(/^\.\/(.+)_([0-9]+)\.(png|jpe?g)$/)
  if (!match) return
  const baseName = match[1]
  const size = Number(match[2])
  if (!size || !stageVariantSizes.includes(size)) return
  const url = resolveImageModule(context(key))
  if (!url) return
  const byBase = urlBySizeAndBase.get(size) || new Map<string, string>()
  byBase.set(baseName, url)
  urlBySizeAndBase.set(size, byBase)
})

export const stageVariantLayersBySize = new Map<number, StageVariantLayer[]>()
stageVariantSizes.forEach((size) => {
  const byBase = urlBySizeAndBase.get(size) || new Map<string, string>()
  const fallbackUrl = fallbackBaseName ? byBase.get(fallbackBaseName) || '' : ''
  const layers = baseNames.map((baseName) => ({
    baseName,
    url: byBase.get(baseName) || fallbackUrl,
  }))
  stageVariantLayersBySize.set(size, layers)
})

const layerIndexByBaseName = new Map<string, number>()
baseNames.forEach((baseName, index) => {
  layerIndexByBaseName.set(baseName, index)
})

export const stageLayerById: number[] = []
Object.entries(stages).forEach(([rawId, stage]) => {
  const stageInfo = stage as StageInfo
  const stageId = Number(rawId)
  if (!Number.isFinite(stageId)) return
  const fileName = stageInfo.img ? stageInfo.img.split('/').pop() || '' : ''
  const baseName = fileName.replace(/\.[^.]+$/, '')
  const layerIndex = layerIndexByBaseName.get(baseName) ?? 0
  stageLayerById[stageId] = layerIndex
})

const sizesByTag = new Map<string, number[]>()
stageVariantSizes.forEach((size) => {
  const byBase = urlBySizeAndBase.get(size) || new Map<string, string>()
  stageTagsByBaseName.forEach((tags, baseName) => {
    if (!byBase.has(baseName)) return
    tags.forEach((tag) => {
      const sizes = sizesByTag.get(tag) || []
      if (!sizes.includes(size)) {
        sizes.push(size)
        sizesByTag.set(tag, sizes)
      }
    })
  })
})

export const getVariantUrl = (
  stageTag: string,
  tileSize: number,
): string | null => {
  const sizes = sizesByTag.get(stageTag)
  if (!sizes || sizes.length === 0) return null
  const bucket = resolveVariantBucket(tileSize, sizes)
  if (!bucket) return null
  const byBase = urlBySizeAndBase.get(bucket)
  if (!byBase) return null
  const tags = Array.from(stageTagsByBaseName.entries())
  for (const [baseName, baseTags] of tags) {
    if (baseTags.includes(stageTag)) {
      const url = byBase.get(baseName)
      if (url) return url
    }
  }
  return null
}
