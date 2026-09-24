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
] as const

export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number]
