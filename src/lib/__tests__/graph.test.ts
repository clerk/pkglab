import { describe, test, expect } from 'bun:test';
import { DepGraph } from 'dependency-graph';

import type { WorkspacePackage } from '../../types';
import {
  buildDependencyGraph,
  closeUnderDeps,
  computeInitialScope,
  deterministicToposort,
  expandDependents,
  precomputeTransitiveDependents,
  precomputeTransitiveDeps,
} from '../graph';


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePkg(
  name: string,
  opts: {
    deps?: Record<string, string>;
    peerDeps?: Record<string, string>;
    optionalDeps?: Record<string, string>;
    isPrivate?: boolean;
  } = {},
): WorkspacePackage {
  return {
    name,
    dir: `/workspace/packages/${name}`,
    publishable: !opts.isPrivate,
    packageJson: {
      name,
      version: '1.0.0',
      private: opts.isPrivate ?? false,
      dependencies: opts.deps,
      peerDependencies: opts.peerDeps,
      optionalDependencies: opts.optionalDeps,
    },
  };
}

// Build a graph from a simple adjacency spec: { A: ['B', 'C'] } means A depends on B and C.
// All nodes are public by default. Pass privateNodes to mark some private.
function graphFromSpec(
  spec: Record<string, string[]>,
  privateNodes: string[] = [],
): DepGraph<WorkspacePackage> {
  const privateSet = new Set(privateNodes);
  const pkgs: WorkspacePackage[] = Object.keys(spec).map(name =>
    makePkg(name, {
      deps: Object.fromEntries(spec[name].map(d => [d, 'workspace:^'])),
      isPrivate: privateSet.has(name),
    }),
  );
  return buildDependencyGraph(pkgs);
}

// ---------------------------------------------------------------------------
// buildDependencyGraph
// ---------------------------------------------------------------------------

describe('buildDependencyGraph', () => {
  test('single package with no deps', () => {
    const graph = buildDependencyGraph([makePkg('a')]);
    expect(graph.hasNode('a')).toBe(true);
    expect(graph.size()).toBe(1);
    expect(graph.dependenciesOf('a')).toEqual([]);
  });

  test('linear chain A -> B -> C', () => {
    const pkgs = [
      makePkg('a', { deps: { b: 'workspace:^' } }),
      makePkg('b', { deps: { c: 'workspace:^' } }),
      makePkg('c'),
    ];
    const graph = buildDependencyGraph(pkgs);
    expect(graph.dependenciesOf('a')).toEqual(expect.arrayContaining(['b', 'c']));
    expect(graph.directDependenciesOf('a')).toEqual(['b']);
    expect(graph.directDependenciesOf('b')).toEqual(['c']);
  });

  test('diamond dependency A -> B, A -> C, B -> D, C -> D', () => {
    const pkgs = [
      makePkg('a', { deps: { b: '*', c: '*' } }),
      makePkg('b', { deps: { d: '*' } }),
      makePkg('c', { deps: { d: '*' } }),
      makePkg('d'),
    ];
    const graph = buildDependencyGraph(pkgs);
    expect(graph.dependenciesOf('a')).toEqual(expect.arrayContaining(['b', 'c', 'd']));
    expect(graph.dependenciesOf('a')).toHaveLength(3);
  });

  test('ignores deps not in the workspace', () => {
    const pkgs = [makePkg('a', { deps: { react: '^18', b: 'workspace:^' } }), makePkg('b')];
    const graph = buildDependencyGraph(pkgs);
    expect(graph.directDependenciesOf('a')).toEqual(['b']);
  });

  test('includes peerDependencies and optionalDependencies', () => {
    const pkgs = [
      makePkg('a', { peerDeps: { b: '*' }, optionalDeps: { c: '*' } }),
      makePkg('b'),
      makePkg('c'),
    ];
    const graph = buildDependencyGraph(pkgs);
    expect(graph.directDependenciesOf('a')).toEqual(expect.arrayContaining(['b', 'c']));
  });

  test('empty input returns empty graph', () => {
    const graph = buildDependencyGraph([]);
    expect(graph.size()).toBe(0);
    expect(graph.overallOrder()).toEqual([]);
  });

  test('stores WorkspacePackage as node data', () => {
    const pkg = makePkg('x');
    const graph = buildDependencyGraph([pkg]);
    expect(graph.getNodeData('x')).toEqual(pkg);
  });
});

// ---------------------------------------------------------------------------
// computeInitialScope
// ---------------------------------------------------------------------------

describe('computeInitialScope', () => {
  test('single target with no deps', () => {
    const graph = graphFromSpec({ a: [] });
    const { scope, dependencies } = computeInitialScope(graph, ['a']);
    expect([...scope]).toEqual(['a']);
    expect(dependencies.a).toEqual([]);
  });

  test('target pulls in transitive deps', () => {
    const graph = graphFromSpec({ a: ['b'], b: ['c'], c: [] });
    const { scope } = computeInitialScope(graph, ['a']);
    expect(scope.has('a')).toBe(true);
    expect(scope.has('b')).toBe(true);
    expect(scope.has('c')).toBe(true);
  });

  test('multiple targets merge scopes', () => {
    const graph = graphFromSpec({ a: ['c'], b: ['c'], c: [] });
    const { scope } = computeInitialScope(graph, ['a', 'b']);
    expect(scope.size).toBe(3);
  });

  test('dependencies record has direct deps only', () => {
    const graph = graphFromSpec({ a: ['b'], b: ['c'], c: [] });
    const { dependencies } = computeInitialScope(graph, ['a']);
    expect(dependencies.a).toEqual(['b']);
  });

  test('diamond: no duplicates in scope', () => {
    const graph = graphFromSpec({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });
    const { scope } = computeInitialScope(graph, ['a']);
    expect(scope.size).toBe(4);
  });

  test('empty targets returns empty scope', () => {
    const graph = graphFromSpec({ a: ['b'], b: [] });
    const { scope, dependencies } = computeInitialScope(graph, []);
    expect(scope.size).toBe(0);
    expect(Object.keys(dependencies)).toHaveLength(0);
  });

  test('uses cachedDeps when provided', () => {
    const graph = graphFromSpec({ a: ['b'], b: ['c'], c: [] });
    const cachedDeps = precomputeTransitiveDeps(graph);
    const { scope } = computeInitialScope(graph, ['a'], cachedDeps);
    expect(scope.has('c')).toBe(true);
  });

  test('target not in graph is handled gracefully', () => {
    const graph = graphFromSpec({ a: [] });
    // 'z' is not a node. computeInitialScope catches the error.
    const { scope, dependencies } = computeInitialScope(graph, ['z']);
    expect(scope.has('z')).toBe(true);
    expect(dependencies.z).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// closeUnderDeps
// ---------------------------------------------------------------------------

describe('closeUnderDeps', () => {
  test('no-op when scope already closed', () => {
    const graph = graphFromSpec({ a: ['b'], b: [] });
    const scope = new Set(['a', 'b']);
    const result = closeUnderDeps(graph, scope);
    expect(result.size).toBe(2);
  });

  test('adds missing transitive deps', () => {
    const graph = graphFromSpec({ a: ['b'], b: ['c'], c: [] });
    const scope = new Set(['a']);
    const result = closeUnderDeps(graph, scope);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(true);
  });

  test('skips deps of private packages', () => {
    const graph = graphFromSpec({ a: ['b'], b: [] }, ['a']);
    const scope = new Set(['a']);
    const result = closeUnderDeps(graph, scope);
    // 'a' is private, so its deps are not pulled in
    expect(result.has('b')).toBe(false);
  });

  test('iterative closure: adding a dep triggers its own deps', () => {
    // a -> b -> c -> d. Start with just {a}
    const graph = graphFromSpec({ a: ['b'], b: ['c'], c: ['d'], d: [] });
    const scope = new Set(['a']);
    const result = closeUnderDeps(graph, scope);
    expect(result.size).toBe(4);
  });

  test('uses cachedDeps when provided', () => {
    const graph = graphFromSpec({ a: ['b'], b: ['c'], c: [] });
    const cachedDeps = precomputeTransitiveDeps(graph);
    const result = closeUnderDeps(graph, new Set(['a']), cachedDeps);
    expect(result.has('c')).toBe(true);
  });

  test('empty scope returns empty set', () => {
    const graph = graphFromSpec({ a: [] });
    const result = closeUnderDeps(graph, new Set());
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// expandDependents
// ---------------------------------------------------------------------------

describe('expandDependents', () => {
  test('finds direct dependents', () => {
    // b depends on a, so a's dependent is b
    const graph = graphFromSpec({ a: [], b: ['a'] });
    const { newPackages, dependents } = expandDependents(graph, ['a'], new Set(['a']));
    expect(newPackages).toEqual(['b']);
    expect(dependents.a).toEqual(['b']);
  });

  test('finds transitive dependents', () => {
    // c -> b -> a. Expanding from a should find b and c.
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['b'] });
    const { newPackages } = expandDependents(graph, ['a'], new Set(['a']));
    expect(newPackages).toEqual(expect.arrayContaining(['b', 'c']));
  });

  test('does not include packages already in scope', () => {
    const graph = graphFromSpec({ a: [], b: ['a'] });
    const currentScope = new Set(['a', 'b']);
    const { newPackages } = expandDependents(graph, ['a'], currentScope);
    expect(newPackages).toHaveLength(0);
  });

  test('consumer filtering: only returns consumed packages', () => {
    // c -> b -> a. Consumer only has 'b' installed.
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['b'] });
    const consumed = new Set(['b']);
    const { newPackages, skippedDependents } = expandDependents(
      graph,
      ['a'],
      new Set(['a']),
      consumed,
    );
    expect(newPackages).toEqual(['b']);
    // c is skipped because it's not consumed
    expect(skippedDependents.some(s => s.name === 'c')).toBe(true);
  });

  test('consumer filtering: keeps packages already in scope', () => {
    // c -> b -> a. b is in scope, c is consumed.
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['b'] });
    const currentScope = new Set(['a', 'b']);
    const consumed = new Set(['c']);
    const { newPackages, dependents } = expandDependents(
      graph,
      ['a'],
      currentScope,
      consumed,
    );
    expect(newPackages).toEqual(['c']);
    // b is in dependents[a] because it passes the filter (in currentScope)
    expect(dependents.a).toEqual(expect.arrayContaining(['b', 'c']));
  });

  test('no consumer filter: returns all dependents', () => {
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['b'] });
    const { newPackages } = expandDependents(graph, ['a'], new Set(['a']));
    expect(newPackages).toEqual(expect.arrayContaining(['b', 'c']));
  });

  test('skippedDependents excludes private packages', () => {
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['a'] }, ['c']);
    const consumed = new Set<string>();
    const { skippedDependents } = expandDependents(
      graph,
      ['a'],
      new Set(['a']),
      consumed,
    );
    // c is private, should not appear in skippedDependents
    expect(skippedDependents.some(s => s.name === 'c')).toBe(false);
    // b is public and not consumed, should be skipped
    expect(skippedDependents.some(s => s.name === 'b')).toBe(true);
  });

  test('empty changedPackages returns nothing', () => {
    const graph = graphFromSpec({ a: [], b: ['a'] });
    const { newPackages, dependents, skippedDependents } = expandDependents(
      graph,
      [],
      new Set(['a']),
    );
    expect(newPackages).toHaveLength(0);
    expect(Object.keys(dependents)).toHaveLength(0);
    expect(skippedDependents).toHaveLength(0);
  });

  test('uses cachedDependents when provided', () => {
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['b'] });
    const cached = precomputeTransitiveDependents(graph);
    const { newPackages } = expandDependents(graph, ['a'], new Set(['a']), undefined, cached);
    expect(newPackages).toEqual(expect.arrayContaining(['b', 'c']));
  });

  test('skippedDependents are sorted by name', () => {
    const graph = graphFromSpec({ a: [], z: ['a'], m: ['a'], d: ['a'] });
    const consumed = new Set<string>();
    const { skippedDependents } = expandDependents(
      graph,
      ['a'],
      new Set(['a']),
      consumed,
    );
    const names = skippedDependents.map(s => s.name);
    expect(names).toEqual([...names].sort());
  });
});

// ---------------------------------------------------------------------------
// deterministicToposort
// ---------------------------------------------------------------------------

describe('deterministicToposort', () => {
  test('single node', () => {
    const graph = graphFromSpec({ a: [] });
    const result = deterministicToposort(graph, new Set(['a']));
    expect(result).toEqual(['a']);
  });

  test('linear chain produces correct order', () => {
    // c -> b -> a means c must come after b, b after a
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['b'] });
    const result = deterministicToposort(graph, new Set(['a', 'b', 'c']));
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('lexical tie-breaking among independent nodes', () => {
    const graph = graphFromSpec({ c: [], a: [], b: [] });
    const result = deterministicToposort(graph, new Set(['c', 'a', 'b']));
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('diamond: deps before dependents, lexical tie-breaking', () => {
    // a and b have no deps (so a before b lexically), c depends on both
    const graph = graphFromSpec({ a: [], b: [], c: ['a', 'b'] });
    const result = deterministicToposort(graph, new Set(['a', 'b', 'c']));
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('subset: only includes specified nodes', () => {
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['b'] });
    // Only toposort b and c; a is not in subset
    const result = deterministicToposort(graph, new Set(['b', 'c']));
    // b has no in-subset deps, so it comes first
    expect(result).toEqual(['b', 'c']);
  });

  test('empty subset returns empty array', () => {
    const graph = graphFromSpec({ a: [] });
    const result = deterministicToposort(graph, new Set());
    expect(result).toEqual([]);
  });

  test('complex graph: lexical tie-breaking at each level', () => {
    // root -> z, root -> m, root -> a. All of z, m, a are leaves.
    const graph = graphFromSpec({ root: ['z', 'm', 'a'], z: [], m: [], a: [] });
    const result = deterministicToposort(graph, new Set(['root', 'z', 'm', 'a']));
    // a, m, z are all zero in-degree first (lexically sorted), then root
    expect(result).toEqual(['a', 'm', 'z', 'root']);
  });

  test('handles nodes becoming ready at different stages with correct ordering', () => {
    // a -> (no deps), b -> a, c -> (no deps), d -> b, d -> c
    const graph = graphFromSpec({ a: [], b: ['a'], c: [], d: ['b', 'c'] });
    const result = deterministicToposort(graph, new Set(['a', 'b', 'c', 'd']));
    // Round 1: a, c (lexical). Round 2: b (unlocked by a). Round 3: d (unlocked by b and c)
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  test('cycle fallback: appends stuck nodes', () => {
    // Create a circular graph manually since graphFromSpec uses buildDependencyGraph
    // which doesn't allow cycles. We build the DepGraph directly.
    const graph = new DepGraph<WorkspacePackage>({ circular: true });
    const pkgA = makePkg('a', { deps: { b: '*' } });
    const pkgB = makePkg('b', { deps: { a: '*' } });
    graph.addNode('a', pkgA);
    graph.addNode('b', pkgB);
    graph.addDependency('a', 'b');
    graph.addDependency('b', 'a');

    const result = deterministicToposort(graph, new Set(['a', 'b']));
    // Both have in-degree 1, neither reaches 0 normally. They'll be appended sorted.
    expect(result).toEqual(['a', 'b']);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// precomputeTransitiveDeps / precomputeTransitiveDependents
// ---------------------------------------------------------------------------

describe('precomputeTransitiveDeps', () => {
  test('returns cached deps for each node', () => {
    const graph = graphFromSpec({ a: ['b'], b: ['c'], c: [] });
    const cache = precomputeTransitiveDeps(graph);
    expect(cache.get('a')).toEqual(expect.arrayContaining(['b', 'c']));
    expect(cache.get('b')).toEqual(['c']);
    expect(cache.get('c')).toEqual([]);
  });
});

describe('precomputeTransitiveDependents', () => {
  test('returns cached dependents for each node', () => {
    const graph = graphFromSpec({ a: [], b: ['a'], c: ['b'] });
    const cache = precomputeTransitiveDependents(graph);
    expect(cache.get('a')).toEqual(expect.arrayContaining(['b', 'c']));
    expect(cache.get('b')).toEqual(['c']);
    expect(cache.get('c')).toEqual([]);
  });
});
