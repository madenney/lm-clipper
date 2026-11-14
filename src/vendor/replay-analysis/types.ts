// Structural input/output types for the detectors. They describe the fields the
// detectors read, in slippi-js's shape, without importing slippi-js: Clipper uses
// slippi-js 6.x and the database 9.x, and both pass their parsed frames here.

/** A post-frame update (slippi-js `PostFrameUpdateType`), fields as read here. */
export interface PostFrame {
  frame?: number | null
  actionStateId?: number | null
  actionStateCounter?: number | null
  percent?: number | null
  stocksRemaining?: number | null
  lastAttackLanded?: number | null
  lastHitBy?: number | null
  hitlagRemaining?: number | null
  positionX?: number | null
  positionY?: number | null
  isAirborne?: boolean | null
  facingDirection?: number | null
  /** On the landing frame of an aerial: 1 = L-cancelled, 2 = missed (0 otherwise). */
  lCancelStatus?: number | null
  /** 0 = vulnerable, 1 = invulnerable, 2 = intangible. */
  hurtboxCollisionState?: number | null
  shieldSize?: number | null
}

/** One frame (slippi-js `FrameEntryType`). */
export interface FrameEntry {
  frame: number
  players: Record<number, { post?: PostFrame | null } | null | undefined>
}

/** All frames keyed by frame number (slippi-js `FramesType`). */
export type Frames = Record<number, FrameEntry>

/** Game settings (slippi-js `GameStartType`), fields as read here. */
export interface GameSettings {
  players: { playerIndex: number }[]
}

/** A stock (slippi-js `StockType`). */
export interface Stock {
  playerIndex: number
  startFrame?: number | null
  endFrame?: number | null
  deathAnimation?: number | null
}

export interface PlayerIndexed {
  playerIndex: number
  opponentIndex: number
}

/** A move landed within a combo (slippi-js `MoveLandedType`). */
export interface MoveLanded {
  playerIndex: number
  frame: number
  moveId: number
  hitCount: number
  damage: number
}

/** A combo (slippi-js `ComboType`): `playerIndex` is the player being comboed. */
export interface Combo {
  playerIndex: number
  startFrame: number
  endFrame?: number | null
  startPercent: number
  currentPercent: number
  endPercent?: number | null
  moves: MoveLanded[]
  didKill: boolean
  lastHitBy: number | null
}
