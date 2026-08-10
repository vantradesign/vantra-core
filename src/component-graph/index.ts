import type {
  ComponentGraph,
  ComponentGraphData,
  ComponentGraphEdge,
  ComponentGraphIndex,
  ComponentGraphNode,
  GraphEdgeKind,
  GraphQueryOptions,
  GraphWarning,
  ModuleReference,
  ParsedComponent,
} from '../types'
import { findCycles } from './cycles'

/** Prefix used for the synthetic nodes that represent design tokens. */
const TOKEN_NODE_PREFIX = 'token:'

/** Every edge kind, used as the default traversal filter. */
const ALL_EDGE_KINDS: readonly GraphEdgeKind[] = [
  'component',
  'utility',
  'type',
  're-export',
  'token',
]

/**
 * Builds the dependency graph for a set of parsed components, or re-attaches the
 * traversal helpers to a previously serialized graph.
 *
 * The returned graph is plain JSON data plus non-enumerable helper methods:
 * `JSON.stringify(graph)` yields exactly {@link ComponentGraphData}, and
 * spreading it (`{ ...graph }`) yields the same pure data. That is what makes it
 * safe to persist to Supabase or hand between CI steps.
 *
 * Passing a deserialized {@link ComponentGraphData} back in is the supported way
 * to recover `getConsumersOf`/`getDependenciesOf` without re-parsing the
 * repository.
 *
 * @param input - Parsed components to build from, or a serialized graph to rehydrate.
 * @returns A graph with reverse-lookup helpers attached.
 * @throws TypeError when `input` is neither an array nor a graph-shaped object.
 *
 * @example Build, persist, rehydrate
 * ```ts
 * import { parseComponents, buildComponentGraph } from '@vantradesign/core'
 *
 * const graph = buildComponentGraph(parseComponents('./packages/ui'))
 *
 * const json = JSON.stringify(graph)            // pure data, no methods
 * const restored = buildComponentGraph(JSON.parse(json))
 *
 * restored.getConsumersOf('Button')             // who renders Button?
 * restored.getDependenciesOf('Button')          // what does Button need?
 * ```
 *
 * @public
 */
export function buildComponentGraph(
  input: ParsedComponent[] | ComponentGraphData,
): ComponentGraph {
  if (Array.isArray(input)) {
    return attachHelpers(buildData(input))
  }

  if (typeof input !== 'object' || input === null || !Array.isArray(input.nodes)) {
    throw new TypeError(
      'buildComponentGraph: expected a ParsedComponent[] or a serialized ComponentGraphData object.',
    )
  }

  return attachHelpers(normalizeData(input))
}

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Derives the pure-data graph from parsed components.
 */
function buildData(components: readonly ParsedComponent[]): ComponentGraphData {
  const warnings: GraphWarning[] = []
  const nodes = new Map<string, ComponentGraphNode>()

  const byFilePath = new Map<string, ParsedComponent[]>()
  const byPackage = new Map<string, ParsedComponent[]>()

  for (const component of components) {
    if (nodes.has(component.id)) {
      warnings.push({
        code: 'duplicate-node-id',
        message: `Duplicate component id "${component.id}"; only the first occurrence is kept.`,
        nodeId: component.id,
      })
      continue
    }

    nodes.set(component.id, toNode(component))

    appendTo(byFilePath, component.filePath, component)
    if (component.packageName !== undefined) {
      appendTo(byPackage, component.packageName, component)
    }
  }

  // symbols accumulated per (from, to, kind)
  const edgeSymbols = new Map<string, Set<string>>()

  const addEdge = (from: string, to: string, kind: GraphEdgeKind, symbols: string[]): void => {
    const key = `${from}\u0000${to}\u0000${kind}`
    const existing = edgeSymbols.get(key)
    if (existing === undefined) {
      edgeSymbols.set(key, new Set(symbols))
      return
    }
    for (const symbol of symbols) existing.add(symbol)
  }

  for (const component of components) {
    if (!nodes.has(component.id)) continue

    for (const reference of component.imports) {
      linkReference(component, reference, false, byFilePath, byPackage, addEdge, warnings)
    }

    for (const reference of component.reExports) {
      linkReference(component, reference, true, byFilePath, byPackage, addEdge, warnings)
    }

    for (const token of component.tokenReferences) {
      const tokenId = `${TOKEN_NODE_PREFIX}${token}`
      if (!nodes.has(tokenId)) nodes.set(tokenId, toTokenNode(tokenId, token))
      addEdge(component.id, tokenId, 'token', [token])
    }
  }

  const edges = materializeEdges(edgeSymbols)
  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))

  return {
    version: 1,
    nodes: sortedNodes,
    edges,
    index: buildIndex(sortedNodes),
    cycles: computeCycles(sortedNodes, edges),
    warnings,
  }
}

/**
 * Turns one module reference into zero or more graph edges.
 */
function linkReference(
  source: ParsedComponent,
  reference: ModuleReference,
  isReExport: boolean,
  byFilePath: ReadonlyMap<string, ParsedComponent[]>,
  byPackage: ReadonlyMap<string, ParsedComponent[]>,
  addEdge: (from: string, to: string, kind: GraphEdgeKind, symbols: string[]) => void,
  warnings: GraphWarning[],
): void {
  if (reference.isExternal) return

  const targets = resolveTargets(reference, byFilePath, byPackage)

  if (targets.length === 0) {
    if (reference.resolvedPath === undefined && reference.resolvedPackage === undefined) {
      warnings.push({
        code: 'unresolved-import',
        message: `Could not resolve "${reference.moduleSpecifier}" imported by ${source.filePath}.`,
        nodeId: source.id,
      })
    }
    return
  }

  for (const target of targets) {
    if (target.id === source.id) continue

    const kind: GraphEdgeKind = isReExport
      ? 're-export'
      : reference.isTypeOnly
        ? 'type'
        : target.kind === 'module'
          ? 'utility'
          : 'component'

    addEdge(source.id, target.id, kind, reference.names)
  }
}

/**
 * Finds the components a module reference points at.
 *
 * Name matching is attempted first so that importing `Button` from a barrel
 * links to `Button` rather than to every component the barrel re-exports. When
 * a *file* reference matches no name (the common case for utility modules whose
 * node is named after the file), the file's nodes are used as the fallback.
 * Package-level references get no such fallback, since that would link a single
 * import to an entire package.
 */
function resolveTargets(
  reference: ModuleReference,
  byFilePath: ReadonlyMap<string, ParsedComponent[]>,
  byPackage: ReadonlyMap<string, ParsedComponent[]>,
): ParsedComponent[] {
  const filePath = reference.resolvedPath
  const isFileReference = filePath !== undefined

  const candidates = isFileReference
    ? (byFilePath.get(filePath) ?? [])
    : reference.resolvedPackage !== undefined
      ? (byPackage.get(reference.resolvedPackage) ?? [])
      : []

  if (candidates.length === 0) return []

  if (reference.names.includes('*')) return [...candidates]

  const matched = candidates.filter((candidate) => matchesNames(candidate, reference.names))
  if (matched.length > 0) return matched

  return isFileReference ? [...candidates] : []
}

/**
 * `true` when a component owns any of the imported binding names.
 */
function matchesNames(component: ParsedComponent, names: readonly string[]): boolean {
  for (const name of names) {
    if (name === 'default') {
      if (component.isDefaultExport) return true
      continue
    }
    if (component.name === name) return true
    if (component.functions.some((entry) => entry.name === name)) return true
    if (component.types.some((entry) => entry.name === name)) return true
    if (component.values.some((entry) => entry.name === name)) return true
  }
  return false
}

/**
 * Converts a parsed component into its graph-node summary.
 */
function toNode(component: ParsedComponent): ComponentGraphNode {
  const node: ComponentGraphNode = {
    id: component.id,
    name: component.name,
    kind: component.kind,
    filePath: component.filePath,
    propNames: component.props.map((prop) => prop.name),
    exportedFunctionNames: component.functions.map((entry) => entry.name),
    exportedTypeNames: component.types.map((entry) => entry.name),
    exportedValueNames: component.values.map((entry) => entry.name),
  }

  if (component.packageName !== undefined) node.packageName = component.packageName

  return node
}

/**
 * Builds a synthetic node representing a design token.
 */
function toTokenNode(id: string, token: string): ComponentGraphNode {
  return {
    id,
    name: token,
    kind: 'token',
    filePath: '',
    propNames: [],
    exportedFunctionNames: [],
    exportedTypeNames: [],
    exportedValueNames: [],
  }
}

/**
 * Flattens the accumulated edge map into a deterministically ordered array.
 */
function materializeEdges(edgeSymbols: ReadonlyMap<string, Set<string>>): ComponentGraphEdge[] {
  const edges: ComponentGraphEdge[] = []

  for (const [key, symbols] of edgeSymbols) {
    const [from, to, kind] = key.split('\u0000')
    if (from === undefined || to === undefined || kind === undefined) continue

    edges.push({
      from,
      to,
      kind: kind as GraphEdgeKind,
      symbols: [...symbols].sort(),
    })
  }

  return edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  )
}

/**
 * Builds the name/path/package lookup indexes.
 */
function buildIndex(nodes: readonly ComponentGraphNode[]): ComponentGraphIndex {
  const byName: Record<string, string[]> = {}
  const byFilePath: Record<string, string[]> = {}
  const byPackage: Record<string, string[]> = {}

  for (const node of nodes) {
    ;(byName[node.name] ??= []).push(node.id)
    if (node.filePath !== '') (byFilePath[node.filePath] ??= []).push(node.id)
    if (node.packageName !== undefined) (byPackage[node.packageName] ??= []).push(node.id)
  }

  return { byName, byFilePath, byPackage }
}

/**
 * Detects circular dependencies among non-token nodes.
 */
function computeCycles(
  nodes: readonly ComponentGraphNode[],
  edges: readonly ComponentGraphEdge[],
): string[][] {
  const codeNodeIds = nodes.filter((node) => node.kind !== 'token').map((node) => node.id)
  const codeNodeSet = new Set(codeNodeIds)

  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.kind === 'token') continue
    if (!codeNodeSet.has(edge.from) || !codeNodeSet.has(edge.to)) continue
    appendTo(adjacency, edge.from, edge.to)
  }

  return findCycles(codeNodeIds, adjacency)
}

/**
 * Appends a value to a keyed list, creating the list on first use.
 */
function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)
  if (existing === undefined) {
    map.set(key, [value])
    return
  }
  existing.push(value)
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Fills in any derived fields missing from a deserialized graph, so that graphs
 * persisted by older versions stay usable.
 */
function normalizeData(data: ComponentGraphData): ComponentGraphData {
  const nodes = data.nodes
  const edges = Array.isArray(data.edges) ? data.edges : []

  return {
    version: 1,
    nodes,
    edges,
    index: isUsableIndex(data.index) ? data.index : buildIndex(nodes),
    cycles: Array.isArray(data.cycles) ? data.cycles : computeCycles(nodes, edges),
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  }
}

/**
 * `true` when a deserialized index has the expected shape.
 */
function isUsableIndex(index: ComponentGraphIndex | undefined): index is ComponentGraphIndex {
  return (
    typeof index === 'object' &&
    index !== null &&
    typeof index.byName === 'object' &&
    typeof index.byFilePath === 'object' &&
    typeof index.byPackage === 'object'
  )
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Attaches the traversal helpers as non-enumerable methods, keeping the object
 * indistinguishable from plain data when serialized or spread.
 */
function attachHelpers(data: ComponentGraphData): ComponentGraph {
  const nodesById = new Map(data.nodes.map((node) => [node.id, node]))

  const outgoing = new Map<string, ComponentGraphEdge[]>()
  const incoming = new Map<string, ComponentGraphEdge[]>()
  for (const edge of data.edges) {
    appendTo(outgoing, edge.from, edge)
    appendTo(incoming, edge.to, edge)
  }

  const resolveIds = (nameOrId: string): string[] => {
    if (nodesById.has(nameOrId)) return [nameOrId]
    return data.index.byName[nameOrId] ?? []
  }

  const traverse = (
    nameOrId: string,
    adjacency: ReadonlyMap<string, ComponentGraphEdge[]>,
    direction: 'from' | 'to',
    options: GraphQueryOptions,
  ): ComponentGraphNode[] => {
    const seeds = resolveIds(nameOrId)
    if (seeds.length === 0) return []

    const kinds = new Set(options.kinds ?? ALL_EDGE_KINDS)
    const maxDepth = options.transitive === true ? (options.maxDepth ?? Infinity) : 1

    const seedSet = new Set(seeds)
    const found = new Set<string>()
    let frontier = [...seeds]

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = []

      for (const nodeId of frontier) {
        for (const edge of adjacency.get(nodeId) ?? []) {
          if (!kinds.has(edge.kind)) continue

          const neighbour = direction === 'from' ? edge.to : edge.from
          if (found.has(neighbour)) continue

          found.add(neighbour)
          next.push(neighbour)
        }
      }

      frontier = next
    }

    const result: ComponentGraphNode[] = []
    for (const id of found) {
      if (seedSet.has(id)) continue
      const node = nodesById.get(id)
      if (node !== undefined) result.push(node)
    }

    return result.sort((a, b) => a.id.localeCompare(b.id))
  }

  const graph = data as ComponentGraph

  define(graph, 'getNode', (nameOrId: string): ComponentGraphNode | undefined => {
    const direct = nodesById.get(nameOrId)
    if (direct !== undefined) return direct

    const matches = data.index.byName[nameOrId] ?? []
    if (matches.length !== 1) return undefined

    return matches[0] === undefined ? undefined : nodesById.get(matches[0])
  })

  define(
    graph,
    'getDependenciesOf',
    (nameOrId: string, options: GraphQueryOptions = {}): ComponentGraphNode[] =>
      traverse(nameOrId, outgoing, 'from', options),
  )

  define(
    graph,
    'getConsumersOf',
    (nameOrId: string, options: GraphQueryOptions = {}): ComponentGraphNode[] =>
      traverse(nameOrId, incoming, 'to', options),
  )

  define(graph, 'toJSON', (): ComponentGraphData => ({
    version: data.version,
    nodes: data.nodes,
    edges: data.edges,
    index: data.index,
    cycles: data.cycles,
    warnings: data.warnings,
  }))

  return graph
}

/**
 * Defines a non-enumerable method so it survives neither `JSON.stringify` nor
 * object spreading — which is precisely what we want for a persisted artefact.
 */
function define<K extends keyof ComponentGraph>(
  target: ComponentGraph,
  key: K,
  value: ComponentGraph[K],
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: true,
  })
}
