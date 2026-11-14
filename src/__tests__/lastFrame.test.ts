/**
 * @jest-environment node
 *
 * Games whose metadata was stripped (anonymized ranked replays) still get a
 * length: read from the end of the raw stream at import, with a walk of the
 * stream when the replay has no Game End; whole-game recordings of games
 * without a known length run to the end instead of ending at -123.
 */
import fs from 'fs'
import path from 'path'
import { SlippiGame } from '@slippi/slippi-js'
import {
  gameEndFrame,
  hasLastFrame,
  headerKnowsLastFrame,
  readLastFrame,
  UNKNOWN_LAST_FRAME,
} from '../lib/lastFrame'
import { fileProcessor } from '../models/File'
import { FRAME_MAX } from '../constants/frames'

// The test replay is an anonymized ranked game: its metadata block is empty.
const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
const FULL_PARSE_LAST_FRAME = 6805

/** The replay cut part-way through its raw stream, with the raw length left
 *  0 as Slippi leaves it while a game is still being written (or crashed). */
function cutReplay(fraction: number): Buffer {
  const whole = fs.readFileSync(REPLAY)
  const rawLength = whole.readUInt32BE(11)
  const cut = Buffer.from(
    whole.subarray(0, 15 + Math.floor(rawLength * fraction)),
  )
  cut.writeUInt32BE(0, 11)
  return cut
}

/** The same bytes with the stream broken right after Game Start, so a walk of
 *  the stream finds no frames: only the read from the end can get it right. */
function unwalkable(replay: Buffer): Buffer {
  const b = Buffer.from(replay)
  const payloadsEnd = 15 + 1 + b[16]
  // Game Start's payload size, from the payload sizes list.
  let gameStartSize = 0
  for (let i = 17; i < payloadsEnd; i += 3)
    if (b[i] === 0x36) gameStartSize = b.readUInt16BE(i + 1)
  expect(b[payloadsEnd]).toBe(0x36)
  b[payloadsEnd + 1 + gameStartSize] = 0x00
  expect(new SlippiGame(b).getLatestFrame()).toBeNull()
  return b
}

describe('readLastFrame', () => {
  it('has no metadata to go on in the fixture', () => {
    expect(new SlippiGame(REPLAY).getMetadata()).toEqual({})
  })

  it('reads the last frame from the end of the replay', () => {
    expect(readLastFrame(REPLAY)).toBe(FULL_PARSE_LAST_FRAME)
    expect(readLastFrame(fs.readFileSync(REPLAY))).toBe(FULL_PARSE_LAST_FRAME)
    // Without parsing frames.
    expect(readLastFrame(unwalkable(fs.readFileSync(REPLAY)))).toBe(
      FULL_PARSE_LAST_FRAME,
    )
  })

  it('matches a full parse', () => {
    expect(new SlippiGame(REPLAY).getLatestFrame()?.frame).toBe(
      FULL_PARSE_LAST_FRAME,
    )
  })

  it('reads the end of a finished replay with no Game End (ranked)', () => {
    // Many anonymized ranked replays end on the last frame's bookend.
    const whole = fs.readFileSync(REPLAY)
    const rawLength = whole.readUInt32BE(11)
    const rawEnd = 15 + rawLength
    const GAME_END_SIZE = 7 // 0x39 + its payload in this replay
    expect(whole[rawEnd - GAME_END_SIZE]).toBe(0x39)
    const noEnd = Buffer.concat([
      whole.subarray(0, rawEnd - GAME_END_SIZE),
      whole.subarray(rawEnd),
    ])
    noEnd.writeUInt32BE(rawLength - GAME_END_SIZE, 11)
    expect(new SlippiGame(noEnd).getGameEnd()).toBeNull()
    expect(readLastFrame(noEnd)).toBe(FULL_PARSE_LAST_FRAME)
    expect(readLastFrame(unwalkable(noEnd))).toBe(FULL_PARSE_LAST_FRAME)
  })

  it('walks the stream when the replay was cut short', () => {
    const cut = cutReplay(0.6)
    const expected = new SlippiGame(cut).getLatestFrame()?.frame
    expect(typeof expected).toBe('number')
    const got = readLastFrame(cut)
    // A partly written last frame may count or not; never more than one off.
    expect(got).not.toBeNull()
    expect(
      Math.abs((got as number) - (expected as number)),
    ).toBeLessThanOrEqual(1)
    expect(got as number).toBeLessThan(FULL_PARSE_LAST_FRAME)
  })

  it('says null for a replay with no frames', () => {
    expect(readLastFrame(cutReplay(0.001))).toBeNull()
  })

  it('throws for a file that is not there', () => {
    expect(() => readLastFrame('/nonexistent/replay.slp')).toThrow()
  })
})

describe('import of an anonymized replay', () => {
  it('stores the real last frame instead of -123', () => {
    const file = fileProcessor(REPLAY)
    expect(file.isValid).toBe(true)
    expect(file.info).toBe('Metadata removed')
    expect(file.lastFrame).toBe(FULL_PARSE_LAST_FRAME)
  })
})

describe('helpers', () => {
  it('knows a real length from the sentinels', () => {
    expect(hasLastFrame(6805)).toBe(true)
    expect(hasLastFrame(UNKNOWN_LAST_FRAME)).toBe(false)
    expect(hasLastFrame(0)).toBe(false)
    expect(hasLastFrame(null)).toBe(false)
    expect(hasLastFrame(undefined)).toBe(false)
  })

  it('ends a whole-game recording at the end when the length is unknown', () => {
    expect(gameEndFrame(6805)).toBe(6805)
    // -123 is truthy: `lastFrame || FRAME_MAX` used to end here.
    expect(gameEndFrame(UNKNOWN_LAST_FRAME)).toBe(FRAME_MAX)
    expect(gameEndFrame(0)).toBe(FRAME_MAX)
    expect(gameEndFrame(undefined)).toBe(FRAME_MAX)
  })

  it('reads library headers without a length again', () => {
    expect(headerKnowsLastFrame({ isValid: true, lastFrame: 6805 })).toBe(true)
    expect(
      headerKnowsLastFrame({ isValid: true, lastFrame: UNKNOWN_LAST_FRAME }),
    ).toBe(false)
    expect(
      headerKnowsLastFrame({ isValid: false, lastFrame: UNKNOWN_LAST_FRAME }),
    ).toBe(true)
  })
})
