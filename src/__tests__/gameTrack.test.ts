import path from 'path'
import { SlippiGame } from '@slippi/slippi-js'
import { readClipTrack } from '../main/clipTrack'

const SLP = path.join(__dirname, '..', '..', 'assets', 'test.slp')

describe('readClipTrack over a whole game', () => {
  it('samples sparsely, with percent and stocks for the game flow', () => {
    const last = new SlippiGame(SLP).getLatestFrame()!.frame
    const track = readClipTrack(SLP, -123, last, [0, 1])
    for (const p of track.players) {
      expect(p.points.length).toBeGreaterThan(100)
      expect(p.points.length).toBeLessThanOrEqual(2401)
      // Stocks never go up; percent is a number.
      for (let i = 1; i < p.points.length; i += 1)
        expect(p.points[i].s).toBeLessThanOrEqual(p.points[i - 1].s)
      expect(p.points.every((pt) => Number.isFinite(pt.p))).toBe(true)
    }
  })
})
