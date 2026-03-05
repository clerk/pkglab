import type { WorkspacePackage } from '../types';

import type { PackageFingerprint } from './fingerprint';
import { fingerprintPackages } from './fingerprint';
import { loadFingerprintState, toPackageFingerprints } from './fingerprint-state';
import {
  buildDependencyGraph,
  computeInitialScope,
  expandDependents,
  closeUnderDeps,
  deterministicToposort,
  precomputeTransitiveDeps,
  precomputeTransitiveDependents,
} from './graph';
import { log } from './log';
import { getActiveRepos } from './repo-state';
import { CommandError } from './errors';

export type ChangeReason = 'changed' | 'propagated' | 'unchanged';

export interface CascadeResult {
  cascadePackages: WorkspacePackage[];
  publishSet: WorkspacePackage[];
  unchangedSet: WorkspacePackage[];
  reason: Map<string, ChangeReason>;
  existingVersions: Map<string, string>;
  fingerprints: Map<string, PackageFingerprint>;
  targetSet: Set<string>;
  expandedFrom: Map<string, string>;
  initialScope: Set<string>;
  allSkippedDependents: { name: string; via: string }[];
  activeRepos: Awaited<ReturnType<typeof getActiveRepos>>;
}

export function detectChanges(
  cascadePackages: WorkspacePackage[],
  fingerprints: Map<string, PackageFingerprint>,
  previousState: Record<string, { hash: string; version: string }>,
  graph: ReturnType<typeof buildDependencyGraph>,
): { reason: Map<string, ChangeReason>; existingVersions: Map<string, string> } {
  const reason = new Map<string, ChangeReason>();
  const existingVersions = new Map<string, string>();
  const cascadeNames = new Set(cascadePackages.map(p => p.name));

  // Process in topological order (cascadePackages is already topo-sorted)
  for (const pkg of cascadePackages) {
    const fp = fingerprints.get(pkg.name);
    const prev = previousState[pkg.name];

    // Content hash changed or no previous state: mark as changed
    if (!fp || !prev || fp.hash !== prev.hash) {
      reason.set(pkg.name, 'changed');
      continue;
    }

    // Content same, but check if any workspace dep in the cascade changed/propagated
    let depChanged = false;
    try {
      const deps = graph.directDependenciesOf(pkg.name);
      for (const dep of deps) {
        if (cascadeNames.has(dep)) {
          const depReason = reason.get(dep);
          if (depReason === 'changed' || depReason === 'propagated') {
            depChanged = true;
            break;
          }
        }
      }
    } catch {
      // Node not in graph, treat as no deps
    }

    if (depChanged) {
      reason.set(pkg.name, 'propagated');
    } else {
      reason.set(pkg.name, 'unchanged');
      existingVersions.set(pkg.name, prev.version);
    }
  }

  return { reason, existingVersions };
}

export async function runCascade(
  targets: string[],
  workspace: { root: string; packages: WorkspacePackage[] },
  tag: string | undefined,
  opts: { verbose: boolean; shallow: boolean; force: boolean },
): Promise<CascadeResult> {
  const graph = buildDependencyGraph(workspace.packages);

  // Precompute transitive closures once for the entire graph
  const cachedDeps = precomputeTransitiveDeps(graph);
  const cachedDependents = precomputeTransitiveDependents(graph);

  // Gather consumed packages from active repos for cascade filtering.
  // No active repos = empty set = no dependents pass filter (nobody is consuming).
  // Active repos = filter dependents to only packages consumers have installed.
  const consumedPackages = new Set<string>();
  const activeRepos = await getActiveRepos();
  for (const { state } of activeRepos) {
    for (const pkgName of Object.keys(state.packages)) {
      consumedPackages.add(pkgName);
    }
  }

  // Phase 1: targets + transitive deps (no dependents yet)
  const { scope: initialScope } = computeInitialScope(graph, targets, cachedDeps);
  const scope = new Set(initialScope);

  // Track scope reasons: why each package is in scope
  const targetSet = new Set(targets);
  // Maps dependent name to the package that triggered its inclusion
  const expandedFrom = new Map<string, string>();
  // All skipped dependents across iterations (name + which package triggered them)
  let allSkippedDependents: { name: string; via: string }[] = [];

  // Load previous fingerprint state (--force uses empty state to republish all)
  const previousState = opts.force ? {} : await loadFingerprintState(workspace.root, tag ?? null);

  // Eager fingerprinting: fingerprint ALL publishable packages upfront in one parallel batch.
  // The cost of fingerprinting a few extra packages is negligible compared to eliminating
  // sequential rounds of fingerprinting inside the cascade loop.
  const allPublishable = workspace.packages.filter(p => p.publishable);
  if (opts.verbose) {
    log.info(`Fingerprinting ${allPublishable.length} packages...`);
  }
  const previousFingerprints = opts.force ? undefined : toPackageFingerprints(previousState);
  const fingerprints = await fingerprintPackages(
    allPublishable.map(p => ({ name: p.name, dir: p.dir })),
    previousFingerprints,
  );

  // Track which changed packages we've already expanded dependents from
  const expandedSet = new Set<string>();
  // Track reason and existingVersions across iterations
  let reason = new Map<string, ChangeReason>();
  let existingVersions = new Map<string, string>();

  // Verbose: log initial scope
  const verboseExpansions: { source: string; newPackages: string[] }[] = [];

  // Two-phase cascade loop
  while (true) {
    // Close under deps: ensure every publishable package has its workspace deps in scope
    const closed = closeUnderDeps(graph, scope, cachedDeps);
    for (const name of closed) {
      scope.add(name);
    }

    // Toposort the full scope for detectChanges
    const ordered = deterministicToposort(graph, scope);
    const scopePackages = ordered.map(name => graph.getNodeData(name));

    // Classify all packages in topo order
    ({ reason, existingVersions } = detectChanges(scopePackages, fingerprints, previousState, graph));

    // --shallow: skip dependent expansion (targets + deps only)
    if (opts.shallow) {
      break;
    }

    // Find changed packages we haven't expanded from yet
    const toExpand: string[] = [];
    for (const [name, r] of reason) {
      if (r === 'changed' && !expandedSet.has(name)) {
        toExpand.push(name);
      }
    }

    if (toExpand.length === 0) {
      break;
    }

    // Expand dependents from newly changed packages
    const expansion = expandDependents(graph, toExpand, scope, consumedPackages, cachedDependents);
    for (const name of toExpand) {
      expandedSet.add(name);
    }

    // Track which package triggered each dependent's inclusion
    for (const source of toExpand) {
      for (const dep of expansion.dependents[source] || []) {
        if (!scope.has(dep) && !expandedFrom.has(dep)) {
          expandedFrom.set(dep, source);
        }
      }
    }

    // Collect skipped dependents
    if (expansion.skippedDependents.length > 0) {
      allSkippedDependents = allSkippedDependents.concat(expansion.skippedDependents);
    }

    if (expansion.newPackages.length === 0) {
      break;
    }

    // Log expansion for verbose output
    if (opts.verbose) {
      for (const source of toExpand) {
        const newFromSource = (expansion.dependents[source] || []).filter(d => !scope.has(d));
        if (newFromSource.length > 0) {
          verboseExpansions.push({ source, newPackages: newFromSource });
        }
      }
    }

    // Add new packages to scope
    for (const name of expansion.newPackages) {
      scope.add(name);
    }
  }

  // Deduplicate skipped dependents
  const seenSkipped = new Set<string>();
  allSkippedDependents = allSkippedDependents
    .filter(d => {
      if (scope.has(d.name) || seenSkipped.has(d.name)) {
        return false;
      }
      seenSkipped.add(d.name);
      return true;
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));

  // Final toposort of the complete scope
  const finalOrdered = deterministicToposort(graph, scope);
  let cascadePackages = finalOrdered.map(name => graph.getNodeData(name));

  // Skip private packages pulled in by cascade
  const skippedPrivate = cascadePackages.filter(p => !p.publishable);
  if (skippedPrivate.length > 0) {
    if (opts.verbose) {
      for (const pkg of skippedPrivate) {
        log.warn(`Skipping private package ${pkg.name}`);
      }
    }
    cascadePackages = cascadePackages.filter(p => p.publishable);
  }

  // Verbose cascade breakdown
  if (opts.verbose) {
    const initialNames = [...initialScope].toSorted();
    const depsInInitial = initialNames.filter(n => !targetSet.has(n));
    const initialParts = targets.concat(depsInInitial.map(n => `${n} (dep)`));
    log.info(`Initial scope: ${initialParts.join(', ')}`);
    for (const { source, newPackages } of verboseExpansions) {
      const sourceReason = reason.get(source) === 'changed' ? 'changed' : 'dep changed';
      log.info(`Expanded from ${source} (${sourceReason}):`);
      for (const d of newPackages) {
        log.line(`  - ${d}`);
      }
    }
  }

  // Validate no non-publishable dependencies in the cascade set
  for (const pkg of cascadePackages) {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const deps = pkg.packageJson[field];
      if (!deps) {
        continue;
      }
      for (const depName of Object.keys(deps)) {
        const depPkg = workspace.packages.find(p => p.name === depName);
        if (depPkg && !depPkg.publishable) {
          throw new CommandError(`Cannot publish ${pkg.name}: depends on private package ${depName}`);
        }
      }
    }
  }

  const publishSet = cascadePackages.filter(p => {
    const r = reason.get(p.name);
    return r === 'changed' || r === 'propagated';
  });
  const unchangedSet = cascadePackages.filter(p => reason.get(p.name) === 'unchanged');

  return {
    cascadePackages,
    publishSet,
    unchangedSet,
    reason,
    existingVersions,
    fingerprints,
    targetSet,
    expandedFrom,
    initialScope,
    allSkippedDependents,
    activeRepos,
  };
}
