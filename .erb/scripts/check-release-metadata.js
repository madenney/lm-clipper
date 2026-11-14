// Fails when the numbers a release depends on do not agree:
//   package.json version == release/app/package.json version (electron-builder takes the
//   installer, latest.yml and the in-app version from release/app) == both lockfiles'
//   own version == the newest entry of src/constants/changelog.ts (the "What's new" window)
//   == the git tag (when one is given).
//
//   node .erb/scripts/check-release-metadata.js [v3.0.0]
//
// The release workflow runs it first, with the tag; `npm test` runs it without one
// (src/__tests__/releaseMetadata.test.ts), so a half-done version bump fails in CI before
// anyone tags.
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '../..');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The newest (first) changelog entry: { version, date } or null. */
function newestChangelogEntry(source) {
  const m = /version:\s*'([^']+)',\s*date:\s*'([^']+)'/.exec(source);
  return m ? { version: m[1], date: m[2] } : null;
}

/** { problems, warnings, version } for the tree at projectDir; `tag` like "v3.0.0" is optional. */
function checkReleaseMetadata({ projectDir = PROJECT_DIR, tag, today = new Date().toISOString().slice(0, 10) } = {}) {
  const problems = [];
  const warnings = [];
  const root = readJson(path.join(projectDir, 'package.json'));
  const app = readJson(path.join(projectDir, 'release', 'app', 'package.json'));
  const version = root.version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '')) problems.push(`package.json version "${version}" is not a version`);
  if (app.version !== version) {
    problems.push(`release/app/package.json is ${app.version} but package.json is ${version} (electron-builder uses release/app's)`);
  }
  for (const rel of ['package-lock.json', path.join('release', 'app', 'package-lock.json')]) {
    const file = path.join(projectDir, rel);
    if (!fs.existsSync(file)) {
      problems.push(`${rel.replace(/\\/g, '/')} is missing (the shipped dependencies must be locked)`);
      continue;
    }
    const lock = readJson(file);
    const lockVersion = (lock.packages && lock.packages[''] && lock.packages[''].version) || lock.version;
    if (lockVersion !== version) problems.push(`${rel.replace(/\\/g, '/')} says ${lockVersion}: run npm install --package-lock-only --ignore-scripts there`);
  }
  const changelog = newestChangelogEntry(fs.readFileSync(path.join(projectDir, 'src', 'constants', 'changelog.ts'), 'utf8'));
  if (!changelog) {
    problems.push('src/constants/changelog.ts has no entry');
  } else {
    if (changelog.version !== version) problems.push(`the newest changelog entry is ${changelog.version}, not ${version}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(changelog.date)) problems.push(`the changelog date "${changelog.date}" is not YYYY-MM-DD`);
    else if (tag && changelog.date > today) problems.push(`the changelog date ${changelog.date} is in the future`);
    else if (tag && changelog.date !== today) warnings.push(`the changelog date is ${changelog.date}, not today (${today}): set it on release day`);
  }
  if (tag && tag !== `v${version}`) problems.push(`the tag is ${tag} but the version is ${version}`);
  return { problems, warnings, version };
}

module.exports = { checkReleaseMetadata, newestChangelogEntry };

if (require.main === module) {
  const { problems, warnings, version } = checkReleaseMetadata({ tag: process.argv[2] });
  for (const w of warnings) console.warn(`::warning::${w}`);
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error(`check-release-metadata: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`check-release-metadata: ${version} is consistent${process.argv[2] ? ` with tag ${process.argv[2]}` : ''}`);
}
