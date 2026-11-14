import {
  aiFilterInput,
  buildAiFilterPrompt,
  extractCode,
} from '../constants/aiFilterPrompt'

describe('AI Filter prompt', () => {
  it('says what the input rows are from the step before', () => {
    expect(aiFilterInput(undefined)).toBe('games')
    expect(aiFilterInput('files')).toBe('games')
    expect(aiFilterInput('comboFilter')).toBe('combos')
    expect(aiFilterInput('edgeguardFilter')).toBe('edgeguards')
    expect(aiFilterInput('sort')).toBe('clips')
  })

  it('explains the task and the input, then waits for the request', () => {
    const p = buildAiFilterPrompt('games')
    expect(p).toContain('WHOLE GAME')
    expect(p).toContain('```js')
    // Ends on a blank line under "The clips I want", ready for typing.
    expect(p).toMatch(/## The clips I want[\s\S]*\n\n$/)
    expect(buildAiFilterPrompt('combos')).toContain('COMBO')
  })

  it('takes the code out of an AI reply', () => {
    expect(
      extractCode(
        'Here you go:\n```js\nreturn clips.filter(c => c.stage === 31)\n```\nEnjoy',
      ),
    ).toBe('return clips.filter(c => c.stage === 31)')
    expect(extractCode('```\nreturn clips\n```')).toBe('return clips')
    expect(extractCode('  return clips  ')).toBe('return clips')
  })
})
