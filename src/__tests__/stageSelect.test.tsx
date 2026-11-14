/** The stage picker (components/StageSelect.tsx): thumbnail + name options on the shared shell. */
import '@testing-library/jest-dom'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import StageSelect from '../renderer/components/StageSelect'
import { legalStages } from '../constants/stages'

jest.mock('../renderer/lib/clipAssets', () => ({
  resolveStageImage: (id: number) => `stage-${id}.png`,
}))

function Harness({
  mode,
  onChange,
}: {
  mode?: 'single' | 'multi'
  onChange?: (_v: string[]) => void
}) {
  const [v, setV] = useState<string[]>([])
  return (
    <StageSelect
      mode={mode}
      value={v}
      ariaLabel="Stage"
      onChange={(n) => {
        setV(n)
        onChange?.(n)
      }}
    />
  )
}
const trigger = () => screen.getByRole('combobox')
const search = () => screen.getByRole('searchbox')

describe('StageSelect', () => {
  it('lists Any stage then every legal stage in order, with thumbnails', () => {
    render(<Harness />)
    expect(trigger()).toHaveTextContent('Any stage')
    fireEvent.click(trigger())
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Any stage',
      ...legalStages.map((s) => s.name),
    ])
    expect(options[1].querySelector('img')).toHaveAttribute(
      'src',
      `stage-${legalStages[0].id}.png`,
    )
    expect(search()).toHaveAttribute('aria-label', 'Filter stages')
  })

  it('picks by click, filters by typing, Enter picks, Any clears', () => {
    const onChange = jest.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.change(search(), { target: { value: 'battle' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(search(), { key: 'Enter' })
    const bf = legalStages.find((s) => s.name === 'Battlefield')!
    expect(onChange).toHaveBeenLastCalledWith([String(bf.id)])
    expect(trigger()).toHaveTextContent('Battlefield')
    expect(trigger().querySelector('img')).toHaveAttribute(
      'src',
      `stage-${bf.id}.png`,
    )
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('option', { name: 'Any stage' }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('multi toggles several and stays open; Escape closes', () => {
    const onChange = jest.fn()
    render(<Harness mode="multi" onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('option', { name: legalStages[0].name }))
    fireEvent.click(screen.getByRole('option', { name: legalStages[1].name }))
    expect(onChange).toHaveBeenLastCalledWith([
      String(legalStages[0].id),
      String(legalStages[1].id),
    ])
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-multiselectable',
      'true',
    )
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
