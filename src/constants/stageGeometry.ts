// Per-stage geometry in Melee world coordinates. Two consumers: the schematic
// drawn by the Stage Zone picker, and the edgeguard parser's stage boundaries
// (see edgeguardRects below) — this file is the single source of truth for both.
//
// Coordinate system (matches slippi-js post.positionX / positionY):
//   x = 0 is the stage's center vertical line; +x is right, -x is left.
//   y = 0 is roughly the main stage surface; +y is up, -y is down (below stage).
//
// SOURCE OF THE NUMBERS
//
// ground.xMax, ledgeGrab and blastzone are taken from libmelee's stage
// constants (github.com/altf4/libmelee, melee/stages.py), which are read out of
// the game's own stage data:
//
//   ground.xMax  = libmelee EDGE_GROUND_POSITION — where the solid stage ends
//                  (the last x you can stand on)
//   ledgeGrab    = libmelee EDGE_POSITION        — where a character's origin
//                  sits while HANGING on the ledge
//   blastzone    = libmelee BLASTZONES           — matches exactly, including
//                  Yoshi's Story's asymmetry (-175.7 left, 173.6 right)
//
// ledgeGrab is ground.xMax + 2.91 on every stage (the ledge-grab overhang).
//
// Independently corroborated against 427 of this project's own replays: the
// median |positionX| of players in a ledge-hang action state (0xfc-0x107) lands
// 0.73 +/- 0.03 inside ledgeGrab on all six stages. Both the values and their
// mutual consistency check out.
//
// Platform coordinates below are NOT from libmelee and remain approximate —
// they only feed the schematic drawing, never the parser. Caveats: Fountain of
// Dreams' side platforms move vertically, and Pokémon Stadium transforms — both
// are drawn at a representative neutral pose.

export type StagePlatform = {
  // A raised platform (side or top). Horizontal span + surface height.
  xMin: number
  xMax: number
  y: number
  label?: string
}

export type StageGeometryEntry = {
  id: number
  name: string
  // Main stage surface. xMax = the last x you can stand on (EDGE_GROUND_POSITION).
  ground: { xMin: number; xMax: number; y: number }
  // Where a character's origin sits while hanging on the ledge (EDGE_POSITION).
  // Always ground.xMax + 2.91. This — not ground.xMax — is "reaching the ledge".
  ledgeGrab: number
  // Side + top platforms (empty for FD). Approximate; schematic only.
  platforms: StagePlatform[]
  // Blast zones — beyond these is a KO.
  blastzone: { left: number; right: number; top: number; bottom: number }
  note?: string
}

const stageGeometry: Record<number, StageGeometryEntry> = {
  // Fountain of Dreams
  2: {
    id: 2,
    name: 'Fountain of Dreams',
    ground: { xMin: -63.3475, xMax: 63.3475, y: 0 },
    ledgeGrab: 66.2554,
    platforms: [
      { xMin: -49.5, xMax: -21.5, y: 27, label: 'left (moves)' },
      { xMin: 21.5, xMax: 49.5, y: 27, label: 'right (moves)' },
    ],
    blastzone: { left: -198.75, right: 198.75, top: 202.5, bottom: -146.25 },
    note: 'Side platforms move vertically (~y 16–35); drawn at a mid height.',
  },
  // Pokémon Stadium
  3: {
    id: 3,
    name: 'Pokémon Stadium',
    ground: { xMin: -87.75, xMax: 87.75, y: 0 },
    ledgeGrab: 90.6579,
    platforms: [
      { xMin: -55, xMax: -25, y: 25, label: 'left' },
      { xMin: 25, xMax: 55, y: 25, label: 'right' },
    ],
    blastzone: { left: -230, right: 230, top: 180, bottom: -111 },
    note: 'Transforms during play; drawn in the neutral two-platform form.',
  },
  // Yoshi's Story
  8: {
    id: 8,
    name: "Yoshi's Story",
    ground: { xMin: -56, xMax: 56, y: 0 },
    ledgeGrab: 58.9078,
    platforms: [
      { xMin: -59.5, xMax: -28, y: 23.45, label: 'left' },
      { xMin: 28, xMax: 59.5, y: 23.45, label: 'right' },
      { xMin: -15.75, xMax: 15.75, y: 42, label: 'top' },
    ],
    blastzone: { left: -175.7, right: 173.6, top: 168, bottom: -91 },
  },
  // Dream Land
  28: {
    id: 28,
    name: 'Dream Land',
    ground: { xMin: -77.2713, xMax: 77.2713, y: 0 },
    ledgeGrab: 80.1792,
    platforms: [
      { xMin: -61.39, xMax: -31.73, y: 30.24, label: 'left' },
      { xMin: 31.73, xMax: 61.39, y: 30.24, label: 'right' },
      { xMin: -19.02, xMax: 19.02, y: 51.43, label: 'top' },
    ],
    blastzone: { left: -255, right: 255, top: 250, bottom: -123 },
  },
  // Battlefield
  31: {
    id: 31,
    name: 'Battlefield',
    ground: { xMin: -68.4, xMax: 68.4, y: 0 },
    ledgeGrab: 71.3079,
    platforms: [
      { xMin: -57.6, xMax: -20, y: 27.2, label: 'left' },
      { xMin: 20, xMax: 57.6, y: 27.2, label: 'right' },
      { xMin: -18.8, xMax: 18.8, y: 54.4, label: 'top' },
    ],
    blastzone: { left: -224, right: 224, top: 200, bottom: -108.8 },
  },
  // Final Destination
  32: {
    id: 32,
    name: 'Final Destination',
    ground: { xMin: -85.5657, xMax: 85.5657, y: 0 },
    ledgeGrab: 88.4735,
    platforms: [],
    blastzone: { left: -246, right: 246, top: 188, bottom: -140 },
  },
}

// Stages shown in the zone picker, in a sensible left-to-right order.
export const ZONE_STAGE_IDS = [31, 32, 28, 8, 2, 3]

// ---- Edgeguard stage boundaries ------------------------------------------
//
// The edgeguard parser needs four numbers per stage. Three come straight out of
// the table above, from the game's own data:
//
//   ruler     = ledgeGrab      used ONLY to measure — how close the victim got
//                              to the ledge, how far past it the edgeguarder
//                              chased. It never triggers anything; actual ledge
//                              grabs are read from action states. It is
//                              ledgeGrab, NOT ground.xMax: a player hanging on
//                              the ledge sits 2.91 past where the stage ends,
//                              so measuring from ground.xMax would score a
//                              perfect ledge grab as "2.9 short".
//   lip       = ground.y       the stage surface.
//   topBlast  = blastzone.top  distinguishes an off-the-top KO from a side or
//                              bottom one.
//
// The fourth is NOT a fact about the stage, and this is the important part:
//
//   OFFSTAGE BUFFER — how far *inward* from where the stage ends (ground.xMax)
//   the edgeguard situation is considered to begin. Geometry says where the
//   stage ends; it cannot say when a player is in trouble. A player one unit
//   inside Battlefield's edge is geometrically safe but may well be getting
//   edgeguarded; a player one unit past it may just be ledgedashing back on.
//   So this is a judgment about the sport, and it is the one value worth tuning.
//
// It applies ONLY to the victim, and only to: the side read, stageTouches, and
// recovery-attempt detection. Bigger = mildly more permissive.
//
// It deliberately does NOT affect (a) the launch window that anchors the clip
// start, or (b) any test of where the EDGEGUARDER is — both use the true stage
// edge, because "did this player physically leave the stage" is a fact, not a
// judgment. Wiring the buffered line into either one silently destroys clips.

// Inward from where the stage ends, in world units. One value for every stage.
//
// Defaults to 0 — "offstage" literally means past the solid stage. That is the
// only value with a defensible definition: at any buffer > 0 a player standing
// on solid ground counts as offstage. Measured over 408 replays, raising it to
// 18 buys ~2% more clips (786 -> 802), so the recall cost of 0 is small and the
// semantics are clean. Left tunable because "when is a player in trouble" is a
// judgment about the sport, and someone may want a wider net.
export const DEFAULT_OFFSTAGE_BUFFER = 0

// How far below the stage surface the victim must fall to read as offstage.
// Absorbs float noise around y = 0 without meaningfully delaying detection.
export const LIP_BUFFER = 10

export type EdgeguardRect = {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

// Stage boundaries for the edgeguard parser, derived from the geometry above.
// Right-side only (positive x); the parser mirrors via Math.abs(x).
//
// edge.xMin (buffered) applies ONLY to the VICTIM — "is this player in trouble",
// a judgment call. stageEnd (unbuffered) applies to the EDGEGUARDER, where the
// only question is the factual "were they physically off the stage". Using the
// buffered line for the edgeguarder reads an on-stage player in hitstun as
// "offstage in their own trouble" and truncates real edgeguards.
export function edgeguardRects(
  stageId: number,
  offstageBuffer: number = DEFAULT_OFFSTAGE_BUFFER,
): { edge: EdgeguardRect; bz: EdgeguardRect; stageEnd: number } | null {
  const g = stageGeometry[stageId]
  if (!g) return null
  return {
    edge: {
      xMin: g.ground.xMax - offstageBuffer, // victim's offstage line
      xMax: g.ledgeGrab, // where you actually grab the ledge (a ruler)
      yMin: g.ground.y - LIP_BUFFER, // below the stage lip = offstage
      yMax: g.blastzone.top,
    },
    bz: {
      xMin: 0,
      xMax: g.blastzone.right,
      yMin: g.blastzone.bottom,
      yMax: g.blastzone.top, // the only bz value the parser reads
    },
    stageEnd: g.ground.xMax, // edgeguarder's on/off-stage test
  }
}

export default stageGeometry
