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
  | 'video_created' // a checkpoint of rendered clips (many per render, shared renderId)
  | 'import_completed' // an import finished (files added)
  | 'filter_run' // a filter finished running
  | 'ai_prompt_copied' // the "Copy AI Prompt" button in the custom-code editor
  | 'usage_opt_out' // the user just turned this off — the last event we send
  | 'usage_opt_in' // the user turned it back on

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

/**
 * Apply a change to the `sendAnonymousUsage` setting, reporting the change
 * itself around the flip.
 *
 * The ordering is the whole point of this function existing, and it is not
 * something to inline at the call site: `track()` reads the LIVE config on
 * every call and drops everything while the flag is off. So the opt-out ping
 * has to go out BEFORE the flag flips (while consent is still active) and the
 * opt-in ping AFTER. Reverse either and the event vanishes silently, with no
 * error and nothing in the data to hint at it.
 *
 * `usage_opt_out` is the last thing an opting-out install ever sends; the
 * privacy page discloses this explicitly.
 */
export function applyUsageConsent(
  wasOptedIn: boolean,
  nowOptedIn: boolean,
  flip: () => void,
) {
  if (wasOptedIn && !nowOptedIn) track('usage_opt_out')
  flip()
  if (!wasOptedIn && nowOptedIn) track('usage_opt_in')
}
