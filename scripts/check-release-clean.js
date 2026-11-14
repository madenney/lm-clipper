#!/usr/bin/env node
// Fails when a release build contains the owner's private tools: run after
// `npm run build`, before packaging. LUNAR_OWNER_BUILD=1 builds skip it. The text to
// look for lives with the private tools (src/owner/release-check.json). The published
// source has no owner-off folder (its src/owner already is the empty one) and no list, so
// there is nothing to find. A tree that has src/owner-off is the private one: it fails
// closed when the list is missing or empty.
const fs = require('fs')
const path = require('path')

if (process.env.LUNAR_OWNER_BUILD === '1') {
  console.log('check-release-clean: owner build, skipped')
  process.exit(0)
}
const listFile = path.join(__dirname, '..', 'src', 'owner', 'release-check.json')
const privateTree = fs.existsSync(path.join(__dirname, '..', 'src', 'owner-off'))
if (!fs.existsSync(listFile)) {
  if (privateTree) {
    console.error('check-release-clean: src/owner-off exists but src/owner/release-check.json is missing; refusing to pass')
    process.exit(1)
  }
  console.log('check-release-clean: no private tools in this tree, nothing to check')
  process.exit(0)
}
let list
try {
  list = JSON.parse(fs.readFileSync(listFile, 'utf8')).patterns
} catch (error) {
  console.error(`check-release-clean: cannot read ${listFile}: ${error.message}`)
  process.exit(1)
}
if (!Array.isArray(list) || !list.length) {
  console.error('check-release-clean: release-check.json has no patterns; refusing to pass')
  process.exit(1)
}
const FORBIDDEN = list.map(([source, flags]) => new RegExp(source, flags))
const dist = path.join(__dirname, '..', 'release', 'app', 'dist')
const hits = []
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.(js|css|html|json|map|txt)$/.test(name)) {
      const text = fs.readFileSync(p, 'utf8')
      for (const re of FORBIDDEN) {
        const m = re.exec(text)
        if (m) hits.push(`${path.relative(dist, p)}: ${re} near "${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}"`)
      }
    }
  }
}
if (!fs.existsSync(dist)) {
  console.error(`check-release-clean: ${dist} not found; run npm run build first`)
  process.exit(1)
}
walk(dist)
if (hits.length) {
  console.error(`check-release-clean: private tools found in the release build:\n  ${hits.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-release-clean: release build is clean (${FORBIDDEN.length} patterns)`)
