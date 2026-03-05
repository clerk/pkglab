import { describe, test, expect } from 'bun:test';
import { DepGraph } from 'dependency-graph';

import type { WorkspacePackage } from '../../types';
import type { PackageFingerprint } from '../../lib/fingerprint';
import { detectChanges } from '../../lib/cascade';

// Helper to create a minimal WorkspacePackage
function makePackage(
  name: string,
  deps: Record<string, string> = {},
): WorkspacePackage {
  return {
    name,
    dir: `/fake/${name}`,
    publishable: true,
    packageJson: {
      name,
      version: '1.0.0',
      dependencies: deps,
    },
  };
}

// Helper to build a DepGraph from WorkspacePackage entries
function makeGraph(packages: WorkspacePackage[]): DepGraph<WorkspacePackage> {
  const graph = new DepGraph<WorkspacePackage>();
  const names = new Set(packages.map(p => p.name));

  for (const pkg of packages) {
    graph.addNode(pkg.name, pkg);
  }

  for (const pkg of packages) {
    const allDeps = {
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

describe('detectChanges', () => {
  test('package with no previous state is classified as changed', () => {
    const pkg = makePackage('pkg-a');
    const graph = makeGraph([pkg]);
    const fingerprints = new Map<string, PackageFingerprint>([
      ['pkg-a', { hash: 'abc123', fileCount: 5 }],
    ]);
    const previousState: Record<string, { hash: string; version: string }> = {};

    const { reason, existingVersions } = detectChanges([pkg], fingerprints, previousState, graph);

    expect(reason.get('pkg-a')).toBe('changed');
    expect(existingVersions.has('pkg-a')).toBe(false);
  });

  test('package with hash mismatch is classified as changed', () => {
    const pkg = makePackage('pkg-a');
    const graph = makeGraph([pkg]);
    const fingerprints = new Map<string, PackageFingerprint>([
      ['pkg-a', { hash: 'new-hash', fileCount: 5 }],
    ]);
    const previousState = {
      'pkg-a': { hash: 'old-hash', version: '0.0.0-pkglab.12345' },
    };

    const { reason, existingVersions } = detectChanges([pkg], fingerprints, previousState, graph);

    expect(reason.get('pkg-a')).toBe('changed');
    expect(existingVersions.has('pkg-a')).toBe(false);
  });

  test('package with no fingerprint is classified as changed', () => {
    const pkg = makePackage('pkg-a');
    const graph = makeGraph([pkg]);
    const fingerprints = new Map<string, PackageFingerprint>();
    const previousState = {
      'pkg-a': { hash: 'abc123', version: '0.0.0-pkglab.12345' },
    };

    const { reason } = detectChanges([pkg], fingerprints, previousState, graph);

    expect(reason.get('pkg-a')).toBe('changed');
  });

  test('package with matching hash and no changed deps is classified as unchanged', () => {
    const pkg = makePackage('pkg-a');
    const graph = makeGraph([pkg]);
    const fingerprints = new Map<string, PackageFingerprint>([
      ['pkg-a', { hash: 'same-hash', fileCount: 5 }],
    ]);
    const previousState = {
      'pkg-a': { hash: 'same-hash', version: '0.0.0-pkglab.12345' },
    };

    const { reason, existingVersions } = detectChanges([pkg], fingerprints, previousState, graph);

    expect(reason.get('pkg-a')).toBe('unchanged');
    expect(existingVersions.get('pkg-a')).toBe('0.0.0-pkglab.12345');
  });

  test('package with matching hash but a changed dep is classified as propagated', () => {
    const depPkg = makePackage('dep');
    const consumerPkg = makePackage('consumer', { dep: 'workspace:^' });
    const packages = [depPkg, consumerPkg];
    const graph = makeGraph(packages);

    // Topological order: dep first, then consumer
    const cascadePackages = [depPkg, consumerPkg];

    const fingerprints = new Map<string, PackageFingerprint>([
      ['dep', { hash: 'new-dep-hash', fileCount: 3 }],
      ['consumer', { hash: 'same-hash', fileCount: 4 }],
    ]);
    const previousState = {
      dep: { hash: 'old-dep-hash', version: '0.0.0-pkglab.11111' },
      consumer: { hash: 'same-hash', version: '0.0.0-pkglab.22222' },
    };

    const { reason, existingVersions } = detectChanges(cascadePackages, fingerprints, previousState, graph);

    expect(reason.get('dep')).toBe('changed');
    expect(reason.get('consumer')).toBe('propagated');
    expect(existingVersions.has('consumer')).toBe(false);
  });

  test('package with matching hash but a propagated dep is classified as propagated', () => {
    const root = makePackage('root');
    const mid = makePackage('mid', { root: 'workspace:^' });
    const leaf = makePackage('leaf', { mid: 'workspace:^' });
    const packages = [root, mid, leaf];
    const graph = makeGraph(packages);

    // Topological order: root -> mid -> leaf
    const cascadePackages = [root, mid, leaf];

    const fingerprints = new Map<string, PackageFingerprint>([
      ['root', { hash: 'new-root-hash', fileCount: 2 }],
      ['mid', { hash: 'same-mid-hash', fileCount: 3 }],
      ['leaf', { hash: 'same-leaf-hash', fileCount: 4 }],
    ]);
    const previousState = {
      root: { hash: 'old-root-hash', version: '0.0.0-pkglab.10000' },
      mid: { hash: 'same-mid-hash', version: '0.0.0-pkglab.20000' },
      leaf: { hash: 'same-leaf-hash', version: '0.0.0-pkglab.30000' },
    };

    const { reason, existingVersions } = detectChanges(cascadePackages, fingerprints, previousState, graph);

    expect(reason.get('root')).toBe('changed');
    expect(reason.get('mid')).toBe('propagated');
    expect(reason.get('leaf')).toBe('propagated');
    expect(existingVersions.has('mid')).toBe(false);
    expect(existingVersions.has('leaf')).toBe(false);
  });

  test('multiple packages in topological order with mixed classifications', () => {
    // Graph: shared <- types <- backend
    //                        <- frontend
    // shared changes, types depends on shared, backend/frontend depend on types
    const shared = makePackage('@clerk/shared');
    const types = makePackage('@clerk/types', { '@clerk/shared': 'workspace:^' });
    const backend = makePackage('@clerk/backend', { '@clerk/types': 'workspace:^' });
    const frontend = makePackage('@clerk/frontend', { '@clerk/types': 'workspace:^' });
    const unrelated = makePackage('@clerk/unrelated');

    const packages = [shared, types, backend, frontend, unrelated];
    const graph = makeGraph(packages);

    // Topological order: shared, types, unrelated can be interleaved, then backend/frontend
    const cascadePackages = [shared, unrelated, types, backend, frontend];

    const fingerprints = new Map<string, PackageFingerprint>([
      ['@clerk/shared', { hash: 'new-shared', fileCount: 10 }],
      ['@clerk/types', { hash: 'same-types', fileCount: 8 }],
      ['@clerk/backend', { hash: 'same-backend', fileCount: 6 }],
      ['@clerk/frontend', { hash: 'same-frontend', fileCount: 7 }],
      ['@clerk/unrelated', { hash: 'same-unrelated', fileCount: 3 }],
    ]);
    const previousState = {
      '@clerk/shared': { hash: 'old-shared', version: '0.0.0-pkglab.100' },
      '@clerk/types': { hash: 'same-types', version: '0.0.0-pkglab.200' },
      '@clerk/backend': { hash: 'same-backend', version: '0.0.0-pkglab.300' },
      '@clerk/frontend': { hash: 'same-frontend', version: '0.0.0-pkglab.400' },
      '@clerk/unrelated': { hash: 'same-unrelated', version: '0.0.0-pkglab.500' },
    };

    const { reason, existingVersions } = detectChanges(cascadePackages, fingerprints, previousState, graph);

    expect(reason.get('@clerk/shared')).toBe('changed');
    expect(reason.get('@clerk/types')).toBe('propagated');
    expect(reason.get('@clerk/backend')).toBe('propagated');
    expect(reason.get('@clerk/frontend')).toBe('propagated');
    expect(reason.get('@clerk/unrelated')).toBe('unchanged');
    expect(existingVersions.get('@clerk/unrelated')).toBe('0.0.0-pkglab.500');
    expect(existingVersions.size).toBe(1);
  });

  test('dep outside the cascade set does not affect classification', () => {
    // consumer depends on external-dep, but external-dep is not in cascadePackages
    const externalDep = makePackage('external-dep');
    const consumer = makePackage('consumer', { 'external-dep': 'workspace:^' });

    // Build graph with both so the dependency edge exists
    const graph = makeGraph([externalDep, consumer]);

    // But only consumer is in the cascade set
    const cascadePackages = [consumer];

    const fingerprints = new Map<string, PackageFingerprint>([
      ['consumer', { hash: 'same-hash', fileCount: 4 }],
    ]);
    const previousState = {
      consumer: { hash: 'same-hash', version: '0.0.0-pkglab.99999' },
    };

    const { reason, existingVersions } = detectChanges(cascadePackages, fingerprints, previousState, graph);

    // external-dep is not in cascadeNames, so even though it's a dep, it doesn't propagate
    expect(reason.get('consumer')).toBe('unchanged');
    expect(existingVersions.get('consumer')).toBe('0.0.0-pkglab.99999');
  });

  test('unchanged dep does not propagate to consumer', () => {
    const dep = makePackage('dep');
    const consumer = makePackage('consumer', { dep: 'workspace:^' });
    const graph = makeGraph([dep, consumer]);

    const cascadePackages = [dep, consumer];

    const fingerprints = new Map<string, PackageFingerprint>([
      ['dep', { hash: 'same-dep', fileCount: 3 }],
      ['consumer', { hash: 'same-consumer', fileCount: 4 }],
    ]);
    const previousState = {
      dep: { hash: 'same-dep', version: '0.0.0-pkglab.10000' },
      consumer: { hash: 'same-consumer', version: '0.0.0-pkglab.20000' },
    };

    const { reason, existingVersions } = detectChanges(cascadePackages, fingerprints, previousState, graph);

    expect(reason.get('dep')).toBe('unchanged');
    expect(reason.get('consumer')).toBe('unchanged');
    expect(existingVersions.get('dep')).toBe('0.0.0-pkglab.10000');
    expect(existingVersions.get('consumer')).toBe('0.0.0-pkglab.20000');
  });

  test('package not in graph is handled gracefully (no deps)', () => {
    const pkg = makePackage('orphan');
    // Empty graph, package is not added as a node
    const graph = new DepGraph<WorkspacePackage>();

    const fingerprints = new Map<string, PackageFingerprint>([
      ['orphan', { hash: 'same-hash', fileCount: 1 }],
    ]);
    const previousState = {
      orphan: { hash: 'same-hash', version: '0.0.0-pkglab.55555' },
    };

    const { reason, existingVersions } = detectChanges([pkg], fingerprints, previousState, graph);

    // directDependenciesOf throws for unknown node, caught by try/catch, no deps -> unchanged
    expect(reason.get('orphan')).toBe('unchanged');
    expect(existingVersions.get('orphan')).toBe('0.0.0-pkglab.55555');
  });
});
