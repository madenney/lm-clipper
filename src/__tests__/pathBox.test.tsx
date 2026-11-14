/**
 * The wizards' folder box (components/PathBox.tsx): a long path keeps its end
 * on screen (the start is what gets cut), with the full path as the tooltip.
 */
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import PathBox, { splitPathTail } from '../renderer/components/PathBox'

describe('splitPathTail', () => {
  it('keeps the last two parts apart from the start', () => {
    expect(splitPathTail('/home/me/Downloads/lunar-200/slp')).toEqual([
      '/home/me/Downloads/',
      'lunar-200/',
      'slp',
    ])
    expect(splitPathTail('C:\\Users\\me\\Replays\\ranked-slp')).toEqual([
      'C:\\Users\\me\\',
      'Replays\\',
      'ranked-slp',
    ])
    expect(splitPathTail('/home/me/a/')).toEqual(['/home/', 'me/', 'a/'])
  })

  it('a short path', () => {
    expect(splitPathTail('slp')).toEqual(['', '', 'slp'])
    expect(splitPathTail('/slp')).toEqual(['/', '', 'slp'])
  })
})

describe('PathBox', () => {
  it('shows the path with its end kept apart, and the whole path as tooltip', () => {
    const p = '/home/me/Downloads/very/long/folder/lunar-200/slp'
    render(<PathBox path={p} />)
    const box = screen.getByTestId('path-box')
    expect(box).toHaveAttribute('title', p)
    expect(box).toHaveTextContent(p)
    expect(box.querySelector('.path-box-name')).toHaveTextContent('slp')
    expect(box.querySelector('.path-box-parent')).toHaveTextContent(
      'lunar-200/',
    )
  })

  it('shows the placeholder when there is no path', () => {
    render(<PathBox path="" placeholder="Select output directory..." />)
    expect(screen.getByText('Select output directory...')).toBeInTheDocument()
  })
})
