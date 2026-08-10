import { cx } from './utils'
import { clampLines } from './utils/text.js'
import { spacing } from '../../tokens/src/index'
import { iconNames } from '@fixture/icons'
import { colorVariable } from '@fixture/tokens/src/index'
import defaultExport from 'lodash-es'

/**
 * Options accepted by {@link formatLabel}.
 */
export interface FormatOptions {
  /** Maximum number of lines to keep. */
  maxLines?: number
  /** Upper-cases the result. */
  shout?: boolean
}

/**
 * Formats a label for display.
 *
 * @param value - Raw label text.
 * @param options - Formatting switches.
 * @param extras - Additional class names to append.
 */
export function formatLabel(
  value: string,
  options: FormatOptions = {},
  ...extras: string[]
): string {
  const clamped = clampLines(value, options.maxLines ?? 1)
  return cx(clamped, ...extras)
}

/**
 * Picks a value from a record, preserving the value type.
 */
export function pick<TRecord extends Record<string, unknown>, TKey extends keyof TRecord>(
  source: TRecord,
  key: TKey,
): TRecord[TKey] {
  return source[key]
}

/**
 * Resolves after the given number of milliseconds.
 */
export const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A generator over the spacing scale.
 */
export function* spacingSteps(): Generator<string> {
  for (const value of Object.values(spacing)) yield value
}

/**
 * A design-system linting rule.
 */
export class SpacingRule {
  /** Rule identifier. */
  readonly id = 'spacing-scale'

  /** Reports whether a value sits on the scale. */
  check(value: string): boolean {
    return Object.values(spacing).includes(value as never)
  }
}

/** Re-exported for convenience. */
export { clampLines }

/** The default export of an external package, re-exported. */
export const external = defaultExport

/** Every icon name, sourced from a package resolved through its manifest. */
export const allIcons = iconNames

/** The brand colour variable, imported through a package subpath. */
export const brandColor = colorVariable('brand')
