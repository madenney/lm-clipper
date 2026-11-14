// Downloads the ffmpeg build pinned in .erb/ffmpeg-pins.json for one platform, checks its
// sha256 and puts the binary where electron-builder looks for it (release/app/ffmpeg).
// Used by the release and CI workflows and for local packaging:
//
//   node .erb/scripts/fetch-ffmpeg.js <linux|win|mac> [x64|arm64]   (defaults to this machine)
//
// A file that does not match its pinned sha256 stops the build: nothing unpinned is ever
// shipped. The hosts rate-limit cloud runners and answer a throttled request with a small
// HTML page, so a download is retried with backoff.
// FFMPEG_MIRROR_BASE (optional): a URL prefix that holds copies of the same files (for
// example a bucket the project owns); it is tried first and the pinned sha256 still decides.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '../..');
const PINS_FILE = path.join(PROJECT_DIR, '.erb', 'ffmpeg-pins.json');
const PLATFORMS = { linux: 'linux', win32: 'win32', win: 'win32', darwin: 'darwin', mac: 'darwin' };

/** The pin entry for a platform/arch ('linux'|'win'|'mac'|node names). Throws when there is none. */
function pinFor(platform, arch, pins = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'))) {
  const os_ = PLATFORMS[platform];
  if (!os_) throw new Error(`unknown platform "${platform}"`);
  const key = `${os_}-${arch}`;
  const pin = pins[key];
  if (!pin || typeof pin !== 'object') throw new Error(`no ffmpeg pin for ${key} in .erb/ffmpeg-pins.json`);
  for (const field of ['version', 'url', 'sha256', 'archive', 'member']) {
    if (!pin[field]) throw new Error(`ffmpeg pin ${key} has no ${field}`);
  }
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) throw new Error(`ffmpeg pin ${key}: sha256 is not 64 hex characters`);
  if (!/^https:\/\//.test(pin.url)) throw new Error(`ffmpeg pin ${key}: url is not https`);
  return { key, ...pin };
}

/** Where the binary goes, named as bundledBinaryName() in src/main/util.ts expects. */
function outputName(platform, arch) {
  const os_ = PLATFORMS[platform];
  if (os_ === 'win32') return 'ffmpeg-win32-x64.exe';
  if (os_ === 'linux') return 'ffmpeg-linux-x64';
  return `ffmpeg-darwin-${arch}`;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (lunar-clipper-release)' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Downloads `pin` into `dir`, retrying; returns the file path once its sha256 matches. */
async function fetchPinned(pin, dir, { attempts = 5, backoffMs = 15000, mirror = process.env.FFMPEG_MIRROR_BASE } = {}) {
  const file = path.join(dir, path.basename(new URL(pin.url).pathname));
  const urls = [];
  if (mirror) urls.push(`${mirror.replace(/\/+$/, '')}/${path.basename(file)}`);
  urls.push(pin.url);
  let last = 'no attempt';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const url of urls) {
      fs.rmSync(file, { force: true });
      try {
        await download(url, file);
        const got = sha256File(file);
        if (got === pin.sha256) return file;
        last = `${url}: sha256 ${got} is not the pinned ${pin.sha256} (${fs.statSync(file).size} bytes)`;
      } catch (error) {
        last = `${url}: ${error.message}`;
      }
      console.log(`ffmpeg download attempt ${attempt} failed: ${last}`);
    }
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  throw new Error(`ffmpeg ${pin.version} download failed or does not match its pinned sha256 after ${attempts} attempts: ${last}`);
}

function extractFromZip(zipFile, member, dest) {
  // yauzl is a dependency of the app: no unzip/PowerShell needed on any runner.
  // eslint-disable-next-line global-require
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let found = false;
      zip.on('error', reject);
      zip.on('end', () => {
        if (!found) reject(new Error(`${member} is not in ${path.basename(zipFile)}`));
      });
      zip.on('entry', (entry) => {
        if (entry.fileName !== member) return zip.readEntry();
        found = true;
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const out = fs.createWriteStream(dest);
          stream.pipe(out);
          out.on('finish', () => {
            zip.close();
            resolve();
          });
          out.on('error', reject);
          stream.on('error', reject);
        });
      });
      zip.readEntry();
    });
  });
}

function extractFromTar(tarFile, member, dest, dir) {
  const result = spawnSync('tar', ['-xf', tarFile, '-C', dir, member], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`tar could not extract ${member} from ${path.basename(tarFile)}`);
  fs.copyFileSync(path.join(dir, member), dest);
}

async function main() {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  const pin = pinFor(platform, arch);
  const outDir = path.join(PROJECT_DIR, 'release', 'app', 'ffmpeg');
  const dest = path.join(outDir, outputName(platform, arch));
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-ffmpeg-'));
  try {
    console.log(`ffmpeg ${pin.version} for ${pin.key}: ${pin.url}`);
    const archive = await fetchPinned(pin, work);
    console.log(`sha256 ok: ${pin.sha256}`);
    if (pin.archive === 'zip') await extractFromZip(archive, pin.member, dest);
    else extractFromTar(archive, pin.member, dest, work);
    if (PLATFORMS[platform] !== 'win32') fs.chmodSync(dest, 0o755);
    console.log(`ffmpeg ${pin.version} -> ${path.relative(PROJECT_DIR, dest)} (${fs.statSync(dest).size} bytes)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { pinFor, outputName, sha256File, fetchPinned };

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
