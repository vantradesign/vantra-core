/**
 * Tracks a boolean flag and returns a toggler for it.
 */
export function useToggle(initial = false): [boolean, () => void] {
  let value = initial
  return [value, (): void => void (value = !value)]
}

/**
 * Resolves the CSS custom property backing a semantic colour role.
 */
export async function resolveColorToken(role: string): Promise<string> {
  return `var(--color-${role})`
}
