/**
 * @jest-environment node
 */
import type { PlayResult } from 'slippi-dolphin-runner'
import { judgeTestRun, dolphinErrorHint } from '../main/dolphinCheck'

const result = (over: Record<string, unknown> = {}): PlayResult =>
  ({
    lastFrame: 3600,
    stalled: false,
    stoppedEarly: false,
    diagnostic: null,
    placement: null,
    ...over,
  }) as unknown as PlayResult

const diagnostic = (over: Record<string, unknown> = {}) => ({
  replay: 'test.slp',
  reason: 'boot-stall',
  silentForSec: 30,
  hungOnBoot: true,
  endFrame: null,
  stderrBytes: 10,
  stdoutTail: [],
  stderrTail: ['some line', 'last line'],
  ...over,
})

describe('judgeTestRun', () => {
  it('passes a run that played frames and exited cleanly', () => {
    expect(judgeTestRun(result({ exitCode: 0 }), 500).ok).toBe(true)
    // runner 0.5.6: no exitCode at all
    expect(judgeTestRun(result(), 500).ok).toBe(true)
  })

  it('fails when no frame was ever seen', () => {
    const v = judgeTestRun(result(), 0)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/never played the replay/)
  })

  it('fails a hung boot and shows its stderr', () => {
    const v = judgeTestRun(
      result({ stalled: true, diagnostic: diagnostic() }),
      0,
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/never played the replay \(nothing for 30 s\)/)
    expect(v.stderr).toEqual(['some line', 'last line'])
  })

  it("fails an 'early-exit' (runner 0.5.7) with its exit code", () => {
    const v = judgeTestRun(
      result({
        exitCode: 127,
        stderrTail: ['dlopen(): error loading libfuse.so.2'],
        diagnostic: diagnostic({ reason: 'early-exit', hungOnBoot: false }),
      }),
      0,
      '/x/Slippi_Playback-x86_64.AppImage',
      'linux',
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toBe(
      'Dolphin closed before the replay started (exit code 127).',
    )
    expect(v.hint).toMatch(/libfuse2/)
    expect(v.stderr).toEqual(['dlopen(): error loading libfuse.so.2'])
  })

  it('fails a nonzero exit even after frames', () => {
    const v = judgeTestRun(result({ exitCode: 1 }), 200)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/exit code 1/)
  })

  it('fails a frame stall but not a hard timeout', () => {
    expect(
      judgeTestRun(
        result({
          stalled: true,
          diagnostic: diagnostic({ reason: 'frame-stall', hungOnBoot: false }),
        }),
        100,
      ).reason,
    ).toMatch(/stopped responding \(frame-stall\)/)
    expect(
      judgeTestRun(
        result({
          stalled: true,
          diagnostic: diagnostic({ reason: 'hard-timeout', hungOnBoot: false }),
        }),
        100,
      ).ok,
    ).toBe(true)
  })
})

describe('dolphinErrorHint', () => {
  it('recognises FUSE, permissions, display and missing libraries', () => {
    expect(dolphinErrorHint('fuse: device not found', '', 'linux')).toMatch(
      /sudo apt install libfuse2/,
    )
    expect(
      dolphinErrorHint('spawn EACCES', '/home/me/Dolphin.AppImage', 'linux'),
    ).toBe(
      'Clipper is not allowed to run this file. Make it executable: chmod +x "/home/me/Dolphin.AppImage"',
    )
    expect(
      dolphinErrorHint('qt.qpa.xcb: could not connect to display', '', 'linux'),
    ).toMatch(/no display/)
    expect(
      dolphinErrorHint(
        'error while loading shared libraries: libEGL.so.1: cannot open',
        '',
        'linux',
      ),
    ).toMatch(/libEGL\.so\.1/)
    expect(dolphinErrorHint('all good', '', 'linux')).toBeNull()
    expect(dolphinErrorHint('', '', 'linux')).toBeNull()
  })

  it('gives Windows its own permission hint', () => {
    expect(dolphinErrorHint('EACCES', 'C:\\x.exe', 'win32')).toMatch(
      /antivirus/,
    )
  })
})
