/**
 * The .slpz replay format, in process (no external binary): a Slippi replay
 * whose event stream is reordered into byte columns and zstd-compressed, about
 * 9x smaller than the .slp. Port of the `slpz` crate (v1.3.0, the tool Clipper
 * bundles and the database compresses with); the two produce the same bytes.
 *
 *   0..4    version (0)
 *   4..8    offset of the payload sizes event   (copied from the .slp)
 *   8..12   offset of the Game Start event      (copied)
 *   12..16  offset of the metadata (UBJSON)     (copied)
 *   16..20  offset of the compressed events
 *   20..24  size of the events once decompressed (before un-reordering)
 *
 * Everything a header read needs (payload sizes, Game Start, metadata) is
 * stored uncompressed, so those reads never decompress (slpzSlpPrefix,
 * slpzMetadata). zstd comes from Node's zlib (Node 22.15+; Electron 35 has
 * 22.16), so this works the same on Windows, macOS and Linux and inside worker
 * threads. Pure functions, plus readReplayBytes for a file on disk.
 *
 * Clipper keeps downloaded replays as .slpz in its library (setting
 * keepDownloadsCompressed) and reads them through here; Dolphin still needs a
 * real .slp, which main/slpCache.ts decodes into a managed temp folder.
 */
import fs from 'fs'
import zlib from 'zlib'
import { isReplayPath } from './replayPath'

const EVENT_PAYLOADS = 0x35
const GAME_START = 0x36
/** "{U\x03raw[$U#l": a .slp's first 11 bytes; the raw stream's length follows. */
export const SLP_RAW_HEADER = Buffer.from([
  0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c,
])
export const SLPZ_VERSION = 0
/** Bytes before the payload sizes event in a .slpz. */
export const SLPZ_HEADER_BYTES = 24

export class SlpzError extends Error {}

/** Whether a path names a .slpz (by its extension, any case). */
export function isSlpzPath(p: string): boolean {
  return /\.slpz$/i.test(p)
}

/** Whether a path names a replay Clipper reads (.slp or .slpz). */
export { isReplayPath }

/** Whether bytes start like a .slp (rather than a .slpz). */
export function looksLikeSlp(buf: Uint8Array): boolean {
  if (buf.length < SLP_RAW_HEADER.length) return false
  for (let i = 0; i < SLP_RAW_HEADER.length; i++)
    if (buf[i] !== SLP_RAW_HEADER[i]) return false
  return true
}

const zstd = zlib as unknown as {
  zstdDecompressSync?: (_b: Uint8Array, _o?: object) => Buffer
  zstdCompressSync?: (_b: Uint8Array, _o?: object) => Buffer
  constants: Record<string, number>
}

/** Whether this runtime can read .slpz in process (Node 22.15+ zstd). */
export function slpzSupported(): boolean {
  return (
    typeof zstd.zstdDecompressSync === 'function' &&
    typeof zstd.zstdCompressSync === 'function'
  )
}

/** Most the events block of a .slpz may inflate to. A real replay is a few MB
 *  (a runaway one up to 1.7 GB is already refused elsewhere); this stops a crafted
 *  stream that claims little and expands without end (launch review SEC-3). */
export const SLPZ_MAX_EVENTS_BYTES = 512 * 1024 * 1024

type SlpzLayout = {
  eventSizesOffset: number
  gameStartOffset: number
  metadataOffset: number
  compressedOffset: number
  eventsSize: number
}

/** The header's offsets, checked against the buffer (`total` = the whole file's size). */
export function slpzLayout(buf: Uint8Array, total = buf.length): SlpzLayout {
  if (buf.length < SLPZ_HEADER_BYTES)
    throw new SlpzError('Not a .slpz replay (too short).')
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  const version = view.readUInt32BE(0)
  const layout = {
    eventSizesOffset: view.readUInt32BE(4),
    gameStartOffset: view.readUInt32BE(8),
    metadataOffset: view.readUInt32BE(12),
    compressedOffset: view.readUInt32BE(16),
    eventsSize: view.readUInt32BE(20),
  }
  if (
    version > SLPZ_VERSION ||
    layout.eventSizesOffset !== SLPZ_HEADER_BYTES ||
    layout.gameStartOffset <= layout.eventSizesOffset ||
    layout.metadataOffset < layout.gameStartOffset ||
    layout.compressedOffset < layout.metadataOffset ||
    layout.compressedOffset > total ||
    (view.length > layout.eventSizesOffset &&
      view[layout.eventSizesOffset] !== EVENT_PAYLOADS)
  )
    throw new SlpzError('Not a .slpz replay.')
  return layout
}

/** Whether bytes start like a .slpz (its header's offsets make sense). */
export function looksLikeSlpz(buf: Uint8Array, total = buf.length): boolean {
  try {
    slpzLayout(buf, total)
    return true
  } catch {
    return false
  }
}

/** Payload size per command byte, from a payload sizes event (at `at`). */
function eventSizes(buf: Uint8Array, at: number, end: number): Uint16Array {
  if (at + 2 > end || buf[at] !== EVENT_PAYLOADS)
    throw new SlpzError('The replay has no payload sizes.')
  const infoSize = buf[at + 1]
  if (at + 1 + infoSize > end)
    throw new SlpzError('The replay has no payload sizes.')
  const sizes = new Uint16Array(256)
  const count = Math.floor((infoSize - 1) / 3)
  for (let i = 0; i < count; i++) {
    const o = at + 2 + i * 3
    sizes[buf[o]] = (buf[o + 1] << 8) | buf[o + 2]
  }
  return sizes
}

/**
 * The first bytes of the .slp this .slpz decodes to: raw header (length 0),
 * payload sizes and Game Start. Enough for header reads (lib/cpuPlayers.ts)
 * without decompressing. `buf` must reach the Game Start's end.
 */
export function slpzSlpPrefix(buf: Uint8Array, total?: number): Buffer {
  const l = slpzLayout(buf, total ?? buf.length)
  if (buf.length < l.metadataOffset)
    throw new SlpzError('Not enough of the .slpz was read.')
  return Buffer.concat([
    SLP_RAW_HEADER,
    Buffer.alloc(4),
    Buffer.from(buf.buffer, buf.byteOffset + l.eventSizesOffset).subarray(
      0,
      l.metadataOffset - l.eventSizesOffset,
    ),
  ])
}

/** The .slpz's metadata block (UBJSON, the .slp's footer), stored uncompressed. */
export function slpzMetadata(buf: Uint8Array): Buffer {
  const l = slpzLayout(buf)
  return Buffer.from(
    buf.buffer,
    buf.byteOffset + l.metadataOffset,
    l.compressedOffset - l.metadataOffset,
  )
}

/**
 * A small .slp with this .slpz's payload sizes, Game Start and metadata but no
 * frames: slippi-js reads the same settings and metadata from it as from the
 * whole replay (checked on production games), in a tenth of a millisecond
 * instead of a full decode. For import's header read (models/File.ts).
 */
export function slpzHeaderSlp(buf: Uint8Array): Buffer {
  const prefix = slpzSlpPrefix(buf)
  prefix.writeUInt32BE(prefix.length - 15, 11)
  return Buffer.concat([prefix, slpzMetadata(buf)])
}

/** The first bytes of a .slpz that hold everything but the compressed events. */
export function readSlpzHead(file: string): Buffer {
  const fd = fs.openSync(file, 'r')
  try {
    const { size } = fs.fstatSync(fd)
    const head = Buffer.alloc(SLPZ_HEADER_BYTES)
    fs.readSync(fd, head, 0, SLPZ_HEADER_BYTES, 0)
    // A .slp under a .slpz name: the caller reads it whole (looksLikeSlp).
    if (looksLikeSlp(head)) return head
    const { compressedOffset } = slpzLayout(head, size)
    const out = Buffer.alloc(compressedOffset)
    const n = fs.readSync(fd, out, 0, compressedOffset, 0)
    if (n !== compressedOffset) throw new SlpzError('The .slpz is cut off.')
    return out
  } finally {
    fs.closeSync(fd)
  }
}

/** Decode a .slpz to the .slp it was made from. Throws SlpzError when it isn't one. */
export function decodeSlpz(input: Uint8Array): Buffer {
  if (!zstd.zstdDecompressSync)
    throw new SlpzError('This version of Clipper cannot read .slpz replays.')
  const slpz = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const l = slpzLayout(slpz)
  const sizes = eventSizes(slpz, l.eventSizesOffset, l.gameStartOffset)
  let b: Buffer
  try {
    if (l.eventsSize > SLPZ_MAX_EVENTS_BYTES)
      throw new SlpzError('The .slpz replay is too large to open.')
    b = zstd.zstdDecompressSync(slpz.subarray(l.compressedOffset), {
      maxOutputLength: l.eventsSize,
    })
  } catch (error) {
    if (error instanceof SlpzError) throw error
    throw new SlpzError(
      `The .slpz replay could not be decompressed: ${(error as Error).message}`,
    )
  }
  if (b.length !== l.eventsSize || b.length < 4)
    throw new SlpzError('The .slpz replay is damaged (wrong events size).')

  const totalEvents = b.readUInt32BE(0)
  const orderAt = 4
  const dataAt = orderAt + totalEvents
  if (dataAt > b.length)
    throw new SlpzError('The .slpz replay is damaged (event count).')
  const counts = new Uint32Array(256)
  for (let i = orderAt; i < dataAt; i++) counts[b[i]]++
  // Where each command's column block starts in the reordered data.
  const offsets = new Float64Array(256)
  let size = 0
  for (let c = 0; c < 256; c++) {
    offsets[c] = size
    size += sizes[c] * counts[c]
  }
  if (size !== b.length - dataAt)
    throw new SlpzError('The .slpz replay is damaged (event sizes).')
  const eventsLen = size + totalEvents

  const head = l.metadataOffset - l.eventSizesOffset
  const meta = l.compressedOffset - l.metadataOffset
  const out = Buffer.allocUnsafe(15 + head + eventsLen + meta)
  SLP_RAW_HEADER.copy(out, 0)
  out.writeUInt32BE(head + eventsLen, 11)
  slpz.copy(out, 15, l.eventSizesOffset, l.metadataOffset)

  const written = new Uint32Array(256)
  let o = 15 + head
  for (let k = orderAt; k < dataAt; k++) {
    const c = b[k]
    out[o++] = c
    const n = sizes[c]
    const stride = counts[c]
    let src = dataAt + offsets[c] + written[c]
    for (let j = 0; j < n; j++) {
      out[o++] = b[src]
      src += stride
    }
    written[c]++
  }
  slpz.copy(out, o, l.metadataOffset, l.compressedOffset)
  return out
}

const FRAME_BOOKEND = 0x3c
const POST_FRAME_UPDATE = 0x38

/**
 * The frame number of the stream's last Frame Bookend (or, before replay 3.0,
 * its last Post-Frame Update), read from the reordered columns without
 * rebuilding the .slp: each command's payload byte j of its k-th event sits at
 * column offset + j * count + k. Null when there's neither.
 */
export function slpzLastEventFrame(input: Uint8Array): number | null {
  if (!zstd.zstdDecompressSync)
    throw new SlpzError('This version of Clipper cannot read .slpz replays.')
  const slpz = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const l = slpzLayout(slpz)
  const sizes = eventSizes(slpz, l.eventSizesOffset, l.gameStartOffset)
  if (l.eventsSize > SLPZ_MAX_EVENTS_BYTES)
    throw new SlpzError('The .slpz replay is too large to open.')
  const b = zstd.zstdDecompressSync(slpz.subarray(l.compressedOffset), {
    maxOutputLength: l.eventsSize,
  })
  if (b.length !== l.eventsSize || b.length < 4)
    throw new SlpzError('The .slpz replay is damaged (wrong events size).')
  const totalEvents = b.readUInt32BE(0)
  const dataAt = 4 + totalEvents
  if (dataAt > b.length)
    throw new SlpzError('The .slpz replay is damaged (event count).')
  const counts = new Uint32Array(256)
  for (let i = 4; i < dataAt; i++) counts[b[i]]++
  for (const c of [FRAME_BOOKEND, POST_FRAME_UPDATE]) {
    const n = counts[c]
    if (!n || sizes[c] < 4) continue
    let at = dataAt
    for (let k = 0; k < c; k++) at += sizes[k] * counts[k]
    const last = at + (n - 1)
    if (last + 3 * n >= b.length) return null
    return Buffer.from([
      b[last],
      b[last + n],
      b[last + 2 * n],
      b[last + 3 * n],
    ]).readInt32BE(0)
  }
  return null
}

/**
 * Encode a .slp as .slpz (zstd level 3, like the slpz tool's default). Throws
 * SlpzError for a file the format can't hold (cut off, unknown commands): the
 * caller keeps the .slp then.
 */
export function encodeSlpz(input: Uint8Array, level = 3): Buffer {
  if (!zstd.zstdCompressSync)
    throw new SlpzError('This version of Clipper cannot write .slpz replays.')
  const slp = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (slp.length < 16 || !looksLikeSlp(slp))
    throw new SlpzError('Not a .slp replay.')
  const rawLen = slp.readUInt32BE(11)
  const metaAt = 15 + rawLen
  if (rawLen === 0 || slp.length < metaAt)
    throw new SlpzError('The replay is cut off.')
  const sizes = eventSizes(slp, 15, metaAt)
  const sizesLen = 2 + Math.floor((slp[16] - 1) / 3) * 3
  const gameStartAt = 15 + sizesLen
  const gameStartLen = sizes[GAME_START] + 1
  if (slp[gameStartAt] !== GAME_START || gameStartAt + gameStartLen > metaAt)
    throw new SlpzError('The replay has no Game Start.')
  const eventsAt = gameStartAt + gameStartLen

  const counts = new Uint32Array(256)
  let total = 0
  for (let i = eventsAt; i < metaAt; ) {
    const c = slp[i]
    if (!sizes[c]) throw new SlpzError('The replay has an unknown event.')
    counts[c]++
    total++
    i += 1 + sizes[c]
    if (i > metaAt) throw new SlpzError('The replay is cut off.')
  }
  const offsets = new Float64Array(256)
  let size = 0
  for (let c = 0; c < 256; c++) {
    offsets[c] = size
    size += sizes[c] * counts[c]
  }
  const data = Buffer.alloc(4 + total + size)
  data.writeUInt32BE(total, 0)
  const dataAt = 4 + total
  const written = new Uint32Array(256)
  let k = 4
  for (let i = eventsAt; i < metaAt; ) {
    const c = slp[i]
    data[k++] = c
    const n = sizes[c]
    const stride = counts[c]
    let dst = dataAt + offsets[c] + written[c]
    for (let j = 0; j < n; j++) {
      data[dst] = slp[i + 1 + j]
      dst += stride
    }
    written[c]++
    i += 1 + n
  }
  const compressed = zstd.zstdCompressSync(data, {
    params: { [zstd.constants.ZSTD_c_compressionLevel]: level },
  })
  const header = Buffer.alloc(SLPZ_HEADER_BYTES)
  const head = slp.subarray(15, eventsAt)
  const meta = slp.subarray(metaAt)
  header.writeUInt32BE(SLPZ_VERSION, 0)
  header.writeUInt32BE(SLPZ_HEADER_BYTES, 4)
  header.writeUInt32BE(SLPZ_HEADER_BYTES + sizesLen, 8)
  header.writeUInt32BE(SLPZ_HEADER_BYTES + head.length, 12)
  header.writeUInt32BE(SLPZ_HEADER_BYTES + head.length + meta.length, 16)
  header.writeUInt32BE(data.length, 20)
  return Buffer.concat([header, head, meta, compressed])
}

/**
 * Encode, then decode again and compare: the .slpz only when it gives back
 * exactly these bytes (a replay with trailing bytes or a cut stream doesn't),
 * else null and the caller keeps the .slp.
 */
export function encodeSlpzVerified(slp: Uint8Array): Buffer | null {
  try {
    const slpz = encodeSlpz(slp)
    return decodeSlpz(slpz).equals(slp) ? slpz : null
  } catch {
    return null
  }
}

/** A replay's .slp bytes: read as is, or decoded when it's a .slpz. */
export function readReplayBytes(file: string): Buffer {
  const bytes = fs.readFileSync(file)
  if (isSlpzPath(file) && !looksLikeSlp(bytes)) return decodeSlpz(bytes)
  return bytes
}

/** readReplayBytes, without blocking the thread on the read. */
export async function readReplayBytesAsync(file: string): Promise<Buffer> {
  const bytes = await fs.promises.readFile(file)
  if (isSlpzPath(file) && !looksLikeSlp(bytes)) return decodeSlpz(bytes)
  return bytes
}
