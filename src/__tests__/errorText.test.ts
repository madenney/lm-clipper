/**
 * @jest-environment node
 */
import { errorMessage, shownError } from '../main/errorText'

describe('errorMessage / shownError', () => {
  it('never doubles the "Error: " prefix', () => {
    const err = new Error('Error: Could not open Dolphin from path C:\\d.exe.')
    expect(String(err)).toBe(
      'Error: Error: Could not open Dolphin from path C:\\d.exe.',
    )
    expect(errorMessage(err)).toBe(
      'Could not open Dolphin from path C:\\d.exe.',
    )
    expect(shownError(err)).toBe(
      'Error: Could not open Dolphin from path C:\\d.exe.',
    )
  })

  it('handles plain messages, strings and non-errors', () => {
    expect(shownError(new Error('no space'))).toBe('Error: no space')
    expect(shownError('Error: Error: twice')).toBe('Error: twice')
    expect(shownError({ message: 'from IPC' })).toBe('Error: from IPC')
    expect(shownError(undefined, 'Video generation failed')).toBe(
      'Error: Video generation failed',
    )
  })

  it('shows a run that stopped itself as it is', () => {
    expect(shownError(new Error('Stopped: disk full on C:'))).toBe(
      'Stopped: disk full on C:',
    )
  })
})
