/**
 * The clip grid is reachable by keyboard (CR-12): one tab stop that is a listbox of cards, arrow
 * keys move a highlight, Enter opens the card in Single, Space toggles it, P plays and R records.
 * A click also focuses the grid, but then the arrows must stay free for the filter-step shortcut.
 */
import '@testing-library/jest-dom'
import { act } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { DomLayer } from '../renderer/components/Tray/DomLayer'
import type { ClipData } from '../renderer/components/Clip'
import { Selection } from '../lib/selection'
import { clipModeFor } from '../renderer/hooks/useClipMode'

const clips = Array.from(
  { length: 30 },
  (_, i) =>
    ({
      id: i + 1,
      path: `/r/${i + 1}.slp`,
      stage: 2,
      startFrame: 0,
      endFrame: 600,
    }) as unknown as ClipData,
)

function setup() {
  // A 150 px tile in a 1000 x 600 tray.
  const info = clipModeFor({
    zoomSize: 150,
    totalClips: clips.length,
    trayWidth: 1000,
    trayHeight: 600,
  })
  const handlers = {
    onClipMouseDown: jest.fn(),
    onClipMouseEnter: jest.fn(),
    onClipDoubleClick: jest.fn(),
    onClipPlay: jest.fn(),
    onClipRecord: jest.fn(),
    onBackgroundClick: jest.fn(),
  }
  render(
    <DomLayer
      clips={clips}
      mode={info.mode}
      clipSize={info.clipSize}
      gap={info.gap}
      columns={info.columns}
      trayWidth={1000}
      trayHeight={600}
      visible
      selection={Selection.none()}
      startIndex={0}
      total={clips.length}
      onClipMouseDown={handlers.onClipMouseDown}
      onClipMouseEnter={handlers.onClipMouseEnter}
      onClipDoubleClick={handlers.onClipDoubleClick}
      onClipPlay={handlers.onClipPlay}
      onClipRecord={handlers.onClipRecord}
      onBackgroundClick={handlers.onBackgroundClick}
    />,
  )
  const list = screen.getByRole('listbox', { name: 'Clips' })
  return { list, handlers, columns: info.columns }
}

describe('clip grid keyboard', () => {
  it('is one focusable multi-select listbox of options', () => {
    const { list } = setup()
    expect(list).toHaveAttribute('tabindex', '0')
    expect(list).toHaveAttribute('aria-multiselectable', 'true')
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
  })

  it('focus from the keyboard highlights the first card; arrows move it', () => {
    const { list, columns } = setup()
    act(() => list.focus())
    const first = list.getAttribute('aria-activedescendant')
    expect(first).toBeTruthy()
    expect(document.getElementById(first!)).toHaveClass('clip--kbd-active')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    const second = list.getAttribute('aria-activedescendant')
    expect(second).not.toBe(first)
    expect(document.getElementById(second!)).toHaveClass('clip--kbd-active')
    expect(document.getElementById(first!)).not.toHaveClass('clip--kbd-active')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    const below = list.getAttribute('aria-activedescendant')!
    // One card right and one row down from the first: index 1 + columns.
    expect(below.endsWith(`-clip-${1 + columns}`)).toBe(true)
  })

  it('Enter opens Single, Space toggles, P plays, R records the highlighted card', () => {
    const { list, handlers } = setup()
    act(() => list.focus())
    fireEvent.keyDown(list, { key: 'ArrowRight' }) // the second card, id 2
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(handlers.onClipDoubleClick).toHaveBeenCalledWith(1, '2')
    fireEvent.keyDown(list, { key: ' ' })
    expect(handlers.onClipMouseDown).toHaveBeenCalledWith(
      1,
      '2',
      expect.objectContaining({ button: 0, ctrlKey: true }),
    )
    fireEvent.keyDown(list, { key: 'p' })
    expect(handlers.onClipPlay).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/r/2.slp' }),
    )
    fireEvent.keyDown(list, { key: 'r' })
    expect(handlers.onClipRecord).toHaveBeenCalledWith('2')
  })

  it('a click focuses the grid but does not take the arrows (they step filters)', () => {
    const { list } = setup()
    fireEvent.mouseDown(list)
    act(() => list.focus())
    fireEvent.mouseUp(list)
    expect(list).not.toHaveAttribute('aria-activedescendant')
    const stepped = fireEvent.keyDown(list, { key: 'ArrowDown' })
    // Not handled here, so not prevented: the tray's window handler still sees it.
    expect(stepped).toBe(true)
  })
})
