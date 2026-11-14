// Replay analysis shared by Clipper and the database. Canonical source lives in
// packages/replay-analysis; each app has a synced copy (npm run sync-packages).
export * from './types'
export { detectCombos, DEFAULT_COMBO_TIMEOUT } from './combos'
export {
  detectEdgeguard,
  findEdgeguards,
  currentStockStart,
  DEFAULT_EDGEGUARD_OPTS,
} from './edgeguard'
export type {
  DetectOpts,
  Detection,
  EdgeguardEvent,
  EdgeguardMetrics,
  Rect,
} from './edgeguard'
export { detectPhantoms, frameBounds } from './phantom'
export type { PhantomEvent, PhantomMetrics } from './phantom'
export {
  findEarlyQuitOut,
  DEFAULT_EARLY_QUIT_OUT_OPTS,
  QUIT_WINDOW_FRAMES,
} from './earlyQuitOut'
export type { EarlyQuitOut, EarlyQuitOutOpts } from './earlyQuitOut'
export { positionStats } from './position'
export type { PositionCounts, PositionStats } from './position'
export { techLedgeEvents } from './techLedge'
export type {
  TechLedgeEvent,
  TechOption,
  GetupOption,
  LedgeOption,
} from './techLedge'
export { getDeathDirection } from './deaths'
export type { DeathDirection } from './deaths'
export * from './stageGeometry'
export { default as stageGeometry } from './stageGeometry'
export { getRecoveryRange, DEFAULT_RECOVERY_RANGE } from './recoveryData'
export { default as recoveryRanges } from './recoveryData'
export { AS, aerialOf, AERIALS } from './actionStates'
export type { Aerial } from './actionStates'
export { followUp, FOLLOW_UP_RESET_FRAMES } from './frameUtils'
export type { FollowUp } from './frameUtils'
export { findGrabs } from './grabs'
export type { GrabEvent, ThrowDirection } from './grabs'
export { findCrouchCancels } from './crouchCancel'
export type { CrouchCancelEvent } from './crouchCancel'
export { findLCancels } from './lCancel'
export type { LCancelEvent, LCancelSummary } from './lCancel'
export { findShieldOptions } from './shieldOptions'
export type { ShieldEvent, ShieldOption } from './shieldOptions'
export { findLedgeOptions } from './ledgeTiming'
export type { LedgeTimingEvent } from './ledgeTiming'
