/**
 * Runtime smoke test for the *built* package.
 *
 * The unit tests import from `src/`, which proves the logic is correct but says
 * nothing about whether the published bundle loads on the oldest Node version
 * the package claims to support. This script exercises `dist/` directly and is
 * run in CI under that minimum Node version.
 *
 * Deliberately dependency-free: it must run on a bare Node install, without
 * pnpm, because the package manager itself requires a much newer Node than the
 * package does.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixture = (name) => path.join(root, 'tests', 'fixtures', name)

const { parseComponents, buildComponentGraph, parseTokenSchema, DEFAULT_EXCLUDE_PATTERNS } =
  await import(path.join(root, 'dist', 'index.js'))

/* -------------------------------------------------------------------------- */

const components = parseComponents(fixture('react-lib'))
assert.ok(components.length > 0, 'expected components from the React fixture')

const button = components.find((entry) => entry.name === 'Button')
assert.ok(button, 'expected a Button component')
assert.equal(button.kind, 'react')
assert.ok(
  button.props.some((prop) => prop.name === 'label' && prop.required),
  'expected Button to declare a required "label" prop',
)

/* -------------------------------------------------------------------------- */

const graph = buildComponentGraph(components)
assert.ok(graph.nodes.length > 0, 'expected graph nodes')
assert.ok(
  graph.getConsumersOf('Button').some((node) => node.name === 'Card'),
  'expected Card to consume Button',
)

// The graph must survive a JSON round-trip with its helpers reattached.
const serialized = JSON.stringify(graph)
assert.equal(serialized.includes('getConsumersOf'), false, 'helpers must not serialize')

const restored = buildComponentGraph(JSON.parse(serialized))
assert.deepEqual(
  restored.getConsumersOf('Button').map((node) => node.id),
  graph.getConsumersOf('Button').map((node) => node.id),
  'rehydrated graph must answer queries identically',
)

/* -------------------------------------------------------------------------- */

const schema = parseTokenSchema(fixture('token-repo'))
assert.ok(schema.tokens.length > 0, 'expected tokens')
assert.equal(schema.byCssVariable['--color-brand-primary'], 'color.brand.primary')

const brand = schema.tokens.find((entry) => entry.name === 'color.brand.primary')
assert.equal(brand.value, '#2563eb', 'expected the alias to resolve')

/* -------------------------------------------------------------------------- */

assert.ok(DEFAULT_EXCLUDE_PATTERNS.includes('**/node_modules/**'))

console.log(
  `smoke: ok on Node ${process.version} — ` +
    `${components.length} components, ${graph.nodes.length} nodes, ${schema.tokens.length} tokens`,
)
