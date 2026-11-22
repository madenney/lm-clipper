import { app, shell, IpcMainEvent } from 'electron'
import path from 'path'
import fs from 'fs'
import type { ControllerCore } from './context'
import {
  detectPlaybackDolphin,
  detectMeleeIso,
  stripPathQuotes,
} from '../slippiDetect'
import { config as defaultConfig } from '../../constants/defaults'
import { setFFMPEGPathOverride } from '../slpToVideo'
import { closeDbAsync, libraryCall } from '../dbAsync'
import { logMain } from '../logger'
import { applyUsageConsent, releaseHeldTelemetry, track } from '../telemetry'
import { settingChange } from '../usageEvents'
import { TELEMETRY_CONFIG_KEYS } from '../../constants/telemetryEvents'
import {
  migrateConfigTypes,
  rendererConfig,
  rendererMayWrite,
} from '../configStore'
import { ownerKeptPaths } from '../../owner/main'
import { withoutKeptPaths } from '../keptPaths'
import { OWNER_CONFIG_KEYS } from '../../owner/channels'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import {
  PATH_CONFIG_KEYS,
  autoFilterThreads,
  getDefaultProjectDir,
} from './helpers'

export type Ctx = Pick<
  ControllerCore,
  | 'config'
  | 'configPath'
  | 'defaultWorkspacePath'
  | 'devBackupPath'
  | 'ensureDefaultOutputPath'
  | 'hardwareReady'
  | 'library'
  | 'pickSettingsForThisComputer'
  | 'refreshFreeDisk'
  | 'restartIntoConfig'
  | 'saveConfig'
  | 'setArchiveInternal'
  | 'transferManager'
>

/**
 * Dev "reset all" (user, 2026-10-03: "reset my library too, my project
 * files, just delete"): Clipper's own data goes to the Trash — the Replay
 * Library's contents (index, downloaded replays, downloads), My Replays,
 * projects in the default projects folder and the transfer history. Only
 * Clipper's own names inside the library folder are touched, so a library
 * pointed at a folder with other files keeps those. Projects saved elsewhere
 * are left alone.
 *
 * Developer-only: resetApp runs it only in a development build or with
 * testMode on, and only when asked for with `wipeData` (the dev screen
 * switcher's "reset all"). Never reachable from Settings. If the Trash cannot
 * take an item, the item stays where it is: there is no delete-for-good
 * fallback (launch review 0.1, 2026-11-10).
 */
export async function wipeUserData(ctx: Ctx) {
  ctx.transferManager.reset()
  await libraryCall('libraryClose').catch(() => {})
  const remove = async (p: string) => {
    if (!fs.existsSync(p)) return
    await shell.trashItem(p)
  }
  const libraryFolder = ctx.library().folder
  const items = [
    ...['library.sqlite', 'library.sqlite-wal', 'library.sqlite-shm'],
    'replays',
    'Downloads',
  ].map((n) => path.join(libraryFolder, n))
  items.push(path.dirname(ctx.defaultWorkspacePath()))
  const projectDir = getDefaultProjectDir()
  try {
    for (const n of await fs.promises.readdir(projectDir))
      if (/\.lunar(-wal|-shm)?$/.test(n)) items.push(path.join(projectDir, n))
  } catch {
    /* no projects folder */
  }
  // Files the owner tools keep (and folders holding them) are never touched.
  const { remove: removable, skipped } = withoutKeptPaths(
    items,
    ownerKeptPaths(ctx.config),
  )
  if (skipped.length) logMain('reset all: kept', { paths: skipped })
  let trashed = 0
  for (const p of removable) {
    try {
      await remove(p)
      trashed++
    } catch (error) {
      logMain('reset all: could not move to the Trash, left in place', {
        path: p,
        error: String(error),
      })
    }
  }
  logMain('reset all: moved Clipper data to the Trash', {
    items: items.length,
    trashed,
  })
}

export async function getConfig(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  await Promise.race([
    ctx.hardwareReady,
    new Promise((resolve) => {
      setTimeout(resolve, 4000)
    }),
  ])
  await ctx.refreshFreeDisk()
  reply(event, 'config', requestId, rendererConfig(ctx.config))
}

export async function setDefaultOutputPath(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  ctx.ensureDefaultOutputPath()
  reply(event, 'setDefaultOutputPath', requestId, ctx.config.outputPath)
}

export async function updateConfig(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{
    key: string
    value: string | number | boolean | null | string[]
  }>,
) {
  const { requestId, payload } = unpackRequest<{
    key: string
    value: string | number | boolean | null
  }>(data)
  if (!payload || !rendererMayWrite(payload.key)) {
    return reply(event, 'updateConfig', requestId)
  }
  // The Replay Library's folder only changes through moveReplayLibrary, which
  // asks and moves the files; a plain config write would re-point it (launch
  // review CR-3).
  if (payload.key === 'replayLibraryPath') {
    return reply(event, 'updateConfig', requestId)
  }
  if (PATH_CONFIG_KEYS.has(payload.key) && typeof payload.value === 'string') {
    payload.value = stripPathQuotes(payload.value)
  }
  const applyValue = () => {
    ctx.config[payload.key] = payload.value
  }
  if (payload.key === 'sendAnonymousUsage') {
    // This one setting reports its own change. applyUsageConsent owns the
    // before/after-the-flip ordering that makes that work — don't inline it.
    applyUsageConsent(
      ctx.config.sendAnonymousUsage !== false,
      payload.value !== false,
      applyValue,
    )
  } else {
    applyValue()
  }

  // The usage-stats notice has been shown: the first-launch pings may go.
  if (payload.key === 'consentNoticeSeen' && payload.value === true)
    releaseHeldTelemetry()

  if (payload.key === 'ffmpegPath') {
    setFFMPEGPathOverride(payload.value as string)
  }
  // Anonymous usage: a switch, choice or number in Settings changed (usageEvents.settingChange: never a
  // folder, a file or text). Sent after the change, so turning usage data off is not reported here.
  const change = settingChange(payload.key, payload.value)
  if (change) track('setting_changed', change)
  ctx.saveConfig()
  return reply(event, 'updateConfig', requestId)
}

// `{ only: 'hardware' }` (Settings' "Pick settings for this computer")
// re-applies just the hardware picks and keeps every other setting.
export async function resetConfig(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: unknown,
) {
  if ((data as { only?: string } | null)?.only === 'hardware') {
    await ctx.pickSettingsForThisComputer()
    ctx.saveConfig()
    event.reply('config', rendererConfig(ctx.config))
    return
  }
  const preserveKeys = [
    'recentProjects',
    'lastArchivePath',
    'ssbmIsoPath',
    'dolphinPath',
    'outputPath',
    'defaultProjectDirectory',
    'replayLibraryPath',
    'scratchPath',
    // The install's anonymous id and the usage-data choice outlive a reset: it
    // is not a new install, and an opt-out must not flip back on.
    ...TELEMETRY_CONFIG_KEYS,
    ...OWNER_CONFIG_KEYS,
  ]
  const preserved: Record<string, any> = {}
  for (const key of preserveKeys) {
    if (ctx.config[key] !== undefined) preserved[key] = ctx.config[key]
  }
  ctx.config = { ...defaultConfig, ...preserved }
  ctx.config.numFilterThreads = autoFilterThreads()
  // A reset leaves a brand-new user: nothing to catch up on in "What's new" (as on a first run).
  ctx.config.lastSeenVersion = app.getVersion()
  await ctx.pickSettingsForThisComputer()
  ctx.saveConfig()
  event.reply('config', rendererConfig(ctx.config))
}

// Full factory reset: wipe ALL settings AND paths back to first-run
// defaults, then relaunch so the app comes up as a brand-new user. Projects,
// the Replay Library and replay files on disk are NOT touched — only the
// config (a backup of the pre-reset config is left next to it as a safety
// net). The Replay Library's folder is the one path kept, so a library that
// lives somewhere else is still found afterwards.
//
// `{ wipeData: true }` (the dev screen switcher's "reset all") also moves the
// library, My Replays and the default projects to the Trash, and is honoured
// only in a development build or with testMode on (see wipeUserData).
//
// `{ devPreview: true }` (dev screen switcher) is the same reset for
// previewing the new-user flow, but reversible: the pre-preview config is
// saved to a separate backup that is only written when none exists, so
// repeated previews never overwrite your real settings with a newbie
// config. `restoreDevBackup` puts it back. Every reset keeps the telemetry keys
// (installId and the usage-data choice: no fake new installs in telemetry, no opt-out
// turned back on); the preview also keeps testMode (keeps the switcher reachable in
// a packaged build).
export async function resetApp(ctx: Ctx, _event: IpcMainEvent, data?: any) {
  const devPreview = !!data?.devPreview
  const wipeData =
    !devPreview &&
    data?.wipeData === true &&
    (!app.isPackaged || ctx.config.testMode === true)
  if (data?.wipeData === true && !wipeData && !devPreview)
    logMain('resetApp: wipeData refused outside a development build/testMode')
  try {
    if (devPreview) {
      if (!fs.existsSync(ctx.devBackupPath) && fs.existsSync(ctx.configPath)) {
        fs.copyFileSync(ctx.configPath, ctx.devBackupPath)
      }
    } else if (fs.existsSync(ctx.configPath)) {
      fs.copyFileSync(ctx.configPath, `${ctx.configPath}.bak`)
    }
  } catch (_) {
    // best-effort backup; never block a real reset on it
    if (devPreview) return
  }
  const { testMode, untitledCleanupOffered, replayLibraryPath } = ctx.config
  const telemetryKept: Record<string, unknown> = {}
  for (const key of TELEMETRY_CONFIG_KEYS)
    if (ctx.config[key] !== undefined) telemetryKept[key] = ctx.config[key]
  // The owner tools' settings outlive a reset (they also say what it keeps).
  const ownerKept: Record<string, unknown> = {}
  for (const key of OWNER_CONFIG_KEYS)
    if (ctx.config[key] !== undefined) ownerKept[key] = ctx.config[key]
  await closeDbAsync()
  if (wipeData) await wipeUserData(ctx)
  ctx.config = {
    ...JSON.parse(JSON.stringify(defaultConfig)),
    ...telemetryKept,
    ...ownerKept,
  }
  ctx.config.numFilterThreads = autoFilterThreads()
  // A reset leaves a brand-new user: nothing to catch up on in "What's new" (as on a first run).
  ctx.config.lastSeenVersion = app.getVersion()
  await ctx.pickSettingsForThisComputer()
  ctx.config.dolphinPath = detectPlaybackDolphin() || ''
  ctx.config.ssbmIsoPath = detectMeleeIso() || ''
  // A reset that leaves the library on disk keeps pointing at it.
  if (!wipeData && replayLibraryPath)
    ctx.config.replayLibraryPath = replayLibraryPath
  if (devPreview) {
    ctx.config.testMode = testMode
    // A one-time notice about this machine's old projects, not part of
    // the new-user flow being previewed.
    ctx.config.untitledCleanupOffered = untitledCleanupOffered
  }
  ctx.saveConfig()
  ctx.setArchiveInternal(null)
  ctx.restartIntoConfig()
}

export function hasDevBackup(ctx: Ctx, event: IpcMainEvent) {
  event.reply('hasDevBackup', fs.existsSync(ctx.devBackupPath))
}

export async function restoreDevBackup(ctx: Ctx) {
  let restored: any
  try {
    restored = JSON.parse(fs.readFileSync(ctx.devBackupPath).toString())
  } catch (err) {
    logMain('restoreDevBackup failed', (err as Error)?.message ?? err)
    return
  }
  await closeDbAsync()
  ctx.config = migrateConfigTypes({ ...defaultConfig, ...restored })
  ctx.setArchiveInternal(null)
  await ctx.saveConfig()
  try {
    fs.unlinkSync(ctx.devBackupPath)
  } catch (_) {
    // stale backup is harmless; the next preview simply keeps it
  }
  ctx.restartIntoConfig()
}
