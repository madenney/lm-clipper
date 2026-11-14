/**
 * @jest-environment node
 *
 * The replay panel's tug-of-war bars: the left player's share of a stat.
 */
import { shareOf } from '../renderer/components/Clip/ReplayInfoPanel'

jest.mock('../renderer/ipcBridge', () => ({ default: {} }))
jest.mock('../renderer/lib/clipAssets', () => ({
  resolveCharacterImage: () => undefined,
}))

describe('shareOf', () => {
  it('splits by each side’s part of the total', () => {
    expect(shareOf(3, 1)).toBeCloseTo(0.75)
    expect(shareOf(14, 13)).toBeCloseTo(14 / 27)
  })
  it('gives the bigger share to the better side when lower is better', () => {
    // 5.5 openings per kill beats 9.0
    expect(shareOf(5.5, 9, true)).toBeGreaterThan(0.5)
    expect(shareOf(9, 5.5, true)).toBeLessThan(0.5)
  })
  it('is even when both are zero, and unknown when a side is missing', () => {
    expect(shareOf(0, 0)).toBe(0.5)
    expect(shareOf(0, 0, true)).toBe(0.5)
    expect(shareOf(null, 3)).toBeNull()
  })
  it('a zero against something is no share', () => {
    expect(shareOf(0, 5)).toBe(0)
    expect(shareOf(5, 0)).toBe(1)
  })
})
