import { beta } from './beta'

/**
 * Calls into beta, which calls back into alpha.
 */
export function alpha(depth: number): string {
  return depth <= 0 ? 'alpha' : beta(depth - 1)
}
