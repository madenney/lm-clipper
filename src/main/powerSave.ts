/*
 * Keep the computer from sleeping while Clipper works on something long: a
 * download of the whole database, an unpack, a filter run, a recording. A laptop
 * that sleeps mid-job cuts the network (Modern Standby) and makes Dolphin's
 * frame clock jump, so downloads fail on wake and a recording is judged stalled
 * and killed (launch review WIN-10). The display may still turn off.
 *
 * Reference counted: each job takes a hold and gives it back; the system lock is
 * held while any hold is open.
 */
import { powerSaveBlocker } from 'electron'
import { logMain } from './logger'

let blockerId: number | null = null
const holds = new Set<symbol>()

/** Take a hold. Returns the function that gives it back (safe to call twice). */
export function holdAwake(reason: string): () => void {
  const token = Symbol(reason)
  holds.add(token)
  if (blockerId === null) {
    try {
      blockerId = powerSaveBlocker.start('prevent-app-suspension')
      logMain('power: staying awake', { reason })
    } catch (error) {
      // Not available (tests, a headless run): work goes on without it.
      blockerId = null
      logMain('power: could not stay awake', String(error))
    }
  }
  return () => {
    if (!holds.delete(token)) return
    if (holds.size === 0 && blockerId !== null) {
      try {
        powerSaveBlocker.stop(blockerId)
      } catch {
        /* already stopped */
      }
      blockerId = null
      logMain('power: may sleep again')
    }
  }
}

/** How many holds are open (tests). */
export const awakeHolds = () => holds.size
