// Type-check ratchet.
//
// The codebase has a backlog of pre-existing `tsc` errors being burned down
// incrementally. This gate fails CI if the error count EXCEEDS the committed
// baseline in `.tsc-error-baseline` — so no NEW type errors can land — while
// tolerating the known backlog. As errors are fixed, lower the baseline (never
// raise it). Goal: baseline 0, then flip this to a plain `tsc --noEmit`.
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const baselineFile = path.resolve(__dirname, '../../.tsc-error-baseline')
const baseline = parseInt(fs.readFileSync(baselineFile, 'utf8').trim(), 10)

let output = ''
try {
  output = execSync('npx tsc --noEmit -p tsconfig.typecheck.json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (e) {
  output = `${e.stdout || ''}${e.stderr || ''}`
}
const count = (output.match(/error TS\d+/g) || []).length

if (count > baseline) {
  console.error(
    `✗ tsc errors increased: ${count} > baseline ${baseline}.\n` +
      '  New type errors were introduced — fix them, do not raise the baseline.\n',
  )
  console.error(output)
  process.exit(1)
}

if (count < baseline) {
  console.log(
    `✓ tsc errors: ${count} (baseline ${baseline}). ` +
      `Backlog shrank — lower .tsc-error-baseline to ${count}.`,
  )
} else {
  console.log(`✓ tsc errors: ${count} (at baseline ${baseline}).`)
}
process.exit(0)
