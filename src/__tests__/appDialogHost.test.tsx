import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import AppDialogHost from '../renderer/components/AppDialogHost'

type Listener = (_r: unknown) => void

function setup() {
  let listener: Listener = () => {}
  const sent: [string, any][] = []
  ;(window as any).electron = {
    ipcRenderer: {
      on: (_c: string, f: Listener) => {
        listener = f
        return () => {}
      },
      sendMessage: (c: string, a: any) => sent.push([c, a]),
    },
  }
  return { ask: (r: unknown) => act(() => listener(r)), sent }
}

const req = (id: string, extra = {}) => ({
  id,
  type: 'question',
  title: 'Untitled projects',
  message: `Message ${id}`,
  detail: 'Detail',
  buttons: ['Move to Trash', 'Show in Folder', 'Keep Them'],
  defaultId: 2,
  cancelId: 2,
  checkboxChecked: false,
  ...extra,
})

describe('AppDialogHost', () => {
  it('tells main it is ready, then shows requests one at a time in order', () => {
    const { ask, sent } = setup()
    render(<AppDialogHost />)
    expect(sent[0]).toEqual(['dialogReady', null])
    ask(req('a'))
    ask(req('b'))
    expect(screen.getByText('Message a')).toBeInTheDocument()
    expect(screen.queryByText('Message b')).toBeNull()
    fireEvent.click(screen.getByText('Show in Folder'))
    expect(sent[1][0]).toBe('dialogReply')
    expect(sent[1][1]).toMatchObject({ id: 'a', response: 1 })
    expect(screen.getByText('Message b')).toBeInTheDocument()
  })

  it('Esc answers the cancel choice; the default button has focus', () => {
    const { ask, sent } = setup()
    render(<AppDialogHost />)
    ask(req('a'))
    expect(screen.getByText('Keep Them')).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(sent[1][1]).toMatchObject({ id: 'a', response: 2 })
    expect(screen.queryByText('Message a')).toBeNull()
  })

  it('ignores a request it already has (resent after a reload) and reports the checkbox', () => {
    const { ask, sent } = setup()
    render(<AppDialogHost />)
    const r = req('a', { checkboxLabel: 'Do not ask again' })
    ask(r)
    ask(r)
    fireEvent.click(screen.getByLabelText('Do not ask again'))
    fireEvent.click(screen.getByText('Move to Trash'))
    expect(sent[1][1]).toMatchObject({
      id: 'a',
      response: 0,
      checkboxChecked: true,
    })
    expect(screen.queryByText('Message a')).toBeNull()
  })
})
