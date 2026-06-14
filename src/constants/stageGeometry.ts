// Per-stage geometry in Melee world coordinates, used to draw the schematic in
// the Stage Zone picker (and reusable for edgeguard-rectangle tuning).
//
// Coordinate system (matches slippi-js post.positionX / positionY):
//   x = 0 is the stage's center vertical line; +x is right, -x is left.
//   y = 0 is roughly the main stage surface; +y is up, -y is down (below stage).
//
// Values are approximate community stage data — accurate enough to aim a
// filter box and tunable later via the same visualizer. A few stages have
// caveats (noted): Fountain of Dreams' side platforms move vertically, and
// Pokémon Stadium transforms — both are drawn at a representative neutral pose.

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
  // Main stage surface (ledge-to-ledge). Ledges sit at xMin / xMax.
  ground: { xMin: number; xMax: number; y: number }
  // Side + top platforms (empty for FD).
  platforms: StagePlatform[]
  // Blast zones — beyond these is a KO. Mirrors src/constants/rectangles.ts.
  blastzone: { left: number; right: number; top: number; bottom: number }
  note?: string
}

const stageGeometry: Record<number, StageGeometryEntry> = {
  // Fountain of Dreams
  2: {
    id: 2,
    name: 'Fountain of Dreams',
    ground: { xMin: -63.35, xMax: 63.35, y: 0 },
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
    ground: { xMin: -77.27, xMax: 77.27, y: 0 },
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
    ground: { xMin: -85.6, xMax: 85.6, y: 0 },
    platforms: [],
    blastzone: { left: -246, right: 246, top: 188, bottom: -140 },
  },
}

// Stages shown in the zone picker, in a sensible left-to-right order.
export const ZONE_STAGE_IDS = [31, 32, 28, 8, 2, 3]

export default stageGeometry
