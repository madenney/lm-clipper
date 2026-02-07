export const stageVariantSizes = [
  1,
  4,
  9,
  16,
  25,
  36,
  49,
  64,
  81,
  100,
  121,
  144,
]
export const stageVariantSolidMax = 4

export const resolveVariantBucket = (
  tileSize: number,
  sizes: number[] = stageVariantSizes
) => {
  if (!Number.isFinite(tileSize) || sizes.length === 0) return null
  const target = Math.floor(tileSize)
  const minSize = sizes[0]
  let selected = minSize
  if (target < minSize) return minSize
  for (const size of sizes) {
    if (size <= target) {
      selected = size
    } else {
      break
    }
  }
  return selected
}
