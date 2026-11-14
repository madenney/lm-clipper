/**
 * CPU (computer) players in replays. Slippi's Game Start event gives each port
 * a player type: 0 human, 1 CPU, 2 demo, 3 empty. Clipper records `cpu` on each
 * player in the files table (models/File.ts at import, CpuScanWorker for games
 * imported before that) and the Game Filter leaves CPU games out unless
 * "Include CPU games" is on. Pure helpers: no disk, no SQLite.
 */

/** Slippi player type of a CPU. */
export const CPU_PLAYER_TYPE = 1

/** Bytes to read from the start of a .slp to see every port's player type. */
export const HEADER_BYTES = 1024

/** What the background check (main/CpuScanWorker.ts) has done so far. */
export type CpuScanCounts = {
  /** Games without CPU info when the check started. */
  total: number
  /** Games looked at so far (including the ones passed over). */
  checked: number
  /** Games found to have a CPU player. */
  cpuGames: number
  /** Replays not found (or out of reach): left for next time. */
  missing: number
  /** Replays that opened but couldn't be read: marked unknown. */
  unreadable: number
  /** Gave up early because the replays are out of reach. */
  unreachable?: boolean
}

/** The check's state for the open project, as the renderer shows it. */
export type CpuScanStatus = CpuScanCounts & {
  projectPath: string
  state: 'running' | 'paused' | 'stopped' | 'done' | 'failed'
}

type CpuPlayer = { playerIndex?: number; cpu?: boolean | null }

// "{U\x03raw[$U#l" then the raw stream's 4-byte length: the stream starts at 15.
const RAW_PREFIX = [
  0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c,
]
const EVENT_PAYLOADS = 0x35
const GAME_START = 0x36
// Player type of port i, from the Game Start command byte (Slippi spec).
const TYPE_OFFSET = 0x66
const PORT_STRIDE = 0x24

/**
 * Each port's player type (index = port 0-3) from the first bytes of a .slp,
 * or null when they aren't the start of a readable replay.
 */
export function playerTypesFromHeader(bytes: Uint8Array): number[] | null {
  if (bytes.length < 17) return null
  for (let i = 0; i < RAW_PREFIX.length; i += 1)
    if (bytes[i] !== RAW_PREFIX[i]) return null
  if (bytes[15] !== EVENT_PAYLOADS) return null
  const listSize = bytes[16]
  // The payload sizes list: (command, 2-byte size) after its own size byte.
  let gameStartSize = 0
  for (let i = 17; i + 2 < 16 + listSize && i + 2 < bytes.length; i += 3) {
    if (bytes[i] === GAME_START) {
      gameStartSize = (bytes[i + 1] << 8) | bytes[i + 2]
      break
    }
  }
  const gameStart = 16 + listSize
  const lastType = TYPE_OFFSET + PORT_STRIDE * 3
  if (
    bytes[gameStart] !== GAME_START ||
    gameStartSize < lastType ||
    gameStart + lastType >= bytes.length
  )
    return null
  return [0, 1, 2, 3].map(
    (port) => bytes[gameStart + TYPE_OFFSET + PORT_STRIDE * port],
  )
}

/** The players with `cpu` set from the ports' types; null types (unreadable
 *  replay) mark them null: unknown, treated as human. */
export function withCpu<T extends CpuPlayer>(
  players: T[],
  types: number[] | null,
): (T & { cpu: boolean | null })[] {
  return players.map((p) => ({
    ...p,
    cpu:
      types && Number.isInteger(p.playerIndex)
        ? types[p.playerIndex as number] === CPU_PLAYER_TYPE
        : null,
  }))
}

/** Whether a game has a CPU player. Players without `cpu` (not checked yet)
 *  or with null (unreadable) count as human. */
export function isCpuGame(players: CpuPlayer[] | null | undefined): boolean {
  return Array.isArray(players) && players.some((p) => p?.cpu === true)
}

/** Whether every player has been checked (`cpu` true, false or null). */
export function cpuChecked(players: CpuPlayer[] | null | undefined): boolean {
  return (
    Array.isArray(players) &&
    players.length > 0 &&
    players.every((p) => !!p && 'cpu' in p)
  )
}

/**
 * Whether a header the Replay Library remembered from an import knows about
 * CPU players. Older Clipper builds rejected CPU games ("Bot") and didn't
 * record `cpu`; such headers are parsed again.
 */
export function headerKnowsCpu(header: {
  isValid?: boolean
  info?: string
  players?: CpuPlayer[]
}): boolean {
  if (!header.isValid) return header.info !== 'Bot'
  return cpuChecked(header.players)
}
