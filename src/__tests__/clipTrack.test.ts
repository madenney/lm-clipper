import path from 'path'
import { readClipTrack } from '../main/clipTrack'
import { comboHits } from '../renderer/components/Clip/comboView'

const SLP = path.join(__dirname, '..', '..', 'assets', 'test.slp')

describe('readClipTrack (combo map positions)', () => {
  it('samples both players across the clip plus half a second either side', () => {
    const track = readClipTrack(SLP, 600, 700, [0, 1])
    expect(track.players.map((p) => p.playerIndex)).toEqual([0, 1])
    for (const p of track.players) {
      expect(p.points.length).toBeGreaterThan(50)
      expect(p.points[0].f).toBe(570)
      expect(p.points[p.points.length - 1].f).toBeLessThanOrEqual(730)
      for (const pt of p.points) {
        expect(Number.isFinite(pt.x)).toBe(true)
        expect(Number.isFinite(pt.y)).toBe(true)
      }
    }
  })

  it('refuses anything that is not a replay on this computer', () => {
    expect(() => readClipTrack('/etc/passwd', 0, 10, [0])).toThrow(
      /not on this computer/,
    )
    expect(() => readClipTrack('/nope/game.slp', 0, 10, [0])).toThrow(
      /not on this computer/,
    )
  })
})

describe('comboHits', () => {
  it('orders hits and tracks the percent after each', () => {
    const hits = comboHits({
      startPercent: 10,
      moves: [
        { frame: 120, moveId: 13, damage: 12 },
        { frame: 100, moveId: 2, damage: 3 },
      ],
    })
    expect(hits.map((h) => [h.n, h.frame, h.percent])).toEqual([
      [1, 100, 13],
      [2, 120, 25],
    ])
    expect(comboHits(undefined)).toEqual([])
  })
})
