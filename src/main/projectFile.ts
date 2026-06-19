import path from 'path'

// File extension for Lunar Clipper project files. Projects are SQLite DBs;
// the extension is what lets the OS associate them with the app (double-click
// to open, app icon, "Open with"). The on-disk file carries the extension;
// the in-app display name never does.
export const PROJECT_EXT = '.lunar'

// Ensure a project file path carries the .lunar extension (case-insensitive).
export function ensureProjectExt(filePath: string): string {
  return filePath.toLowerCase().endsWith(PROJECT_EXT)
    ? filePath
    : `${filePath}${PROJECT_EXT}`
}

// Display name = file basename with the .lunar extension stripped. Legacy
// projects have no extension, so this is a no-op for them.
export function projectDisplayName(filePath: string): string {
  const base = path.basename(filePath)
  return base.toLowerCase().endsWith(PROJECT_EXT)
    ? base.slice(0, -PROJECT_EXT.length)
    : base
}
