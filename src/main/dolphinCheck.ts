/**
 * Turning what Dolphin did into something a user can act on: the Test Dolphin
 * verdict (judgeTestRun) and hints for the usual reasons a Dolphin won't start
 * (dolphinErrorHint), and the setup wizard's check that a path is the Playback
 * build (checkDolphinPath).
 */
import { spawn } from 'child_process'
import { promises as fsPromises } from 'fs'
import os from 'os'
import type { PlayResult } from 'slippi-dolphin-runner'
import { resolveDolphinExecutable, stripPathQuotes } from './slippiDetect'

/**
 * Fields slippi-dolphin-runner 0.5.7 adds to a result (exit code, signal, the
 * last stderr lines, and an 'early-exit' diagnostic). Read defensively so this
 * builds and behaves on 0.5.6, which has none of them.
 */
type RunExtras = {
  exitCode?: number | null
  signal?: string | null
  stderrTail?: string[]
}

export type TestVerdict = {
  ok: boolean
  /** One sentence for the bottom bar; '' when ok. */
  reason: string
  /** Last few stderr lines, frame spam excluded. */
  stderr: string[]
  /** What to do about it, when we recognise the error. */
  hint: string | null
}

/**
 * Did the Test Dolphin run actually play the replay? A Dolphin that never
 * reported a frame, quit on its own before the replay started ('early-exit'),
 * or exited with a nonzero code failed, even though play() resolved.
 */
export function judgeTestRun(
  res: PlayResult,
  framesSeen: number,
  dolphinPath = '',
  platform: string = process.platform,
): TestVerdict {
  const extra = res as PlayResult & RunExtras
  const diag = res.diagnostic as
    | (Omit<NonNullable<PlayResult['diagnostic']>, 'reason'> & {
        reason: string
      })
    | null
  const stderr = (
    (Array.isArray(extra.stderrTail) && extra.stderrTail.length
      ? extra.stderrTail
      : diag?.stderrTail) ?? []
  )
    .filter((l: string) => typeof l === 'string' && l.trim())
    .slice(-6)
  const exitCode = typeof extra.exitCode === 'number' ? extra.exitCode : null
  const signal = typeof extra.signal === 'string' ? extra.signal : null
  const hint = dolphinErrorHint(stderr.join('\n'), dolphinPath, platform)
  const how =
    exitCode !== null && exitCode !== 0
      ? ` (exit code ${exitCode})`
      : signal && !res.stalled
        ? ` (${signal})`
        : ''

  if (diag?.reason === 'early-exit') {
    return {
      ok: false,
      reason: `Dolphin closed before the replay ${framesSeen > 0 ? 'finished' : 'started'}${how}.`,
      stderr,
      hint,
    }
  }
  if (framesSeen === 0 && !res.stoppedEarly) {
    if (diag?.reason === 'boot-stall' || diag?.hungOnBoot) {
      return {
        ok: false,
        reason: `Dolphin opened but never played the replay (nothing for ${Math.round(diag?.silentForSec ?? 0)} s).`,
        stderr,
        hint,
      }
    }
    return {
      ok: false,
      reason: `Dolphin never played the replay${how}.`,
      stderr,
      hint,
    }
  }
  if (exitCode !== null && exitCode !== 0) {
    return {
      ok: false,
      reason: `Dolphin exited with an error${how}.`,
      stderr,
      hint,
    }
  }
  if (res.stalled && diag?.reason !== 'hard-timeout') {
    return {
      ok: false,
      reason: `Dolphin stopped responding (${diag?.reason ?? 'stall'}).`,
      stderr,
      hint,
    }
  }
  return { ok: true, reason: '', stderr, hint: null }
}

/** A quoted path for a shell command. */
const quoted = (p: string) => `"${p.replace(/"/g, '\\"')}"`

/**
 * A fix for the errors people actually hit starting Slippi Dolphin, from its
 * stderr / the spawn error text, or null when we don't recognise it.
 */
export function dolphinErrorHint(
  text: string,
  dolphinPath = '',
  platform: string = process.platform,
): string | null {
  if (!text) return null
  if (/fuse|libfuse/i.test(text)) {
    return 'This AppImage needs FUSE to run: install libfuse2 (sudo apt install libfuse2, or libfuse2t64 on Ubuntu 24.04 and later), or extract it with --appimage-extract and choose squashfs-root/AppRun instead.'
  }
  if (/EACCES|permission denied/i.test(text)) {
    return platform === 'win32'
      ? 'Windows would not let Clipper run this file. Check that your antivirus is not blocking it, and that it is not in a protected folder.'
      : `Clipper is not allowed to run this file. Make it executable: chmod +x ${quoted(dolphinPath || '<path to Dolphin>')}`
  }
  if (
    /cannot open display|could not connect to display|no display|\$?DISPLAY\b.*(not set|empty)|xcb.*(connect|plugin)/i.test(
      text,
    )
  ) {
    return 'Dolphin could not open a window (no display). Run Clipper from your desktop session, not over SSH or as a service.'
  }
  const lib = /error while loading shared libraries: ([^:\s]+)/i.exec(text)
  if (lib) {
    return `A library Dolphin needs is missing (${lib[1]}). Install it with your package manager.`
  }
  if (/ENOENT/.test(text)) {
    return 'The file could not be started. Check the Dolphin path in Settings › Paths.'
  }
  return null
}

export type DolphinPathCheck = {
  valid: boolean
  message: string
  /** Set when the path was cleaned up (quotes stripped): save this instead. */
  path?: string
  /** Valid, but worth a look (e.g. a Playback exe outside a "playback" folder). */
  warning?: string
}

/**
 * Is this the Playback build of Slippi Dolphin? Strips pasted quotes, accepts a
 * macOS .app (checks the binary inside), and on Linux/macOS runs `-h` and
 * explains the usual failures (FUSE, permissions, no display).
 */
export async function checkDolphinPath(
  raw: string,
  platform: string = os.platform(),
): Promise<DolphinPathCheck> {
  const cleaned = stripPathQuotes(raw)
  const changed = cleaned !== raw ? { path: cleaned } : {}
  if (!cleaned) return { valid: false, message: 'No path provided.' }

  try {
    await fsPromises.access(cleaned)
  } catch {
    return {
      valid: false,
      message: 'File does not exist at this path.',
      ...changed,
    }
  }

  // On Windows, spawning `dolphin -h` opens a blocking GUI dialog, so judge by
  // the path. Both Slippi builds are "Slippi Dolphin.exe" and no file tells
  // them apart, so a folder other than "playback" is a warning, not a refusal
  // (portable installs and moved folders are real).
  if (platform === 'win32') {
    const lower = cleaned.toLowerCase().replace(/\\/g, '/')
    const isExe = lower.endsWith('.exe')
    if (!isExe) {
      return {
        valid: false,
        message: 'Choose the Dolphin program itself (Slippi Dolphin.exe).',
        ...changed,
      }
    }
    if (lower.includes('/playback/')) {
      return {
        valid: true,
        message: 'Slippi Dolphin Playback detected.',
        ...changed,
      }
    }
    if (/\/(netplay|slippi dolphin online)\//.test(lower)) {
      return {
        valid: false,
        message:
          'This appears to be Slippi Dolphin Online/Netplay, not the Playback build. The Playback build is in a "playback" folder.',
        ...changed,
      }
    }
    return {
      valid: true,
      message: 'Using this Dolphin.',
      warning:
        'Could not confirm this is the Playback build (it is not in a "playback" folder). If clips fail to play, choose the Playback Dolphin from the Slippi Launcher instead.',
      ...changed,
    }
  }

  // macOS: a .app is a folder; check (and later run) the binary inside.
  const exe = resolveDolphinExecutable(cleaned)
  if (
    platform === 'darwin' &&
    /\.app[\\/]*$/i.test(cleaned) &&
    exe === cleaned
  ) {
    return {
      valid: false,
      message: 'Could not find the Dolphin program inside this app.',
      ...changed,
    }
  }

  // On Linux/macOS, spawn dolphin -h and check for playback-specific flags
  let output = ''
  try {
    output = await new Promise<string>((resolve, reject) => {
      const proc = spawn(exe, ['-h'], { timeout: 10000 })
      let out = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      proc.on('close', () => resolve(out))
      proc.on('error', (err) => reject(err))
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const hint = dolphinErrorHint(
      `${e?.code ?? ''} ${e?.message ?? ''}`,
      exe,
      platform,
    )
    return {
      valid: false,
      message: hint
        ? `Could not run this file. ${hint}`
        : 'Could not run this file. Make sure it is an executable Dolphin binary.',
      ...changed,
    }
  }

  if (output.includes('--hide-seekbar')) {
    return {
      valid: true,
      message: 'Slippi Dolphin Playback detected.',
      ...changed,
    }
  }

  const hint = dolphinErrorHint(output, exe, platform)
  if (hint) {
    return {
      valid: false,
      message: `Dolphin could not start. ${hint}`,
      ...changed,
    }
  }

  // Has Slippi flags but not playback-specific ones -- likely the netplay build
  if (output.includes('slippi') || output.includes('Slippi')) {
    return {
      valid: false,
      message:
        'This appears to be Slippi Dolphin Online/Netplay, not the Playback build. Lunar Clipper requires the Playback build.',
      ...changed,
    }
  }

  return {
    valid: false,
    message:
      'This does not appear to be Slippi Dolphin Playback. Make sure you select the Playback build, not regular Dolphin.',
    ...changed,
  }
}
