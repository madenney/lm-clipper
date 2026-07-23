# Lunar Clipper — Usage Telemetry API Contract

> **Audience:** whoever builds the server-side ingest endpoint + admin dashboard
> on **lunarmelee.com**. This document is the source of truth for what the
> desktop app sends. The client implementation lives in the `lm-clipper` repo:
> `src/main/telemetry.ts` (sender) and the call sites listed below. Keep this
> doc and that file in sync.

## Overview

The Lunar Clipper desktop app (Electron, Windows + Linux) sends **anonymous**
usage events to a single HTTPS endpoint. Events are **fire-and-forget** from the
client: it does not read the response, retries nothing, and silently drops on
any error. The server should therefore be lenient and fast (respond `204` and
move on), and must treat all input as untrusted.

- **No PII.** No names, emails, file paths, IP-derived identity, or machine
  fingerprints are sent. The only identifier is a random per-install UUID
  (`installId`) the app generates once and stores in its local config.
- **Opt-out.** Users can disable all telemetry via _Settings → Send Anonymous
  Usage Data_. When off, the client sends nothing. Default is **on**, with a
  one-time first-run disclosure banner that links to the privacy policy.

> ⚠️ **SERVER MUST NOT STORE THE CLIENT IP.** This is the one requirement that
> keeps the whole pipeline "anonymous." Every POST carries the client's IP, and
> an IP **is** personal data under GDPR. The server must drop the IP (or reduce
> it to a coarse country at ingest and discard the original) and never persist
> it alongside `installId`/events. If you store IPs next to events, this stops
> being anonymous telemetry and becomes PII processing with all the consent
> obligations that implies. The client's anonymity guarantees are void without
> this.

**Consent model (why there's no opt-in gate):** anonymous, opt-out product
analytics with (1) a disclosure, (2) a working opt-out, and (3) no server-side
PII (the IP rule above) is the standard, generally-sufficient posture — the same
model VS Code and most desktop apps use. It runs under GDPR "legitimate
interest," which requires transparency + opt-out, **not** explicit opt-in. So
the app does **not** block on a consent prompt; it discloses + lets users opt
out. **Action item for the website:** publish a privacy policy at
`https://www.lunarmelee.com/privacy` (the consent banner links to it) describing
what's collected (the events below), that it's anonymous, that the IP is
discarded, and how to opt out.

## Endpoint

```
POST https://www.lunarmelee.com/api/app-usage
Content-Type: application/json
```

- One event per request. Body is a single JSON object (the envelope below).
- No auth header today. Because the endpoint is reachable by any desktop client,
  treat it as **public/untrusted**: validate the shape, rate-limit per IP, and
  cap field sizes. (See _Abuse / hardening_ below.)
- Recommended response: **`204 No Content`** on accept, `400` on a malformed
  body. The client ignores the status code either way.

## Envelope (every event)

```jsonc
{
  "event": "app_open", // string enum, see Events
  "installId": "7f3a9c2e-1b4d-4e2a-9c8f-2a1b3c4d5e6f", // random UUID v4
  "appVersion": "2.0.0-beta.3", // app.getVersion(), semver (may have -beta.N)
  "os": "win32", // process.platform: "win32" | "linux" | "darwin"
  "arch": "x64", // process.arch: "x64" | "arm64" | ...
  "ts": "2026-06-19T18:43:39.123Z", // client clock, ISO-8601 UTC. UNTRUSTED.
  "data": {
    /* event-specific, see below */
  },
}
```

Field notes for the server:

- **`installId`** — the unique-user key. Random, not a device id; it resets if
  the user wipes their config or reinstalls fresh. Use it for unique-install and
  DAU/MAU counts and retention. Never assume it maps 1:1 to a person/machine.
- **`appVersion`** — drives version-adoption charts. A `-` in the string means a
  prerelease/beta build (e.g. `2.0.0-beta.3`); a clean `2.0.0` is stable.
- **`os` / `arch`** — platform split. `darwin` will not currently appear (no mac
  builds) but may in future; don't hard-reject it.
- **`ts`** — client-supplied and clock-skew prone. **Stamp your own
  `received_at` server-side** and prefer it for time-bucketing; keep `ts` only
  for reference.

## Events

| `event`            | When the client sends it                      | Dedupe on client             |
| ------------------ | --------------------------------------------- | ---------------------------- |
| `install`          | Once, the first launch of a brand-new install | Fires once ever per install  |
| `app_open`         | On launch                                     | **At most once per UTC day** |
| `video_created`    | A video render finished successfully          | None                         |
| `import_completed` | An `.slp` import finished (not cancelled)     | None                         |
| `filter_run`       | A filter finished running (not cancelled)     | None                         |

### `data` payloads

```jsonc
// install
"data": {}                              // envelope fields carry everything

// app_open
"data": {}                              // version/os/arch are in the envelope

// video_created
"data": {
  "clips": 42,                          // number of clips in the rendered video
  "durationSec": 137                    // total rendered length, seconds (0 if unknown)
                                        // derived from clip frame spans at 60fps,
                                        // not probed off the output file

}

// import_completed
"data": {
  "added": 1280,                        // files newly added this import (>= 0)
  "failed": 3                           // files that failed to parse
}

// filter_run
"data": {
  "filterType": "comboFilter",          // filter method id (see note)
  "durationMs": 84213                   // wall-clock runtime of the filter
}
```

**`filterType` values** are the app's internal filter method ids — a small,
low-cardinality enum. Current set includes: `files`, `slpParser` (Combo Parser),
`comboFilter`, `edgeguard2` (Edgeguards Parser), `edgeguardFilter`,
`zeroToDeaths`, `stageCenter`, `reverse`, `sort`, `custom`. Treat the field as
an open string (new types may be added) but expect this vocabulary.

> **Volume note:** `filter_run` and `import_completed` can fire often for power
> users (a project may run many filters). Design ingest/storage to absorb bursts
> and consider down-sampling/aggregating these two in the dashboard.

## Suggested storage

A single append-only `app_usage_events` table is enough to start:

```sql
CREATE TABLE app_usage_events (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server clock (trust this)
  client_ts    TIMESTAMPTZ,                         -- envelope.ts (untrusted)
  event        TEXT  NOT NULL,
  install_id   UUID,                                -- nullable: reject-but-keep bad ones out
  app_version  TEXT,
  os           TEXT,
  arch         TEXT,
  data         JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX ON app_usage_events (event, received_at);
CREATE INDEX ON app_usage_events (install_id);
CREATE INDEX ON app_usage_events (received_at);
```

Derive metrics with queries/materialized views rather than extra columns. A
daily rollup table keyed on `(day, event)` keeps the dashboard cheap.

## Dashboard metrics this enables

- **Installs** — count of `install` events; unique `install_id`s over time.
- **DAU / MAU** — distinct `install_id` with an `app_open` in the day / 28-day
  window. (`app_open` is client-deduped to once/day, so a simple distinct count
  is correct.)
- **Retention** — cohort by first-seen `install_id`, revisited via later
  `app_open`s.
- **Version adoption** — distinct `install_id` per `app_version` per day; great
  for confirming an auto-update rollout is landing.
- **Platform split** — `os` / `arch` distribution.
- **Engagement / output** — `video_created` counts, sum of `clips`, sum of
  `durationSec`; `import_completed` (`added` files); `filter_run` by
  `filterType` to see which features get used.
- **Funnel** — installed → first `app_open` → first `video_created`. Base the
  first stage on distinct `install_id`, not on `install` events: `install` only
  fires for a genuinely fresh config, so anyone upgrading from a pre-telemetry
  build has an id but no `install` event, and later stages would exceed it.

## Abuse / hardening (server-side, since the endpoint is public)

- Validate `event` against the known enum; drop unknown events (or store in a
  quarantine bucket).
- Require `installId` to be a UUID; reject otherwise.
- Cap body size (e.g. 4 KB) and `data` depth; reject oversized.
- Rate-limit per source IP and/or per `installId`.
- **Do not store source IP** alongside events if you want to keep the "no PII"
  promise — or store only a coarse geo/country derived at ingest and discard the
  IP.
- Idempotency for `install`: a client only sends it once, but a retry/relay
  could duplicate — de-dupe on `(install_id, event='install')` if exact install
  counts matter.

## Client reference (lm-clipper repo)

- **Sender:** `src/main/telemetry.ts` — `initTelemetry({ getConfig })` + `track(event, data)`.
- **Install id + `install`/`app_open`:** `src/main/controller.ts`
  (`reportStartupTelemetry`, install-id generation in the constructor).
- **`video_created`:** `src/main/managers/VideoManager.ts`.
- **`import_completed`:** `src/main/managers/ImportManager.ts`.
- **`filter_run`:** `src/main/managers/FilterExecutor.ts`.
- **Opt-out flag:** `sendAnonymousUsage` (config); first-run banner:
  `src/renderer/components/ConsentNotice.tsx` + `consentNoticeSeen` flag.
