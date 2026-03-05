import { DepGraph } from 'dependency-graph';

import type { WorkspacePackage } from '../types';

import { CycleDetectedError } from './errors';

// Precompute all transitive dependencies for every node in the graph.
// Returns a Map keyed by package name, value is the array from graph.dependenciesOf().
export function precomputeTransitiveDeps(graph: DepGraph<WorkspacePackage>): Map<string, string[]> {
  const cache = new Map<string, string[]>();
  for (const node of graph.overallOrder()) {
    cache.set(node, graph.dependenciesOf(node));
  }
  return cache;
}

// Precompute all transitive dependents for every node in the graph.
// Returns a Map keyed by package name, value is the array from graph.dependantsOf().
export function precomputeTransitiveDependents(graph: DepGraph<WorkspacePackage>): Map<string, string[]> {
  const cache = new Map<string, string[]>();
  for (const node of graph.overallOrder()) {
    cache.set(node, graph.dependantsOf(node));
  }
  return cache;
}

export function buildDependencyGraph(packages: WorkspacePackage[]): DepGraph<WorkspacePackage> {
  const graph = new DepGraph<WorkspacePackage>();
  const names = new Set(packages.map(p => p.name));

  for (const pkg of packages) {
    graph.addNode(pkg.name, pkg);
  }

  for (const pkg of packages) {
    const allDeps: Record<string, string> = {
      ...pkg.packageJson.dependencies,
      ...pkg.packageJson.peerDependencies,
      ...pkg.packageJson.optionalDependencies,
    };
    for (const depName of Object.keys(allDeps)) {
      if (names.has(depName)) {
        graph.addDependency(pkg.name, depName);
      }
    }
  }

  return graph;
}

// Phase 1: targets + their transitive deps (no dependents)
// When cachedDeps is provided, uses precomputed transitive deps instead of calling the graph.
export function computeInitialScope(
  graph: DepGraph<WorkspacePackage>,
  targets: string[],
  cachedDeps?: Map<string, string[]>,
): { scope: Set<string>; dependencies: Record<string, string[]> } {
  const scope = new Set<string>();
  const dependencies: Record<string, string[]> = {};

  for (const name of targets) {
    scope.add(name);

    try {
      const directDeps = graph.directDependenciesOf(name).filter(dep => dep !== name);
      dependencies[name] = directDeps;
      // Include transitive dependencies so workspace deps are published together
      const allDeps = cachedDeps?.get(name) ?? graph.dependenciesOf(name);
      for (const dep of allDeps) {
        scope.add(dep);
      }
    } catch {
      dependencies[name] = [];
    }
  }

  return { scope, dependencies };
}

// Phase 2: from specific "changed" packages, compute their dependents.
// Apply consumer filter. Only return packages not already in currentScope.
// When cachedDependents is provided, uses precomputed transitive dependents instead of calling the graph.
export function expandDependents(
  graph: DepGraph<WorkspacePackage>,
  changedPackages: string[],
  currentScope: Set<string>,
  consumedPackages?: Set<string>,
  cachedDependents?: Map<string, string[]>,
): {
  newPackages: string[];
  dependents: Record<string, string[]>;
  skippedDependents: { name: string; via: string }[];
} {
  const dependents: Record<string, string[]> = {};
  const newPackages = new Set<string>();
  const allPossibleDependents = consumedPackages ? new Map<string, string>() : null;

  for (const name of changedPackages) {
    try {
      const transitiveDependents = cachedDependents?.get(name) ?? graph.dependantsOf(name);
      if (allPossibleDependents) {
        for (const d of transitiveDependents) {
          if (!allPossibleDependents.has(d)) {
            allPossibleDependents.set(d, name);
          }
        }
      }

      if (consumedPackages) {
        // Keep dependents that are consumed by active repos OR already in scope
        const filtered = transitiveDependents.filter(d => currentScope.has(d) || consumedPackages.has(d));
        dependents[name] = filtered;
        for (const dep of filtered) {
          if (!currentScope.has(dep)) {
            newPackages.add(dep);
          }
        }
      } else {
        dependents[name] = transitiveDependents;
        for (const dep of transitiveDependents) {
          if (!currentScope.has(dep)) {
            newPackages.add(dep);
          }
        }
      }
    } catch (err: any) {
      if (err.cyclePath) {
        throw new CycleDetectedError(`Dependency cycle detected: ${err.cyclePath.join(' -> ')}`);
      }
      throw err;
    }
  }

  // Skipped dependents: those that would have been included without the filter
  // but are not in scope and not in the new packages set
  const allIncluded = new Set([...currentScope, ...newPackages]);
  const skippedDependents: { name: string; via: string }[] = allPossibleDependents
    ? [...allPossibleDependents.entries()]
        .filter(e => !allIncluded.has(e[0]))
        .filter(e => !graph.getNodeData(e[0]).packageJson.private)
        .map(e => ({ name: e[0], via: e[1] }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
    : [];

  return { newPackages: [...newPackages], dependents, skippedDependents };
}

// Phase 3: ensure every publishable package in scope has its workspace deps in scope.
// Returns the expanded scope (may add new packages). Skips private packages.
// When cachedDeps is provided, uses precomputed transitive deps instead of calling the graph.
export function closeUnderDeps(
  graph: DepGraph<WorkspacePackage>,
  scope: Set<string>,
  cachedDeps?: Map<string, string[]>,
): Set<string> {
  const result = new Set(scope);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of result) {
      const pkg = graph.getNodeData(name);
      if (pkg.packageJson.private) {
        continue;
      }
      try {
        const deps = cachedDeps?.get(name) ?? graph.dependenciesOf(name);
        for (const dep of deps) {
          if (!result.has(dep)) {
            result.add(dep);
            changed = true;
          }
        }
      } catch {}
    }
  }
  return result;
}

export function deterministicToposort(graph: DepGraph<WorkspacePackage>, subset: Set<string>): string[] {
  // Build in-degree map for the subset
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const name of subset) {
    inDegree.set(name, 0);
    adjList.set(name, []);
  }

  for (const name of subset) {
    try {
      for (const dep of graph.directDependenciesOf(name)) {
        if (subset.has(dep)) {
          adjList.get(dep)!.push(name);
          inDegree.set(name, (inDegree.get(name) || 0) + 1);
        }
      }
    } catch {
      // Skip nodes not in graph
    }
  }

  // Kahn's algorithm with lexical tie-breaking.
  // Uses index-based consumption to avoid O(n) Array.shift() on each iteration.
  const queue = [...subset].filter(n => inDegree.get(n) === 0).toSorted();
  const result: string[] = [];
  let head = 0;

  while (head < queue.length) {
    const node = queue[head++];
    result.push(node);

    for (const dependent of (adjList.get(node) || []).toSorted()) {
      const newDeg = (inDegree.get(dependent) || 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position within the unconsumed portion of the queue
        let idx = -1;
        for (let i = head; i < queue.length; i++) {
          if (queue[i] > dependent) {
            idx = i;
            break;
          }
        }
        if (idx === -1) {
          queue.push(dependent);
        } else {
          queue.splice(idx, 0, dependent);
        }
      }
    }
  }

  // Append any nodes stuck in cycles (never reached in-degree 0)
  if (result.length < subset.size) {
    const missing = [...subset].filter(n => !result.includes(n));
    result.push(...missing.toSorted());
  }

  return result;
}
