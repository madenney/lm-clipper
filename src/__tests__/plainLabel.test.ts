import { plainLabel } from '../renderer/components/FilterControls'

describe('plainLabel (compact filter settings)', () => {
  it('says who and what in plain words', () => {
    expect(plainLabel('Comboer CC')).toBe('Player code')
    expect(plainLabel('Comboee Char')).toBe('Opponent character')
    expect(plainLabel('Victim Tag')).toBe('Opponent tag')
    expect(plainLabel('Max Files')).toBe('Max replays')
    expect(plainLabel('Min Hits')).toBe('Min hits')
    expect(plainLabel('Did Kill')).toBe('Did kill')
    expect(plainLabel('Lead-in Frames')).toBe('Lead-in frames')
  })
})
