// Stage boundary rectangles for edgeguard detection
// Keyed by Slippi stage ID. Coordinates define right-side regions;
// the left side is mirrored by negating X values.
//   bz   – blast zone (outside = death)
//   edge – ledge/edge region used to detect offstage situations

const rectangles: Record<
  number,
  {
    name: string
    bz: { xMin: number; xMax: number; yMin: number; yMax: number }
    edge: { xMin: number; xMax: number; yMin: number; yMax: number }
  }
> = {
  2: {
    name: 'Fountain of Dreams',
    bz: { xMin: 0, xMax: 210, yMin: -150, yMax: 195 },
    edge: { xMin: 55, xMax: 70, yMin: -5, yMax: 195 },
  },
  3: {
    name: 'Pokemon Stadium',
    bz: { xMin: 0, xMax: 235, yMin: -115, yMax: 175 },
    edge: { xMin: 80, xMax: 95, yMin: -7, yMax: 175 },
  },
  8: {
    name: "Yoshi's Story",
    bz: { xMin: 0, xMax: 180, yMin: -100, yMax: 160 },
    edge: { xMin: 47, xMax: 65, yMin: -15, yMax: 160 },
  },
  28: {
    name: 'Dream Land',
    bz: { xMin: 0, xMax: 260, yMin: -130, yMax: 255 },
    edge: { xMin: 70, xMax: 85, yMin: -7, yMax: 255 },
  },
  31: {
    name: 'Battlefield',
    bz: { xMin: 0, xMax: 230, yMin: -115, yMax: 190 },
    edge: { xMin: 50, xMax: 80, yMin: -10, yMax: 200 },
  },
  32: {
    name: 'Final Destination',
    bz: { xMin: 0, xMax: 250, yMin: -140, yMax: 180 },
    edge: { xMin: 75, xMax: 95, yMin: -10, yMax: 180 },
  },
}

export default rectangles
