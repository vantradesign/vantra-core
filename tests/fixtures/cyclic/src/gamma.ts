import { alpha } from './alpha'

/**
 * Closes the alpha → beta → gamma → alpha cycle.
 */
export function gamma(depth: number): string {
  return alpha(depth)
}
