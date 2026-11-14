import { filterStepKey } from '../renderer/lib/filterNav'

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
})

describe('filterStepKey', () => {
  it('Z and the up arrow go up, X and the down arrow go down', () => {
    expect(filterStepKey(key('z'))).toBe(-1)
    expect(filterStepKey(key('ArrowUp'))).toBe(-1)
    expect(filterStepKey(key('x'))).toBe(1)
    expect(filterStepKey(key('ArrowDown'))).toBe(1)
  })
  it('ignores caps lock', () => {
    expect(filterStepKey(key('Z'))).toBe(-1)
    expect(filterStepKey(key('X'))).toBe(1)
  })
  it('leaves other keys and shortcuts (Ctrl+Z, Cmd+X) alone', () => {
    expect(filterStepKey(key('a'))).toBe(0)
    expect(filterStepKey(key('ArrowLeft'))).toBe(0)
    expect(filterStepKey(key('z', { ctrlKey: true }))).toBe(0)
    expect(filterStepKey(key('x', { metaKey: true }))).toBe(0)
  })
})
