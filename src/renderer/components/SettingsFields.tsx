import { useEffect, useRef, useState } from 'react'

/**
 * Settings text boxes that commit when the user is done typing, not on every keystroke. A path
 * saved letter by letter ("D", "D:", "D:\Sl...") pointed the Replay Library at half-typed folders,
 * and a number box emptied to retype saved NaN.
 */

/** A path pasted from Explorer's "Copy as path" comes quoted. */
export const cleanPath = (raw: string) =>
  raw.replace(/^\s*(["'])(.*)\1\s*$/, '$2').trim()

/** A path box: edits stay local; blur, Enter or closing Settings commits them. `onCommit` gets the
 *  cleaned path and a `revert` that puts the box back to the saved value (a refused change). */
export function PathField({
  id,
  value,
  placeholder,
  onCommit,
  readOnly,
  title,
}: {
  id: string
  value: string
  placeholder?: string
  /** Shown but not typeable (the Replay Library moves only through Browse). */
  readOnly?: boolean
  title?: string
  onCommit: (_path: string, _revert: () => void) => void
}) {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const valueRef = useRef(value)
  valueRef.current = value
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  // The saved value changed under us (Browse, a reset): show it.
  useEffect(() => setDraft(value), [value])

  const commit = () => {
    const next = cleanPath(draftRef.current)
    if (next === valueRef.current) {
      setDraft(next)
      return
    }
    commitRef.current(next, () => setDraft(valueRef.current))
  }
  // Closing Settings with the cursor still in the box keeps what was typed.
  useEffect(
    () => () => {
      const next = cleanPath(draftRef.current)
      if (next !== valueRef.current) commitRef.current(next, () => {})
    },
    [],
  )

  return (
    <input
      type="text"
      id={id}
      className="settings-path-input"
      value={draft}
      placeholder={placeholder}
      readOnly={readOnly}
      title={title}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
    />
  )
}

/** Limits for the settings that have an obvious range; the rest only refuse a non-number. */
export const INT_LIMITS: Record<string, [number, number]> = {
  numCPUs: [1, 64],
  numFilterThreads: [1, 64],
  slice: [1, 999999],
  bitrateKbps: [1, 1_000_000],
  crf: [0, 51],
}

/** The number a typed draft means for setting `id`, clamped to its range, or null when it is not a
 *  number (an emptied box: the saved value stays). */
export function commitInt(id: string, draft: string): number | null {
  const n = parseInt(draft, 10)
  if (!Number.isFinite(n)) return null
  const limits = INT_LIMITS[id]
  return limits ? Math.min(limits[1], Math.max(limits[0], n)) : n
}

/** A whole-number box: a draft while typing, a valid (clamped) number on blur or Enter. */
export function IntField({
  id,
  value,
  onCommit,
}: {
  id: string
  value: number
  onCommit: (_n: number) => void
}) {
  const [draft, setDraft] = useState(String(value ?? ''))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const valueRef = useRef(value)
  valueRef.current = value
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  useEffect(() => setDraft(String(value ?? '')), [value])

  const commit = () => {
    const n = commitInt(id, draftRef.current)
    if (n === null) {
      setDraft(String(valueRef.current ?? ''))
      return
    }
    setDraft(String(n))
    if (n !== valueRef.current) commitRef.current(n)
  }
  useEffect(
    () => () => {
      const n = commitInt(id, draftRef.current)
      if (n !== null && n !== valueRef.current) commitRef.current(n)
    },
    [id],
  )

  const limits = INT_LIMITS[id]
  return (
    <input
      type="number"
      id={id}
      className="settings-input settings-input--number"
      value={draft}
      min={limits?.[0]}
      max={limits?.[1]}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
    />
  )
}
