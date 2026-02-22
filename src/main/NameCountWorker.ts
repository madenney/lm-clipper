import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'

type NameCountRequest = { type: 'getNames' } | { type: 'getConnectCodes' }

type NameCountResponse =
  | { type: 'names'; data: { name: string; total: number }[] }
  | { type: 'connectCodes'; data: { name: string; total: number }[] }
  | { type: 'error'; error: string }

const postMessage = (message: NameCountResponse) => {
  parentPort?.postMessage(message)
}

if (!parentPort) {
  throw new Error('NameCountWorker missing parent port')
}

const { dbPath } = workerData as { dbPath: string }
const db = new Database(dbPath, { readonly: true })
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

parentPort.on('message', (message: NameCountRequest) => {
  try {
    if (message.type === 'getNames') {
      const rows = db
        .prepare(
          `SELECT
             JSON_EXTRACT(je.value, '$.displayName') AS name,
             COUNT(*) AS total
           FROM files, JSON_EACH(files.players) AS je
           WHERE name IS NOT NULL AND name != ''
           GROUP BY name
           ORDER BY total DESC`,
        )
        .all() as { name: string; total: number }[]
      postMessage({ type: 'names', data: rows })
    } else if (message.type === 'getConnectCodes') {
      const rows = db
        .prepare(
          `SELECT
             JSON_EXTRACT(je.value, '$.connectCode') AS name,
             COUNT(*) AS total
           FROM files, JSON_EACH(files.players) AS je
           WHERE name IS NOT NULL AND name != ''
           GROUP BY name
           ORDER BY total DESC`,
        )
        .all() as { name: string; total: number }[]
      postMessage({ type: 'connectCodes', data: rows })
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error)
    postMessage({ type: 'error', error: errorText })
  }
})
