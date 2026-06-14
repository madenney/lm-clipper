import { ReplayInterface, OverlaySourceRule } from '../constants/types'

/**
 * Shared, pure token resolution for filename patterns AND video overlays.
 * No node (fs/path) imports so it is safe to use in the renderer too (the
 * Settings live-preview calls these directly). All path handling is plain
 * string ops on forward-slash-normalised paths.
 */

const pad = (n: number, len: number): string => String(n).padStart(len, '0')

const normalise = (p: string): string => (p || '').replace(/\\/g, '/')

/**
 * Derive the {source} value from a clip's file path using ordered rules.
 * Rules are evaluated top-to-bottom; the first whose `marker` matches wins.
 * An empty marker always matches (use as a catch-all fallback).
 */
export function resolveSource(
  filePath: string,
  rules: OverlaySourceRule[] | undefined,
): string {
  const norm = normalise(filePath)
  const segments = norm.split('/').filter(Boolean)

  for (const rule of rules || []) {
    const marker = (rule.marker || '').trim()
    const matched = marker === '' ? true : norm.includes(marker)
    if (!matched) continue

    let value = ''
    if (rule.extract === 'fixed') {
      value = rule.value || ''
    } else if (rule.extract === 'nextSegment') {
      const idx = segments.indexOf(marker)
      value = idx >= 0 && idx + 1 < segments.length ? segments[idx + 1] : ''
    } else if (rule.extract === 'regex') {
      try {
        const m = norm.match(new RegExp(rule.value))
        value = m ? (m[1] ?? m[0]) : ''
      } catch {
        value = ''
      }
    }
    return `${rule.prefix || ''}${value}${rule.suffix || ''}`
  }
  return ''
}

/**
 * Build the full token→value map for a replay. Values are RAW (not sanitised
 * for the filesystem); callers that need filename-safe values sanitise after.
 */
export function buildReplayVars(
  replay: ReplayInterface,
  sourceRules?: OverlaySourceRule[],
): Record<string, string> {
  const m = replay.meta || {}
  const filePath = normalise(replay.path)
  const segs = filePath.split('/').filter(Boolean)
  const base = segs.length > 0 ? segs[segs.length - 1] : ''
  const filename = base.replace(/\.[^.]+$/, '')
  const folder = segs.length >= 2 ? segs[segs.length - 2] : ''
  const parentfolder = segs.length >= 3 ? segs[segs.length - 3] : ''

  return {
    character1: m.character1 || 'Unknown',
    character2: m.character2 || 'Unknown',
    player1: m.player1 || 'P1',
    player2: m.player2 || 'P2',
    stage: m.stage || 'Unknown',
    date: m.date || '',
    time: m.time || '',
    index: pad(replay.index, 4),
    kills: m.didKill ? 'kill' : 'nokill',
    damage: m.damage !== undefined ? String(m.damage) : '0',
    moves: m.moves !== undefined ? String(m.moves) : '0',
    filename,
    folder,
    parentfolder,
    source: resolveSource(filePath, sourceRules),
  }
}

/** Replace {token} occurrences in a pattern using a vars map. */
export function applyPattern(
  pattern: string,
  vars: Record<string, string>,
): string {
  return pattern.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match)
}

/** Token metadata for building the overlay pattern UI (click-to-insert). */
export const OVERLAY_TOKENS: { key: string; label: string }[] = [
  { key: 'source', label: 'Source' },
  { key: 'date', label: 'Date' },
  { key: 'time', label: 'Time' },
  { key: 'player1', label: 'Player 1' },
  { key: 'player2', label: 'Player 2' },
  { key: 'character1', label: 'Character 1' },
  { key: 'character2', label: 'Character 2' },
  { key: 'stage', label: 'Stage' },
  { key: 'damage', label: 'Damage' },
  { key: 'moves', label: 'Moves' },
  { key: 'kills', label: 'Kill' },
  { key: 'filename', label: 'Filename' },
  { key: 'folder', label: 'Folder' },
  { key: 'parentfolder', label: 'Parent Folder' },
  { key: 'index', label: 'Index' },
]
