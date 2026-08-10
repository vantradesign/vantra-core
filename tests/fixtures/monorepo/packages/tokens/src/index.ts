/**
 * Spacing scale, in rem.
 */
export const spacing = {
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
} as const

/** Name of the CSS custom property namespace. */
export const TOKEN_PREFIX = 'vt'

/**
 * A semantic colour role.
 */
export type ColorRole = 'brand' | 'surface' | 'danger'

/**
 * Builds the CSS custom property for a semantic colour role.
 */
export function colorVariable(role: ColorRole): string {
  return `var(--${TOKEN_PREFIX}-color-${role})`
}
