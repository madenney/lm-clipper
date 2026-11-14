/**
 * Shared bits for the full-zoom card's combo map and damage timeline.
 */
import { moves } from '../../../constants/moves'

/** Slippi's port colours (P1 red, P2 blue, P3 yellow, P4 green). */
export const PORT_COLORS = ['#f15959', '#6d8bff', '#febe3f', '#4ce44c']
export const portColor = (port?: number) =>
  PORT_COLORS[((port ?? 1) - 1 + 4) % 4] ?? PORT_COLORS[0]

export const moveName = (moveId: number): string =>
  moves.find((m: { id: number; name: string }) => m.id === moveId)?.name ??
  `Move ${moveId}`

export type ComboHit = {
  n: number
  frame: number
  name: string
  damage: number
  /** Percent after this hit. */
  percent: number
}

/** The combo's hits in order, with the victim's percent after each. */
export function comboHits(
  combo:
    | {
        startPercent?: number
        moves?: { frame: number; moveId: number; damage: number }[]
      }
    | undefined,
): ComboHit[] {
  if (!combo?.moves?.length) return []
  let percent = typeof combo.startPercent === 'number' ? combo.startPercent : 0
  return [...combo.moves]
    .sort((a, b) => a.frame - b.frame)
    .map((m, i) => {
      percent += m.damage || 0
      return {
        n: i + 1,
        frame: m.frame,
        name: moveName(m.moveId),
        damage: m.damage || 0,
        percent,
      }
    })
}

export const fmtSeconds = (frames: number) => `${(frames / 60).toFixed(1)}s`
