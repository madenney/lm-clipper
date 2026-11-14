import { isFileLockedText } from '../main/fsRetry'

describe('isFileLockedText', () => {
  it('recognises ffmpeg saying an input is still held by another process', () => {
    expect(
      isFileLockedText('C:\\x\\clip-unmerged.wav: Permission denied\r\n'),
    ).toBe(true)
    expect(
      isFileLockedText(
        'The process cannot access the file because it is being used by another process.',
      ),
    ).toBe(true)
  })
  it('does not retry other ffmpeg failures', () => {
    expect(isFileLockedText('Invalid data found when processing input')).toBe(
      false,
    )
    expect(isFileLockedText('No space left on device')).toBe(false)
  })
})
