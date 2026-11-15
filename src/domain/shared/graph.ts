/** Adjacency list: node id -> ids it depends on. Dependencies on unknown nodes are ignored here. */
export type DependencyGraph = ReadonlyMap<string, readonly string[]>;

/**
 * Finds one dependency cycle and returns it as a path that starts and ends on the same node
 * (`["a", "b", "a"]`), or `undefined` when the graph is acyclic. Iteration order is the map's
 * insertion order, so the reported cycle is deterministic.
 */
export function findDependencyCycle(graph: DependencyGraph): readonly string[] | undefined {
  const done = new Set<string>();

  const visit = (node: string, path: string[]): readonly string[] | undefined => {
    const at = path.indexOf(node);
    if (at !== -1) {
      return [...path.slice(at), node];
    }
    if (done.has(node)) {
      return undefined;
    }
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) {
        const cycle = visit(next, path);
        if (cycle !== undefined) {
          return cycle;
        }
      }
    }
    path.pop();
    done.add(node);
    return undefined;
  };

  for (const node of graph.keys()) {
    const cycle = visit(node, []);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return undefined;
}
