/*
 * Windows runtime verification for the Dolphin `--user` profile isolation.
 * =======================================================================
 * The `--user` refactor (commits 31aec14 / b850e5c) is verified on Linux, and
 * its Windows *path resolution* is unit-tested — but nothing has confirmed that
 * a real Windows Slippi Playback Dolphin actually HONORS `--user` at runtime
 * and finds `Sys/` relative to its own binary. This script confirms exactly
 * that, on a Windows machine, without touching the app.
 *
 * WHAT IT DOES (mirrors buildWorkerProfile in src/main/slpToVideo.ts):
 *   1. Reads dolphinPath + ssbmIsoPath from %APPDATA%\lm-clipper\lm-clipper.json
 *      (override with SPIKE_DOLPHIN / SPIKE_ISO env vars, or pass a .slp arg).
 *   2. Snapshots (sha256) the REAL profile inis under <dolphinDir>\User.
 *   3. Builds a throwaway --user temp profile: copies the real GFX.ini/Dolphin.ini
 *      and applies the recording overrides to the COPIES (dump flags ON, EFBScale,
 *      bitrate, aspect), plus a fresh GALE01/Hotkeys. Preserves UseFFV1.
 *   4. Records ~8s of assets\test.slp with the app's exact flags + `--user`.
 *   5. Checks a non-trivial .avi (+ .wav) came out, and that the REAL profile is
 *      byte-identical before/after.
 *
 * PASS  = boots + dumps a valid video from the temp --user profile AND the real
 *         profile is untouched  ->  Windows --user is safe to ship.
 * FAIL  = no output / real profile changed  ->  STOP, capture the log, report.
 *
 * RUN (from a Windows checkout, with lm-clipper configured at least once):
 *     node scripts\windows\verify-dolphin-user.js
 *   optional:  node scripts\windows\verify-dolphin-user.js "C:\path\to\some.slp"
 *
 * Zero dependencies (built-in Node only). ffprobe is used if on PATH; otherwise
 * the video is validated by file size.
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const log = (...a) => console.log('[verify]', ...a)
const isWin = process.platform === 'win32'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
let cfg = {}
try {
  cfg = JSON.parse(fs.readFileSync(path.join(APPDATA, 'lm-clipper', 'lm-clipper.json'), 'utf8'))
} catch (e) {
  log('WARN could not read lm-clipper.json:', e.message)
}
const DOLPHIN = process.env.SPIKE_DOLPHIN || cfg.dolphinPath
const ISO = process.env.SPIKE_ISO || cfg.ssbmIsoPath
const RES = cfg.resolution != null ? cfg.resolution : 7
const BITRATE = cfg.bitrateKbps != null ? cfg.bitrateKbps : 50000
const WIDE = cfg.widescreen !== false

// Windows portable profile layout (matches resolveDolphinIniPaths, Windows branch)
const dolphinDir = DOLPHIN ? path.dirname(DOLPHIN) : ''
const realConfigDir = path.join(dolphinDir, 'User', 'Config')
const realGameSettingsDir = path.join(dolphinDir, 'User', 'GameSettings')
const realGfx = path.join(realConfigDir, 'GFX.ini')
const realDolphin = path.join(realConfigDir, 'Dolphin.ini')
const realGale = path.join(realGameSettingsDir, 'GALE01.ini')

// Default replay: the bundled assets\test.slp, else the arg, else scan Documents\Slippi
function pickReplay() {
  const arg = process.argv[2]
  if (arg && fs.existsSync(arg)) return arg
  const bundled = path.resolve(__dirname, '..', '..', 'assets', 'test.slp')
  if (fs.existsSync(bundled)) return bundled
  const root = path.join(os.homedir(), 'Documents', 'Slippi')
  const stack = [root]
  try {
    while (stack.length) {
      const d = stack.pop()
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n)
        let st
        try { st = fs.statSync(p) } catch { continue }
        if (st.isDirectory()) stack.push(p)
        else if (n.toLowerCase().endsWith('.slp')) return p
      }
    }
  } catch {}
  return null
}

const sha = (p) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return 'MISSING' }
}
const snapshot = () => ({ gfx: sha(realGfx), dolphin: sha(realDolphin), gale: sha(realGale) })

// last frame from the .slp UBJSON footer (no slippi-js dependency)
function lastFrameOf(slp) {
  try {
    const b = fs.readFileSync(slp)
    const i = b.lastIndexOf(Buffer.from('lastFrame'))
    if (i < 0) return null
    if (b.slice(i + 9, i + 10).toString() !== 'l') return null // 'l' = int32 marker
    return b.readInt32BE(i + 10)
  } catch { return null }
}

// transform ini lines: rewrite a matched prefix, pass everything else through
function transform(srcFile, rules) {
  const out = []
  const lines = fs.readFileSync(srcFile, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    let done = false
    for (const [prefix, val] of rules) {
      if (line.startsWith(prefix)) { out.push(val); done = true; break }
    }
    if (!done) out.push(line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
;(async () => {
  if (!isWin) log('NOTE: platform is not win32 — this is the Windows verifier, but continuing anyway.')
  log('config:')
  log('  dolphin :', DOLPHIN)
  log('  iso     :', ISO)
  log('  real profile dir:', path.join(dolphinDir, 'User'))
  for (const [k, v] of [['dolphin', DOLPHIN], ['iso', ISO]]) {
    if (!v || !fs.existsSync(v)) { log(`FATAL: ${k} not found:`, v); process.exit(2) }
  }
  for (const [k, v] of [['GFX.ini', realGfx], ['Dolphin.ini', realDolphin]]) {
    if (!fs.existsSync(v)) { log(`FATAL: real ${k} not found at`, v, '\n  (open Slippi Dolphin once so it writes its profile, then retry)'); process.exit(2) }
  }
  const replay = pickReplay()
  if (!replay) { log('FATAL: no .slp replay found (pass one as an argument)'); process.exit(2) }
  log('  replay  :', replay)

  const lastFrame = lastFrameOf(replay)
  const endFrame = lastFrame && lastFrame > 60 ? Math.min(lastFrame, 480) : 480
  log('  lastFrame:', lastFrame, '-> recording to endFrame', endFrame)

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmclip-verify-user-'))
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmclip-verify-dump-'))
  fs.mkdirSync(path.join(userDir, 'Config'), { recursive: true })
  fs.mkdirSync(path.join(userDir, 'GameSettings'), { recursive: true })

  // Build the temp --user profile (mirrors buildWorkerProfile)
  fs.writeFileSync(path.join(userDir, 'GameSettings', 'GALE01.ini'),
    '[Gecko]\n[Gecko_Enabled]\n[Gecko_Disabled]\n')
  fs.writeFileSync(path.join(userDir, 'Config', 'GFX.ini'), transform(realGfx, [
    ['AspectRatio', `AspectRatio = ${WIDE ? 6 : 5}`],
    ['InternalResolutionFrameDumps', 'InternalResolutionFrameDumps = True'],
    ['BitrateKbps', `BitrateKbps = ${BITRATE}`],
    ['EFBScale', `EFBScale = ${RES}`],
  ]))
  fs.writeFileSync(path.join(userDir, 'Config', 'Dolphin.ini'), transform(realDolphin, [
    ['DumpFrames ', 'DumpFrames = True'],
    ['DumpFramesSilent ', 'DumpFramesSilent = True'],
    ['DumpAudio ', 'DumpAudio = True'],
    ['DumpAudioSilent ', 'DumpAudioSilent = True'],
  ]))
  fs.writeFileSync(path.join(userDir, 'Config', 'Hotkeys.ini'), '[Hotkeys1]\nDevice = /0/\n')

  // sanity: UseFFV1 carried through from the real profile?
  const gfx = fs.readFileSync(path.join(userDir, 'Config', 'GFX.ini'), 'utf8')
  log('  temp GFX UseFFV1:', (gfx.match(/^UseFFV1 = .*/m) || ['(absent)'])[0],
      '| EFBScale:', (gfx.match(/^EFBScale = .*/m) || [])[0])

  const commPath = path.join(userDir, 'comm.json')
  fs.writeFileSync(commPath, JSON.stringify({
    mode: 'normal', replay, startFrame: -123, endFrame,
    isRealTimeMode: false, commandId: crypto.randomBytes(12).toString('hex'),
  }))

  const before = snapshot()
  log('real profile sha (before):', JSON.stringify(before))

  const args = ['-i', commPath, '-o', 'verify-unmerged', `--output-directory=${outDir}`,
    '-b', '-e', ISO, '--user', userDir, '--cout']
  log('spawn:', DOLPHIN, args.join(' '))

  const proc = spawn(DOLPHIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let saw = false, last = null, lastProgress = Date.now(), done = false
  const stderrTail = []

  const killTree = () => {
    try {
      if (isWin && proc.pid) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
      else proc.kill('SIGKILL')
    } catch {}
  }
  const finish = (why) => { if (done) return; done = true; log('terminating —', why); try { proc.kill(); } catch {}; setTimeout(killTree, 2500) }

  const bootTimer = setTimeout(() => { if (!saw) finish('BOOT STALE — no first frame in 90s') }, 90000)
  const stallTimer = setInterval(() => { if (saw && Date.now() - lastProgress > 30000) finish('FRAME STALL — 30s no progress') }, 5000)
  const hardTimer = setTimeout(() => finish('HARD TIMEOUT (180s)'), 180000)

  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (line.startsWith('[CURRENT_FRAME]')) {
        if (!saw) { saw = true; log('FIRST FRAME — boot OK') }
        lastProgress = Date.now()
        last = parseInt(line.slice('[CURRENT_FRAME]'.length).trim(), 10)
        if (last >= endFrame) finish(`reached endFrame ${endFrame}`)
      } else if (/error|fail|cannot|unable|missing/i.test(line)) {
        log('stdout(!):', line)
      }
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d) => { stderrTail.push(d); if (stderrTail.length > 40) stderrTail.shift() })

  await new Promise((res) => {
    proc.on('exit', () => res())
    proc.on('error', (e) => { log('spawn error:', e.message); res() })
  })
  clearTimeout(bootTimer); clearInterval(stallTimer); clearTimeout(hardTimer)
  log('dolphin exited | lastFrame:', last)

  // ---- evaluate ----
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
  log('output dir:', JSON.stringify(files))
  const avi = files.filter((f) => f.toLowerCase().endsWith('.avi'))
    .map((f) => path.join(outDir, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
  const wav = files.some((f) => f.toLowerCase().endsWith('.wav'))

  let videoOk = false, probeInfo = ''
  if (avi) {
    const sz = fs.statSync(avi).size
    const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', avi], { encoding: 'utf8' })
    if (pr.status === 0) {
      try {
        const s = JSON.parse(pr.stdout).streams[0]
        probeInfo = `${s.codec_name} ${s.width}x${s.height} frames=${s.nb_read_frames}`
        videoOk = Number(s.width) > 0 && Number(s.nb_read_frames) > 30
      } catch {}
    } else {
      probeInfo = '(ffprobe not on PATH — validating by size)'
      videoOk = sz > 500000 // >0.5MB of dump = real video
    }
    log('avi:', path.basename(avi), (sz / 1e6).toFixed(1) + 'MB', probeInfo)
  } else log('NO .avi produced')

  const after = snapshot()
  const untouched = JSON.stringify(before) === JSON.stringify(after)
  log('real profile sha (after) :', JSON.stringify(after))

  const pass = saw && videoOk && untouched
  log('')
  log('=============== WINDOWS --user VERDICT ===============')
  log('  booted from temp --user profile :', saw ? 'YES' : 'NO')
  log('  valid video dumped              :', videoOk ? 'YES' : 'NO', wav ? '(+wav)' : '(no wav)')
  log('  real profile untouched          :', untouched ? 'YES' : 'NO')
  log('  ----------------------------------------------------')
  log('  RESULT:', pass ? 'PASS — Windows --user is safe to ship' : 'FAIL — STOP, report the log below')
  log('=====================================================')
  if (!pass) { log('last stderr:'); log(stderrTail.join('').slice(-2000)) }
  log('temp user profile:', userDir)
  log('dump dir         :', outDir)
  process.exit(pass ? 0 : 1)
})().catch((e) => { log('HARNESS ERROR:', e); process.exit(3) })
