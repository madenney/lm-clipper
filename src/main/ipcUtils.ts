import { IpcMainEvent } from 'electron'
import { ArchiveInterface, ShallowArchiveInterface } from '../constants/types'

export type RequestEnvelope<T> = {
  requestId?: string
  payload?: T
}

export const unpackRequest = <T>(
  data: unknown,
): { requestId?: string; payload: T } => {
  if (data && typeof data === 'object') {
    const record = data as { requestId?: string; payload?: T }
    if ('requestId' in record && 'payload' in record) {
      return { requestId: record.requestId, payload: record.payload as T }
    }
  }
  return { requestId: undefined, payload: data as T }
}

export const reply = (
  event: IpcMainEvent,
  channel: string,
  requestId: string | undefined,
  payload?: unknown,
) => {
  if (requestId) {
    event.reply(channel, { requestId, payload })
  } else {
    event.reply(channel, payload)
  }
}

export const buildShallowArchive = (
  archive: ArchiveInterface | null,
): ShallowArchiveInterface | null => {
  if (!archive) return null
  return {
    path: archive.path,
    name: archive.name,
    createdAt: archive.createdAt,
    // Preserve null (= count not yet hydrated) so the renderer shows a spinner
    // instead of a misleading 0 and knows to lazily fetch the real count.
    files: archive.files ?? null,
    filters: (archive.filters || []).map((filter) => ({
      id: filter.id,
      type: filter.type,
      label: filter.label,
      isProcessed: filter.isProcessed,
      params: filter.params,
      results: filter.results,
      ...(filter.resumable
        ? {
            resumable: true,
            ...(filter.resumeProgress
              ? { resumeProgress: filter.resumeProgress }
              : {}),
          }
        : {}),
    })),
  }
}
