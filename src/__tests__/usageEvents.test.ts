import {
  errorKind,
  isReportableSetting,
  renderSettings,
  settingChange,
} from '../main/usageEvents'

describe('usage events: what a setting change may report', () => {
  it('switches, choices and numbers from Settings are reported', () => {
    expect(settingChange('includeGameEnding', true)).toEqual({
      key: 'includeGameEnding',
      value: true,
    })
    expect(settingChange('autoImportSlippi', false)).toEqual({
      key: 'autoImportSlippi',
      value: false,
    })
    expect(settingChange('bitrateKbps', 15000)).toEqual({
      key: 'bitrateKbps',
      value: 15000,
    })
    expect(settingChange('resolution', '1080p')).toEqual({
      key: 'resolution',
      value: '1080p',
    })
  })
  it('never a folder, a file, typed text or the usage choice itself', () => {
    for (const key of [
      'outputPath',
      'ssbmIsoPath',
      'dolphinPath',
      'ffmpegPath',
      'outputFilenamePattern',
      'replayLibraryPath',
    ]) {
      expect(isReportableSetting(key)).toBe(false)
      expect(settingChange(key, '/home/someone/Videos')).toBeNull()
    }
    expect(settingChange('sendAnonymousUsage', false)).toBeNull()
    expect(settingChange('consentNoticeSeen', true)).toBeNull()
    expect(settingChange('notASetting', true)).toBeNull()
  })
  it('a choice that is not a short code is dropped (no free text through a dropdown key)', () => {
    expect(settingChange('resolution', 'C:\\Users\\name\\x')).toBeNull()
    expect(settingChange('resolution', 'a'.repeat(40))).toBeNull()
    expect(settingChange('bitrateKbps', Number.NaN)).toBeNull()
  })
})

describe('usage events: errors are a short kind, never the message', () => {
  it('sorts the common failures', () => {
    expect(errorKind(new Error('ENOSPC: no space left on device, write'))).toBe(
      'disk_full',
    )
    expect(
      errorKind(new Error("EACCES: permission denied, open 'C:\\x'")),
    ).toBe('permission')
    expect(
      errorKind(new Error('recording produced no video ... utvideo')),
    ).toBe('ffmpeg')
    expect(errorKind(new Error('Dolphin exited before the first frame'))).toBe(
      'dolphin',
    )
    expect(errorKind(new Error('something odd'))).toBe('other')
    expect(errorKind(undefined)).toBe('other')
  })
})

describe('usage events: the settings a render ran with', () => {
  it('keeps only reportable values, and the overlay as on/off, never its words or font file', () => {
    const s = renderSettings({
      resolution: '1080p',
      widescreen: true,
      numCPUs: 4,
      includeGameEnding: false,
      outputPath: '/home/x',
      overlayEnabled: true,
      overlayPattern: '{date} my secret text',
      overlayFont: '/home/x/font.ttf',
      overlayFontSize: 24,
      overlayPosition: 'bottom-left',
    })
    expect(s).toEqual({
      resolution: '1080p',
      widescreen: true,
      numCPUs: 4,
      includeGameEnding: false,
      overlay: true,
      overlayPosition: 'bottom-left',
      overlayFontSize: 24,
      customFont: true,
    })
    expect(JSON.stringify(s)).not.toContain('/home')
    expect(JSON.stringify(s)).not.toContain('secret')
  })
})
