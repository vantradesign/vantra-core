/**
 * Barrel for the UI utilities, imported as a bare directory specifier.
 */
export { clampLines } from './text'

/**
 * Joins class names, dropping falsy entries.
 */
export function cx(...names: Array<string | false | undefined>): string {
  return names.filter((name): name is string => typeof name === 'string').join(' ')
}
