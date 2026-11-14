/**
 * The one default project (quick imports and downloads with no project open). Its name is
 * internal: the app never shows it, it just says "your project". Named projects show theirs.
 */
export const DEFAULT_PROJECT_NAME = 'My Replays'

export const isDefaultProjectName = (
  name: string | null | undefined,
): boolean => !name || name === DEFAULT_PROJECT_NAME

/** The name to show for a project, or null for the default one. */
export const shownProjectName = (
  name: string | null | undefined,
): string | null => (isDefaultProjectName(name) ? null : (name as string))
