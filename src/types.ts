/**
 * Central, stable type contract for `@vantradesign/core`.
 *
 * Every type in this file is part of the package's public API and is therefore
 * covered by the SemVer guarantees documented in the README. Downstream tools in
 * `vantra-governance-suite` persist these shapes (e.g. to Supabase) and pass them
 * between CI steps, so all of them are plain, JSON-serializable data.
 *
 * @packageDocumentation
 */

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A position inside a source file.
 *
 * Paths are always **repository-relative** and use POSIX separators, so that a
 * graph produced on macOS is byte-identical to one produced on a Linux CI runner.
 */
export interface SourceLocation {
  /** Repository-relative, POSIX-separated path, e.g. `packages/ui/src/Button.vue`. */
  filePath: string
  /** 1-based line number of the declaration. */
  line: number
  /** 1-based column number of the declaration. */
  column: number
}

/**
 * The flavour of a parsed source unit.
 *
 * - `vue-sfc` — a Vue Single File Component (`.vue`).
 * - `react` — a React component declared in `.tsx`/`.jsx` (or typed as `FC`).
 * - `module` — a plain TypeScript/JavaScript module that exports no component
 *   (utility packages, token modules, barrel files).
 */
export type ComponentKind = 'vue-sfc' | 'react' | 'module'

/* -------------------------------------------------------------------------- */
/* AST parser output                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A single public prop of a component.
 */
export interface PropDefinition {
  /** Prop name exactly as consumers must write it (camelCase for both Vue and React). */
  name: string
  /**
   * The prop's declared type, rendered as TypeScript source text.
   *
   * Falls back to the inferred type when no explicit annotation exists, and to
   * `'unknown'` when the type cannot be resolved (e.g. an unresolvable import).
   */
  type: string
  /** `true` when the prop must be supplied by the consumer. */
  required: boolean
  /**
   * The default value rendered as source text (e.g. `'md'`, `0`, `() => []`),
   * or `undefined` when the prop has no default.
   */
  defaultValue?: string
  /** Leading TSDoc/JSDoc description, if the prop is documented. */
  description?: string
}

/**
 * A single parameter of an exported function or hook.
 */
export interface FunctionParameter {
  /** Parameter name, or the destructuring pattern source text. */
  name: string
  /** Declared or inferred parameter type as TypeScript source text. */
  type: string
  /** `true` for optional (`?`) parameters and parameters with a default. */
  optional: boolean
  /** Default value as source text, when present. */
  defaultValue?: string
  /** `true` for rest parameters (`...args`). */
  rest: boolean
}

/**
 * An exported function, hook or composable.
 */
export interface ExportedFunction {
  /** Exported binding name. */
  name: string
  /** Ordered parameter list. */
  parameters: FunctionParameter[]
  /** Declared or inferred return type as TypeScript source text. */
  returnType: string
  /** `true` when declared with `async`. */
  isAsync: boolean
  /** `true` when this is the module's default export. */
  isDefaultExport: boolean
  /**
   * `true` when the name follows the React/Vue convention for hooks and
   * composables (`useX`). Downstream tools treat these as public API too.
   */
  isHook: boolean
  /** Leading TSDoc/JSDoc description, if documented. */
  description?: string
  /** Where the function is declared. */
  location: SourceLocation
}

/**
 * An exported non-function value: `export const spacing = { ... }`.
 *
 * Plain TypeScript token and utility packages express most of their public API
 * this way, so these are tracked alongside functions and types.
 */
export interface ExportedValue {
  /** Exported binding name. */
  name: string
  /** Declared or inferred type as TypeScript source text. */
  type: string
  /** `true` for `const` bindings (as opposed to `let`/`var`). */
  isConst: boolean
  /** `true` when this is the module's default export. */
  isDefaultExport: boolean
  /**
   * The initializer as source text, present only for simple literals
   * (string, number, boolean). Object and array initializers are omitted to
   * keep persisted artefacts small.
   */
  literalValue?: string
  /** Leading TSDoc/JSDoc description, if documented. */
  description?: string
  /** Where the value is declared. */
  location: SourceLocation
}

/**
 * A single member of an exported interface, type alias, enum or class.
 */
export interface TypeMember {
  /** Member name. */
  name: string
  /** Member type as TypeScript source text. */
  type: string
  /** `true` when the member is optional (`?`). */
  optional: boolean
  /** Leading TSDoc/JSDoc description, if documented. */
  description?: string
}

/**
 * The declaration form of an exported type.
 */
export type ExportedTypeKind = 'interface' | 'type-alias' | 'enum' | 'class'

/**
 * An exported type, interface, enum or class.
 */
export interface ExportedType {
  /** Exported type name. */
  name: string
  /** Which declaration form was used. */
  kind: ExportedTypeKind
  /**
   * Structural members. Populated for interfaces, enums, classes and for type
   * aliases whose right-hand side is an object literal type. Empty otherwise
   * (e.g. for union aliases), in which case {@link ExportedType.text} carries
   * the full definition.
   */
  members: TypeMember[]
  /** The declaration's right-hand side as TypeScript source text. */
  text: string
  /** Names of extended/implemented types, when applicable. */
  extends: string[]
  /** `true` when this is the module's default export. */
  isDefaultExport: boolean
  /** Leading TSDoc/JSDoc description, if documented. */
  description?: string
  /** Where the type is declared. */
  location: SourceLocation
}

/**
 * A module reference produced by an `import` or a re-`export ... from` statement.
 */
export interface ModuleReference {
  /** The module specifier exactly as written in source, e.g. `'./Button.vue'`. */
  moduleSpecifier: string
  /**
   * The repository-relative path the specifier resolves to, when it points at a
   * file inside the parsed repository. `undefined` for unresolved or external
   * modules.
   */
  resolvedPath?: string
  /**
   * The workspace package name the specifier resolves to (e.g. `@acme/tokens`),
   * when it points at another package root inside the same repository.
   */
  resolvedPackage?: string
  /**
   * Imported/re-exported binding names. `default` is represented literally as
   * `'default'`; a namespace import (`* as x`) is represented as `'*'`.
   */
  names: string[]
  /** `true` for `import type` / `export type` statements. */
  isTypeOnly: boolean
  /** `true` when the specifier could not be resolved inside the repository. */
  isExternal: boolean
}

/**
 * The parsed public API surface of one exported component, or of one
 * component-less module.
 *
 * Granularity: **one `ParsedComponent` per exported component symbol**. A file
 * exporting two React components yields two entries that share a `filePath`. A
 * file exporting no component yields exactly one entry with `kind: 'module'`.
 */
export interface ParsedComponent {
  /**
   * Stable, repository-unique identifier: `` `${filePath}#${name}` ``.
   *
   * Component names are not unique across a monorepo, so this — not `name` — is
   * what graph edges reference.
   */
  id: string
  /** The exported component or module name. */
  name: string
  /** Which flavour of source unit this is. */
  kind: ComponentKind
  /** Repository-relative, POSIX-separated path of the declaring file. */
  filePath: string
  /** `name` field of the nearest ancestor `package.json`, when one exists. */
  packageName?: string
  /** `true` when the component is the module's default export. */
  isDefaultExport: boolean
  /** Public props, in declaration order. Empty for `module` entries. */
  props: PropDefinition[]
  /**
   * Exported functions, hooks and composables declared in the same file,
   * excluding the component functions themselves.
   *
   * When a file declares several components, each of them repeats the file's
   * full export surface — these lists are file-scoped, not component-scoped.
   */
  functions: ExportedFunction[]
  /** Exported types, interfaces, enums and classes declared in the same file. */
  types: ExportedType[]
  /** Exported non-function values declared in the same file. */
  values: ExportedValue[]
  /** All `import` statements in the declaring file. */
  imports: ModuleReference[]
  /** All `export ... from` re-export statements in the declaring file. */
  reExports: ModuleReference[]
  /**
   * CSS custom properties referenced anywhere in the declaring file, normalized
   * to their `--token-name` form and de-duplicated.
   *
   * These become `token` edges in the component graph.
   */
  tokenReferences: string[]
  /** Leading TSDoc/JSDoc description of the component, if documented. */
  description?: string
  /** Where the component is declared. */
  location: SourceLocation
}

/**
 * Options for {@link parseComponents}.
 */
export interface ParseComponentsOptions {
  /**
   * Glob patterns of files to parse, relative to the repository root.
   *
   * @defaultValue `['**\/*.ts', '**\/*.tsx', '**\/*.vue']`
   */
  include?: string[]
  /**
   * Glob patterns to skip, relative to the repository root. These are applied in
   * addition to {@link DEFAULT_EXCLUDE_PATTERNS}, never instead of them, so that
   * `node_modules` can never be walked by accident.
   */
  exclude?: string[]
  /**
   * Path-alias map applied to non-relative specifiers before resolution, e.g.
   * `{ '@/': 'src/' }`. Values are repository-relative.
   */
  aliases?: Record<string, string>
  /**
   * Maximum number of files to parse. Acts as a guard rail against accidentally
   * pointing the parser at a huge tree.
   *
   * @defaultValue `5000`
   */
  maxFiles?: number
}

/* -------------------------------------------------------------------------- */
/* Component graph                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a graph node represents.
 *
 * Extends {@link ComponentKind} with `token`, used for the synthetic nodes that
 * represent design tokens consumed by a component.
 */
export type GraphNodeKind = ComponentKind | 'token'

/**
 * Why one node depends on another.
 *
 * - `component` — the source imports and composes the target component.
 * - `utility` — the source imports a function/value from a non-component module.
 * - `type` — the source imports only types from the target (`import type`).
 * - `re-export` — the source re-exports the target (barrel files).
 * - `token` — the source references a design token.
 */
export type GraphEdgeKind = 'component' | 'utility' | 'type' | 're-export' | 'token'

/**
 * A node in the component graph.
 *
 * Nodes carry a lightweight *summary* of the parsed component rather than the
 * full {@link ParsedComponent}, to keep persisted graphs small. Consumers that
 * need full detail keep the `ParsedComponent[]` alongside the graph.
 */
export interface ComponentGraphNode {
  /** Matches {@link ParsedComponent.id}, or `` `token:--name` `` for token nodes. */
  id: string
  /** Component, module or token name. */
  name: string
  /** What this node represents. */
  kind: GraphNodeKind
  /** Repository-relative declaring file. Empty string for token nodes. */
  filePath: string
  /** Owning workspace package, when known. */
  packageName?: string
  /** Names of the component's public props. */
  propNames: string[]
  /** Names of the module's exported functions/hooks. */
  exportedFunctionNames: string[]
  /** Names of the module's exported types. */
  exportedTypeNames: string[]
  /** Names of the module's exported non-function values. */
  exportedValueNames: string[]
}

/**
 * A directed dependency edge: `from` depends on `to`.
 */
export interface ComponentGraphEdge {
  /** {@link ComponentGraphNode.id} of the dependent node. */
  from: string
  /** {@link ComponentGraphNode.id} of the dependency. */
  to: string
  /** Why the dependency exists. */
  kind: GraphEdgeKind
  /** The specific binding names that caused the edge, sorted and de-duplicated. */
  symbols: string[]
}

/**
 * Lookup indexes shipped with the graph so consumers do not have to rebuild them
 * after deserializing.
 */
export interface ComponentGraphIndex {
  /** Component/module name to the node ids carrying that name. */
  byName: Record<string, string[]>
  /** Repository-relative file path to the node ids declared in that file. */
  byFilePath: Record<string, string[]>
  /** Workspace package name to the node ids belonging to it. */
  byPackage: Record<string, string[]>
}

/**
 * The pure-data half of the component graph: plain JSON, no methods.
 *
 * This is exactly what `JSON.stringify(graph)` produces and what should be
 * persisted to Supabase or passed between CI steps.
 */
export interface ComponentGraphData {
  /**
   * Serialization schema version. Bumped only on a breaking change to the
   * persisted shape, independently of the package version.
   */
  version: 1
  /** All nodes, sorted by `id` for deterministic output. */
  nodes: ComponentGraphNode[]
  /** All edges, sorted by `from`, then `to`, then `kind`. */
  edges: ComponentGraphEdge[]
  /** Precomputed lookup indexes. */
  index: ComponentGraphIndex
  /**
   * Circular dependencies among non-token nodes.
   *
   * Each entry is a strongly connected component — a set of node ids that are
   * all mutually reachable — given as a sorted id list. Self-referencing files
   * appear as single-element entries. SCCs are used rather than enumerating
   * every elementary cycle because the latter is exponential in the worst case.
   */
  cycles: string[][]
  /** Unresolved specifiers and other non-fatal issues encountered while building. */
  warnings: GraphWarning[]
}

/**
 * A non-fatal problem encountered while building the graph.
 */
export interface GraphWarning {
  /** Machine-readable warning code. */
  code: 'unresolved-import' | 'duplicate-node-id' | 'dangling-edge'
  /** Human-readable explanation. */
  message: string
  /** Node id the warning relates to, when applicable. */
  nodeId?: string
}

/**
 * Options accepted by the graph traversal helpers.
 */
export interface GraphQueryOptions {
  /**
   * Follow edges transitively instead of returning only direct neighbours.
   *
   * @defaultValue `false`
   */
  transitive?: boolean
  /**
   * Restrict traversal to these edge kinds.
   *
   * @defaultValue all kinds
   */
  kinds?: GraphEdgeKind[]
  /**
   * Maximum depth when `transitive` is `true`. `Infinity` by default.
   *
   * @defaultValue `Infinity`
   */
  maxDepth?: number
}

/**
 * The component graph: {@link ComponentGraphData} plus non-enumerable traversal
 * helpers.
 *
 * The helpers are attached as *methods*, which `JSON.stringify` omits — so a
 * `ComponentGraph` serializes to exactly {@link ComponentGraphData}. To get the
 * helpers back after deserializing, pass the plain object back through
 * `buildComponentGraph()`.
 */
export interface ComponentGraph extends ComponentGraphData {
  /**
   * Resolves a node by id, or by name when the name is unambiguous.
   *
   * @param nameOrId - A node id, or a component/module name.
   * @returns The node, or `undefined` if unknown or ambiguous by name.
   */
  getNode(nameOrId: string): ComponentGraphNode | undefined

  /**
   * Every node that this component depends on (outgoing edges).
   *
   * @param nameOrId - A node id, or a component/module name.
   * @param options - Traversal options.
   * @returns Matching nodes, sorted by id. Empty when the node is unknown.
   */
  getDependenciesOf(nameOrId: string, options?: GraphQueryOptions): ComponentGraphNode[]

  /**
   * Every node that depends on this component (incoming edges) — the reverse
   * lookup used by impact analysis in the consuming tools.
   *
   * @param nameOrId - A node id, or a component/module name.
   * @param options - Traversal options.
   * @returns Matching nodes, sorted by id. Empty when the node is unknown.
   */
  getConsumersOf(nameOrId: string, options?: GraphQueryOptions): ComponentGraphNode[]

  /**
   * Returns the plain, JSON-serializable representation of this graph.
   *
   * Also invoked automatically by `JSON.stringify`.
   */
  toJSON(): ComponentGraphData
}

/* -------------------------------------------------------------------------- */
/* Token schema                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalized semantic category of a design token.
 *
 * Derived from an explicit `$type`/`type` field when present, otherwise inferred
 * from the token's path segments. `other` is the deliberate catch-all — tokens
 * are never dropped just because their category is unclear.
 */
export type TokenCategory =
  | 'color'
  | 'spacing'
  | 'sizing'
  | 'typography'
  | 'border'
  | 'radius'
  | 'shadow'
  | 'opacity'
  | 'motion'
  | 'z-index'
  | 'breakpoint'
  | 'asset'
  | 'other'

/**
 * The file format a token was read from.
 */
export type TokenSourceFormat = 'json' | 'css'

/**
 * A scoped override of a token's value.
 *
 * Theme overrides (`[data-theme='dark'] { --color-bg: #000 }`) and media-query
 * overrides define the same token more than once. They are variants of one
 * token rather than duplicates, so they are attached to it instead of being
 * dropped or reported as errors.
 */
export interface TokenVariant {
  /** The selector (and any wrapping at-rule) the override is declared under. */
  scope: string
  /** The resolved value for this scope. */
  value: string
  /** The value exactly as authored, before alias resolution. */
  rawValue: string
  /** Repository-relative path of the file declaring the override. */
  filePath: string
}

/**
 * A single design token, normalized into one representation regardless of the
 * format it was authored in.
 */
export interface DesignToken {
  /**
   * Canonical dot-delimited name, e.g. `color.brand.primary`.
   *
   * Both `{ color: { brand: { primary } } }` in JSON and `--color-brand-primary`
   * in CSS normalize to this same name, which is what makes cross-format
   * comparison possible.
   */
  name: string
  /** The name exactly as authored (JSON key path joined by `.`, or the CSS custom property). */
  originalName: string
  /** The token's CSS custom property form, e.g. `--color-brand-primary`. */
  cssVariable: string
  /** The token's path segments, e.g. `['color', 'brand', 'primary']`. */
  path: string[]
  /**
   * The resolved value, with token aliases substituted where they could be
   * resolved. Always a string; numbers are stringified.
   */
  value: string
  /** The value exactly as authored, before alias resolution. */
  rawValue: string
  /** Normalized semantic category. */
  category: TokenCategory
  /** The explicitly declared type (`$type`/`type`), when the source provided one. */
  declaredType?: string
  /**
   * Canonical names of tokens this token aliases, e.g. `['color.base.blue.500']`
   * for a value of `{color.base.blue.500}` or `var(--color-base-blue-500)`.
   */
  aliases: string[]
  /** Author-provided description (`$description`, `description` or `comment`). */
  description?: string
  /** Which format the token came from. */
  format: TokenSourceFormat
  /** Repository-relative, POSIX-separated path of the defining file. */
  filePath: string
  /**
   * For CSS tokens, the selector the custom property was declared under
   * (e.g. `:root`, `[data-theme='dark']`), optionally prefixed with its at-rule.
   */
  scope?: string
  /**
   * Additional scoped definitions of the same token, e.g. dark-theme overrides.
   * Present only when the token is defined more than once.
   */
  variants?: TokenVariant[]
}

/**
 * A non-fatal problem encountered while parsing token files.
 *
 * Malformed and partial token files never throw — they produce warnings, so that
 * one broken file cannot take down a CI pipeline that governs an entire design
 * system.
 */
export interface TokenParseWarning {
  /** Machine-readable warning code. */
  code:
    | 'invalid-json'
    | 'invalid-css'
    | 'unreadable-file'
    | 'missing-value'
    | 'unresolved-alias'
    | 'circular-alias'
    | 'duplicate-token'
    | 'unsupported-value'
  /** Human-readable explanation. */
  message: string
  /** Repository-relative path of the offending file. */
  filePath: string
  /** Canonical token name the warning relates to, when applicable. */
  tokenName?: string
}

/**
 * A token file that was read.
 */
export interface TokenSourceFile {
  /** Repository-relative, POSIX-separated path. */
  filePath: string
  /** Which format it was parsed as. */
  format: TokenSourceFormat
  /** How many tokens were extracted from it. */
  tokenCount: number
}

/**
 * The complete, normalized set of design tokens found in a repository.
 *
 * Plain JSON, like {@link ComponentGraphData}, so it can be persisted and shared
 * between CI steps.
 */
export interface TokenSchema {
  /** Serialization schema version, bumped independently of the package version. */
  version: 1
  /** All tokens, sorted by canonical name, de-duplicated by name. */
  tokens: DesignToken[]
  /** Canonical token names grouped by semantic category. */
  byCategory: Record<TokenCategory, string[]>
  /** CSS custom property to canonical token name — the cross-format join key. */
  byCssVariable: Record<string, string>
  /** Every token file that was read. */
  sources: TokenSourceFile[]
  /** Non-fatal problems encountered while parsing. */
  warnings: TokenParseWarning[]
}

/**
 * Options for {@link parseTokenSchema}.
 */
export interface ParseTokenSchemaOptions {
  /**
   * Glob patterns of token files to read, relative to the repository root.
   *
   * @defaultValue `['**\/*.tokens.json', '**\/tokens\/**\/*.json', '**\/tokens.json', '**\/*.css']`
   */
  include?: string[]
  /**
   * Glob patterns to skip, applied in addition to {@link DEFAULT_EXCLUDE_PATTERNS}.
   */
  exclude?: string[]
  /**
   * Prefix stripped from CSS custom properties before normalization, e.g. `'vt'`
   * turns `--vt-color-primary` into `color.primary`.
   *
   * Without this, a prefixed CSS variable and its unprefixed JSON counterpart
   * would normalize to different canonical names.
   */
  cssVariablePrefix?: string
  /**
   * Resolve `{alias}` / `var(--alias)` values to their target's concrete value.
   *
   * @defaultValue `true`
   */
  resolveAliases?: boolean
  /**
   * Maximum number of token files to read.
   *
   * @defaultValue `2000`
   */
  maxFiles?: number
}

/* -------------------------------------------------------------------------- */
/* Shared constants                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Directory patterns that are always excluded from every scan, regardless of the
 * caller-supplied `exclude` option.
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.output/**',
  '**/coverage/**',
  '**/.git/**',
  '**/*.d.ts',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.stories.*',
  '**/__tests__/**',
  '**/__mocks__/**',
]
