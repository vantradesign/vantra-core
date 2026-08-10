import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ParsedComponent, PropDefinition } from '../src/types'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolves a fixture repository to an absolute path.
 */
export function fixture(name: string): string {
  return path.join(here, 'fixtures', name)
}

/**
 * Finds a parsed component by name, failing loudly when it is missing.
 */
export function componentNamed(components: ParsedComponent[], name: string): ParsedComponent {
  const match = components.find((component) => component.name === name)
  if (match === undefined) {
    throw new Error(
      `Expected a component named "${name}". Found: ${components.map((c) => c.name).join(', ')}`,
    )
  }
  return match
}

/**
 * Finds a prop by name, failing loudly when it is missing.
 */
export function propNamed(component: ParsedComponent, name: string): PropDefinition {
  const match = component.props.find((prop) => prop.name === name)
  if (match === undefined) {
    throw new Error(
      `Expected "${component.name}" to declare a prop "${name}". Found: ${component.props
        .map((p) => p.name)
        .join(', ')}`,
    )
  }
  return match
}
