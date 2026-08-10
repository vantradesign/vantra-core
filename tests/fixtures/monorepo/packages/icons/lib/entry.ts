/**
 * Names of the icons shipped by this package.
 */
export const iconNames = ['check', 'close', 'chevron'] as const

/**
 * A single icon identifier.
 */
export type IconName = (typeof iconNames)[number]
