/**
 * `@vantra-design/core` — shared primitives for the Vantra design-system
 * governance suite.
 *
 * Three capabilities, one dependency-free-at-runtime contract:
 *
 * - {@link parseComponents} — extract the public API surface of every component
 *   in a repository (Vue SFC, React TSX, or plain TypeScript modules).
 * - {@link buildComponentGraph} — turn those components into a serializable
 *   dependency graph with reverse lookups for impact analysis.
 * - {@link parseTokenSchema} — normalize JSON and CSS design tokens into one
 *   comparable schema.
 *
 * @packageDocumentation
 */

export { parseComponents } from './ast-parser'
export { buildComponentGraph } from './component-graph'
export { parseTokenSchema } from './token-schema'

export { DEFAULT_EXCLUDE_PATTERNS } from './types'

export type {
  ComponentGraph,
  ComponentGraphData,
  ComponentGraphEdge,
  ComponentGraphIndex,
  ComponentGraphNode,
  ComponentKind,
  DesignToken,
  ExportedFunction,
  ExportedType,
  ExportedTypeKind,
  ExportedValue,
  FunctionParameter,
  GraphEdgeKind,
  GraphNodeKind,
  GraphQueryOptions,
  GraphWarning,
  ModuleReference,
  ParseComponentsOptions,
  ParsedComponent,
  ParseTokenSchemaOptions,
  PropDefinition,
  SourceLocation,
  TokenCategory,
  TokenParseWarning,
  TokenSchema,
  TokenSourceFile,
  TokenSourceFormat,
  TokenVariant,
  TypeMember,
} from './types'
