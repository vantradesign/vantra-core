import { gamma } from './gamma'

/**
 * Middle link of the alpha → beta → gamma → alpha cycle.
 */
export function beta(depth: number): string {
  return gamma(depth)
}
