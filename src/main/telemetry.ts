import https from 'https'
import { app } from 'electron'
import type { ConfigInterface } from '../constants/types'

// Anonymous usage telemetry. Fire-and-forget pings to the lunarmelee.com
// ingest endpoint, used to drive the admin dashboard. The wire contract
// (envelope + per-event payloads) is documented in docs/telemetry-api.md —
// keep that file in sync with any change here.

const ENDPOINT = 'https://www.lunarmelee.com/api/app-usage'

export type TelemetryEvent =
  | 'install' // once, the first time a fresh install launches
  | 'app_open' // at most once per calendar day (DAU / version / OS)
  | 'video_created' // a render finished
  | 'import_completed' // an import finished (files added)
  | 'filter_run' // a filter finished running

let getConfig: (() => ConfigInterface) | null = null

export function initTelemetry(deps: { getConfig: () => ConfigInterface }) {
  getConfig = deps.getConfig
}

/**
 * Send one anonymous usage event. Never blocks, never throws. Silently drops
 * when the user has opted out (`sendAnonymousUsage === false`), before an
 * `installId` exists, or on any network error. Common fields (installId, app
 * version, os, arch, timestamp) are attached automatically; `data` carries the
 * event-specific payload.
 */
export function track(
  event: TelemetryEvent,
  data: Record<string, unknown> = {},
) {
  try {
    const config = getConfig?.()
    if (!config || config.sendAnonymousUsage === false) return
    const installId = config.installId
    if (!installId) return

    const body = JSON.stringify({
      event,
      installId,
      appVersion: app.getVersion(),
      os: process.platform,
      arch: process.arch,
      ts: new Date().toISOString(),
      data,
    })

    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    })
    req.on('error', () => {}) // silently ignore failures
    req.on('timeout', () => req.destroy())
    req.write(body)
    req.end()
  } catch {
    // Telemetry must never affect app behaviour.
  }
}
