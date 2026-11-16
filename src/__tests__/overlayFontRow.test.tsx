/**
 * Settings > Overlay, the font row and the preview: the list, importing (the new
 * font is picked, a refused file says why), a font that has gone missing,
 * removing, and the preview picture drawn by the main process.
 */
import '@testing-library/jest-dom'
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'

import {
  OverlayFontRow,
  OverlayPreviewImage,
} from '../renderer/components/OverlayFont'

const bridge = {
  fonts: [] as { file: string; name: string }[],
  importReply: null as any,
  removed: [] as string[],
  previews: [] as any[],
  previewUrl: 'data:image/png;base64,AAAA' as string | null,
}

jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    overlayFontsList: (h: (_r: any) => void) => h({ fonts: bridge.fonts }),
    overlayFontsImport: (h: (_r: any) => void) => h(bridge.importReply),
    overlayFontsRemove: (file: string, h: (_r: any) => void) => {
      bridge.removed.push(file)
      bridge.fonts = bridge.fonts.filter((f) => f.file !== file)
      h({ removed: true, fonts: bridge.fonts })
    },
    overlayPreview: (payload: any, h: (_r: any) => void) => {
      bridge.previews.push(payload)
      h({ dataUrl: bridge.previewUrl })
    },
  },
}))

const font = (file: string) => ({ file, name: file.replace(/\.[^.]+$/, '') })

beforeEach(() => {
  bridge.fonts = []
  bridge.importReply = null
  bridge.removed = []
  bridge.previews = []
  bridge.previewUrl = 'data:image/png;base64,AAAA'
})

const row = (value = '') => {
  const onChange = jest.fn()
  render(<OverlayFontRow value={value} onChange={onChange} />)
  return onChange
}
const options = () =>
  screen.getAllByRole('option').map((o) => o.textContent || '')

describe('the font row', () => {
  it('offers the bundled font and what was imported', () => {
    bridge.fonts = [font('Inter-Bold.ttf'), font('Melee.otf')]
    const onChange = row()
    expect(options()).toEqual([
      'Default (Liberation Mono Bold)',
      'Inter-Bold',
      'Melee',
    ])
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Font'), {
      target: { value: 'Melee.otf' },
    })
    expect(onChange).toHaveBeenCalledWith('Melee.otf')
  })

  it('picks the font that was just imported', () => {
    const onChange = row()
    bridge.importReply = {
      imported: [font('Brand.ttf')],
      failed: [],
      canceled: false,
      fonts: [font('Brand.ttf')],
    }
    fireEvent.click(screen.getByRole('button', { name: 'Import font…' }))
    expect(onChange).toHaveBeenCalledWith('Brand.ttf')
    expect(options()).toContain('Brand')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says why a file was refused, and changes nothing', () => {
    const onChange = row()
    bridge.importReply = {
      imported: [],
      failed: [
        { name: 'fake.ttf', reason: 'this file could not be read as a font' },
      ],
      canceled: false,
      fonts: [],
    }
    fireEvent.click(screen.getByRole('button', { name: 'Import font…' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'fake.ttf: this file could not be read as a font',
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a cancelled file dialog is not an error', () => {
    const onChange = row()
    bridge.importReply = { imported: [], failed: [], canceled: true, fonts: [] }
    fireEvent.click(screen.getByRole('button', { name: 'Import font…' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows a chosen font that is gone, and that the default is used', () => {
    bridge.fonts = [font('Other.ttf')]
    row('Gone.ttf')
    expect(options()).toContain('Gone.ttf (missing)')
    expect(screen.getByText(/the default is used/)).toBeVisible()
  })

  it('removing goes back to the bundled font', () => {
    bridge.fonts = [font('Brand.ttf')]
    function Held() {
      const [value, setValue] = useState('Brand.ttf')
      return <OverlayFontRow value={value} onChange={setValue} />
    }
    render(<Held />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(bridge.removed).toEqual(['Brand.ttf'])
    expect(options()).toEqual(['Default (Liberation Mono Bold)'])
    expect(screen.getByLabelText('Font')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })
})

describe('the preview', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('is the picture the main process draws, in the chosen font', () => {
    const { rerender } = render(
      <OverlayPreviewImage
        text="Fox vs Marth"
        font=""
        size={24}
        fallback={<i>plain</i>}
      />,
    )
    expect(screen.getByText('plain')).toBeVisible()
    act(() => jest.advanceTimersByTime(200))
    expect(screen.getByRole('img')).toHaveAttribute('src', bridge.previewUrl)
    expect(bridge.previews).toEqual([
      { text: 'Fox vs Marth', font: '', size: 24 },
    ])

    rerender(
      <OverlayPreviewImage
        text="Fox vs Marth"
        font="Brand.ttf"
        size={40}
        fallback={<i>plain</i>}
      />,
    )
    act(() => jest.advanceTimersByTime(200))
    expect(bridge.previews[1]).toEqual({
      text: 'Fox vs Marth',
      font: 'Brand.ttf',
      size: 40,
    })
  })

  it('falls back to plain text when there is no picture', () => {
    bridge.previewUrl = null
    render(
      <OverlayPreviewImage
        text="Fox vs Marth"
        font=""
        size={24}
        fallback={<i>plain</i>}
      />,
    )
    act(() => jest.advanceTimersByTime(200))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('plain')).toBeVisible()
  })

  it('asks for nothing while the text is empty', () => {
    render(
      <OverlayPreviewImage
        text="  "
        font=""
        size={24}
        fallback={<i>plain</i>}
      />,
    )
    act(() => jest.advanceTimersByTime(200))
    expect(bridge.previews).toEqual([])
  })
})
