/**
 * Finds every strongly connected component with more than one member, plus
 * every self-referencing node, using an iterative Tarjan traversal.
 *
 * The traversal is iterative rather than recursive so that a deeply nested
 * dependency chain in a large monorepo cannot blow the call stack.
 *
 * @param nodeIds - All node ids to consider.
 * @param adjacency - Outgoing neighbours for each node id.
 * @returns Sorted cycles, each a sorted list of node ids.
 *
 * @internal
 */
export function findCycles(
  nodeIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const cycles: string[][] = []

  // Self-loops are genuine circular dependencies but form single-member SCCs,
  // so Tarjan alone would not surface them.
  for (const nodeId of nodeIds) {
    if (adjacency.get(nodeId)?.includes(nodeId) === true) {
      cycles.push([nodeId])
    }
  }

  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let counter = 0

  for (const start of nodeIds) {
    if (indices.has(start)) continue

    const work: Array<{ nodeId: string; nextChild: number }> = [{ nodeId: start, nextChild: 0 }]

    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame === undefined) break

      const { nodeId } = frame

      if (frame.nextChild === 0) {
        indices.set(nodeId, counter)
        lowLinks.set(nodeId, counter)
        counter += 1
        stack.push(nodeId)
        onStack.add(nodeId)
      }

      const neighbours = adjacency.get(nodeId) ?? []
      let descended = false

      for (let index = frame.nextChild; index < neighbours.length; index += 1) {
        const neighbour = neighbours[index]
        if (neighbour === undefined) continue

        if (!indices.has(neighbour)) {
          frame.nextChild = index + 1
          work.push({ nodeId: neighbour, nextChild: 0 })
          descended = true
          break
        }

        if (onStack.has(neighbour)) {
          lowLinks.set(
            nodeId,
            Math.min(lowLinks.get(nodeId) ?? 0, indices.get(neighbour) ?? 0),
          )
        }
      }

      if (descended) continue

      if (lowLinks.get(nodeId) === indices.get(nodeId)) {
        const component: string[] = []
        for (;;) {
          const popped = stack.pop()
          if (popped === undefined) break
          onStack.delete(popped)
          component.push(popped)
          if (popped === nodeId) break
        }
        if (component.length > 1) cycles.push(component.sort())
      }

      work.pop()

      const parent = work[work.length - 1]
      if (parent !== undefined) {
        lowLinks.set(
          parent.nodeId,
          Math.min(lowLinks.get(parent.nodeId) ?? 0, lowLinks.get(nodeId) ?? 0),
        )
      }
    }
  }

  return cycles.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''))
}
