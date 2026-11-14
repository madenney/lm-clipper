/**
 * The published source tree (npm run deploy -- clipper) is scanned for the text in
 * src/owner/release-check.json and the deploy stops on any hit. Run the same scan here,
 * so a stray word in a comment, test or doc fails in `npm test`, not on release day.
 * Skipped where src/owner is the empty public stand-in (no release-check.json).
 */
import fs from 'fs'
import path from 'path'

const appDir = path.resolve(__dirname, '..', '..')
const checkFile = path.join(appDir, 'src', 'owner', 'release-check.json')
const SKIP_DIRS = new Set([
  'node_modules',
  'release',
  '.git',
  'dist',
  '.webpack',
])
const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|ejs|yml|yaml|sh|txt|ps1)$/i

function* walk(dir: string, rel = ''): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // The private folder and its public stand-in are not part of the scan.
      if (relPath === 'src/owner' || relPath === 'src/owner-off') continue
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(path.join(dir, entry.name), relPath)
    } else if (TEXT_EXT.test(entry.name)) {
      yield relPath
    }
  }
}

const describeIf = fs.existsSync(checkFile) ? describe : describe.skip

describeIf('public source tree', () => {
  it('has none of the text release-check.json forbids', () => {
    const patterns = (
      JSON.parse(fs.readFileSync(checkFile, 'utf8')).patterns as [
        string,
        string,
      ][]
    ).map(([source, flags]) => new RegExp(source, flags))
    const hits: string[] = []
    for (const rel of walk(appDir)) {
      const text = fs.readFileSync(path.join(appDir, rel), 'utf8')
      for (const re of patterns) {
        if (re.test(text)) hits.push(`${rel}: ${re.source}`)
      }
    }
    expect(hits).toEqual([])
  })
})
