// Builds the slpz helper from its published source and puts it where electron-builder looks
// for it (release/app/slpz), for the machine's own OS and CPU:
//
//   node .erb/scripts/build-slpz.js [<linux|win|mac> [x64|arm64]]
//
// The same version and `--locked` build on every platform, in CI and locally, instead of
// binaries committed from somebody's machine (their provenance was unknown, and the three
// platforms could have run three different slpz versions). Needs a Rust toolchain
// (https://rustup.rs; the GitHub runners have one). The version is SLPZ_VERSION below: it
// must match the in-process port in src/lib/slpz.ts and THIRD_PARTY_NOTICES.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SLPZ_VERSION = '1.3.0';
const PROJECT_DIR = path.resolve(__dirname, '../..');
const PLATFORMS = { linux: 'linux', win32: 'win32', win: 'win32', darwin: 'darwin', mac: 'darwin' };

/** File name in release/app/slpz, as bundledBinaryName() in src/main/util.ts expects. */
function outputName(platform, arch) {
  const os_ = PLATFORMS[platform];
  if (!os_) throw new Error(`unknown platform "${platform}"`);
  if (os_ === 'win32') return 'slpz-win32-x64.exe';
  if (os_ === 'linux') return 'slpz-linux-x64';
  return `slpz-darwin-${arch}`;
}

function main() {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  if (PLATFORMS[platform] !== PLATFORMS[process.platform] || (PLATFORMS[platform] === 'darwin' && arch !== process.arch)) {
    throw new Error(`slpz is built natively: run this on ${platform}-${arch} (this machine is ${process.platform}-${process.arch})`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-slpz-'));
  try {
    const built = spawnSync('cargo', ['install', 'slpz', '--version', SLPZ_VERSION, '--locked', '--root', root], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (built.error || built.status !== 0) {
      throw new Error(`cargo install slpz@${SLPZ_VERSION} failed${built.error ? `: ${built.error.message}` : ''} (is Rust installed?)`);
    }
    const exe = path.join(root, 'bin', PLATFORMS[platform] === 'win32' ? 'slpz.exe' : 'slpz');
    const outDir = path.join(PROJECT_DIR, 'release', 'app', 'slpz');
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, outputName(platform, arch));
    fs.copyFileSync(exe, dest);
    if (PLATFORMS[platform] !== 'win32') fs.chmodSync(dest, 0o755);
    console.log(`slpz ${SLPZ_VERSION} -> ${path.relative(PROJECT_DIR, dest)} (${fs.statSync(dest).size} bytes)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { SLPZ_VERSION, outputName };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
