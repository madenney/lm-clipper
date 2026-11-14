/**
 * A game's last frame when its metadata doesn't say (anonymized ranked
 * replays have an empty metadata block, so `metadata.lastFrame` is missing and
 * import used to store GAME_START_FRAME, -123: no duration anywhere).
 *
 * The cheap way: the raw stream ends with the last frame's bookend (or its
 * post-frame updates, before replay 3.0) and usually a Game End, all fixed
 * sizes (from the stream's own payload sizes list), so a few bytes from the
 * end of the file say the last frame and no frame is parsed. Anonymized ranked
 * replays often have no Game End; that's handled. A replay whose end isn't
 * laid out like that (a crash or a cut copy) falls back to walking the stream
 * for the highest frame number.
 *
 * Used at import (models/File.ts) and by the background repair for older games
 * (main/LastFrameScanWorker.ts). No SQLite here.
 */
import fs from 'fs'
import {
  Command,
  closeSlpFile,
  iterateEvents,
  openSlpFile,
  SlpInputSource,
  type SlpFileType,
} from '@slippi/slippi-js'
import { FRAME_MAX, GAME_START_FRAME } from '../constants/frames'
import {
  decodeSlpz,
  isSlpzPath,
  looksLikeSlp,
  slpzLastEventFrame,
} from './slpz'

/** What import stores when it couldn't tell (older builds): the start frame. */
export const UNKNOWN_LAST_FRAME = GAME_START_FRAME

/** What the repair stores for a replay that opened but has no frames to
 *  read: known to be unknowable, so it isn't read again. */
export const UNREADABLE_LAST_FRAME = 0

/** What the background repair (main/LastFrameScanWorker.ts) has done so far. */
export type LastFrameScanCounts = {
  /** Games with no length when the check started. */
  total: number
  /** Games looked at so far (including the ones passed over). */
  checked: number
  /** Games that got their length. */
  repaired: number
  /** Replays not found (or out of reach): left for next time. */
  missing: number
  /** Replays that opened but had no frames to read: marked 0. */
  unreadable: number
  /** Results rows given the new lengths. */
  resultsRows: number
  /** Gave up early because the replays are out of reach. */
  unreachable?: boolean
}

/** The repair's state for the open project, as the renderer shows it. */
export type LastFrameScanStatus = LastFrameScanCounts & {
  projectPath: string
  state: 'running' | 'paused' | 'stopped' | 'done' | 'failed'
}

/** A frame number that can be a game's last frame. */
function plausible(frame: unknown): frame is number {
  return (
    typeof frame === 'number' &&
    Number.isInteger(frame) &&
    frame > GAME_START_FRAME &&
    frame < FRAME_MAX * 100
  )
}

/** Whether a stored lastFrame is a real duration (not -123, 0 or null). */
export function hasLastFrame(lastFrame: number | null | undefined): boolean {
  return typeof lastFrame === 'number' && lastFrame > 0
}

/** The frame a whole-game recording ends on: the game's last frame, or "the
 *  end, whenever that is" when it isn't known. -123 is truthy, so a plain
 *  `lastFrame || FRAME_MAX` ended those recordings before they started. */
export function gameEndFrame(lastFrame: number | null | undefined): number {
  return hasLastFrame(lastFrame) ? (lastFrame as number) : FRAME_MAX
}

/** Whether a header the replay library kept can be reused as is: older
 *  builds stored anonymized games with no length (-123); those are read again. */
export function headerKnowsLastFrame(header: {
  isValid?: boolean
  lastFrame?: number | null
}): boolean {
  return !header.isValid || header.lastFrame !== UNKNOWN_LAST_FRAME
}

/** The last `length` bytes of the raw stream. */
function rawTail(file: SlpFileType, length: number): Buffer {
  const end = file.rawDataPosition + file.rawDataLength
  const start = Math.max(file.rawDataPosition, end - length)
  const ref = file.ref as {
    buffer?: Buffer
    fileDescriptor?: number
  }
  if (ref.buffer) return ref.buffer.subarray(start, end)
  const out = Buffer.alloc(end - start)
  const read = fs.readSync(
    ref.fileDescriptor as number,
    out,
    0,
    out.length,
    start,
  )
  return out.subarray(0, read)
}

/**
 * The frame of the last event in the stream, read from its end: an optional
 * Game End (anonymized ranked replays end without one), then the last
 * frame's bookend (replays from 3.0) or post-frame update. Null when the end
 * isn't laid out like that (a cut replay): the caller walks the stream.
 */
function fromTail(file: SlpFileType): number | null {
  const size = (command: number) => {
    const payload = file.messageSizes[command]
    return payload && payload > 0 ? payload + 1 : 0
  }
  const gameEnd = size(Command.GAME_END)
  const bookend = size(Command.FRAME_BOOKEND)
  const post = size(Command.POST_FRAME_UPDATE)
  const tail = rawTail(file, gameEnd + Math.max(bookend, post))
  // Where the last frame's events end: before a Game End, or at the end.
  const ends: number[] = []
  if (
    gameEnd &&
    tail.length >= gameEnd &&
    tail[tail.length - gameEnd] === Command.GAME_END
  )
    ends.push(tail.length - gameEnd)
  ends.push(tail.length)
  for (const end of ends) {
    // Frame bookend: command, frame, latest finalized frame (int32s).
    if (
      bookend >= 9 &&
      end >= bookend &&
      tail[end - bookend] === Command.FRAME_BOOKEND
    ) {
      const frame = tail.readInt32BE(end - bookend + 1)
      const finalized = tail.readInt32BE(end - bookend + 5)
      if (plausible(frame) && finalized <= frame) return frame
    }
    // Post-frame update: command, frame (int32), then the player's state.
    if (
      post >= 5 &&
      end >= post &&
      tail[end - post] === Command.POST_FRAME_UPDATE
    ) {
      const frame = tail.readInt32BE(end - post + 1)
      if (plausible(frame)) return frame
    }
  }
  return null
}

function fromStream(file: SlpFileType): number | null {
  let last: number | null = null
  iterateEvents(file, (command, payload) => {
    if (
      command === Command.FRAME_BOOKEND ||
      command === Command.POST_FRAME_UPDATE
    ) {
      const frame = (payload as { frame?: number | null } | null)?.frame
      if (plausible(frame) && (last === null || frame > last)) last = frame
    }
    return false
  })
  return last
}

/**
 * The last frame of a .slp or .slpz (a path, or .slp bytes), or null when it has no
 * frames to read. Throws when the file can't be opened at all.
 */
export function readLastFrame(input: string | Buffer): number | null {
  // A .slpz: its last frame straight from the compressed columns (no .slp
  // rebuilt, lib/slpz.ts), else decoded in memory and read like a .slp.
  let source: string | Buffer = input
  if (typeof input === 'string' && isSlpzPath(input)) {
    const bytes = fs.readFileSync(input)
    if (!looksLikeSlp(bytes)) {
      try {
        const frame = slpzLastEventFrame(bytes)
        if (plausible(frame)) return frame
      } catch {
        /* read it the long way */
      }
      source = decodeSlpz(bytes)
    } else source = bytes
  }
  const file = openSlpFile(
    typeof source === 'string'
      ? { source: SlpInputSource.FILE, filePath: source }
      : { source: SlpInputSource.BUFFER, buffer: source },
  )
  try {
    return fromTail(file) ?? fromStream(file)
  } finally {
    closeSlpFile(file)
  }
}
