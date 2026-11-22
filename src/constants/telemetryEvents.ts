// Usage telemetry event names. Part of the Clipper -> website contract: the
// website accepts exactly these (website/src/utils/appUsageEvents.ts), checked by
// scripts/test/api-errors.test.mjs. Payloads are documented in docs/telemetry-api.md.
// Keep this file import-free so that root test can load it.
export const TELEMETRY_EVENTS = [
  'install', // once, the first time a fresh install launches
  'app_open', // at most once per calendar day (DAU / version / OS)
  'video_created', // a checkpoint of rendered clips (many per render, shared renderId)
  'import_completed', // an import finished (files added)
  'filter_run', // a filter finished running
  'ai_prompt_copied', // the "Copy AI Prompt" button in the custom-code editor
  'usage_opt_out', // the user just turned this off — the last event we send
  'usage_opt_in', // the user turned it back on
  // Added 2026-11-18 (Clipper 3.0.4+; older installs never send them):
  'render_finished', // a recording run ended: outcome, clips, time taken, settings used, error kind
  'video_tools_run', // Video Tools made a video: combine / compress, outcome, time taken
  'setting_changed', // a switch, choice or number in Settings changed (never paths or text)
  'feature_used', // a feature was used: play_clip, record_clip, auto_import
  'app_quit', // the app was closed: minutes it was open
] as const

export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number]

// Config keys a Settings > Reset keeps: the install's random id and the usage-data choice.
// Losing them made every reset a "new install" in the numbers and silently turned a
// user's opt-out back on. Keep this file import-free (a root test loads it).
export const TELEMETRY_CONFIG_KEYS = [
  'installId',
  'sendAnonymousUsage',
  'lastUsagePing',
  'lastUsagePingVersion',
  'installPingPending',
] as const
