import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXCLUDE_PATTERNS,
  buildComponentGraph,
  parseComponents,
  parseTokenSchema,
} from '../src/index'
import { fixture } from './helpers'

describe('public API', () => {
  it('exports the three entry points and the shared defaults', () => {
    expect(typeof parseComponents).toBe('function')
    expect(typeof buildComponentGraph).toBe('function')
    expect(typeof parseTokenSchema).toBe('function')
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('**/node_modules/**')
  })

  it('excludes build output and tests by default', () => {
    const components = parseComponents(fixture('react-lib'))

    expect(components.every((entry) => !entry.filePath.includes('node_modules'))).toBe(true)
    expect(components.every((entry) => !entry.filePath.includes('.test.'))).toBe(true)
  })
})

describe('integration — component graph joined to the token schema', () => {
  const components = parseComponents(fixture('vue-lib'))
  const graph = buildComponentGraph(components)
  const schema = parseTokenSchema(fixture('token-repo'))

  it('links a component to a real token through the CSS variable index', () => {
    const button = graph.getNode('Button')
    expect(button).toBeDefined()

    const tokenDependencies = graph
      .getDependenciesOf('Button', { kinds: ['token'] })
      .map((node) => node.name)

    expect(tokenDependencies).toContain('--color-brand-primary')

    // The very point of canonical naming: a CSS variable found in a component
    // resolves to a token defined in an entirely separate JSON file.
    const canonical = schema.byCssVariable['--color-brand-primary']
    expect(canonical).toBe('color.brand.primary')

    const resolved = schema.tokens.find((entry) => entry.name === canonical)
    expect(resolved?.value).toBe('#2563eb')
  })

  it('identifies tokens a component references that the design system does not define', () => {
    const referenced = graph
      .getDependenciesOf('Button', { kinds: ['token'] })
      .map((node) => node.name)

    const undefinedTokens = referenced.filter(
      (name) => schema.byCssVariable[name] === undefined,
    )

    // `--color-text-inverse` is used by the component but never defined.
    expect(undefinedTokens).toContain('--color-text-inverse')
  })

  it('supports the full persist-and-restore workflow', () => {
    const persisted = JSON.stringify({ graph, schema })
    const restored = JSON.parse(persisted) as {
      graph: Parameters<typeof buildComponentGraph>[0]
      schema: typeof schema
    }

    const rehydrated = buildComponentGraph(restored.graph)

    expect(rehydrated.getConsumersOf('VtIcon').map((node) => node.name)).toEqual(
      graph.getConsumersOf('VtIcon').map((node) => node.name),
    )
    expect(restored.schema.tokens.length).toBe(schema.tokens.length)
  })
})
