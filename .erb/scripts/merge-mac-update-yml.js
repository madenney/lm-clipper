// Merges the per-arch macOS update files (latest-mac-x64.yml +
// latest-mac-arm64.yml, likewise beta-mac-*.yml) that the separate arm64 and
// x64 packaging jobs write into one latest-mac.yml listing both zips.
// electron-updater on an Apple Silicon Mac picks the file whose URL contains
// "arm64"; Intel Macs pick the others. The top-level path/sha512 (read only by
// very old updaters) come from the x64 file, which also runs under Rosetta.
//
// usage: node merge-mac-update-yml.js <dir>
// Rewrites every <channel>-mac-<arch>.yml group in <dir> into <channel>-mac.yml
// and removes the per-arch files. The format is electron-builder's own simple
// YAML (version, files list, path, sha512, releaseDate), parsed line by line.
const fs = require('fs');
const path = require('path');

function parse(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = [];
  const files = [];
  const tail = [];
  let section = head;
  for (const line of lines) {
    if (line === 'files:') {
      section = files;
      continue;
    }
    if (section === files && !line.startsWith('  ')) section = tail;
    section.push(line);
  }
  return { head, files, tail };
}

function merge(parts) {
  // parts: [{ arch, text }], x64 first when present.
  parts.sort((a, b) => (a.arch === 'x64' ? -1 : b.arch === 'x64' ? 1 : 0));
  const parsed = parts.map((p) => ({ arch: p.arch, ...parse(p.text) }));
  const base = parsed[0];
  const versions = new Set(parsed.map((p) => p.head.find((l) => l.startsWith('version:'))));
  if (versions.size !== 1) throw new Error(`version mismatch: ${[...versions].join(' / ')}`);
  const files = parsed.flatMap((p) => p.files);
  return [...base.head, 'files:', ...files, ...base.tail].join('\n');
}

function main(dir) {
  const groups = new Map();
  for (const name of fs.readdirSync(dir)) {
    const m = /^(.+-mac)-(x64|arm64)\.yml$/.exec(name);
    if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push({ arch: m[2], file: path.join(dir, name) });
  }
  if (!groups.size) {
    console.log('no per-arch mac update files found');
    return;
  }
  for (const [channel, entries] of groups) {
    const merged = merge(entries.map((e) => ({ arch: e.arch, text: fs.readFileSync(e.file, 'utf8') })));
    fs.writeFileSync(path.join(dir, `${channel}.yml`), merged.endsWith('\n') ? merged : `${merged}\n`);
    for (const e of entries) fs.unlinkSync(e.file);
    console.log(`${channel}.yml <- ${entries.map((e) => e.arch).join(' + ')}`);
  }
}

module.exports = { merge };

if (require.main === module) {
  if (!process.argv[2]) {
    console.error('usage: merge-mac-update-yml.js <dir>');
    process.exit(2);
  }
  main(process.argv[2]);
}
