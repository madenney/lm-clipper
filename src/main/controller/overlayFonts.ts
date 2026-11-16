import { app, dialog, IpcMainEvent } from 'electron'
import type { ControllerCore } from './context'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import { logMain } from '../logger'
import {
  OVERLAY_FONT_EXTS,
  importOverlayFonts,
  listOverlayFonts,
  overlayFontPath,
  overlayFontsDir,
  removeOverlayFont,
} from '../overlayFonts'
import { renderOverlayPreview } from '../overlayRenderer'

// Settings > Overlay: the fonts the user imported for the text burned into
// recordings, and a preview drawn by the recording's own renderer.

type Ctx = Pick<ControllerCore, 'mainWindow'>

const fontsDir = () => overlayFontsDir(app.getPath('userData'))

export async function overlayFontsList(
  _ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  return reply(event, 'overlayFontsList', requestId, {
    fonts: await listOverlayFonts(fontsDir()),
  })
}

/** Ask for font files and copy the good ones into Clipper's own folder. */
export async function overlayFontsImport(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  const dir = fontsDir()
  const { canceled, filePaths } = await dialog.showOpenDialog(ctx.mainWindow, {
    title: 'Import fonts for the overlay',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Fonts',
        extensions: OVERLAY_FONT_EXTS.map((ext) => ext.slice(1)),
      },
    ],
  })
  const picked = canceled ? [] : filePaths
  const result = await importOverlayFonts(dir, picked)
  if (result.failed.length > 0)
    logMain('overlay fonts: not imported', result.failed)
  return reply(event, 'overlayFontsImport', requestId, {
    ...result,
    canceled: picked.length === 0,
    fonts: await listOverlayFonts(dir),
  })
}

export async function overlayFontsRemove(
  _ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<string>,
) {
  const { requestId, payload } = unpackRequest<string>(data)
  const dir = fontsDir()
  const removed =
    typeof payload === 'string' ? await removeOverlayFont(dir, payload) : false
  return reply(event, 'overlayFontsRemove', requestId, {
    removed,
    fonts: await listOverlayFonts(dir),
  })
}

/** The label as a recording draws it (1080p), as a PNG data URL; null for no text. */
export async function overlayPreview(
  _ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<{ text: string; font?: string; size?: number }>,
) {
  const { requestId, payload } = unpackRequest<{
    text: string
    font?: string
    size?: number
  }>(data)
  let dataUrl: string | null = null
  try {
    const png = renderOverlayPreview(
      typeof payload?.text === 'string' ? payload.text : '',
      {
        fontPath: overlayFontPath(fontsDir(), payload?.font),
        fontSize: payload?.size,
      },
    )
    if (png) dataUrl = `data:image/png;base64,${png.toString('base64')}`
  } catch (err) {
    logMain('overlay preview failed', String(err))
  }
  return reply(event, 'overlayPreview', requestId, { dataUrl })
}
