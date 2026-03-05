import { defineCommand } from 'citty';
import { join, resolve, relative } from 'node:path';

import type { VersionEntry, CatalogFormat } from '../lib/consumer';
import type { pkglabConfig, RepoState } from '../types';

import { getPositionalArgs, normalizeScope } from '../lib/args';
import { c } from '../lib/color';
import { loadConfig } from '../lib/config';
import {
  addRegistryToNpmrc,
  injectPreCommitHook,
  ensureNpmrcForActiveRepos,
  installWithVersionUpdates,
  findCatalogRoot,
  findCatalogEntry,
  loadCatalogData,
} from '../lib/consumer';
import { ensureDaemonRunning } from '../lib/daemon';
import { CommandError, SilentExitError } from '../lib/errors';
import { runPreHook, runPostHook, runErrorHook } from '../lib/hooks';
import { log } from '../lib/log';
import { detectPackageManager } from '../lib/pm-detect';
import { getDistTags, listPackageNames } from '../lib/registry';
import { canonicalRepoPath, loadRepoByPath, saveRepoByPath } from '../lib/repo-state';
import { prefetchUpdateCheck } from '../lib/update-check';
import { sanitizeTag, ispkglabVersion, extractTag } from '../lib/version';
import { collectWorkspacePackageJsons, discoverWorkspace } from '../lib/workspace';
import type { WorkspaceDiscovery } from '../lib/workspace';

function parsePackageArg(input: string): { name: string; tag?: string } {
  const lastAt = input.lastIndexOf('@');
  // If lastAt is 0, it's just @scope/pkg with no tag
  // If lastAt > 0, there might be a tag after it
  if (lastAt > 0) {
    const name = input.slice(0, lastAt);
    const tag = input.slice(lastAt + 1);
    if (tag) {
      return { name, tag };
    }
  }
  return { name: input };
}

interface ResolvedPackage {
  name: string;
  version: string;
  tag: string | undefined;
}

function resolveFromDistTags(
  pkgName: string,
  distTags: Record<string, string>,
  requestedTag?: string,
): ResolvedPackage {
  const tag = requestedTag ? sanitizeTag(requestedTag) : undefined;
  const distTagKey = tag ?? 'pkglab';
  const version = distTags[distTagKey];

  if (!version) {
    const available = Object.keys(distTags).filter(t => t !== 'latest');
    if (available.length === 0) {
      log.error(`No pkglab versions for ${pkgName}. Publish first: pkglab pub ${pkgName}`);
    } else if (tag) {
      const tagList = available.filter(t => t !== 'pkglab').join(', ');
      const hasUntagged = 'pkglab' in distTags;
      const untaggedNote = hasUntagged ? ' Also has untagged versions.' : '';
      log.error(`No version for '${pkgName}' with tag '${tag}'. Available: ${tagList || '(none)'}.${untaggedNote}`);
    } else {
      const tagList = available.filter(t => t !== 'pkglab').join(', ');
      log.error(`No untagged version for '${pkgName}'. Available tags: ${tagList}`);
    }
    throw new CommandError(`No matching version for ${pkgName}`, { logged: true });
  }

  return { name: pkgName, version, tag };
}

const NPMRC_NOTICE =
  'notice: pkglab added registry entries to .npmrc\n' +
  'These entries point to localhost and will break CI if committed.\n' +
  'pkglab has applied --skip-worktree to prevent accidental commits.\n' +
  'Run pkglab restore --all to restore your .npmrc.';


async function batchInstallPackages(
  config: pkglabConfig,
  repoPath: string,
  packages: ResolvedPackage[],
  catalog?: boolean,
  packagejson?: string,
  dryRun?: boolean,
  verbose?: boolean,
  cachedWorkspace?: WorkspaceDiscovery,
): Promise<void> {
  let effectivePath = repoPath;
  let catalogRoot: string | undefined;
  let catalogFormat: CatalogFormat | undefined;
  const catalogNames = new Map<string, string>(); // pkg name -> catalogName
  const packageJsonDir = packagejson ? resolve(repoPath, packagejson) : undefined;
  const pkgJsonTarget = packageJsonDir ?? repoPath;

  // Phase 1: Catalog detection (always try, --catalog makes it strict)
  const found = await findCatalogRoot(repoPath);
  if (found) {
    const data = await loadCatalogData(found.root, found.format);
    for (const pkg of packages) {
      const entry = findCatalogEntry(data, pkg.name);
      if (entry) {
        catalogNames.set(pkg.name, entry.catalogName);
        if (verbose) {
          log.info(`Catalog detected for ${pkg.name}: ${entry.catalogName} (${found.format})`);
        } else if (!catalog) {
          log.dim(`  auto-detected catalog for ${pkg.name}`);
        }
      } else if (catalog) {
        const source = found.format === 'pnpm-workspace' ? 'pnpm-workspace.yaml' : 'workspace root package.json';
        throw new CommandError(`${pkg.name} is not in any catalog. Add it to the catalog field in ${source} first.`);
      } else if (verbose) {
        log.dim(`  ${pkg.name}: not found in any catalog, using direct mode`);
      }
    }
    if (catalogNames.size > 0) {
      catalogRoot = found.root;
      catalogFormat = found.format;
      effectivePath = found.root;
    }
  } else if (catalog) {
    throw new CommandError(
      "No catalog found. The workspace root needs a 'catalog' or 'catalogs' field in package.json or pnpm-workspace.yaml.",
    );
  } else if (verbose) {
    log.dim('  No catalog found in workspace');
  }

  // Stale deps detection: always scan the target package.json for stale pkglab versions
  {
    const batchNames = new Set(packages.map(p => p.name));
    const pkgJson = await Bun.file(join(pkgJsonTarget, 'package.json')).json();
    const staleDeps: { name: string; version: string }[] = [];

    for (const field of ['dependencies', 'devDependencies'] as const) {
      const deps = pkgJson[field];
      if (!deps) {
        continue;
      }
      for (const [depName, depVersion] of Object.entries(deps)) {
        if (typeof depVersion === 'string' && ispkglabVersion(depVersion) && !batchNames.has(depName)) {
          staleDeps.push({ name: depName, version: depVersion });
        }
      }
    }

    if (verbose && staleDeps.length === 0) {
      log.dim('  No stale pkglab dependencies found');
    }

    if (staleDeps.length > 0) {
      if (verbose) {
        log.info(`Found ${staleDeps.length} stale pkglab dependencies`);
      }
      const unresolvable: string[] = [];

      for (const dep of staleDeps) {
        const distTags = await getDistTags(dep.name, config);
        const tag = extractTag(dep.version);
        const distTagKey = tag ?? 'pkglab';
        const latestVersion = distTags[distTagKey];

        if (latestVersion) {
          packages.push({ name: dep.name, version: latestVersion, tag: tag ?? undefined });
          if (verbose) {
            log.info(`Upgrading stale ${dep.name}@${dep.version} -> ${latestVersion}`);
          } else {
            log.dim(`  Upgrading stale ${dep.name}@${dep.version} to ${latestVersion}`);
          }
        } else {
          unresolvable.push(dep.name);
        }
      }

      if (unresolvable.length > 0) {
        log.error(
          `These pkglab packages have stale versions in package.json but no matching version on the registry:\n` +
            unresolvable.map(n => `  ${n}`).join('\n') +
            `\nRun pkglab restore for these packages first: pkglab restore ${unresolvable.join(' ')}`,
        );
        throw new CommandError('Stale pkglab packages with no matching registry version', { logged: true });
      }
    }
  }

  // Phase 2: npmrc setup (shared)
  if (dryRun) {
    log.dim('  Would update .npmrc with local registry entries');
  } else {
    const { isFirstTime } = await addRegistryToNpmrc(effectivePath, config.port);
    if (isFirstTime) {
      await injectPreCommitHook(effectivePath);
      log.info(NPMRC_NOTICE);
    }
  }

  // Phase 3: Build version entries and install
  const relPackageJsonDir = packageJsonDir ? relative(effectivePath, packageJsonDir) : undefined;

  // When no -p flag, scan workspace packages to find all sub-packages that use each dep
  let workspacePackageJsons: Array<{ path: string; relDir: string; packageJson: Record<string, any> }> | undefined;
  if (!packagejson) {
    workspacePackageJsons = await collectWorkspacePackageJsons(effectivePath, cachedWorkspace);
    if (verbose && workspacePackageJsons) {
      log.info(`Workspace scan: found ${workspacePackageJsons.length} package.json files`);
      for (const wsPkg of workspacePackageJsons) {
        log.dim(`  ${wsPkg.relDir === '.' ? '(root)' : wsPkg.relDir}`);
      }
    } else if (verbose) {
      log.dim('  Not a workspace, targeting root package.json only');
    }
  } else if (verbose) {
    log.dim(`  Targeting single directory: ${packagejson} (skipping workspace scan)`);
  }

  const entries: VersionEntry[] = packages.map(pkg => {
    const catalogName = catalogNames.get(pkg.name);

    let targets: Array<{ dir: string }>;
    if (packagejson) {
      // Explicit -p flag: single target, no scanning
      targets = [{ dir: relPackageJsonDir ?? '.' }];
    } else if (workspacePackageJsons) {
      // Scan workspace packages for this dep
      const foundTargets: Array<{ dir: string }> = [];
      for (const wsPkg of workspacePackageJsons) {
        for (const field of ['dependencies', 'devDependencies'] as const) {
          const deps = wsPkg.packageJson[field];
          if (!deps || !(pkg.name in deps)) {
            continue;
          }
          const depVersion = deps[pkg.name];
          if (typeof depVersion === 'string' && depVersion.startsWith('catalog:')) {
            if (verbose) {
              log.dim(
                `  ${wsPkg.relDir === '.' ? '(root)' : wsPkg.relDir}: ${pkg.name} uses catalog: protocol, skipping`,
              );
            }
            continue;
          }
          foundTargets.push({ dir: wsPkg.relDir });
          break; // found in this package, no need to check devDependencies too
        }
      }
      if (foundTargets.length > 0) {
        const dirs = foundTargets.map(t => (t.dir === '.' ? '(root)' : t.dir)).join(', ');
        log.dim(`  ${pkg.name} -> ${dirs}`);
      }
      targets = foundTargets.length > 0 ? foundTargets : [{ dir: '.' }];
    } else {
      // Standalone project, single target at root
      targets = [{ dir: '.' }];
    }

    return {
      name: pkg.name,
      version: pkg.version,
      ...(catalogName && { catalogName }),
      ...(catalogName && catalogFormat && { catalogFormat }),
      targets,
    };
  });

  // Dry run: show what would happen and return early
  if (dryRun) {
    log.info('Dry run: the following changes would be applied');
    log.line('');
    for (const entry of entries) {
      const mode = entry.catalogName ? `catalog (${entry.catalogName})` : 'direct';
      log.info(`${entry.name}@${entry.version} [${mode}]`);
      for (const t of entry.targets) {
        const dir = t.dir === '.' ? '(root)' : t.dir;
        if (entry.catalogName) {
          log.dim(`  catalog entry updated at workspace root`);
        } else {
          log.dim(`  package.json modified in ${dir}`);
        }
      }
    }
    log.line('');
    const pm = await detectPackageManager(effectivePath);
    const dryCmd = [pm, 'install', '--ignore-scripts'];
    if (pm === 'pnpm' || pm === 'bun') {
      dryCmd.push('--prefer-offline');
    }
    log.dim(`  Would run: ${dryCmd.join(' ')}`);
    return;
  }

  const pm = await detectPackageManager(effectivePath);
  if (verbose) {
    log.dim(`  Package manager: ${pm}`);
  }
  const previousVersions = await installWithVersionUpdates({
    repoPath: effectivePath,
    catalogRoot,
    entries,
    pm,
    registryUrl: `http://127.0.0.1:${config.port}`,
    onCommand: cmd => log.dim(`  ${cmd.join(' ')}`),
  });

  // Phase 4: Repo state update (shared)
  let repoState: RepoState = (await loadRepoByPath(effectivePath)) || {
    path: effectivePath,
    active: false,
    packages: {},
  };

  for (const pkg of packages) {
    const catalogName = catalogNames.get(pkg.name);
    const targets = previousVersions.get(pkg.name) ?? [{ dir: relPackageJsonDir ?? '.', original: '' }];
    if (!repoState.packages[pkg.name]) {
      repoState.packages[pkg.name] = {
        current: pkg.version,
        tag: pkg.tag,
        ...(catalogName && { catalogName }),
        ...(catalogFormat && { catalogFormat }),
        targets,
      };
    } else {
      repoState.packages[pkg.name].current = pkg.version;
      repoState.packages[pkg.name].tag = pkg.tag;
      if (catalogName) {
        repoState.packages[pkg.name].catalogName = catalogName;
      }
      if (catalogFormat) {
        repoState.packages[pkg.name].catalogFormat = catalogFormat;
      }
      // Merge targets: preserve existing original values (the real pre-pkglab versions)
      const existingTargets = repoState.packages[pkg.name].targets;
      repoState.packages[pkg.name].targets = targets.map(t => {
        const prev = existingTargets.find(e => e.dir === t.dir);
        return prev && prev.original ? { ...t, original: prev.original } : t;
      });
    }
  }

  repoState.active = true;
  repoState.lastUsed = Date.now();
  await saveRepoByPath(effectivePath, repoState);

  // Phase 5: Success logging
  for (const { name, version } of packages) {
    const isCatalog = catalogNames.has(name);
    log.success(`Installed ${name}@${version}${isCatalog ? ' (catalog)' : ''}`);
  }
}

async function interactivePick(config: pkglabConfig, fixedTag?: string): Promise<ResolvedPackage[]> {
  const [packageNames, { filterableCheckbox }, { select }, { ExitPromptError }] = await Promise.all([
    listPackageNames(config),
    import('../lib/prompt'),
    import('@inquirer/prompts'),
    import('@inquirer/core'),
  ]);

  if (packageNames.length === 0) {
    throw new CommandError('No pkglab packages found. Publish first: pkglab pub');
  }

  let selectedNames: string[];
  try {
    selectedNames = await filterableCheckbox({
      message: 'Select packages to add:',
      pageSize: 15,
      choices: packageNames.map(name => ({ name, value: name })),
    });
  } catch (err) {
    if (err instanceof ExitPromptError) {
      throw new SilentExitError(0);
    }
    throw err;
  }

  if (selectedNames.length === 0) {
    log.dim('No packages selected.');
    return [];
  }

  const resolved: ResolvedPackage[] = [];
  for (const pkgName of selectedNames) {
    const distTags = await getDistTags(pkgName, config);
    const tags = Object.keys(distTags).filter(t => t !== 'latest');
    let selectedTag: string | undefined;

    if (tags.length === 0) {
      log.error(`No pkglab versions for ${pkgName}. Publish first.`);
      continue;
    }

    if (fixedTag) {
      resolved.push(resolveFromDistTags(pkgName, distTags, fixedTag));
      continue;
    }

    if (tags.length === 1) {
      selectedTag = tags[0] === 'pkglab' ? undefined : tags[0];
    } else {
      try {
        const picked = await select<string>({
          message: `Tag for ${pkgName}:`,
          choices: tags.map(t => ({
            name: t === 'pkglab' ? c.dim('(untagged)') : t,
            value: t,
          })),
        });
        selectedTag = picked === 'pkglab' ? undefined : picked;
      } catch (err) {
        if (err instanceof ExitPromptError) {
          throw new SilentExitError(0);
        }
        throw err;
      }
    }

    resolved.push(resolveFromDistTags(pkgName, distTags, selectedTag));
  }

  return resolved;
}

async function resolveScopePackages(
  config: pkglabConfig,
  repoPath: string,
  scope: string,
  tag: string | undefined,
  verbose?: boolean,
  cachedWorkspace?: WorkspaceDiscovery,
): Promise<{ resolved: ResolvedPackage[]; workspace: WorkspaceDiscovery }> {
  const prefix = normalizeScope(scope);
  if (!prefix) {
    throw new CommandError(`Invalid scope: "${scope}". Use a scope name like "clerk" or "@clerk".`);
  }

  // Discover workspace once (use cache if provided)
  let workspace: WorkspaceDiscovery;
  try {
    workspace = cachedWorkspace ?? (await discoverWorkspace(repoPath));
  } catch {
    throw new CommandError('--scope requires a workspace. No workspace detected.');
  }

  // Scan workspace
  const allPackageJsons = await collectWorkspacePackageJsons(repoPath, workspace);
  if (!allPackageJsons) {
    throw new CommandError('--scope requires a workspace. No workspace detected.');
  }

  if (verbose) {
    log.info(`Scanning ${allPackageJsons.length} package.json files for scope ${prefix}*`);
  }

  // Collect unique dep names matching scope
  const scopedDeps = new Set<string>();
  for (const { packageJson } of allPackageJsons) {
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const deps = packageJson[field];
      if (!deps) {
        continue;
      }
      for (const depName of Object.keys(deps)) {
        if (depName.startsWith(prefix)) {
          const depVersion = deps[depName];
          // Skip catalog: protocol entries (handled by catalog auto-detection)
          if (typeof depVersion === 'string' && depVersion.startsWith('catalog:')) {
            if (verbose) {
              log.dim(`  Skipping ${depName} (uses catalog: protocol)`);
            }
            continue;
          }
          scopedDeps.add(depName);
        }
      }
    }
  }

  if (scopedDeps.size === 0) {
    throw new CommandError(`No dependencies matching scope '${prefix.slice(0, -1)}' found in workspace.`);
  }

  // Check all are published, resolve versions
  const missing: string[] = [];
  const resolved: ResolvedPackage[] = [];

  for (const depName of scopedDeps) {
    const distTags = await getDistTags(depName, config);
    const distTagKey = tag ? sanitizeTag(tag) : 'pkglab';
    const version = distTags[distTagKey];
    if (!version) {
      missing.push(depName);
    } else {
      resolved.push({ name: depName, version, tag: tag ? sanitizeTag(tag) : undefined });
    }
  }

  if (missing.length > 0) {
    log.error(
      `These packages are not published in the local registry:\n` +
        missing.map(n => `  ${n}`).join('\n') +
        `\nPublish them first: pkglab pub ${missing.join(' ')}`,
    );
    throw new CommandError('Packages not published in the local registry', { logged: true });
  }

  log.info(`Found ${resolved.length} packages matching ${prefix}*`);
  for (const pkg of resolved) {
    log.dim(`  ${pkg.name}@${pkg.version}`);
  }

  return { resolved, workspace };
}

export default defineCommand({
  meta: { name: 'add', description: 'Add pkglab packages to this repo' },
  args: {
    name: {
      type: 'positional',
      description: 'Package name(s) or name@tag',
      required: false,
    },
    catalog: {
      type: 'boolean',
      alias: 'c',
      description: 'Update the workspace catalog instead of individual package.json',
      default: false,
    },
    packagejson: {
      type: 'string',
      alias: 'p',
      description: 'Path to directory containing the target package.json (relative to cwd)',
    },
    tag: {
      type: 'string',
      alias: 't',
      description: 'Tag for all packages',
    },
    scope: {
      type: 'string',
      alias: 's',
      description: 'Add all published packages matching a scope (e.g. clerk or @clerk)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be installed without making changes',
      default: false,
    },
    verbose: {
      type: 'boolean',
      alias: 'v',
      description: 'Show detailed output',
      default: false,
    },
  },
  async run({ args }) {
    const showUpdate = await prefetchUpdateCheck();
    const config = await loadConfig();
    const names = getPositionalArgs(args);
    const catalog = args.catalog;
    const packagejson = args.packagejson as string | undefined;
    const scope = args.scope as string | undefined;
    const tag = args.tag as string | undefined;
    const dryRun = args['dry-run'];
    const verbose = args.verbose;

    // Validation
    if (scope && names.length > 0) {
      throw new CommandError('Cannot combine --scope with package names. Use one or the other.');
    }
    if (scope && packagejson) {
      throw new CommandError('Cannot combine --scope with -p. Scope scans the entire workspace.');
    }
    if (tag && names.length > 0) {
      const hasInlineTag = names.some(n => {
        const lastAt = n.lastIndexOf('@');
        return lastAt > 0 && n.slice(lastAt + 1).length > 0;
      });
      if (hasInlineTag) {
        throw new CommandError('Cannot combine --tag with inline @tag syntax. Use one or the other.');
      }
    }

    if (dryRun && names.length === 0 && !scope) {
      throw new CommandError('--dry-run requires package names or --scope. Interactive mode is not supported with --dry-run.');
    }

    const [, repoPath] = await Promise.all([ensureDaemonRunning(), canonicalRepoPath(process.cwd())]);
    log.dim('Using pkglab registry server');

    let resolved: ResolvedPackage[];
    let cachedWorkspace: WorkspaceDiscovery | undefined;
    if (scope) {
      const result = await resolveScopePackages(config, repoPath, scope, tag, verbose);
      resolved = result.resolved;
      cachedWorkspace = result.workspace;
    } else if (names.length === 0) {
      resolved = await interactivePick(config, tag);
    } else {
      const parsed = names.map(parsePackageArg);
      const distTagResults = await Promise.all(parsed.map(p => getDistTags(p.name, config)));
      resolved = parsed.map((p, i) => resolveFromDistTags(p.name, distTagResults[i], tag ?? p.tag));
    }

    if (resolved.length > 0) {
      // Hooks: build context and run pre-add before batchInstallPackages
      if (!dryRun) {
        const pm = await detectPackageManager(repoPath);
        const hookCtx = {
          event: 'add' as const,
          packages: resolved.map(p => ({ name: p.name, version: p.version })),
          tag: tag ?? null,
          repoPath,
          registryUrl: `http://127.0.0.1:${config.port}`,
          packageManager: pm,
        };

        const preResult = await runPreHook(hookCtx);
        if (preResult.status === 'ok') {
          log.success(`pre-add hook (${(preResult.durationMs / 1000).toFixed(1)}s)`);
        } else if (preResult.status === 'aborted' || preResult.status === 'failed' || preResult.status === 'timed_out') {
          const label = preResult.status === 'timed_out' ? 'timed out' : `failed (exit ${preResult.exitCode ?? 1})`;
          log.error(`pre-add hook ${label}`);
          await runErrorHook({
            ...hookCtx,
            error: { stage: 'pre-hook', message: `pre-add hook ${label}`, failedHook: 'pre-add' },
          });
          throw new CommandError(`pre-add hook ${label}`, { logged: true });
        }

        try {
          await batchInstallPackages(config, repoPath, resolved, catalog, packagejson, dryRun, verbose, cachedWorkspace);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await runErrorHook({
            ...hookCtx,
            error: { stage: 'operation', message, failedHook: null },
          });
          throw err;
        }

        await ensureNpmrcForActiveRepos(config.port);

        const postResult = await runPostHook(hookCtx);
        if (postResult.status === 'ok') {
          log.success(`post-add hook (${(postResult.durationMs / 1000).toFixed(1)}s)`);
        } else if (postResult.status === 'failed' || postResult.status === 'timed_out') {
          const label = postResult.status === 'timed_out' ? 'timed out' : `failed (exit ${postResult.exitCode ?? 1})`;
          log.warn(`post-add hook ${label}`);
        }
      } else {
        await batchInstallPackages(config, repoPath, resolved, catalog, packagejson, dryRun, verbose, cachedWorkspace);
      }
    }
    await showUpdate();
  },
});
