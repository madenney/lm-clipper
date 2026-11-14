// electron-builder afterSign hook: notarize the signed macOS app with Apple's
// notarytool (@electron/notarize 2.x) and staple the ticket.
//
// Runs only when all of these hold, and otherwise skips with a note (an
// unsigned build is still a valid local/CI build):
//   - building for macOS
//   - APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD (an app-specific password from
//     appleid.apple.com; APPLE_ID_PASS is accepted as the old name) and
//     APPLE_TEAM_ID are set
//   - the app really is signed with a "Developer ID Application" certificate
//     (CSC_LINK / CSC_KEY_PASSWORD), because Apple rejects anything else
//
// electron-builder's own notarize step is switched off (build.mac.notarize =
// false in package.json) so the app is not notarized twice.
const { execFileSync } = require('child_process');
const path = require('path');

function isDeveloperIdSigned(appPath) {
  try {
    // codesign prints its details on stderr.
    const out = execFileSync('codesign', ['-dvv', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return /Authority=Developer ID Application/.test(out);
  } catch (err) {
    const text = `${err.stdout || ''}${err.stderr || ''}`;
    return /Authority=Developer ID Application/.test(text);
  }
}

exports.default = async function notarizeMacos(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword =
    process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASS;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.warn(
      '  • Skipping notarization: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to notarize.'
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!isDeveloperIdSigned(appPath)) {
    console.warn(
      '  • Skipping notarization: the app is not signed with a Developer ID Application certificate (set CSC_LINK and CSC_KEY_PASSWORD).'
    );
    return;
  }

  console.log(`  • Notarizing ${appPath} (notarytool, team ${teamId})…`);
  // Lazy require so Linux/Windows packaging never needs this module loaded.
  // eslint-disable-next-line global-require
  const { notarize } = require('@electron/notarize');
  await notarize({ appPath, appleId, appleIdPassword, teamId });
  console.log('  • Notarization done and stapled.');
};
