import https from 'https'
import { app } from 'electron'
import type { ConfigInterface } from '../constants/types'
import type { TelemetryEvent } from '../constants/telemetryEvents'

// Anonymous usage telemetry. Fire-and-forget pings to the lunarmelee.com
// ingest endpoint, used to drive the admin dashboard. The wire contract
// (envelope + per-event payloads) is documented in docs/telemetry-api.md —
// keep that file in sync with any change here.

const ENDPOINT = 'https://www.lunarmelee.com/api/app-usage'

export type { TelemetryEvent }

let getConfig: (() => ConfigInterface) | null = null
let saveConfig: (() => void) | null = null

export function initTelemetry(deps: {
  getConfig: () => ConfigInterface
  saveConfig?: () => void
}) {
  getConfig = deps.getConfig
  saveConfig = deps.saveConfig ?? null
}

/**
 * Why this process must not report usage, or null when it may. Only a real,
 * packaged install of the app counts as a user: development runs, the
 * win-rig test suites (LM_CLIPPER_TEST_HOME, LM_CLIPPER_AUTORUN_*) and a
 * config with testMode on would otherwise show up as installs, opens and
 * "videos" in the admin App Usage numbers (analytics review F7).
 * LM_CLIPPER_TELEMETRY_FORCE=1 lets a developer test the pings on purpose.
 */
export function telemetrySuppressedReason(
  config?: Pick<ConfigInterface, 'testMode'> | null,
): string | null {
  if (process.env.LM_CLIPPER_TELEMETRY_FORCE === '1') return null
  if (process.env.LM_CLIPPER_TEST_HOME) return 'test-home'
  if (Object.keys(process.env).some((k) => k.startsWith('LM_CLIPPER_AUTORUN_')))
    return 'autorun'
  if (!app.isPackaged) return 'not-packaged'
  if (config?.testMode === true) return 'test-mode'
  return null
}

// The first-launch pings (install, app_open) wait until the usage-stats notice
// has been shown (config.consentNoticeSeen), so nothing is sent before the user
// could have seen it or turned it off (launch review PRIV-1).
const HELD_UNTIL_NOTICE: TelemetryEvent[] = ['install', 'app_open']
type Held = { data: Record<string, unknown>; onResult?: (_ok: boolean) => void }
const held = new Map<TelemetryEvent, Held>()

// Requests still on the wire, so a quit can wait a moment for them (flushTelemetry).
const inflight = new Set<Promise<void>>()

/** The notice has been shown: send what was held back (nothing if opted out). */
export function releaseHeldTelemetry() {
  const pending = [...held]
  held.clear()
  for (const [event, h] of pending) track(event, h.data, h.onResult)
}

/**
 * Wait (at most `timeoutMs`) for pings already sent to finish, so one fired
 * just before quitting is not cut off with the process. Never rejects.
 */
export function flushTelemetry(timeoutMs = 1500): Promise<void> {
  if (inflight.size === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    Promise.allSettled([...inflight]).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Send one anonymous usage event. Never blocks, never throws. Silently drops
 * when the user has opted out (`sendAnonymousUsage === false`), before an
 * `installId` exists, in a dev/test run (telemetrySuppressedReason), or on any
 * network error. Common fields (installId, app version, os, arch, timestamp)
 * are attached automatically; `data` carries the event-specific payload.
 *
 * `onResult(true)` runs when the server answered 2xx; `onResult(false)` when
 * nothing was sent or the request failed, so a caller can retry next launch
 * instead of assuming a ping arrived.
 */
export function track(
  event: TelemetryEvent,
  data: Record<string, unknown> = {},
  onResult?: (_ok: boolean) => void,
) {
  let reported = false
  const report = (ok: boolean) => {
    if (reported) return
    reported = true
    try {
      onResult?.(ok)
    } catch {
      // a caller's bookkeeping must not affect the app
    }
  }
  try {
    const config = getConfig?.()
    if (!config || config.sendAnonymousUsage === false) return report(false)
    const installId = config.installId
    if (!installId) return report(false)
    if (telemetrySuppressedReason(config)) return report(false)
    if (HELD_UNTIL_NOTICE.includes(event) && !config.consentNoticeSeen) {
      held.set(event, { data, onResult })
      reported = true // the held copy reports when it is released
      return
    }

    const body = JSON.stringify({
      event,
      installId,
      appVersion: app.getVersion(),
      os: process.platform,
      arch: process.arch,
      ts: new Date().toISOString(),
      data,
    })

    const req = https.request(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        res.resume() // the body is never read
        const code = res.statusCode ?? 0
        finish(code >= 200 && code < 300)
      },
    )
    let settle: () => void = () => {}
    const tracked = new Promise<void>((resolve) => {
      settle = resolve
    })
    inflight.add(tracked)
    const finish = (ok: boolean) => {
      inflight.delete(tracked)
      settle()
      report(ok)
    }
    req.on('error', () => finish(false)) // silently ignore failures
    req.on('timeout', () => req.destroy())
    req.write(body)
    req.end()
  } catch {
    // Telemetry must never affect app behaviour.
    report(false)
  }
}

/**
 * Launch pings: `install` (until the server has acknowledged it once) and
 * `app_open` (once per UTC day, and again when the version changes).
 *
 * The "already sent" marks are written only after the server answered 2xx. They
 * used to be written before sending, so a launch with no network (or a quit
 * before the notice) used up the day's ping, or the one-time `install`, for
 * good (analytics review F19). The install mark is `installPingPending`, set
 * when the config is first created and kept on disk until acknowledged.
 */
export function reportStartupTelemetry(version: string, now = new Date()) {
  const today = now.toISOString().slice(0, 10)
  const config = getConfig?.()
  if (!config) return
  if (config.installPingPending) {
    track('install', {}, (ok) => {
      const c = getConfig?.()
      if (!ok || !c) return
      c.installPingPending = false
      saveConfig?.()
    })
  }
  if (
    config.lastUsagePing !== today ||
    config.lastUsagePingVersion !== version
  ) {
    track('app_open', {}, (ok) => {
      const c = getConfig?.()
      if (!ok || !c) return
      c.lastUsagePing = today
      c.lastUsagePingVersion = version
      saveConfig?.()
    })
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
