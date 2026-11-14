/**
 * slippi-js's SlippiGame, able to open .slpz replays too (lib/slpz.ts). Every
 * replay read in Clipper (import, parsers, filters, custom code, recording's
 * game reads) goes through this class instead of '@slippi/slippi-js' directly,
 * so a library that keeps its downloads compressed reads like any other.
 *
 * A .slpz path is decoded in memory (about 5 ms a game) and parsed from the
 * buffer; a .slp path is passed through untouched (slippi-js reads it from
 * disk as before).
 */
import { SlippiGame as BaseSlippiGame } from '@slippi/slippi-js'
import {
  isSlpzPath,
  looksLikeSlp,
  readReplayBytes,
  readSlpzHead,
  slpzHeaderSlp,
} from './slpz'

type Input = ConstructorParameters<typeof BaseSlippiGame>[0]
type Options = ConstructorParameters<typeof BaseSlippiGame>[1]

/** What SlippiGame should be given for this input: a .slpz path becomes its .slp bytes. */
export function slippiInput(input: Input): Input {
  return typeof input === 'string' && isSlpzPath(input)
    ? readReplayBytes(input)
    : input
}

export class SlippiGame extends BaseSlippiGame {
  constructor(input: Input, opts?: Options) {
    super(slippiInput(input), opts)
  }
}

/**
 * A SlippiGame for header reads only (getSettings, getMetadata): for a .slpz
 * just its uncompressed head is read and nothing is decompressed. Frames are
 * not there: use SlippiGame for anything else.
 */
export function openReplayHeader(file: string): BaseSlippiGame {
  if (!isSlpzPath(file)) return new BaseSlippiGame(file)
  const head = readSlpzHead(file)
  // A .slp that was only named .slpz: read it whole.
  if (looksLikeSlp(head)) return new SlippiGame(file)
  return new BaseSlippiGame(slpzHeaderSlp(head))
}
