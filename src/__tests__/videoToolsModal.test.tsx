/**
 * Video Tools, the window and its top-bar button: always reachable, what is
 * ticked on opening, what the one action button does for a selection (combine,
 * compress, both), the empty state, cancel, and the remembered quality.
 */
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, within } from '@testing-library/react'

import VideoToolsModal from '../renderer/components/VideoToolsModal'
import ActionBar from '../renderer/components/ActionBar'
import {
  describeAction,
  latestFolderPath,
  mergeScan,
  sortFolders,
} from '../renderer/lib/videoTools'
import type { VideoFolder } from '../constants/types'

const bridge = {
  folders: [] as VideoFolder[],
  runs: [] as any[],
  finishRun: null as null | ((_res: any) => void),
  probes: [] as any[],
  cancels: 0,
  reveals: [] as string[],
}

jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    videoToolsList: (handler: (_res: any) => void) =>
      handler({ folders: bridge.folders }),
    videoToolsProbe: (payload: any, handler: (_res: any) => void) => {
      bridge.probes.push(payload)
      handler({ seconds: 60 * payload.items.length, bitrateKbps: 15000 })
    },
    videoToolsRun: (payload: any, handler: (_res: any) => void) => {
      bridge.runs.push(payload)
      bridge.finishRun = handler
    },
    videoToolsCancel: () => {
      bridge.cancels += 1
    },
    videoToolsReveal: (file: string) => bridge.reveals.push(file),
  },
}))

const ROOT = '/videos/out'
const folder = (
  name: string,
  clips: string[],
  finished: string[] = [],
): VideoFolder => ({
  path: name ? `${ROOT}/${name}` : ROOT,
  name,
  isRoot: name === '',
  clips,
  finished,
  sizes: Object.fromEntries(
    [...clips, ...finished].map((c) => [c, 100_000_000]),
  ),
})

const sent: [string, unknown][] = []
beforeEach(() => {
  jest.useFakeTimers()
  window.localStorage.clear()
  bridge.folders = []
  bridge.runs = []
  bridge.probes = []
  bridge.finishRun = null
  bridge.cancels = 0
  bridge.reveals = []
  sent.length = 0
  ;(window as any).electron = {
    ipcRenderer: {
      sendMessage: (channel: string, payload: unknown) =>
        sent.push([channel, payload]),
      on: () => () => {},
    },
  }
})
afterEach(() => jest.useRealTimers())

const open = () => {
  const onClose = jest.fn()
  render(
    <VideoToolsModal config={{ outputPath: ROOT } as any} onClose={onClose} />,
  )
  return onClose
}
const settle = () => act(() => jest.advanceTimersByTime(600))
const goButton = () =>
  screen.getByRole('button', { name: /^(Combin|Compress)/ })
const quality = (name: RegExp) => screen.getByRole('radio', { name })

describe('the top bar button', () => {
  const bar = (over: Record<string, unknown> = {}) => {
    const onVideoTools = jest.fn()
    render(
      <ActionBar
        selectedCount={0}
        selectionLabel="clip"
        selectionLength={null as any}
        isGenerating={false}
        isPlaying={false}
        stopping={false}
        progress={null}
        showSpinner={false}
        onPlay={() => {}}
        onRecord={() => {}}
        onStopPlayback={() => {}}
        onStopRecording={() => {}}
        onCancelRecording={() => {}}
        onVideoTools={onVideoTools}
        onOpenOutput={() => {}}
        options={null}
        // eslint-disable-next-line react/jsx-props-no-spreading
        {...over}
      />,
    )
    return onVideoTools
  }

  it('is there with nothing selected and nothing recorded', () => {
    const onVideoTools = bar()
    const button = screen.getByRole('button', { name: 'Video Tools' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onVideoTools).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled()
  })

  it('gives way to Stop and Cancel while recording', () => {
    bar({ isGenerating: true })
    expect(screen.queryByRole('button', { name: 'Video Tools' })).toBeNull()
  })
})

describe('the window', () => {
  it('says so when nothing has been recorded, and offers the folder', () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Video Tools' })).toBeVisible()
    expect(screen.getByText('No videos yet')).toBeVisible()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Combine/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Open output folder$/ }))
    expect(sent).toContainEqual(['openFolder', ROOT])
  })

  it('opens with the newest recording ticked, ready to combine', () => {
    bridge.folders = [
      folder('output_1', ['a.mp4', 'b.mp4']),
      folder('output_2', ['c.mp4', 'd.mp4', 'e.mp4'], ['final.mp4']),
      folder('', [], ['stitched.mp4']),
    ]
    open()
    settle()
    const rows = screen
      .getAllByRole('button', { expanded: false })
      .map((r) => r.textContent)
    expect(rows[0]).toContain('output_2')
    expect(rows[0]).toContain('latest')
    expect(rows[0]).toContain('3/4') // its clips, not its finished video
    expect(rows[1]).toContain('output_1')
    expect(rows[2]).toContain('Output folder')
    expect(goButton()).toHaveTextContent('Combine 3 clips')
    expect(goButton()).toBeEnabled()

    fireEvent.click(goButton())
    expect(bridge.runs).toEqual([
      {
        items: ['c.mp4', 'd.mp4', 'e.mp4'].map((name) => ({
          folder: `${ROOT}/output_2`,
          name,
        })),
        compress: false,
        videoKbps: undefined,
      },
    ])
  })

  it('names the job: combine, combine and compress, with sizes per quality', () => {
    bridge.folders = [folder('output_1', ['a.mp4', 'b.mp4'])]
    open()
    settle()
    // 2 x 100 MB as they are; 2 minutes at 4 Mbps + audio once compressed.
    expect(quality(/Original/)).toHaveTextContent('≈ 200 MB')
    expect(quality(/Medium/)).toHaveTextContent('≈ 62.4 MB')
    expect(screen.getByText('2m 0s')).toBeVisible()
    fireEvent.click(quality(/Medium/))
    expect(goButton()).toHaveTextContent('Combine and compress 2 clips')
    fireEvent.click(goButton())
    expect(bridge.runs[0]).toMatchObject({ compress: true, videoKbps: 4000 })
  })

  it('one video can be compressed but not copied', () => {
    bridge.folders = [folder('output_1', ['a.mp4', 'b.mp4'], ['final.mp4'])]
    open()
    settle()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(goButton()).toBeDisabled()
    // One folder only: it is open already.
    fireEvent.click(screen.getByRole('checkbox', { name: 'final.mp4' }))
    expect(goButton()).toHaveTextContent('Compress 1 video')
    expect(goButton()).toBeDisabled()
    expect(screen.getByText(/Pick High, Medium or Small/)).toBeVisible()
    fireEvent.click(quality(/Small/))
    expect(goButton()).toBeEnabled()
    fireEvent.click(goButton())
    expect(bridge.runs).toEqual([
      {
        items: [{ folder: `${ROOT}/output_1`, name: 'final.mp4' }],
        compress: true,
        videoKbps: 2000,
      },
    ])
  })

  it('select all leaves finished videos alone', () => {
    bridge.folders = [
      folder('output_1', ['a.mp4', 'b.mp4'], ['final.mp4']),
      folder('clips', ['x.mp4']),
    ]
    open()
    settle()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select all clips' }))
    expect(goButton()).toHaveTextContent('Combine 3 clips')
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all clips in output_1' }),
    )
    expect(goButton()).toHaveTextContent('Compress 1 video')
  })

  it('can be cancelled, then says nothing was saved', () => {
    bridge.folders = [folder('output_1', ['a.mp4', 'b.mp4'])]
    const onClose = open()
    settle()
    fireEvent.click(goButton())
    expect(goButton()).toBeDisabled()
    expect(goButton()).toHaveTextContent('Combining…')
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(bridge.cancels).toBe(1)
    act(() => bridge.finishRun?.({ ok: false, cancelled: true }))
    expect(screen.getByText('Cancelled. Nothing was saved.')).toBeVisible()
    expect(goButton()).toBeEnabled()
  })

  it('shows the result, reveals it, and lists it straight away', () => {
    bridge.folders = [folder('output_1', ['a.mp4', 'b.mp4'])]
    open()
    settle()
    fireEvent.click(goButton())
    bridge.folders = [folder('output_1', ['a.mp4', 'b.mp4'], ['final.mp4'])]
    act(() =>
      bridge.finishRun?.({
        ok: true,
        output: `${ROOT}/output_1/final.mp4`,
        dir: `${ROOT}/output_1`,
      }),
    )
    const saved = screen.getByText('Saved', { exact: false })
    expect(within(saved).getByText('final.mp4')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Show in folder/ }))
    expect(bridge.reveals).toEqual([`${ROOT}/output_1/final.mp4`])
    expect(
      screen.getByRole('checkbox', { name: 'final.mp4' }),
    ).not.toBeChecked()
  })

  it('shows why a job failed', () => {
    bridge.folders = [folder('output_1', ['a.mp4', 'b.mp4'])]
    open()
    settle()
    fireEvent.click(goButton())
    act(() =>
      bridge.finishRun?.({ ok: false, error: 'Not enough free space on D:\\' }),
    )
    expect(screen.getByText(/Not enough free space/)).toBeVisible()
  })

  it('remembers the quality picked last time', () => {
    bridge.folders = [folder('output_1', ['a.mp4', 'b.mp4'])]
    open()
    settle()
    expect(quality(/Original/)).toBeChecked()
    fireEvent.click(quality(/High/))
    document.body.innerHTML = ''
    open()
    settle()
    expect(screen.getAllByRole('radio', { name: /High/ })[0]).toBeChecked()
  })
})

describe("the window's logic", () => {
  it('orders recording folders newest first, the output folder last', () => {
    const order = sortFolders([
      folder('', [], ['stitched.mp4']),
      folder('zebra', ['a.mp4']),
      folder('output', ['a.mp4']),
      folder('output_10', ['a.mp4']),
      folder('output_2', ['a.mp4']),
      folder('alpha', ['a.mp4']),
    ]).map((f) => f.name)
    expect(order).toEqual([
      'output_10',
      'output_2',
      'output',
      'alpha',
      'zebra',
      '',
    ])
  })

  it('the newest recording with clips is the one ticked', () => {
    expect(
      latestFolderPath([
        folder('output_3', [], ['final.mp4']),
        folder('output_2', ['a.mp4']),
        folder('output_1', ['a.mp4']),
      ]),
    ).toBe(`${ROOT}/output_2`)
    expect(latestFolderPath([folder('mine', ['a.mp4'])])).toBe('')
  })

  it('a rescan keeps ticks and order, drops what vanished, adds what is new', () => {
    const first = mergeScan(
      {},
      [folder('output_1', ['a.mp4', 'b.mp4', 'c.mp4'], ['final.mp4'])],
      `${ROOT}/output_1`,
    )
    expect(first[`${ROOT}/output_1`].checked).toEqual({
      'a.mp4': true,
      'b.mp4': true,
      'c.mp4': true,
      'final.mp4': false,
    })
    const moved = {
      [`${ROOT}/output_1`]: {
        order: ['c.mp4', 'a.mp4', 'b.mp4', 'final.mp4'],
        checked: first[`${ROOT}/output_1`].checked,
      },
    }
    const next = mergeScan(moved, [
      folder('output_1', ['a.mp4', 'c.mp4', 'd.mp4'], ['final.mp4']),
    ])
    expect(next[`${ROOT}/output_1`].order).toEqual([
      'c.mp4',
      'a.mp4',
      'final.mp4',
      'd.mp4',
    ])
    expect(next[`${ROOT}/output_1`].checked).toEqual({
      'c.mp4': true,
      'a.mp4': true,
      'final.mp4': false,
      'd.mp4': false,
    })
  })

  it('the button says what will happen', () => {
    expect(describeAction(0, false, 'copy')).toMatchObject({ enabled: false })
    expect(describeAction(1, false, 'copy')).toMatchObject({
      label: 'Compress 1 video',
      enabled: false,
    })
    expect(describeAction(1, true, 'small')).toMatchObject({
      label: 'Compress 1 video',
      enabled: true,
    })
    expect(describeAction(12, false, 'copy').label).toBe('Combine 12 clips')
    expect(describeAction(2, true, 'high').label).toBe(
      'Combine and compress 2 videos',
    )
  })
})
