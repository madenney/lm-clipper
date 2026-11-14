/* eslint-disable global-require, import/no-dynamic-require */
/**
 * The release scripts in .erb/scripts: the version/tag/changelog check, the ffmpeg pins,
 * the bundled-binary check and the macOS update-file merge. They run on release day in CI;
 * these tests run them on every `npm test`.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { bundledBinaryName } from '../main/util'

const scripts = path.resolve(__dirname, '../../.erb/scripts')
const projectDir = path.resolve(__dirname, '../..')
const metadata = require(path.join(scripts, 'check-release-metadata.js'))
const ffmpeg = require(path.join(scripts, 'fetch-ffmpeg.js'))
const slpz = require(path.join(scripts, 'build-slpz.js'))
const bundled = require(path.join(scripts, 'check-bundled-binaries.js'))
const mac = require(path.join(scripts, 'merge-mac-update-yml.js'))

function tree(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-release-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

const lock = (version: string) =>
  JSON.stringify({ name: 'x', version, packages: { '': { version } } })
const changelog = (version: string, date: string) =>
  `export const CHANGELOG = [\n  {\n    version: '${version}',\n    date: '${date}',\n    summary: 'x',\n  },\n]\n`
const release = (over: Record<string, string> = {}) => ({
  'package.json': JSON.stringify({ version: '3.1.0' }),
  'release/app/package.json': JSON.stringify({ version: '3.1.0' }),
  'package-lock.json': lock('3.1.0'),
  'release/app/package-lock.json': lock('3.1.0'),
  'src/constants/changelog.ts': changelog('3.1.0', '2026-12-01'),
  ...over,
})

describe('release metadata (version, lockfiles, changelog, tag)', () => {
  it('the real tree agrees with itself', () => {
    const { problems, version } = metadata.checkReleaseMetadata({ projectDir })
    expect(problems).toEqual([])
    expect(version).toBe(require('../../package.json').version)
  })

  it('passes when everything matches the tag', () => {
    const dir = tree(release())
    const r = metadata.checkReleaseMetadata({
      projectDir: dir,
      tag: 'v3.1.0',
      today: '2026-12-01',
    })
    expect(r.problems).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('fails when only the root package.json was bumped', () => {
    const dir = tree(
      release({ 'package.json': JSON.stringify({ version: '3.1.1' }) }),
    )
    const { problems } = metadata.checkReleaseMetadata({
      projectDir: dir,
      tag: 'v3.1.1',
      today: '2026-12-01',
    })
    expect(problems.join('\n')).toMatch(
      /release\/app\/package\.json is 3\.1\.0 but package\.json is 3\.1\.1/,
    )
    expect(problems.join('\n')).toMatch(/newest changelog entry is 3\.1\.0/)
  })

  it('fails on a tag that is not the version, a missing lockfile and a future date', () => {
    const dir = tree(
      release({
        'src/constants/changelog.ts': changelog('3.1.0', '2027-01-01'),
      }),
    )
    fs.rmSync(path.join(dir, 'release/app/package-lock.json'))
    const { problems } = metadata.checkReleaseMetadata({
      projectDir: dir,
      tag: 'v3.1.9',
      today: '2026-12-01',
    })
    expect(problems.join('\n')).toMatch(
      /the tag is v3\.1\.9 but the version is 3\.1\.0/,
    )
    expect(problems.join('\n')).toMatch(
      /release\/app\/package-lock\.json is missing/,
    )
    expect(problems.join('\n')).toMatch(/in the future/)
  })

  it('warns, without failing, when the changelog date is not today', () => {
    const dir = tree(release())
    const r = metadata.checkReleaseMetadata({
      projectDir: dir,
      tag: 'v3.1.0',
      today: '2026-12-05',
    })
    expect(r.problems).toEqual([])
    expect(r.warnings[0]).toMatch(/not today/)
  })
})

describe('ffmpeg pins', () => {
  const pins = JSON.parse(
    fs.readFileSync(path.join(projectDir, '.erb/ffmpeg-pins.json'), 'utf8'),
  )

  it.each([
    ['linux', 'x64'],
    ['win', 'x64'],
    ['mac', 'arm64'],
    ['mac', 'x64'],
  ])('%s %s has a versioned https url and a sha256', (platform, arch) => {
    const pin = ffmpeg.pinFor(platform, arch, pins)
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(pin.url).toMatch(/^https:\/\//)
    // A versioned file, never a moving "latest"/"release" alias.
    expect(path.basename(pin.url)).not.toMatch(/latest|release-/)
    expect(path.basename(pin.url)).toMatch(/\d/)
    expect(pin.version).toMatch(/^\d+\.\d+(\.\d+)?$/)
  })

  it('names the output like bundledBinaryName and the build config expect', () => {
    for (const [platform, node, arch] of [
      ['linux', 'linux', 'x64'],
      ['win', 'win32', 'x64'],
      ['mac', 'darwin', 'arm64'],
      ['mac', 'darwin', 'x64'],
    ] as const) {
      expect(ffmpeg.outputName(platform, arch)).toBe(
        bundledBinaryName('ffmpeg', node, arch),
      )
      expect(slpz.outputName(platform, arch)).toBe(
        bundledBinaryName('slpz', node, arch),
      )
    }
  })

  it('refuses a missing pin, a short sha256 and a plain-http url', () => {
    expect(() => ffmpeg.pinFor('linux', 'arm64', pins)).toThrow(/no ffmpeg pin/)
    const bad = { 'linux-x64': { ...pins['linux-x64'], sha256: 'abc' } }
    expect(() => ffmpeg.pinFor('linux', 'x64', bad)).toThrow(/sha256/)
    const http = {
      'linux-x64': {
        ...pins['linux-x64'],
        url: 'http://example.test/x.tar.xz',
      },
    }
    expect(() => ffmpeg.pinFor('linux', 'x64', http)).toThrow(/https/)
  })
})

describe('checkBundledBinaries', () => {
  const elf = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(60),
  ])
  elf.writeUInt16LE(0x3e, 18)
  const make = (files: Record<string, Buffer | string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-bin-'))
    for (const [rel, data] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), data)
    }
    return dir
  }
  const extraResources = [
    {
      from: 'release/app/ffmpeg/ffmpeg-linux-x64',
      to: 'ffmpeg/ffmpeg-linux-x64',
    },
    { from: 'release/app/slpz/slpz-linux-x64', to: 'slpz/slpz-linux-x64' },
  ]

  it('accepts real-looking Linux binaries', () => {
    const dir = make({
      'release/app/ffmpeg/ffmpeg-linux-x64': elf,
      'release/app/slpz/slpz-linux-x64': elf,
    })
    const r = bundled.checkBundledBinaries({
      platformKey: 'linux',
      arch: 'x64',
      extraResources,
      projectDir: dir,
    })
    expect(r.problems).toEqual([])
    expect(r.checked).toHaveLength(2)
  })

  it('reports a missing, empty or wrong-format binary', () => {
    const dir = make({
      'release/app/ffmpeg/ffmpeg-linux-x64': '<html>throttled</html>',
      'release/app/slpz/slpz-linux-x64': '',
    })
    const r = bundled.checkBundledBinaries({
      platformKey: 'linux',
      arch: 'x64',
      extraResources,
      projectDir: dir,
    })
    expect(r.problems.join('\n')).toMatch(/ffmpeg-linux-x64: not a Linux ELF/)
    expect(r.problems.join('\n')).toMatch(/slpz-linux-x64: empty file/)
    const none = bundled.checkBundledBinaries({
      platformKey: 'linux',
      arch: 'x64',
      extraResources,
      projectDir: make({}),
    })
    expect(none.problems.join('\n')).toMatch(/ffmpeg-linux-x64: missing/)
  })

  it('a Windows build without the hidden launcher entry fails', () => {
    const r = bundled.checkBundledBinaries({
      platformKey: 'win',
      arch: 'x64',
      extraResources: [],
      projectDir: make({}),
    })
    expect(r.problems.join('\n')).toMatch(
      /lunar-hidden-launcher\.exe: not in build\.win\.extraResources/,
    )
  })

  it('a binary that does not match the SHA256SUMS beside it fails', () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30, 1)])
    const sha = (b: Buffer) =>
      crypto.createHash('sha256').update(b).digest('hex')
    const resources = [{ from: 'bin/tool.exe', to: 'tool/tool.exe' }]
    const good = make({
      'bin/tool.exe': exe,
      'bin/SHA256SUMS': `${sha(exe)}  tool.exe\n`,
    })
    const bad = make({
      'bin/tool.exe': exe,
      'bin/SHA256SUMS': `${'0'.repeat(64)}  tool.exe\n`,
    })
    const run = (dir: string) =>
      bundled.checkBundledBinaries({
        platformKey: 'win',
        arch: 'x64',
        extraResources: [
          ...resources,
          { from: 'x', to: 'hidden-launcher/lunar-hidden-launcher.exe' },
        ],
        projectDir: dir,
      })
    expect(
      run(good).problems.filter((p: string) => p.startsWith('bin/')),
    ).toEqual([])
    expect(run(bad).problems.join('\n')).toMatch(
      /bin\/tool\.exe: sha256 .* does not match SHA256SUMS/,
    )
  })

  it('the real build config lists every helper for each platform it builds', () => {
    const { build } = require('../../package.json')
    for (const key of ['linux', 'win']) {
      const to = build[key].extraResources.map((e: { to: string }) => e.to)
      expect(to).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^ffmpeg\//),
          expect.stringMatching(/^slpz\//),
        ]),
      )
    }
  })
})

describe('macOS update file merge', () => {
  const file = (version: string, name: string) =>
    `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: abc\n    size: 1\npath: ${name}\nsha512: abc\nreleaseDate: '2026-12-01T00:00:00.000Z'`

  it('lists both architectures in one file, x64 first for the legacy fields', () => {
    const merged = mac.merge([
      {
        arch: 'arm64',
        text: file('3.1.0', 'Lunar-Clipper-3.1.0-mac-arm64.zip'),
      },
      { arch: 'x64', text: file('3.1.0', 'Lunar-Clipper-3.1.0-mac-x64.zip') },
    ])
    expect(merged).toMatch(
      /files:\n {2}- url: Lunar-Clipper-3\.1\.0-mac-x64\.zip[\s\S]*- url: Lunar-Clipper-3\.1\.0-mac-arm64\.zip/,
    )
    expect(merged).toMatch(/\npath: Lunar-Clipper-3\.1\.0-mac-x64\.zip/)
  })

  it('refuses two different versions', () => {
    expect(() =>
      mac.merge([
        { arch: 'arm64', text: file('3.1.0', 'a.zip') },
        { arch: 'x64', text: file('3.1.1', 'b.zip') },
      ]),
    ).toThrow(/version mismatch/)
  })
})
