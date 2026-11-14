/**
 * Dialog and banner behaviour from the launch review (CR-4, CR-8, CR-12, CR-13, CR-19, CR-3):
 * every dialog has a role, takes focus, keeps Tab inside, closes on Esc one layer at a time and
 * gives focus back; the update banner wraps and explains; the usage notice stays until OK; a render
 * crash is reported and has a way out; settings boxes commit when the user is done.
 */
import '@testing-library/jest-dom'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import Modal from '../renderer/components/Modal'
import { ConfirmModal } from '../renderer/components/FilterModals'
import UpdateBanner from '../renderer/components/UpdateBanner'
import ConsentNotice from '../renderer/components/ConsentNotice'
import ErrorBoundary from '../renderer/components/ErrorBoundary'
import { IntField, PathField } from '../renderer/components/SettingsFields'
import { isModalOpen } from '../renderer/hooks/useModal'
import {
  deleteKeyTargetsScope,
  shortcutsBlocked,
} from '../renderer/lib/keyboardScope'

jest.mock('../renderer/ipcBridge', () => ({ __esModule: true, default: {} }))

const sent: [string, unknown][] = []
beforeEach(() => {
  sent.length = 0
  ;(window as any).electron = {
    ipcRenderer: {
      sendMessage: (channel: string, payload: unknown) =>
        sent.push([channel, payload]),
      on: () => () => {},
    },
  }
})

function Layers() {
  const [outer, setOuter] = useState(true)
  const [inner, setInner] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOuter(true)}>
        open outer
      </button>
      {outer && (
        <Modal
          overlayClassName="o"
          className="b"
          label="Outer"
          onClose={() => setOuter(false)}
        >
          <button type="button" onClick={() => setInner(true)}>
            first
          </button>
          <input aria-label="field" />
          <button type="button">last</button>
          {inner && (
            <Modal
              overlayClassName="o"
              className="b"
              label="Inner"
              onClose={() => setInner(false)}
            >
              <button type="button">inner button</button>
            </Modal>
          )}
        </Modal>
      )}
    </div>
  )
}

describe('Modal / useModal', () => {
  it('is a labelled modal dialog with focus inside it', () => {
    render(<Layers />)
    const dialog = screen.getByRole('dialog', { name: 'Outer' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(isModalOpen()).toBe(true)
  })

  it('keeps Tab inside the dialog, wrapping at both ends', () => {
    render(<Layers />)
    const first = screen.getByText('first')
    const last = screen.getByText('last')
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })

  it('pulls focus back in when it was outside', () => {
    render(<Layers />)
    ;(document.body as HTMLElement).focus()
    screen.getByText('open outer').focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getByRole('dialog', { name: 'Outer' })).toContainElement(
      document.activeElement as HTMLElement,
    )
  })

  it('Esc closes only the top dialog, and focus goes back', () => {
    render(<Layers />)
    const first = screen.getByText('first')
    first.focus()
    fireEvent.click(first)
    expect(screen.getByRole('dialog', { name: 'Inner' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(isModalOpen()).toBe(false)
  })

  it('a click on the backdrop closes it, a click inside does not', () => {
    const onClose = jest.fn()
    const { container } = render(
      <Modal
        overlayClassName="overlay"
        className="box"
        label="Box"
        onClose={onClose}
      >
        <button type="button">in</button>
      </Modal>,
    )
    fireEvent.click(screen.getByText('in'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('.overlay')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a dialog with no onClose is answered with its buttons (Esc does nothing)', () => {
    render(
      <Modal overlayClassName="o" className="b" label="Wait">
        <button type="button">ok</button>
      </Modal>,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Wait' })).toBeInTheDocument()
  })

  it('ConfirmModal is a dialog named by its title, Esc cancels', () => {
    const onCancel = jest.fn()
    render(
      <ConfirmModal
        title="Remove 30 results?"
        body="They go."
        confirmLabel="Remove"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    )
    expect(
      screen.getByRole('dialog', { name: 'Remove 30 results?' }),
    ).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('window shortcuts leave dialogs and typing alone', () => {
  const key = (target: EventTarget, k = 'Backspace') => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true })
    Object.defineProperty(e, 'target', { value: target })
    return e
  }

  it('is blocked while typing, and while a dialog is open', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(shortcutsBlocked(key(input))).toBe(true)
    expect(shortcutsBlocked(key(document.body))).toBe(false)
    render(
      <Modal overlayClassName="o" className="b" label="Settings">
        <button type="button">x</button>
      </Modal>,
    )
    expect(shortcutsBlocked(key(document.body))).toBe(true)
    input.remove()
  })

  it('is blocked while a dropdown menu is open', () => {
    const menu = document.createElement('div')
    menu.className = 'filter-multi-menu'
    document.body.appendChild(menu)
    expect(shortcutsBlocked(key(document.body))).toBe(true)
    menu.remove()
    expect(shortcutsBlocked(key(document.body))).toBe(false)
  })

  it('Delete counts on the page or in the tray, not on a button elsewhere', () => {
    const tray = document.createElement('div')
    const inTray = document.createElement('button')
    tray.appendChild(inTray)
    const elsewhere = document.createElement('button')
    document.body.append(tray, elsewhere)
    expect(deleteKeyTargetsScope(key(document.body), tray)).toBe(true)
    expect(deleteKeyTargetsScope(key(window), tray)).toBe(true)
    expect(deleteKeyTargetsScope(key(inTray), tray)).toBe(true)
    expect(deleteKeyTargetsScope(key(elsewhere), tray)).toBe(false)
    tray.remove()
    elsewhere.remove()
  })
})

describe('UpdateBanner', () => {
  it('shows a plain sentence for an error, with the raw text behind Details', () => {
    render(
      <UpdateBanner
        status={{
          state: 'error',
          message: 'Cannot find latest.yml (HttpError: 404)',
        }}
        onDismiss={() => {}}
      />,
    )
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent(/No update information is published yet/)
    expect(banner).not.toHaveTextContent('latest.yml')
    fireEvent.click(screen.getByText('Details'))
    expect(banner).toHaveTextContent('Cannot find latest.yml')
    // It wraps instead of running off both edges.
    expect(banner.style.whiteSpace).not.toBe('nowrap')
  })

  it('Restart now asks first: running work is stopped', () => {
    render(<UpdateBanner status={{ state: 'ready' }} onDismiss={() => {}} />)
    fireEvent.click(screen.getByText('Restart now'))
    expect(sent.find(([c]) => c === 'install-update')).toBeUndefined()
    expect(screen.getByRole('alert')).toHaveTextContent(/will be stopped/)
    fireEvent.click(screen.getByText('Not yet'))
    expect(screen.getByText('Restart now')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Restart now'))
    fireEvent.click(screen.getByText('Restart'))
    expect(sent.find(([c]) => c === 'install-update')).toBeDefined()
  })
})

describe('ConsentNotice', () => {
  it('says what is sent, links Privacy and Turn off, and stays until OK', () => {
    const onDismiss = jest.fn()
    const opened: unknown[] = []
    window.addEventListener('lunar:openSettings', (e) =>
      opened.push((e as CustomEvent).detail),
    )
    render(<ConsentNotice onDismiss={onDismiss} />)
    expect(
      screen.getByRole('region', { name: 'Usage statistics notice' }),
    ).toHaveTextContent(/anonymous usage stats/)
    fireEvent.click(screen.getByText('Turn off'))
    expect(opened).toEqual([{ section: 'diagnostics' }])
    fireEvent.click(screen.getByText('OK'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('ErrorBoundary', () => {
  function Boom({ boom }: { boom: boolean }) {
    if (boom) throw new Error('bad row')
    return <p>fine</p>
  }

  it('reports the error to main and offers a way out of a crashing project', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const closed = jest.fn()
    render(
      <ErrorBoundary area="workspace" onCloseProject={closed}>
        <Boom boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    const report = sent.find(([c]) => c === 'rendererError')
    expect(report?.[1]).toMatchObject({
      type: 'react-error',
      area: 'workspace',
      message: 'bad row',
    })
    fireEvent.click(screen.getByText('Close project'))
    expect(closed).toHaveBeenCalledTimes(1)
    jest.restoreAllMocks()
  })

  it('an inline boundary leaves the rest of the app standing', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <div>
        <p>rest of the app</p>
        <ErrorBoundary area="downloads panel" fallback="inline">
          <Boom boom />
        </ErrorBoundary>
      </div>,
    )
    expect(screen.getByText('rest of the app')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Something went wrong in the downloads panel',
    )
    jest.restoreAllMocks()
  })
})

describe('Settings boxes commit when the user is done', () => {
  it('a path box does not save per keystroke: blur or Enter commits, once', () => {
    const commit = jest.fn()
    render(<PathField id="p" value="/old" placeholder="x" onCommit={commit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'D' } })
    fireEvent.change(input, { target: { value: 'D:' } })
    fireEvent.change(input, { target: { value: '"D:\\Slippi Library"' } })
    expect(commit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toBe('D:\\Slippi Library')
  })

  it('a refused change goes back to the saved value', () => {
    const commit = jest.fn((_p: string, revert: () => void) => revert())
    render(<PathField id="p" value="/old" onCommit={commit} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/typo' } })
    fireEvent.blur(input)
    expect(input.value).toBe('/old')
  })

  it('closing Settings with the cursor still in the box keeps what was typed', () => {
    const commit = jest.fn()
    const { unmount } = render(
      <PathField id="p" value="/old" onCommit={commit} />,
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '/new' },
    })
    unmount()
    expect(commit).toHaveBeenCalledWith('/new', expect.any(Function))
  })

  it('a number box emptied to retype never saves NaN, and clamps on blur', () => {
    const commit = jest.fn()
    render(<IntField id="numCPUs" value={2} onCommit={commit} />)
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(commit).not.toHaveBeenCalled()
    expect(input.value).toBe('2')
    fireEvent.change(input, { target: { value: '500' } })
    fireEvent.blur(input)
    expect(commit).toHaveBeenCalledWith(64)
    expect(input.value).toBe('64')
  })
})
