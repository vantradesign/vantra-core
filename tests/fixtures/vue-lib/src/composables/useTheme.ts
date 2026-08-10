/**
 * Visual emphasis levels shared by the interactive components.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost'

/**
 * A resolved theme descriptor.
 */
export interface Theme {
  /** Theme identifier, e.g. `light`. */
  name: string
  /** `true` when the theme is a dark variant. */
  dark: boolean
}

/** The theme applied when nothing else is configured. */
export const DEFAULT_THEME_NAME = 'light'

/** Every theme the fixture library ships with. */
export const AVAILABLE_THEMES = ['light', 'dark'] as const

/**
 * Provides the active theme and a setter for it.
 */
export function useTheme(): { theme: Theme; setTheme: (name: string) => void } {
  const theme: Theme = { name: DEFAULT_THEME_NAME, dark: false }

  return {
    theme,
    setTheme(name: string): void {
      theme.name = name
      theme.dark = name === 'dark'
    },
  }
}

/**
 * Formats a token name into its CSS custom property.
 */
export const toCssVariable = (name: string, prefix = ''): string =>
  `--${prefix}${prefix === '' ? '' : '-'}${name.split('.').join('-')}`
