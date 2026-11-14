import { dialog, IpcMainEvent } from 'electron'
import path from 'path'
import fs, { promises as fsPromises } from 'fs'
import { askDialog } from '../askRenderer'
import { storageConcern } from '../dataLocations'
import type { ControllerCore } from './context'
import { ensureProjectExt, projectDisplayName } from '../projectFile'
import {
  updateMetadataNameAsync,
  updateMetadataPathAndNameAsync,
  closeDbAsync,
} from '../dbAsync'
import { logMain } from '../logger'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import type { Ctx as LibraryToolsCtx } from './libraryTools'
import { offerUntitledCleanup } from './libraryTools'
import { getDefaultProjectDir } from './helpers'

export type Ctx = Pick<
  ControllerCore,
  | 'addToRecentProjects'
  | 'archive'
  | 'autoCreateUntitledProject'
  | 'closeCurrentProject'
  | 'prepareProjectSwitch'
  | 'config'
  | 'createNewArchiveInternal'
  | 'defaultWorkspacePath'
  | 'getUntitledName'
  | 'mainWindow'
  | 'onRendererReady'
  | 'reloadArchiveFrom'
  | 'removeFromRecentProjects'
  | 'rendererReadyFired'
  | 'saveConfig'
  | 'setArchiveInternal'
  | 'stopCpuScan'
  | 'stopNameCountWorker'
  | 'updateWindowTitle'
> &
  LibraryToolsCtx

export async function getArchive(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  if (ctx.archive) {
    try {
      ctx.stopNameCountWorker()
      // The CPU check keeps going: the same project reloads, and
      // startMissingCheck's start leaves a running check alone.
      const metadata = await ctx.reloadArchiveFrom(ctx.archive.path)
      ctx.updateWindowTitle()
      reply(event, 'archive', requestId, metadata)
    } catch (error) {
      console.error('Error loading archive metadata:', error)
      const gone = !fs.existsSync(ctx.archive.path)
      ctx.setArchiveInternal(null)
      // Forget the project only when its file is gone; a failed open (a lock, a
      // busy database) keeps it for the next start (launch review REL-5).
      if (gone) {
        ctx.config.lastArchivePath = null
        ctx.saveConfig()
      }
      reply(event, 'archive', requestId)
    }
  } else {
    reply(event, 'archive', requestId)
  }

  // The renderer has mounted and registered its listeners by the time it
  // first asks for the archive — safe point to flush a pending OS file open.
  if (!ctx.rendererReadyFired) {
    ctx.rendererReadyFired = true
    ctx.onRendererReady?.()
    offerUntitledCleanup(ctx).catch((error) =>
      logMain('untitled cleanup offer failed', error),
    )
  }
}

export async function createNewArchive(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{ name?: string; location?: string }>,
) {
  try {
    const { requestId, payload } = unpackRequest<{
      name?: string
      location?: string
    }>(data)
    const metadata = await ctx.createNewArchiveInternal(payload || {})
    reply(event, 'createNewArchive', requestId, metadata)
  } catch (error) {
    const { requestId } = unpackRequest<{
      name?: string
      location?: string
    }>(data)
    reply(event, 'createNewArchive', requestId, { error: true, info: error })
  }
}

export async function getDirectory(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(
      ctx.mainWindow,
      {
        properties: ['openDirectory'],
        defaultPath: ctx.config.lastArchivePath
          ? ctx.config.lastArchivePath
          : '',
      },
    )
    if (canceled) return reply(event, 'directory', requestId)
    return reply(event, 'directory', requestId, filePaths[0])
  } catch (error) {
    console.error('[getDirectory] error:', error)
    return reply(event, 'directory', requestId)
  }
}

export async function openExistingArchive(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(
      ctx.mainWindow,
      {
        properties: ['openFile'],
        filters: [
          { name: 'Lunar Clipper Project', extensions: ['lunar'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        defaultPath: ctx.config.lastArchivePath
          ? path.dirname(ctx.config.lastArchivePath)
          : undefined,
      },
    )
    if (canceled) return reply(event, 'openExistingArchive', requestId)

    if (!(await ctx.prepareProjectSwitch()))
      return reply(event, 'openExistingArchive', requestId)
    ctx.stopNameCountWorker()
    await ctx.stopCpuScan()
    await closeDbAsync()
    try {
      await ctx.reloadArchiveFrom(filePaths[0])
      ctx.updateWindowTitle()
    } catch (e) {
      console.error('Error opening archive', e)
      return reply(event, 'openExistingArchive', requestId, {
        error: 'Failed to open given filepath',
      })
    }

    if (!ctx.archive || !ctx.archive.shallowCopy)
      throw new Error('Something went wrong :(')

    // Fix legacy projects whose name is still "Untitled"
    if (/^Untitled(\s\d+)?$/.test(ctx.archive.name)) {
      const derivedName = projectDisplayName(filePaths[0])
      await updateMetadataNameAsync(filePaths[0], derivedName)
      ctx.archive.name = derivedName
    }

    ctx.config.lastArchivePath = ctx.archive.path
    ctx.config.projectName = ctx.archive.name
    ctx.saveConfig()
    ctx.addToRecentProjects(ctx.archive.name, ctx.archive.path)
    const metadata = await ctx.archive.shallowCopy()
    return reply(event, 'openExistingArchive', requestId, metadata)
  } catch (error) {
    return reply(event, 'openExistingArchive', requestId, { error })
  }
}

export async function closeArchive(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  await ctx.closeCurrentProject()
  return reply(event, 'closeArchive', requestId)
}

/** Start screen › Empty project: straight into My Replays, no dialog. */
export async function openMyReplays(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  try {
    return reply(
      event,
      'openMyReplays',
      requestId,
      await ctx.autoCreateUntitledProject(),
    )
  } catch (error) {
    logMain('openMyReplays: error', error)
    return reply(event, 'openMyReplays', requestId, {
      error: 'Could not open My Replays.',
    })
  }
}

/** Projects are SQLite databases (WAL): on a network share they can be damaged,
 *  and a cloud-synced folder locks and uploads them while open. Ask before
 *  putting one there; false = the user chose another place. */
async function confirmProjectLocation(
  ctx: Ctx,
  folder: string,
): Promise<boolean> {
  const concern = storageConcern(folder)
  if (!concern) return true
  const { response } = await askDialog(ctx.mainWindow, {
    type: 'warning',
    title: 'Project location',
    message:
      concern.kind === 'network'
        ? 'Keep this project on a network share?'
        : `Keep this project in a ${concern.provider} folder?`,
    detail: concern.message,
    buttons: ['Choose another place', 'Keep it here'],
    defaultId: 0,
    cancelId: 0,
  })
  return response === 1
}

export async function newProject(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  try {
    // New Project is the explicit "I want a named project" action (quick
    // imports go to My Replays), so it asks for a name and place. Cancel
    // replies with nothing, which the renderer ignores.
    const lastDir =
      ctx.config.lastArchivePath &&
      ctx.config.lastArchivePath !== ctx.defaultWorkspacePath()
        ? path.dirname(ctx.config.lastArchivePath)
        : getDefaultProjectDir()
    if (!fs.existsSync(lastDir)) fs.mkdirSync(lastDir, { recursive: true })
    const { canceled, filePath } = await dialog.showSaveDialog(ctx.mainWindow, {
      title: 'New Project',
      buttonLabel: 'Create',
      defaultPath: path.join(
        lastDir,
        ensureProjectExt(ctx.getUntitledName(lastDir, 'New Project')),
      ),
      filters: [{ name: 'Lunar Clipper Project', extensions: ['lunar'] }],
    })
    if (canceled || !filePath) return reply(event, 'newProject', requestId)
    const target = ensureProjectExt(filePath)
    if (fs.existsSync(target))
      return reply(event, 'newProject', requestId, {
        error: 'A project with that name already exists there.',
      })
    if (!(await confirmProjectLocation(ctx, path.dirname(target))))
      return reply(event, 'newProject', requestId)
    if (!(await ctx.prepareProjectSwitch()))
      return reply(event, 'newProject', requestId)
    const location = path.dirname(target)
    const name = projectDisplayName(target)
    logMain('newProject: creating', { name, location })
    const metadata = await ctx.createNewArchiveInternal({ name, location })
    logMain('newProject: created successfully')
    return reply(event, 'newProject', requestId, metadata)
  } catch (error) {
    logMain('newProject: error', error)
    return reply(event, 'newProject', requestId, { error: true, info: error })
  }
}

export async function saveAsArchive(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  if (!ctx.archive) {
    return reply(event, 'saveAsArchive', requestId, {
      error: 'No project open',
    })
  }

  // Parent the dialog to the main window. A parentless dialog on
  // Linux/X11 isn't transient-for the app, so GNOME can spawn it behind
  // the window with its filename-autocomplete popup floating detached.
  const { canceled, filePath: rawPath } = await dialog.showSaveDialog(
    ctx.mainWindow,
    {
      title: 'Save Project As',
      // Suggest a complete filename *with* the .lunar extension. Passing
      // the bare display name ("Untitled 6") left the GTK save dialog's
      // name field holding a prefix that matches the sibling
      // "Untitled *.lunar" files, so it popped an autocomplete dropdown
      // over the field on open — which read as a "strange non-functional
      // menu". A finished name has nothing to autocomplete against.
      defaultPath: path.resolve(
        path.dirname(ctx.archive.path),
        ensureProjectExt(ctx.archive.name),
      ),
      filters: [{ name: 'Lunar Clipper Project', extensions: ['lunar'] }],
    },
  )
  if (canceled || !rawPath) {
    return reply(event, 'saveAsArchive', requestId)
  }

  const newPath = ensureProjectExt(rawPath)
  if (!(await confirmProjectLocation(ctx, path.dirname(newPath))))
    return reply(event, 'saveAsArchive', requestId)
  try {
    // Save As copies the file: nothing may still be writing to it.
    if (!(await ctx.prepareProjectSwitch()))
      return reply(event, 'saveAsArchive', requestId)
    const oldPath = ctx.archive.path
    ctx.stopNameCountWorker()
    await ctx.stopCpuScan()
    await closeDbAsync()
    await fsPromises.copyFile(oldPath, newPath)

    // Update the stored path and name inside the DB
    const newName = projectDisplayName(newPath)
    await updateMetadataPathAndNameAsync(newPath, newPath, newName)

    await ctx.reloadArchiveFrom(newPath)
    ctx.updateWindowTitle()

    ctx.config.lastArchivePath = newPath
    ctx.config.projectName = newName
    ctx.saveConfig()
    ctx.addToRecentProjects(newName, newPath)

    const shallow = await ctx.archive.shallowCopy!()
    return reply(event, 'saveAsArchive', requestId, shallow)
  } catch (error) {
    console.error('Error saving project as:', error)
    return reply(event, 'saveAsArchive', requestId, {
      error: true,
      info: error,
    })
  }
}

export async function getRecentProjects(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  const recents = (ctx.config.recentProjects || []).filter((p) =>
    fs.existsSync(p.path),
  )
  // Update stored list to remove stale entries
  if (recents.length !== (ctx.config.recentProjects || []).length) {
    ctx.config.recentProjects = recents
    ctx.saveConfig()
  }
  return reply(event, 'getRecentProjects', requestId, recents)
}

export async function openRecentProject(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<string>,
) {
  const { requestId, payload: projectPath } = unpackRequest<string>(data)
  if (!projectPath || !fs.existsSync(projectPath)) {
    if (projectPath) ctx.removeFromRecentProjects(projectPath)
    return reply(event, 'openRecentProject', requestId, {
      error: 'Project file not found',
    })
  }

  try {
    if (!(await ctx.prepareProjectSwitch()))
      return reply(event, 'openRecentProject', requestId)
    ctx.stopNameCountWorker()
    await ctx.stopCpuScan()
    await closeDbAsync()
    await ctx.reloadArchiveFrom(projectPath)
    ctx.updateWindowTitle()
    if (!ctx.archive || !ctx.archive.shallowCopy) {
      throw new Error('Failed to load project')
    }
    // Fix legacy projects whose name is still "Untitled"
    if (/^Untitled(\s\d+)?$/.test(ctx.archive.name)) {
      const derivedName = path.basename(projectPath)
      await updateMetadataNameAsync(projectPath, derivedName)
      ctx.archive.name = derivedName
    }

    ctx.config.lastArchivePath = projectPath
    ctx.config.projectName = ctx.archive.name
    ctx.saveConfig()
    ctx.addToRecentProjects(ctx.archive.name, projectPath)
    const shallow = await ctx.archive.shallowCopy()
    return reply(event, 'openRecentProject', requestId, shallow)
  } catch (error) {
    console.error('Error opening recent project:', error)
    return reply(event, 'openRecentProject', requestId, {
      error: true,
      info: error,
    })
  }
}
