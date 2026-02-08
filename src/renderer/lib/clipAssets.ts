/**
 * Clip Asset Resolution
 *
 * Utilities for resolving stage images and character icons for clip display.
 */

import type { PlayerInterface } from '../../constants/types'
import { characters } from '../../constants/characters'
import { stages } from '../../constants/stages'
import { getVariantUrl } from '../stageVariantAssets'

// Arrow images
import NextArrow from '../../images/next.png'
import WhiteNextArrow from '../../images/whitenext.png'

type ImageModule = string | { default: string }

const resolveModule = (value: ImageModule): string | undefined =>
  typeof value === 'string' ? value : value?.default

export const arrowImages = {
  dark: NextArrow,
  light: WhiteNextArrow,
} as const

// Stages that need light arrow (dark backgrounds)
const darkStageIds = new Set([2, 3, 31, 32])

export const getArrowImage = (stageId: number): string => {
  return darkStageIds.has(stageId) ? arrowImages.light : arrowImages.dark
}

// Character icons via require.context
const charContext = (require as any).context(
  '../../images/character-icons',
  true,
  /\.(png|jpe?g)$/,
)
const charImages = new Map<string, string>()
charContext.keys().forEach((key: string) => {
  const match = key.match(/^\.\/([^/]+)\/([^/]+)\.(png|jpe?g)$/)
  if (!match) return
  const folder = match[1]
  const colorName = match[2]
  const url = resolveModule(charContext(key))
  if (url) charImages.set(`${folder}/${colorName}`, url)
})

// Stage base images via require.context
const stageContext = (require as any).context(
  '../../images/stages',
  false,
  /\.(png|jpe?g|jpg)$/,
)
const stageBaseImages = new Map<string, string>()
stageContext.keys().forEach((key: string) => {
  const match = key.match(/^\.\/(.+)\.(png|jpe?g|jpg)$/)
  if (!match) return
  const baseName = match[1]
  const url = resolveModule(stageContext(key))
  if (url) stageBaseImages.set(baseName, url)
})

// Build stage tag -> base image URL mapping
const stageImageByTag = new Map<string, string>()
Object.values(stages).forEach((stage) => {
  const stageInfo = stage as { tag?: string; img?: string }
  if (!stageInfo.tag || !stageInfo.img) return
  const fileName = stageInfo.img.split('/').pop() || ''
  const baseName = fileName.replace(/\.[^.]+$/, '')
  if (!baseName) return
  const url = stageBaseImages.get(baseName)
  if (url) stageImageByTag.set(stageInfo.tag, url)
})

/**
 * Resolve stage image URL, using variant if available for the tile size
 */
export const resolveStageImage = (
  stageId: number,
  tileSize?: number,
): string | null => {
  const stageInfo = stages[stageId as keyof typeof stages] as
    | { tag?: string }
    | undefined
  const tag = stageInfo?.tag || 'bf'

  if (tileSize) {
    const variantUrl = getVariantUrl(tag, tileSize)
    if (variantUrl) return variantUrl
  }

  return stageImageByTag.get(tag) || stageImageByTag.get('bf') || null
}

/**
 * Get stage tag from stage ID
 */
export const getStageTag = (stageId: number): string => {
  const stageInfo = stages[stageId as keyof typeof stages] as
    | { tag?: string }
    | undefined
  return stageInfo?.tag || 'unknown'
}

/**
 * Get stage name from stage ID
 */
export const getStageName = (stageId: number): string => {
  const stageInfo = stages[stageId as keyof typeof stages] as
    | { name?: string; shortName?: string }
    | undefined
  return stageInfo?.shortName || stageInfo?.name || 'Unknown'
}

/**
 * Resolve character icon URL for a player
 */
export const resolveCharacterImage = (
  player?: PlayerInterface,
): string | undefined => {
  if (!player) return undefined
  const character = characters[player.characterId]
  if (!character) return undefined
  const color = character.colors[player.characterColor]
  if (!color) return undefined
  const folder = character.img
    ?.replace(/^character-icons\//, '')
    .replace(/\/$/, '')
  if (!folder) return undefined
  return charImages.get(`${folder}/${color}`)
}

/**
 * Get character name from character ID
 */
export const getCharacterName = (characterId: number): string | null => {
  const character = characters[characterId]
  return character?.name || null
}

/**
 * Get character short name from character ID
 */
export const getCharacterShortName = (characterId: number): string | null => {
  const character = characters[characterId]
  return character?.shortName || character?.name || null
}

/**
 * Get player display label (displayName > nametag > character shortName)
 */
export const getPlayerLabel = (player?: PlayerInterface): string => {
  if (!player) return ''
  if (player.displayName) return player.displayName
  if (player.nametag) return player.nametag
  return getCharacterShortName(player.characterId) || ''
}
