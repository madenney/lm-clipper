import '../styles/PathBox.css'

/**
 * A path in three pieces so its end stays readable: everything before the
 * last two parts, the folder above the last part, and the last part
 * ("/home/me/Downloads/", "lunar-200/", "slp").
 */
export function splitPathTail(fullPath: string): [string, string, string] {
  const parts = fullPath.split(/(?<=[\\/])/)
  // Trailing separators belong to the part before them.
  const name = parts.length > 1 ? parts[parts.length - 1] : fullPath
  const parent = parts.length > 2 ? parts[parts.length - 2] : ''
  const head = fullPath.slice(0, fullPath.length - name.length - parent.length)
  if (!head) return ['', '', fullPath]
  return [head, parent, name]
}

/**
 * A read-only folder path that shows its end: a long path is cut in the
 * middle ("/home/me/Dow…/lunar-200/slp"), not at the end where the folder's
 * own name is; the start goes first, then the folder above, the name last.
 * The full path is in the tooltip. Used by the SLPZ and ZIP import wizards.
 */
export default function PathBox({
  path: fullPath,
  placeholder,
  className = '',
}: {
  path: string
  placeholder?: string
  className?: string
}) {
  if (!fullPath)
    return (
      <div className={`path-box path-box--empty ${className}`}>
        {placeholder}
      </div>
    )
  const [head, parent, name] = splitPathTail(fullPath)
  return (
    <div
      className={`path-box ${className}`}
      title={fullPath}
      aria-label={fullPath}
      data-testid="path-box"
    >
      {head ? <span className="path-box-head">{head}</span> : null}
      {parent ? <span className="path-box-parent">{parent}</span> : null}
      <span className="path-box-name">{name}</span>
    </div>
  )
}
