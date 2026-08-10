import path from 'node:path'

/**
 * Converts a platform path to POSIX separators.
 *
 * Every path that leaves this package is POSIX-normalized so that artefacts
 * produced on macOS/Windows are byte-identical to those produced on Linux CI.
 *
 * @internal
 */
export function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Returns `absolutePath` expressed relative to `rootPath`, POSIX-normalized.
 *
 * @internal
 */
export function toRepoRelative(rootPath: string, absolutePath: string): string {
  return toPosix(path.relative(rootPath, absolutePath))
}

/**
 * Absolute, POSIX-normalized form of `value`.
 *
 * @internal
 */
export function toAbsolutePosix(value: string): string {
  return toPosix(path.resolve(value))
}

/**
 * The file extension of `filePath`, lowercased and without the leading dot.
 *
 * @internal
 */
export function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase()
}

/**
 * The basename of `filePath` without its extension.
 *
 * @internal
 */
export function basenameWithoutExtension(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
}

/**
 * Converts an arbitrary identifier-ish string to PascalCase.
 *
 * Used to derive a component name from a filename (`my-button.vue` →
 * `MyButton`), which is the convention both Vue and React libraries follow.
 *
 * @internal
 */
export function toPascalCase(value: string): string {
  const parts = value
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (parts.length === 0) return ''

  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * `true` when `value` looks like a component name (starts with an uppercase letter).
 *
 * @internal
 */
export function isPascalCase(value: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(value)
}

/**
 * Splits a dot- or dash-delimited token name into normalized path segments.
 *
 * @internal
 */
export function splitTokenPath(value: string): string[] {
  return value
    .split(/[.\-/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}
