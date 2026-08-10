import { describe, expect, it } from 'vitest'
import { parseComponents } from '../src/ast-parser'
import { buildComponentGraph } from '../src/component-graph'
import type { ComponentGraphData } from '../src/types'
import { fixture } from './helpers'

const reactComponents = parseComponents(fixture('react-lib'))
const graph = buildComponentGraph(reactComponents)

describe('buildComponentGraph — structure', () => {
  it('creates one node per parsed component', () => {
    for (const component of reactComponents) {
      expect(graph.getNode(component.id)).toBeDefined()
    }
  })

  it('classifies edges by what the target actually is', () => {
    const fromButton = graph.edges.filter((edge) => edge.from === 'src/Button.tsx#Button')

    expect(fromButton).toContainEqual(
      expect.objectContaining({
        to: 'src/hooks/useToggle.ts#useToggle',
        kind: 'utility',
        symbols: ['useToggle'],
      }),
    )

    expect(fromButton).toContainEqual(
      expect.objectContaining({ to: 'src/types.ts#types', kind: 'type' }),
    )
  })

  it('records component-to-component edges', () => {
    const cardEdges = graph.edges.filter((edge) => edge.from === 'src/Card.tsx#Card')

    expect(cardEdges).toContainEqual(
      expect.objectContaining({ to: 'src/Button.tsx#Button', kind: 'component' }),
    )
  })

  it('marks barrel re-exports with their own edge kind', () => {
    const barrelEdges = graph.edges.filter((edge) => edge.from === 'src/index.ts#index')

    expect(barrelEdges.length).toBeGreaterThan(0)
    expect(barrelEdges.every((edge) => edge.kind === 're-export')).toBe(true)
  })

  it('creates synthetic token nodes and edges', () => {
    const tokenNode = graph.getNode('token:--color-brand-primary')

    expect(tokenNode).toMatchObject({ kind: 'token', name: '--color-brand-primary' })
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: 'src/Button.tsx#Button',
        to: 'token:--color-brand-primary',
        kind: 'token',
      }),
    )
  })

  it('never emits an edge from a node to itself', () => {
    expect(graph.edges.every((edge) => edge.from !== edge.to)).toBe(true)
  })

  it('produces deterministic, sorted output', () => {
    const rebuilt = buildComponentGraph(parseComponents(fixture('react-lib')))

    expect(rebuilt.nodes).toEqual(graph.nodes)
    expect(rebuilt.edges).toEqual(graph.edges)
    expect(graph.nodes.map((node) => node.id)).toEqual(
      [...graph.nodes.map((node) => node.id)].sort(),
    )
  })
})

describe('buildComponentGraph — indexes and queries', () => {
  it('indexes nodes by name, path and package', () => {
    expect(graph.index.byName['Button']).toEqual(['src/Button.tsx#Button'])
    expect(graph.index.byFilePath['src/Card.tsx']).toEqual([
      'src/Card.tsx#Card',
      'src/Card.tsx#CardHeader',
    ])
  })

  it('resolves a node by friendly name as well as by id', () => {
    expect(graph.getNode('Button')?.id).toBe('src/Button.tsx#Button')
    expect(graph.getNode('src/Button.tsx#Button')?.name).toBe('Button')
    expect(graph.getNode('NoSuchComponent')).toBeUndefined()
  })

  it('answers the impact-analysis question: who consumes this?', () => {
    const consumers = graph.getConsumersOf('Button').map((node) => node.id)

    expect(consumers).toContain('src/Card.tsx#Card')
    expect(consumers).toContain('src/index.ts#index')
  })

  it('answers the dependency question: what does this need?', () => {
    const direct = graph.getDependenciesOf('Card').map((node) => node.id)

    expect(direct).toContain('src/Button.tsx#Button')
    expect(direct).not.toContain('src/hooks/useToggle.ts#useToggle')
  })

  it('walks the graph transitively when asked', () => {
    const transitive = graph.getDependenciesOf('Card', { transitive: true }).map((n) => n.id)

    // Card → Button → useToggle
    expect(transitive).toContain('src/Button.tsx#Button')
    expect(transitive).toContain('src/hooks/useToggle.ts#useToggle')
  })

  it('honours maxDepth during transitive traversal', () => {
    const depthOne = graph
      .getDependenciesOf('Card', { transitive: true, maxDepth: 1 })
      .map((node) => node.id)

    expect(depthOne).toContain('src/Button.tsx#Button')
    expect(depthOne).not.toContain('src/hooks/useToggle.ts#useToggle')
  })

  it('filters traversal by edge kind', () => {
    const tokensOnly = graph.getDependenciesOf('Button', { kinds: ['token'] })

    expect(tokensOnly.length).toBeGreaterThan(0)
    expect(tokensOnly.every((node) => node.kind === 'token')).toBe(true)
  })

  it('excludes the queried node from its own results', () => {
    const dependencies = graph.getDependenciesOf('Button', { transitive: true })

    expect(dependencies.map((node) => node.id)).not.toContain('src/Button.tsx#Button')
  })

  it('returns an empty list for unknown names rather than throwing', () => {
    expect(graph.getDependenciesOf('Nope')).toEqual([])
    expect(graph.getConsumersOf('Nope')).toEqual([])
  })
})

describe('buildComponentGraph — cycles', () => {
  it('detects a multi-module circular dependency', () => {
    const cyclic = buildComponentGraph(parseComponents(fixture('cyclic')))

    expect(cyclic.cycles).toEqual([
      ['src/alpha.ts#alpha', 'src/beta.ts#beta', 'src/gamma.ts#gamma'],
    ])
  })

  it('reports no cycles for an acyclic library', () => {
    expect(graph.cycles).toEqual([])
  })

  it('ignores token edges when looking for cycles', () => {
    expect(graph.cycles.flat().every((id) => !id.startsWith('token:'))).toBe(true)
  })
})

describe('buildComponentGraph — serialization', () => {
  it('serializes to pure data with no methods attached', () => {
    const json = JSON.parse(JSON.stringify(graph)) as ComponentGraphData

    expect(Object.keys(json).sort()).toEqual([
      'cycles',
      'edges',
      'index',
      'nodes',
      'version',
      'warnings',
    ])
    expect('getNode' in json).toBe(false)
  })

  it('keeps helpers non-enumerable so spreading yields plain data', () => {
    expect(Object.keys({ ...graph })).not.toContain('getConsumersOf')
  })

  it('round-trips through JSON without losing query behaviour', () => {
    const restored = buildComponentGraph(
      JSON.parse(JSON.stringify(graph)) as ComponentGraphData,
    )

    expect(restored.nodes).toEqual(graph.nodes)
    expect(restored.edges).toEqual(graph.edges)
    expect(restored.getConsumersOf('Button').map((node) => node.id)).toEqual(
      graph.getConsumersOf('Button').map((node) => node.id),
    )
    expect(restored.getDependenciesOf('Card', { transitive: true }).map((n) => n.id)).toEqual(
      graph.getDependenciesOf('Card', { transitive: true }).map((n) => n.id),
    )
  })

  it('rebuilds derived data missing from an older serialized graph', () => {
    const stripped = {
      version: 1,
      nodes: graph.nodes,
      edges: graph.edges,
    } as unknown as ComponentGraphData

    const restored = buildComponentGraph(stripped)

    expect(restored.index.byName['Button']).toEqual(['src/Button.tsx#Button'])
    expect(restored.cycles).toEqual([])
    expect(restored.getConsumersOf('Button').length).toBeGreaterThan(0)
  })

  it('rejects input that is neither components nor a graph', () => {
    expect(() => buildComponentGraph({} as ComponentGraphData)).toThrow(TypeError)
  })

  it('handles an empty repository gracefully', () => {
    const empty = buildComponentGraph([])

    expect(empty.nodes).toEqual([])
    expect(empty.edges).toEqual([])
    expect(empty.cycles).toEqual([])
    expect(empty.getNode('anything')).toBeUndefined()
  })
})

describe('buildComponentGraph — cross-package edges', () => {
  const monorepo = buildComponentGraph(
    parseComponents(fixture('monorepo'), { aliases: { '@/': 'packages/ui/src/' } }),
  )

  it('links a component to the package it imports from', () => {
    const dependencies = monorepo.getDependenciesOf('VtAlert').map((node) => node.id)

    expect(dependencies).toContain('packages/tokens/src/index.ts#index')
    expect(dependencies).toContain('packages/ui/src/utils/text.ts#text')
  })

  it('records the package on each node', () => {
    expect(monorepo.getNode('VtAlert')?.packageName).toBe('@fixture/ui')
  })

  it('indexes nodes by package', () => {
    expect(monorepo.index.byPackage['@fixture/tokens']).toEqual([
      'packages/tokens/src/index.ts#index',
    ])
  })
})
