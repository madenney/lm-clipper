// Fails packaging when a helper binary (ffmpeg, slpz) that electron-builder
// should copy into resources/ is missing, empty, or built for the wrong OS/CPU.
// electron-builder silently skips an extraResources entry whose `from` does
// not exist, which is how an installer can ship without ffmpeg.
//
// Two ways in:
//   - electron-builder `beforePack` hook (package.json build.beforePack): runs
//     for every platform/arch actually being packaged, with CLI overrides
//     already applied.
//   - CLI: node .erb/scripts/check-bundled-binaries.js <linux|win|mac> [x64|arm64]
//     (defaults to this machine), used by CI before `npm run build`.
//
// The binary names must match bundledBinaryName() in src/main/util.ts.
//
// Windows also ships slippi-dolphin-runner's lunar-hidden-launcher.exe (Hide
// Recording Windows runs Dolphin on a hidden desktop through it), unpacked in
// resources/hidden-launcher/ (src/main/hideLauncher.ts). Without it every
// recording would open visibly, so a Windows build without that entry fails.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '../..');

// builder-util's Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

const PLATFORM_KEYS = { linux: 'linux', win32: 'win', win: 'win', darwin: 'mac', mac: 'mac' };

function readHead(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// Returns a problem string, or null when the file looks like an executable for
// the given platform/arch.
function checkExecutableFormat(file, platformKey, arch) {
  const head = readHead(file, 64);
  if (platformKey === 'win') {
    if (head[0] !== 0x4d || head[1] !== 0x5a) return 'not a Windows executable (no MZ header)';
    return null;
  }
  if (platformKey === 'linux') {
    if (head.readUInt32BE(0) !== 0x7f454c46) return 'not a Linux ELF executable';
    const machine = head.readUInt16LE(18);
    const want = arch === 'arm64' ? 0xb7 : 0x3e;
    if (machine !== want) return `ELF machine 0x${machine.toString(16)} is not ${arch}`;
    return null;
  }
  // macOS: thin 64-bit Mach-O (0xfeedfacf little-endian) or a fat binary.
  const magicLE = head.readUInt32LE(0);
  const magicBE = head.readUInt32BE(0);
  if (magicBE === 0xcafebabe) return null; // fat/universal: contains several arches
  if (magicLE !== 0xfeedfacf) return 'not a 64-bit Mach-O executable';
  const cpu = head.readUInt32LE(4);
  const want = arch === 'arm64' ? 0x0100000c : 0x01000007;
  if (cpu !== want) {
    const got = cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : `0x${cpu.toString(16)}`;
    return `Mach-O is ${got}, expected ${arch}`;
  }
  return null;
}

// A SHA256SUMS file next to a binary (the runner ships one with its hidden launcher) is
// checked against it: returns a problem string, or null when there is none or it matches.
function checkSidecarSums(file) {
  const sums = path.join(path.dirname(file), 'SHA256SUMS');
  if (!fs.existsSync(sums)) return null;
  const name = path.basename(file);
  const line = fs
    .readFileSync(sums, 'utf8')
    .split(/\r?\n/)
    .map((l) => /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(l))
    .find((m) => m && m[2] === name);
  if (!line) return null;
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return got.toLowerCase() === line[1].toLowerCase() ? null : `sha256 ${got} does not match SHA256SUMS (${line[1]})`;
}

function expand(pattern, arch, platformKey) {
  return pattern
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{os\}/g, platformKey)
    .replace(/\$\{platform\}/g, platformKey === 'win' ? 'win32' : platformKey === 'mac' ? 'darwin' : 'linux');
}

// Resources a platform's build must list in extraResources (by destination).
const REQUIRED_RESOURCES = {
  win: [
    {
      to: 'hidden-launcher/lunar-hidden-launcher.exe',
      from: 'node_modules/slippi-dolphin-runner/native/win/bin/lunar-hidden-launcher.exe',
    },
  ],
};

function checkBundledBinaries({ platformKey, arch, extraResources, projectDir = PROJECT_DIR }) {
  const problems = [];
  const checked = [];
  for (const req of REQUIRED_RESOURCES[platformKey] || []) {
    const listed = (extraResources || []).some((e) => e && typeof e === 'object' && e.to === req.to);
    if (!listed) problems.push(`${req.to}: not in build.${platformKey}.extraResources (from ${req.from})`);
  }
  for (const entry of extraResources || []) {
    const from = typeof entry === 'string' ? entry : entry && entry.from;
    if (!from || /[*?{]/.test(from.replace(/\$\{[a-z]+\}/g, ''))) continue; // globs: not a single binary
    const rel = expand(from, arch, platformKey);
    const file = path.resolve(projectDir, rel);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      let hint = '';
      if (platformKey === 'win' && rel.endsWith('.exe') && fs.existsSync(file.slice(0, -4))) {
        hint = ` (found ${path.basename(file.slice(0, -4))} without .exe: copy it to ${path.basename(file)})`;
      }
      problems.push(`${rel}: missing${hint}`);
      continue;
    }
    if (stat.isDirectory()) continue;
    if (stat.size === 0) {
      problems.push(`${rel}: empty file`);
      continue;
    }
    const formatProblem = checkExecutableFormat(file, platformKey, arch) || checkSidecarSums(file);
    if (formatProblem) {
      problems.push(`${rel}: ${formatProblem}`);
      continue;
    }
    checked.push(`${rel} (${(stat.size / 1048576).toFixed(1)} MB)`);
  }
  return { problems, checked };
}

function report({ platformKey, arch }, { problems, checked }) {
  for (const line of checked) console.log(`  • bundled binary ok: ${line}`);
  if (problems.length) {
    const msg =
      `Bundled helper binaries for ${platformKey}-${arch} are not ready:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\nGet them with `npm run fetch:ffmpeg -- <linux|win|mac>` (pinned, sha256-checked) and ' +
      '`npm run build:slpz -- <linux|win|mac>` (needs Rust), and install dependencies (npm ci) for ' +
      'the hidden launcher (see docs/packaging.md), then package again.';
    throw new Error(msg);
  }
}

// electron-builder beforePack hook.
exports.default = async function beforePack(context) {
  const platformKey = PLATFORM_KEYS[context.electronPlatformName];
  const arch = ARCH_NAMES[context.arch] || String(context.arch);
  const extraResources = context.packager.platformSpecificBuildOptions.extraResources;
  const projectDir = context.packager.info.projectDir || PROJECT_DIR;
  report({ platformKey, arch }, checkBundledBinaries({ platformKey, arch, extraResources, projectDir }));
};

exports.checkBundledBinaries = checkBundledBinaries;

if (require.main === module) {
  const platformKey = PLATFORM_KEYS[process.argv[2] || process.platform];
  const arch = process.argv[3] || process.arch;
  if (!platformKey) {
    console.error('usage: check-bundled-binaries.js <linux|win|mac> [x64|arm64]');
    process.exit(2);
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const { build } = require(path.join(PROJECT_DIR, 'package.json'));
  try {
    report(
      { platformKey, arch },
      checkBundledBinaries({ platformKey, arch, extraResources: (build[platformKey] || {}).extraResources })
    );
  } catch (err) {
    console.error(`::error::${err.message.split('\n').join('%0A')}`);
    console.error(err.message);
    process.exit(1);
  }
}
