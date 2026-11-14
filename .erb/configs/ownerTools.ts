/**
 * Release builds compile src/owner-off (empty stand-ins) in place of src/owner, the
 * owner's private tools, so they never ship. Development keeps them;
 * LUNAR_OWNER_BUILD=1 builds a private release with them in. The published source
 * has no owner-off: its src/owner already is the empty one, so nothing is swapped.
 */
import fs from 'fs'
import path from 'path'
import webpack from 'webpack'

const ownerOffDir = path.join(__dirname, '../../src/owner-off')

export const ownerToolsIncluded =
  process.env.NODE_ENV !== 'production' || process.env.LUNAR_OWNER_BUILD === '1'

export function ownerToolsPlugins(): webpack.WebpackPluginInstance[] {
  if (ownerToolsIncluded || !fs.existsSync(ownerOffDir)) return []
  return [
    new webpack.NormalModuleReplacementPlugin(
      /(^|[\\/])owner[\\/](channels|main|renderer)$/,
      (resource: { request: string }) => {
        resource.request = resource.request.replace(
          /(^|[\\/])owner([\\/])(channels|main|renderer)$/,
          '$1owner-off$2$3',
        )
      },
    ),
  ]
}
