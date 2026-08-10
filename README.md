# @vantra-design/core

Shared AST-parsing, component-graph and design-token primitives for the **Vantra** design-system governance suite.

This package answers three questions about a front-end repository, and nothing more:

| Question | API |
| --- | --- |
| What components exist, and what is their public surface? | `parseComponents()` |
| What depends on what, and who breaks if I change this? | `buildComponentGraph()` |
| What design tokens exist, and what do they resolve to? | `parseTokenSchema()` |

It deliberately contains **no governance rules, no scoring, no reporting and no CLI**. Those live in the tools that consume this package, so that every Vantra tool reasons about the same primitives.

---

## Installation

```bash
pnpm add @vantra-design/core
```

Requires **Node.js >= 18.18**. Ships ESM and CJS builds with bundled type declarations.

---

## Quick start

```ts
import { parseComponents, buildComponentGraph, parseTokenSchema } from '@vantra-design/core'

const components = parseComponents('./packages/ui')
const graph = buildComponentGraph(components)
const tokens = parseTokenSchema('./packages/tokens')

// Impact analysis: what breaks if Button changes?
graph.getConsumersOf('Button')

// Dependency analysis: what does Card rely on, all the way down?
graph.getDependenciesOf('Card', { transitive: true })

// Token lookup: which token backs this CSS variable?
tokens.byCssVariable['--color-brand-primary'] // 'color.brand.primary'
```

---

## `parseComponents(repoPath, options?)`

Walks a repository and returns a `ParsedComponent[]`, one entry per component or module.

**Supported sources**

- **Vue SFCs** — `<script setup>` and the Options API, `defineProps` (type-based and runtime), `withDefaults`, `defineOptions`, and template-only components.
- **React** — function components, arrow components, `React.FC<Props>`, `forwardRef<Ref, Props>`, `memo`, class components, inline prop types, destructuring defaults and legacy `Component.defaultProps`.
- **Plain TypeScript** — exported functions, types, interfaces, enums, classes and constants.

**What you get per component**

```ts
{
  id: 'src/Button.vue#Button',        // stable across runs and machines
  name: 'Button',
  kind: 'vue-sfc',                    // 'vue-sfc' | 'react' | 'module'
  filePath: 'src/Button.vue',         // repo-relative, POSIX separators
  packageName: '@acme/ui',            // owning workspace package
  props: [{ name, type, required, defaultValue?, description? }],
  functions: [...], types: [...], values: [...],
  imports: [...], reExports: [...],
  tokenReferences: ['--color-brand-primary'],
  location: { filePath, line, column },
}
```

**Options**

| Option | Default | Purpose |
| --- | --- | --- |
| `include` | `**/*.{ts,tsx,js,jsx,vue}` | Glob patterns to scan. |
| `exclude` | `DEFAULT_EXCLUDE_PATTERNS` | Adds to the built-in ignore list (`node_modules`, `dist`, tests, …). |
| `aliases` | `{}` | Path aliases, e.g. `{ '@/': 'src/' }`. |
| `maxFiles` | `5000` | Guard rail against runaway scans. |

Notes worth knowing:

- Line numbers in `.vue` files point at the **`.vue` file**, not the extracted script block.
- Prop types are read from the **declared** type annotation where possible, so `ButtonVariant` stays `ButtonVariant` instead of being expanded to a union.
- A token reference truncated by a template placeholder (`` var(--shadow-${level}) ``) is **ignored**, because the real name is only known at runtime.

---

## `buildComponentGraph(input)`

Turns parsed components into a dependency graph — or rehydrates a previously serialized one.

```ts
const graph = buildComponentGraph(components)

graph.nodes      // ComponentGraphNode[]
graph.edges      // ComponentGraphEdge[]  — { from, to, kind, symbols }
graph.index      // byName / byFilePath / byPackage
graph.cycles     // circular dependencies, as sorted node-id groups
graph.warnings   // unresolved imports, duplicate ids
```

**Edge kinds**

| Kind | Meaning |
| --- | --- |
| `component` | A component renders or imports another component. |
| `utility` | A component depends on a plain module. |
| `type` | A type-only import. |
| `re-export` | A barrel forwards a symbol. |
| `token` | A component references a design token. |

**Queries**

```ts
graph.getNode('Button')
graph.getConsumersOf('Button')                          // direct consumers
graph.getDependenciesOf('Card', { transitive: true })   // whole subtree
graph.getDependenciesOf('Card', { transitive: true, maxDepth: 2 })
graph.getDependenciesOf('Button', { kinds: ['token'] }) // tokens only
```

### Persist and restore

The graph is **plain data plus non-enumerable helper methods**. `JSON.stringify(graph)` produces exactly `ComponentGraphData` — no functions leak in — and feeding that object back into `buildComponentGraph()` restores the query helpers without re-parsing the repository.

```ts
const json = JSON.stringify(graph)          // safe to store in Supabase/S3
const restored = buildComponentGraph(JSON.parse(json))
restored.getConsumersOf('Button')           // works again
```

---

## `parseTokenSchema(repoPath, options?)`

Reads design tokens from JSON **and** CSS, and normalizes both into one comparable schema.

**Supported formats**

- **DTCG** — `{ "$value": "...", "$type": "color" }`, including group-level `$type` inheritance.
- **Style Dictionary** — `{ "value": "...", "type": "...", "comment": "..." }`.
- **Plain nested JSON** — `{ "color": { "primary": "#f00" } }`.
- **CSS custom properties** — including `:root`, theme selectors and at-rules.

### Canonical naming

Every token normalizes to a dot-delimited name, which is what makes cross-format comparison possible:

| Authored as | Canonical name |
| --- | --- |
| `{ color: { brandPrimary } }` (JSON) | `color.brand.primary` |
| `--color-brand-primary` (CSS) | `color.brand.primary` |

### Theme variants

A dark-mode override is a **variant**, not a duplicate, and is attached to the token rather than dropped:

```ts
{
  name: 'color.surface.default',
  value: '#ffffff',
  scope: ':root',
  variants: [{ scope: "[data-theme='dark']", value: '#111827', ... }],
}
```

When the same token appears in both a JSON source and a generated CSS file, the **JSON definition wins** and no warning is raised — CSS custom properties are normally generated *from* the JSON.

### Never throws on bad input

Malformed token files produce warnings, never exceptions, so one broken file cannot fail a pipeline governing an entire design system:

```ts
schema.warnings
// [{ code: 'invalid-json', filePath: 'tokens/broken.json', message: '…' }]
```

Warning codes: `invalid-json`, `invalid-css`, `unreadable-file`, `missing-value`, `unresolved-alias`, `circular-alias`, `duplicate-token`, `unsupported-value`.

A missing `repoPath`, by contrast, **does** throw — that is a caller error, not a data error.

**Options**

| Option | Default | Purpose |
| --- | --- | --- |
| `include` | token JSON + `**/*.css` | Glob patterns to scan. |
| `exclude` | `DEFAULT_EXCLUDE_PATTERNS` | Extra ignores. |
| `cssVariablePrefix` | – | Strips/re-applies a prefix, e.g. `vt` for `--vt-color-brand`. |
| `resolveAliases` | `true` | Set `false` to keep `{color.base.blue.500}` verbatim. |
| `maxFiles` | `2000` | Guard rail. |

---

## Determinism

Every output is deterministic and machine-independent:

- Results are **sorted** — components by path then name, tokens by canonical name, edges by from/to/kind.
- Paths are **repository-relative** with POSIX separators, so a graph built on macOS is byte-identical to one built on a Linux CI runner.
- Component ids are stable `filePath#name` strings.

This is what allows two runs to be diffed to detect design-system drift.

---

## Stability

The public API is everything exported from the package root. Internal modules are not part of the contract and may change in any release.

Until `1.0.0`, minor versions may contain breaking changes; from `1.0.0` onward the package follows semantic versioning.

---

## Development

```bash
pnpm install
pnpm run verify        # lint + typecheck + test + build
pnpm run test:watch
pnpm run test:coverage
```

Releases are managed with [changesets](https://github.com/changesets/changesets):

```bash
pnpm run changeset     # describe your change
```

Merging to `main` opens a version PR; merging that PR publishes to npm.

---

## License

[AGPL-3.0-only](./LICENSE) © Vantra Design
