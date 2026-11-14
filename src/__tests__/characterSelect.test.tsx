/**
 * The shared character picker (components/CharacterSelect.tsx): icon + name
 * options, type-to-filter, keyboard control, single and multi values.
 */
import '@testing-library/jest-dom'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import CharacterSelect from '../renderer/components/CharacterSelect'

jest.mock('../renderer/lib/clipAssets', () => ({
  resolveCharacterImage: (p: { characterId: number }) =>
    `icon-${p.characterId}.png`,
}))

function Single({ onChange }: { onChange?: (_v: string[]) => void }) {
  const [v, setV] = useState<string[]>([])
  return (
    <CharacterSelect
      value={v}
      anyLabel="Any character"
      ariaLabel="Playing as"
      onChange={(n) => {
        setV(n)
        onChange?.(n)
      }}
    />
  )
}

function Multi({ onChange }: { onChange?: (_v: string[]) => void }) {
  const [v, setV] = useState<string[]>([])
  return (
    <CharacterSelect
      mode="multi"
      selectAll
      value={v}
      ariaLabel="Chars"
      onChange={(n) => {
        setV(n)
        onChange?.(n)
      }}
    />
  )
}

const trigger = () => screen.getByRole('combobox')
const search = () => screen.getByRole('searchbox')

describe('CharacterSelect single', () => {
  it('shows Any, then every character with its icon', () => {
    render(<Single />)
    expect(trigger()).toHaveTextContent('Any character')
    fireEvent.click(trigger())
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('Any character')
    expect(options[1]).toHaveTextContent('Fox')
    expect(options[1].querySelector('img')).toHaveAttribute('src', 'icon-2.png')
    expect(options).toHaveLength(27)
  })

  it('picks by click and shows the icon and name when closed', () => {
    const onChange = jest.fn()
    render(<Single onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('option', { name: 'Marth' }))
    expect(onChange).toHaveBeenLastCalledWith(['9'])
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger()).toHaveTextContent('Marth')
    expect(trigger().querySelector('img')).toHaveAttribute('src', 'icon-9.png')
  })

  it('filters as you type and Enter picks the first match', () => {
    const onChange = jest.fn()
    render(<Single onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.change(search(), { target: { value: 'falc' } })
    const names = screen.getAllByRole('option').map((o) => o.textContent)
    expect(names).toEqual(['Falco', 'Captain Falcon'])
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['20'])
  })

  it('arrows, Home and End move; Enter selects; Any clears', () => {
    const onChange = jest.fn()
    render(<Single onChange={onChange} />)
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith(['20'])
    fireEvent.keyDown(trigger(), { key: 'Enter' })
    fireEvent.keyDown(search(), { key: 'End' })
    const last = screen.getAllByRole('option').slice(-1)[0]
    expect(search()).toHaveAttribute('aria-activedescendant', last.id)
    fireEvent.keyDown(search(), { key: 'Home' })
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(trigger()).toHaveTextContent('Any character')
  })

  it('Escape and outside click close without changing', () => {
    const onChange = jest.fn()
    render(<Single onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(trigger())
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('CharacterSelect multi', () => {
  it('toggles several, keeps the menu open, shows chips', () => {
    const onChange = jest.fn()
    render(<Multi onChange={onChange} />)
    expect(trigger()).toHaveTextContent('Any')
    fireEvent.click(trigger())
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-multiselectable',
      'true',
    )
    fireEvent.click(screen.getByRole('option', { name: 'Fox' }))
    fireEvent.click(screen.getByRole('option', { name: 'Falco' }))
    expect(onChange).toHaveBeenLastCalledWith(['2', '20'])
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(trigger().querySelectorAll('.char-select-chip')).toHaveLength(2)
    fireEvent.click(screen.getByRole('option', { name: 'Fox' }))
    expect(onChange).toHaveBeenLastCalledWith(['20'])
  })

  it('Select all and Clear', () => {
    const onChange = jest.fn()
    render(<Multi onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByText('Select all'))
    expect(onChange.mock.calls.slice(-1)[0][0]).toHaveLength(26)
    fireEvent.click(screen.getByText('Clear'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
