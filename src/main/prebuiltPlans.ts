/**
 * Prebuilt plans for direct snapshot downloads (apps/database/docs/direct-load-test.md,
 * "The planning bottleneck"). The common big selections ("every Fox game") have their
 * plan built once per full-DB snapshot (`npm run direct-plans` in apps/database) and
 * served as a static file from storage behind Cloudflare: every Fox game's listing is
 * ~29 MB of plan file from Cloudflare's cache instead of ~290 locations pages (~60 MB
 * gzipped) over the Lunar server's home uplink.
 *
 * A plan file is used only when the manifest has the Find-replays filter exactly (the
 * same selection, asking for all of it: findPrebuiltPlan). Its games all sit in the full
 * DB zip; the transfer then asks the website's locations pages only for the selection's
 * other games (`exceptSnapshot`, delta zips and games in no zip). Any trouble (no
 * manifest, no match, a bad file) and the transfer lists everything the usual way.
 */
import crypto from 'crypto'
import http from 'http'
import https from 'https'
import zlib from 'zlib'
import { userAgentHeaders } from './clientIdentity'
import {
  decodePlanColumns,
  findPrebuiltPlan,
  type PlanManifest,
  type PlanManifestEntry,
} from '../vendor/direct-plan'
import type { DirectPlan } from './directDownload'

/** The manifest of prebuilt plans (an R2 bucket of its own on a Cloudflare custom domain). */
export const PREBUILT_PLANS_URL =
  'https://plans.lunarmelee.com/v1/manifest.json'

/** Production: only our plans host, over HTTPS. */
export function planUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      url.hostname === 'plans.lunarmelee.com'
    )
  } catch {
    return false
  }
}

const MANIFEST_MAX = 1024 * 1024
const PLAN_MAX = 256 * 1024 * 1024
const MANIFEST_TTL_MS = 10 * 60 * 1000

/** GET a small file whole (no redirects, a size cap, a timeout). */
function getFile(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const client = u.protocol === 'https:' ? https : http
    const req = client.get(
      u,
      {
        signal,
        headers: { ...userAgentHeaders(), 'Accept-Encoding': 'identity' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`Plans answered ${res.statusCode}.`))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > maxBytes) {
            req.destroy(new Error('The plan file is too big.'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error('Plans stopped answering.')),
    )
    req.on('error', reject)
  })
}

let manifestCache: {
  url: string
  at: number
  manifest: PlanManifest | null
} | null = null

let staleUntil = 0

export function _resetManifestCache() {
  manifestCache = null
  staleUntil = 0
}

/**
 * A prebuilt plan named a zip that storage no longer has (a full-database
 * rebuild whose plans were not regenerated yet): don't trust prebuilt plans, nor
 * the cached manifest, for the next 10 minutes. Otherwise every Resume loads the
 * same stale plan and pauses again (launch review DL-12).
 */
export function markPrebuiltStale(now = Date.now()) {
  manifestCache = null
  staleUntil = now + MANIFEST_TTL_MS
}

async function manifestAt(
  url: string,
  signal: AbortSignal,
): Promise<PlanManifest | null> {
  if (
    manifestCache &&
    manifestCache.url === url &&
    Date.now() - manifestCache.at < MANIFEST_TTL_MS
  )
    return manifestCache.manifest
  let manifest: PlanManifest | null = null
  try {
    manifest = JSON.parse(
      (await getFile(url, MANIFEST_MAX, signal, 10_000)).toString('utf8'),
    )
  } catch {
    if (signal.aborted) throw new Error('Paused')
    manifest = null
  }
  manifestCache = { url, at: Date.now(), manifest }
  return manifest
}

export type PrebuiltOptions = {
  /** The manifest's URL (PREBUILT_PLANS_URL); null: never look. */
  manifestUrl: string | null
  /** Find replays' export filter (databaseExportFilter). */
  filter: Record<string, unknown>
  signal: AbortSignal
  allowUrl?: (_url: string) => boolean
}

export type PrebuiltResult = {
  entry: PlanManifestEntry
  /** The full-DB zip id every game in it sits in: the rest is listed with exceptSnapshot. */
  snapshot: string
}

const RECORDS_PER_PAGE = 20_000

/**
 * Fill an empty plan from the prebuilt plan that answers `filter`, if there is one.
 * Returns what it used, or null (nothing done: list the usual way). The plan's meta
 * marks it `prebuilt` and stays incomplete: the caller lists the rest.
 */
export async function loadPrebuiltPlan(
  plan: DirectPlan,
  o: PrebuiltOptions,
): Promise<PrebuiltResult | null> {
  if (
    !o.manifestUrl ||
    plan.meta.count ||
    plan.meta.cursor ||
    plan.meta.complete
  )
    return null
  if (Date.now() < staleUntil) return null
  const allow = o.allowUrl ?? planUrlAllowed
  if (!allow(o.manifestUrl)) return null
  const manifest = await manifestAt(o.manifestUrl, o.signal)
  if (!manifest) return null
  const entry = findPrebuiltPlan(manifest, o.filter)
  if (!entry || entry.encoding !== 'br') return null
  let url: string
  try {
    url = new URL(entry.file, o.manifestUrl).toString()
  } catch {
    return null
  }
  if (!allow(url)) return null
  let columns
  try {
    const raw = await getFile(
      url,
      Math.min(PLAN_MAX, entry.size + 1),
      o.signal,
      120_000,
    )
    if (
      raw.length !== entry.size ||
      crypto.createHash('sha256').update(raw).digest('hex') !== entry.sha256
    )
      return null
    columns = decodePlanColumns(
      zlib.brotliDecompressSync(raw, { maxOutputLength: PLAN_MAX }),
    )
  } catch {
    if (o.signal.aborted) throw new Error('Paused')
    return null
  }
  const { meta } = columns
  const snap = meta.snapshots[0]
  if (
    !meta.count ||
    meta.snapshots.length !== 1 ||
    snap?.id !== manifest.snapshot ||
    snap.kind !== 'full' ||
    meta.count !== entry.games ||
    meta.other !== 0
  )
    return null
  // Into the plan a page at a time, marked as loading so a stop half-way starts over.
  const marker = { snapshot: snap.id, file: entry.file, loaded: false }
  let h = 0
  for (let s = 0; s < meta.count; s += RECORDS_PER_PAGE) {
    const end = Math.min(meta.count, s + RECORDS_PER_PAGE)
    const games: [string, string, string, number, number, number, number][] = []
    for (let i = s; i < end; i++) {
      const hashed = (columns.hashBitmap[i >> 3] >> (i & 7)) & 1
      games.push([
        columns.ids.toString('hex', i * 12, i * 12 + 12),
        hashed ? columns.hashes.toString('hex', h * 16, ++h * 16) : '',
        '',
        0,
        columns.offsets[i],
        columns.lengths[i],
        columns.headers[i],
      ])
    }
    plan.addPage(
      { snapshots: [snap], games, other: [], next: null },
      {
        cursor: null,
        complete: false,
        prebuilt: { ...marker, loaded: end >= meta.count },
      },
    )
  }
  return { entry, snapshot: snap.id }
}
