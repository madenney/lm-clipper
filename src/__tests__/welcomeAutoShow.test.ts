// The welcome window opens by itself only for a new project (nothing beyond the Replays pool).
import { shouldAutoShowWelcome } from '../renderer/lib/welcome'

const pool = { type: 'files' }

describe('shouldAutoShowWelcome', () => {
  it('opens for a new project: just the Replays pool, or nothing yet', () => {
    expect(shouldAutoShowWelcome([pool], false)).toBe(true)
    expect(shouldAutoShowWelcome([], undefined)).toBe(true)
    expect(shouldAutoShowWelcome(undefined, null)).toBe(true)
  })

  it('stays closed for a project that already has steps of its own', () => {
    expect(shouldAutoShowWelcome([pool, { type: 'slpParser' }], false)).toBe(
      false,
    )
    expect(
      shouldAutoShowWelcome(
        [pool, { type: 'comboFilter' }, { type: 'sort' }],
        undefined,
      ),
    ).toBe(false)
    expect(shouldAutoShowWelcome([{ type: 'custom' }], false)).toBe(false)
  })

  it("never opens after Don't show this again, even for a new project", () => {
    expect(shouldAutoShowWelcome([pool], true)).toBe(false)
    expect(shouldAutoShowWelcome([], true)).toBe(false)
  })
})
