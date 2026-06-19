/**
 * @jest-environment node
 *
 * Unit tests for the .lunar project-file helpers and the exact path/name
 * compositions used by controller.ts (newProject, saveAsArchive,
 * createNewArchiveInternal, getUntitledName). These helpers are the only
 * logic the .lunar change introduced — createDB's metadata insert is
 * unchanged existing code that stores its `name` argument verbatim, so a
 * correct display name (verified here) is a correct stored name. (A live DB
 * round-trip can't run here: better-sqlite3 is built for Electron's ABI and
 * won't load under the jest/node runtime.)
 */
import path from 'path'
import {
  PROJECT_EXT,
  ensureProjectExt,
  projectDisplayName,
} from '../main/projectFile'

describe('ensureProjectExt', () => {
  it('appends .lunar when missing', () => {
    expect(ensureProjectExt('/tmp/My Combos')).toBe('/tmp/My Combos.lunar')
  })
  it('leaves an existing .lunar untouched', () => {
    expect(ensureProjectExt('/tmp/My Combos.lunar')).toBe(
      '/tmp/My Combos.lunar',
    )
  })
  it('is case-insensitive about the existing extension', () => {
    expect(ensureProjectExt('/tmp/Proj.LUNAR')).toBe('/tmp/Proj.LUNAR')
  })
  it('keeps unrelated dots in the name and still appends', () => {
    expect(ensureProjectExt('/tmp/v2.0.final')).toBe('/tmp/v2.0.final.lunar')
  })
})

describe('projectDisplayName', () => {
  it('strips a trailing .lunar', () => {
    expect(projectDisplayName('/tmp/My Combos.lunar')).toBe('My Combos')
  })
  it('is a no-op for legacy extensionless files', () => {
    expect(projectDisplayName('/tmp/Untitled 6727')).toBe('Untitled 6727')
  })
  it('only strips the final .lunar, not inner dots', () => {
    expect(projectDisplayName('/tmp/v2.0.final.lunar')).toBe('v2.0.final')
  })
  it('does not strip a non-.lunar extension', () => {
    expect(projectDisplayName('/tmp/data.sqlite')).toBe('data.sqlite')
  })
  it('PROJECT_EXT is .lunar', () => {
    expect(PROJECT_EXT).toBe('.lunar')
  })
})

// Each case = what the OS save-dialog hands back (rawPath), and what each
// call site must derive. dir is the chosen directory; the file lands at
// dir/<file> and the app shows <name>.
const cases = [
  { raw: '/projects/My Combos', file: 'My Combos.lunar', name: 'My Combos' },
  {
    raw: '/projects/My Combos.lunar',
    file: 'My Combos.lunar',
    name: 'My Combos',
  }, // user typed the ext
  { raw: '/projects/v2.0.final', file: 'v2.0.final.lunar', name: 'v2.0.final' },
  { raw: '/projects/Untitled 2', file: 'Untitled 2.lunar', name: 'Untitled 2' },
]

describe('newProject composition (dialog path -> file + display name)', () => {
  it.each(cases)('$raw -> $file / "$name"', ({ raw, file, name }) => {
    // controller.newProject:
    const newPath = ensureProjectExt(raw)
    const displayName = projectDisplayName(newPath)
    const location = path.dirname(newPath)
    expect(path.basename(newPath)).toBe(file)
    expect(displayName).toBe(name)

    // ...then createNewArchiveInternal re-resolves and must reconstruct the
    // SAME file path (idempotent) and the SAME display name.
    const rebuilt = ensureProjectExt(path.resolve(location, displayName))
    expect(path.basename(rebuilt)).toBe(file)
    expect(projectDisplayName(rebuilt)).toBe(name)
  })
})

describe('saveAsArchive composition', () => {
  it.each(cases)(
    '$raw -> file $file, stored name "$name"',
    ({ raw, file, name }) => {
      const newPath = ensureProjectExt(raw) // dialog result normalized
      expect(path.basename(newPath)).toBe(file)
      expect(projectDisplayName(newPath)).toBe(name) // newName written to metadata
    },
  )
})

describe('getUntitledName uniqueness probes the .lunar path', () => {
  it('an extensionless "Untitled 2" on disk is detected via its .lunar form', () => {
    // getUntitledName checks fs.existsSync(ensureProjectExt(resolve(dir, name)))
    const probed = ensureProjectExt(path.resolve('/data', 'Untitled 2'))
    expect(probed).toBe(path.join('/data', 'Untitled 2.lunar'))
  })
})
