import http, { IncomingMessage } from 'http'
import https from 'https'
import fs, { promises as fsp } from 'fs'
import { pipeline } from 'stream/promises'
import { Transform, pipeline as streamPipeline } from 'stream'
import path from 'path'
import zlib from 'zlib'
import { requireDiskSpace } from './replayExtraction'
import { retryFs } from './fsRetry'
import { clientHeaders, userAgentHeaders } from './clientIdentity'

// Our Cloudflare R2 account endpoint (bundle storage since 2026-09-28). The
// database presigns path-style, so only this exact host, not every R2 bucket.
// Backblaze stays until the old bucket is retired. Mirrors the website's
// ALLOWED_REDIRECT_HOSTS (apps/website/src/utils/downloadActions/shared.ts).
const R2_HOST = 'c5d885cd0ec052db32b77769107a0b67.r2.cloudflarestorage.com'

export function storageUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      (url.hostname === 'dl.lunarmelee.com' ||
        url.hostname === R2_HOST ||
        url.hostname === 's3.us-east-005.backblazeb2.com' ||
        url.hostname.endsWith('.s3.us-east-005.backblazeb2.com'))
    )
  } catch {
    return false
  }
}

function openResponse(
  url: URL,
  options: {
    method?: string
    headers?: Record<string, string>
    signal?: AbortSignal
    body?: string
    /** Also send the per-install id (calls to Lunar's website only, never storage). */
    identify?: boolean
  },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    // Every call says who it is (User-Agent, app version): Node sets no
    // User-Agent itself, which Cloudflare's bot rules treat with suspicion.
    const identity = options.identify ? clientHeaders() : userAgentHeaders()
    const request = client.request(
      url,
      {
        method: options.method || 'GET',
        headers: { ...identity, ...options.headers },
        signal: options.signal,
      },
      resolve,
    )
    request.setTimeout(60000, () =>
      request.destroy(new Error('Connection timed out. Please retry.')),
    )
    request.on('error', reject)
    request.end(options.body)
  })
}

/** A failed website/database request. `code` is the API error code, if any. */
export class DatabaseRequestError extends Error {
  readonly status: number

  readonly code?: string

  readonly retryAfterSeconds?: number

  /** Maintenance only: when it started (ISO). */
  readonly since?: string

  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfterSeconds?: number,
    since?: string,
  ) {
    super(message)
    this.name = 'DatabaseRequestError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
    this.since = since
  }
}

export class DatabaseClient {
  constructor(private origin: string) {
    const url = new URL(origin)
    if (
      !['https://lunarmelee.com', 'https://www.lunarmelee.com'].includes(
        url.origin,
      ) &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      )
    )
      throw new Error('Invalid Lunar Database origin.')
  }

  async json<T>(
    route: string,
    body?: unknown,
    token?: string,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    const response = await openResponse(new URL(route, this.origin), {
      method: encoded === undefined ? 'GET' : 'POST',
      signal,
      body: encoded,
      identify: true,
      headers: {
        ...extraHeaders,
        Accept: 'application/json',
        ...(encoded
          ? {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(encoded)),
            }
          : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response) {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        response.destroy()
        throw new Error('Database response was too large.')
      }
      chunks.push(Buffer.from(chunk))
    }
    const status = response.statusCode || 0
    const retryHeader = parseRetryAfter(response.headers['retry-after'])
    let data: T & {
      error?: string
      code?: string
      retryAfterSeconds?: number
      message?: string
      since?: string
    }
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new DatabaseRequestError(
        status === 404
          ? 'This website does not have desktop integration enabled yet.'
          : status === 426
            ? 'Update Lunar Clipper to keep using the Lunar Database.'
            : 'The Lunar database is out of reach for a moment. Please try again in a few minutes.',
        status,
        status === 426 ? 'client_outdated' : undefined,
        retryHeader,
      )
    }
    if (status < 200 || status >= 300)
      throw new DatabaseRequestError(
        // Maintenance carries the owner's announcement in `message`.
        (data.code === 'maintenance' && typeof data.message === 'string'
          ? data.message
          : data.error) || `Database request failed (${status}).`,
        status,
        typeof data.code === 'string' ? data.code : undefined,
        typeof data.retryAfterSeconds === 'number'
          ? data.retryAfterSeconds
          : retryHeader,
        typeof data.since === 'string' ? data.since : undefined,
      )
    return data
  }

  /**
   * One replay's .slp (the website's replay route: storage or Cloudflare's cache,
   * not the bundle queue), gzip undone. Throws DatabaseRequestError on an error
   * status, with the server's code and Retry-After.
   */
  /** One replay's .slp. `storedOnly`: from storage or not at all (the website
   *  answers 404 for a game in no zip, 503 storage_busy for a hiccup), never the
   *  Lunar server at home: Find replays' and Find clips' downloads. */
  async replay(
    replayId: string,
    signal?: AbortSignal,
    opts: { storedOnly?: boolean } = {},
  ): Promise<Buffer> {
    if (!/^[a-f0-9]{24}$/.test(replayId)) throw new Error('Invalid replay id.')
    const response = await openResponse(
      new URL(
        `/api/download?action=replay&replayId=${replayId}${opts.storedOnly ? '&storedOnly=1' : ''}`,
        this.origin,
      ),
      { headers: { 'Accept-Encoding': 'gzip' }, signal, identify: true },
    )
    const status = response.statusCode || 0
    // Not response.pipe(): pipe() doesn't pass a failure on, so a connection
    // cut mid-body left the gunzip (and the download) waiting forever. Seen on
    // the Windows rig, 2026-10-15: a 60 s network drop froze a 120-game
    // download at 119 for 20+ minutes.
    const body =
      response.headers['content-encoding'] === 'gzip'
        ? streamPipeline(response, zlib.createGunzip(), () => {})
        : response
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of body) {
      size += chunk.length
      if (size > MAX_REPLAY_BYTES) {
        response.destroy()
        throw new ReplayTooLargeError()
      }
      chunks.push(Buffer.from(chunk))
    }
    const bytes = Buffer.concat(chunks)
    if (status >= 200 && status < 300) return bytes
    let data: { error?: string; code?: string; retryAfterSeconds?: number } = {}
    try {
      data = JSON.parse(bytes.toString('utf8'))
    } catch {
      /* not JSON */
    }
    const retryHeader = parseRetryAfter(response.headers['retry-after'])
    throw new DatabaseRequestError(
      data.error || `Replay download failed (${status}).`,
      status,
      typeof data.code === 'string'
        ? data.code
        : status === 426
          ? 'client_outdated'
          : undefined,
      typeof data.retryAfterSeconds === 'number'
        ? data.retryAfterSeconds
        : retryHeader,
    )
  }
}

/** A replay over 64 MB is a runaway recording (one is 1.66 GB): not fetched one by one. */
const MAX_REPLAY_BYTES = 64 * 1024 * 1024

/** The replay is over MAX_REPLAY_BYTES: skipped (and counted), never retried. */
export class ReplayTooLargeError extends Error {
  constructor() {
    super('That replay is too large to download here.')
    this.name = 'ReplayTooLargeError'
  }
}

/** Retry-After as seconds: a number of seconds or an HTTP date. */
export function parseRetryAfter(value: unknown, now = Date.now()) {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds))
    return seconds > 0 ? Math.ceil(seconds) : undefined
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return undefined
  const wait = Math.ceil((at - now) / 1000)
  return wait > 0 ? wait : undefined
}

/** Resume only when both the range and the object validator agree. A server
 * ignoring Range starts a new file; an invalid partial response is never appended. */
export function downloadRange(
  response: { status: number; range?: string; etag?: string; length?: string },
  offset: number,
  validator?: string,
) {
  if (response.status === 200)
    return { append: false, total: Number(response.length) || null }
  const match = response.range?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
  if (
    response.status !== 206 ||
    !match ||
    !validator ||
    response.etag !== validator ||
    Number(match[1]) !== offset ||
    Number(match[2]) < offset ||
    Number(match[3]) <= Number(match[2])
  )
    throw new Error(
      'The download changed or returned an invalid range. Retry the transfer.',
    )
  return { append: true, total: Number(match[3]) }
}

/** Storage refused the presigned link (expired or revoked); a new link from
 *  the website can continue the same download. */
export class DownloadLinkExpiredError extends Error {
  /** The HTTP status storage gave (401/403 expired or revoked; 404/410 gone). */
  readonly status?: number

  constructor(status?: number) {
    super('The download link expired.')
    this.name = 'DownloadLinkExpiredError'
    this.status = status
  }
}

export async function downloadBundle(
  url: string,
  destination: string,
  signal: AbortSignal,
  onProgress: (_bytes: number, _total: number | null) => void,
  // Tests substitute a local server; production always uses storageUrlAllowed.
  allowUrl: (_url: string) => boolean = storageUrlAllowed,
) {
  if (!allowUrl(url))
    throw new Error('The database returned an unsupported download host.')
  const partial = `${destination}.part`
  const metaPath = `${partial}.json`
  let offset = 0
  let etag: string | undefined
  let knownTotal: number | null = null
  try {
    const metadata = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
    etag =
      typeof metadata.etag === 'string' && !metadata.etag.startsWith('W/')
        ? metadata.etag
        : undefined
    if (Number.isSafeInteger(metadata.total) && metadata.total > 0)
      knownTotal = metadata.total
    if (etag) offset = (await fsp.stat(partial)).size
  } catch {
    /* start a new download */
  }
  // The last run got every byte but the final rename failed (antivirus holding
  // a freshly closed multi-GB file) or the app died first: no request, just
  // finish it. Asking storage for "bytes=<size>-" answers 416, which used to
  // throw the whole download away (launch review WIN-6 / DL-6).
  const finish = async () => {
    await retryFs(() => fsp.rename(partial, destination), `rename ${partial}`)
    await fsp.unlink(metaPath).catch(() => {})
    onProgress(offset, offset)
  }
  if (etag && knownTotal !== null && offset === knownTotal) {
    await finish()
    return
  }
  let currentUrl = new URL(url)
  let response: IncomingMessage | undefined
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await openResponse(currentUrl, {
      signal,
      headers:
        offset && etag
          ? {
              Range: `bytes=${offset}-`,
              'If-Range': etag,
              'Accept-Encoding': 'identity',
            }
          : { 'Accept-Encoding': 'identity' },
    })
    if (![301, 302, 303, 307, 308].includes(response.statusCode || 0)) break
    const location = response.headers.location
    response.destroy()
    if (!location) throw new Error('Missing download redirect.')
    currentUrl = new URL(location, currentUrl)
    if (!allowUrl(currentUrl.href))
      throw new Error('Unsupported download redirect.')
    response = undefined
  }
  if (!response) throw new Error('Too many download redirects.')
  if ([401, 403, 404, 410].includes(response.statusCode || 0)) {
    const status = response.statusCode
    response.destroy()
    // Keep the partial file and its validator: a fresh link to the same object
    // can still continue it.
    throw new DownloadLinkExpiredError(status)
  }
  // 416 with "bytes */<size>" and a partial of exactly that size: it is complete.
  if (response.statusCode === 416 && offset > 0) {
    const size = /^bytes \*\/(\d+)$/.exec(
      String(response.headers['content-range'] ?? ''),
    )
    response.destroy()
    if (size && Number(size[1]) === offset) {
      await finish()
      return
    }
  }
  let mode: ReturnType<typeof downloadRange>
  try {
    mode = downloadRange(
      {
        status: response.statusCode || 0,
        range: response.headers['content-range'],
        etag: response.headers.etag,
        length: response.headers['content-length'],
      },
      offset,
      etag,
    )
  } catch (error) {
    response.destroy()
    // Discard only the validator so the next attempt starts from byte zero.
    await fsp.unlink(metaPath).catch(() => {})
    throw error
  }
  let bytes = mode.append ? offset : 0
  try {
    await requireDiskSpace(
      path.dirname(destination),
      Math.max(0, (mode.total || 0) - bytes),
    )
    if (!mode.append) await fsp.writeFile(partial, '')
    await fsp.writeFile(
      metaPath,
      JSON.stringify({
        etag: response.headers.etag,
        ...(mode.total ? { total: mode.total } : {}),
      }),
      { mode: 0o600 },
    )
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        onProgress(bytes, mode.total)
        callback(null, chunk)
      },
    })
    await pipeline(
      response,
      progress,
      fs.createWriteStream(partial, { flags: mode.append ? 'a' : 'w' }),
      { signal },
    )
    if (mode.total !== null && bytes !== mode.total)
      throw new Error('Download was incomplete. Retry to continue.')
    await retryFs(() => fsp.rename(partial, destination), `rename ${partial}`)
    await fsp.unlink(metaPath).catch(() => {})
  } catch (error) {
    response.destroy()
    throw error
  }
}
