/**
 * Interface Edge - Represents an edge in the graph with a `from` node and a `to` node
 */
export interface Edge<Node> {
  readonly from: Node;
  readonly to: Node;
}

/**
 * Interface Graph - Represents a graph data structure with a list of nodes and edges
 */
export interface Graph<Node> {
  readonly nodes: Array<Node>;
  readonly edges: Array<Edge<Node>>;
}

/**
 * Type NodeIdentitySupplier - A function that supplies the identity of a node.
 * Used to uniquely identify a node in the graph.
 */
export type NodeIdentitySupplier<Node, NodeID> = (n: Node) => NodeID;

/**
 * Type NodeComparator - A function that compares two nodes.
 * Used for sorting and comparing nodes.
 */
export type NodeComparator<Node> = (n1: Node, n2: Node) => number;

/**
 * Function dagIsCyclical - Returns true if a cycle is detected in the directed acyclic graph.
 * It uses depth-first search and keeps track of visited nodes and the recursion stack.
 * If a node is encountered that is already in the recursion stack, a cycle is detected.
 */
export function dagIsCyclicalDFS<Node, NodeID>(
  graph: Graph<Node>,
  identity: NodeIdentitySupplier<Node, NodeID>,
  compare: NodeComparator<Node>,
): boolean {
  const visited: Set<NodeID> = new Set();
  const recursionStack: Set<NodeID> = new Set();

  for (const node of graph.nodes) {
    if (dagDFS(node, visited, recursionStack)) return true;
  }

  function dagDFS(
    node: Node,
    visited: Set<NodeID>,
    recursionStack: Set<NodeID>,
  ): boolean {
    const nodeId = identity(node);
    visited.add(nodeId);
    recursionStack.add(nodeId);

    for (const edge of graph.edges) {
      if (compare(edge.from, node) === 0) {
        const neighbour = edge.to;

        if (
          !visited.has(identity(neighbour)) &&
          dagDFS(neighbour, visited, recursionStack)
        ) return true;
        else if (recursionStack.has(identity(neighbour))) return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  return false;
}

/**
 * Function dagCycles - Returns all the nodes and edges that form cycles in the directed acyclic graph.
 * It uses depth-first search and keeps track of visited nodes and the recursion stack.
 * If a node is encountered that is already in the recursion stack, a cycle is detected and stored.
 * This function is more complex and can be computationally intensive as it has to find and store all cycles.
 */
export function dagCyclesDFS<Node, NodeID>(
  graph: Graph<Node>,
  identity: NodeIdentitySupplier<Node, NodeID>,
  compare: NodeComparator<Node>,
): Array<{ cycleNodes: Array<Node>; cycleEdges: Array<Edge<Node>> }> {
  const visited: Set<NodeID> = new Set();
  const recursionStack: Set<NodeID> = new Set();
  const cycleList: Array<
    { cycleNodes: Array<Node>; cycleEdges: Array<Edge<Node>> }
  > = [];

  for (const node of graph.nodes) {
    if (!visited.has(identity(node))) {
      const cycleNodes: Array<Node> = [];
      const cycleEdges: Array<Edge<Node>> = [];
      if (dagDFS(node, visited, recursionStack, cycleNodes, cycleEdges)) {
        cycleList.push({ cycleNodes, cycleEdges });
      }
    }
  }

  function dagDFS(
    node: Node,
    visited: Set<NodeID>,
    recursionStack: Set<NodeID>,
    cycleNodes: Array<Node>,
    cycleEdges: Array<Edge<Node>>,
  ): boolean {
    const nodeId = identity(node);
    visited.add(nodeId);
    recursionStack.add(nodeId);
    cycleNodes.push(node);

    for (const edge of graph.edges) {
      if (compare(edge.from, node) === 0) {
        const neighbour = edge.to;
        cycleEdges.push(edge);

        if (!visited.has(identity(neighbour))) {
          if (
            dagDFS(neighbour, visited, recursionStack, cycleNodes, cycleEdges)
          ) return true;
        } else if (recursionStack.has(identity(neighbour))) {
          return true;
        }

        cycleEdges.pop();
      }
    }

    recursionStack.delete(nodeId);
    cycleNodes.pop();
    return false;
  }

  return cycleList;
}

/**
 * Function dagTopologicalSort - Performs a topological sort on the directed acyclic graph and returns an array of nodes in sorted order.
 * It relies on the fact that a directed acyclic graph (DAG) can be sorted in a linear order.
 */
export function dagTopologicalSortDFS<Node, NodeID>(
  graph: Graph<Node>,
  identity: NodeIdentitySupplier<Node, NodeID>,
  compare: NodeComparator<Node>,
): Array<Node> {
  const visited: Set<NodeID> = new Set();
  const stack: Array<Node> = [];

  for (const node of graph.nodes) {
    if (!visited.has(identity(node))) {
      dagDFS(node);
    }
  }

  function dagDFS(node: Node) {
    visited.add(identity(node));

    for (const edge of graph.edges) {
      if (compare(edge.from, node) === 0) {
        const neighbour = edge.to;
        if (!visited.has(identity(neighbour))) {
          dagDFS(neighbour);
        }
      }
    }

    stack.push(node);
  }

  return stack.reverse();
}

/**
 * Returns the dependencies and dependents of a given node
 * in a directed acyclic graph (DAG) based on a provided topological sort.
 * The function takes the graph, topological sort, and the target node as input.
 * It returns an object with `dependencies` and `dependents` properties.
 */
export function dagDependencies<Node, NodeID>(
  graph: Graph<Node>,
  identity: NodeIdentitySupplier<Node, NodeID>,
  compare: NodeComparator<Node>,
  topologicalSortSupplier: (
    graph: Graph<Node>,
    identity: NodeIdentitySupplier<Node, NodeID>,
    compare: NodeComparator<Node>,
  ) => Array<Node>,
  targetNode: Node,
): { dependencies: Array<Node>; dependents: Array<Node> } {
  const dependencies: Array<Node> = [];
  const dependents: Array<Node> = [];
  const visited: Set<NodeID> = new Set();

  const topologicalSort = topologicalSortSupplier(graph, identity, compare);
  const nodeIndex: Map<NodeID, number> = new Map();
  for (let i = 0; i < topologicalSort.length; i++) {
    nodeIndex.set(identity(topologicalSort[i]), i);
  }

  // Traverse the topological sort starting from the target node
  const targetIndex = nodeIndex.get(identity(targetNode));
  if (typeof targetIndex === "number") {
    for (let i = targetIndex - 1; i >= 0; i--) {
      const node = topologicalSort[i];
      const nodeId = identity(node);
      visited.add(nodeId);
      dependencies.push(node);
    }

    for (let i = targetIndex + 1; i < topologicalSort.length; i++) {
      const node = topologicalSort[i];
      const nodeId = identity(node);
      visited.add(nodeId);
      dependents.push(node);
    }
  }

  // Check remaining nodes that are not visited
  for (const node of graph.nodes) {
    const nodeId = identity(node);
    if (!visited.has(nodeId)) {
      if (compare(node, targetNode) < 0) {
        dependencies.push(node);
      } else if (compare(node, targetNode) > 0) {
        dependents.push(node);
      }
    }
  }

  return { dependencies, dependents };
}

/**
 * Directed Acyclic Graph (DAG) depth-first algorithm bundle. This is the object
 * that should typically be used for DAG interactions. The `dag*` functions are
 * available when you need more flexibility.
 * @param identity function which uniquely identify a node in the graph.
 * @param compare function that compares two nodes, used for sorting and comparing nodes.
 * @returns an object with functions to manage a DAG using depth-first algorithm
 */
export const dagDepthFirst = <Node, NodeID>(
  identity: NodeIdentitySupplier<Node, NodeID>,
  compare: NodeComparator<Node>,
) => {
  return {
    isCyclical: (graph: Graph<Node>) =>
      dagIsCyclicalDFS(graph, identity, compare),
    cycles: (graph: Graph<Node>) => dagCyclesDFS(graph, identity, compare),
    deps: (graph: Graph<Node>, node: Node) =>
      dagDependencies(graph, identity, compare, dagTopologicalSortDFS, node),
    topologicalSort: (graph: Graph<Node>) =>
      dagTopologicalSortDFS(graph, identity, compare),
  };
};

/**
 * Generates a PlantUML diagram of a given graph.
 * It accepts a graph, node configuration, and edge configuration to customize the diagram.
 * Returns a string representing the PlantUML diagram.
 */
export function graphPlantUmlDiagram<Node>(
  graph: Graph<Node>,
  pumlOptions: {
    node: (node: Node) => { text: string; features?: string };
    edge: (
      edge: Edge<Node>,
    ) => { fromText: string; toText: string; features?: string };
  },
): string {
  const nodeLines: string[] = [];
  const edgeLines: string[] = [];

  // Process nodes
  for (const node of graph.nodes) {
    const { text, features } = pumlOptions.node(node);
    const nodeLine = `${text}${features ? ` ${features}` : ""}`;
    nodeLines.push(nodeLine);
  }

  // Process edges
  for (const edge of graph.edges) {
    const { fromText, toText, features } = pumlOptions.edge(edge);
    const edgeLine = `${fromText} --> ${toText}${
      features ? ` ${features}` : ""
    }`;
    edgeLines.push(edgeLine);
  }

  // Generate the PlantUML diagram
  const diagram = `@startuml\n${nodeLines.join("\n")}\n${
    edgeLines.join("\n")
  }\n@enduml`;
  return diagram;
}
