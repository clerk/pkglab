import { describe, test, expect } from 'bun:test';

import type { WorkspacePackage } from '../../types';
import { buildPublishPlan } from '../publisher';

function makePackage(
  name: string,
  deps: Record<string, string> = {},
  overrides: Partial<Pick<WorkspacePackage, 'dir' | 'publishable'>> & {
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {},
): WorkspacePackage {
  const { dir, publishable, peerDependencies, optionalDependencies, devDependencies } = overrides;
  return {
    name,
    dir: dir ?? `/packages/${name}`,
    publishable: publishable ?? true,
    packageJson: {
      name,
      version: '1.0.0',
      dependencies: Object.keys(deps).length > 0 ? deps : undefined,
      peerDependencies,
      optionalDependencies,
      devDependencies,
    },
  };
}

const VERSION = '0.0.0-pkglab.1709654321000';

describe('buildPublishPlan', () => {
  describe('basic plan generation', () => {
    test('creates a plan for a single package', () => {
      const packages = [makePackage('@clerk/shared')];
      const plan = buildPublishPlan(packages, VERSION);

      expect(plan.packages).toHaveLength(1);
      expect(plan.packages[0].name).toBe('@clerk/shared');
      expect(plan.packages[0].dir).toBe('/packages/@clerk/shared');
      expect(plan.packages[0].version).toBe(VERSION);
      expect(plan.packages[0].rewrittenDeps).toEqual({});
    });

    test('creates entries for multiple packages', () => {
      const packages = [makePackage('@clerk/shared'), makePackage('@clerk/types'), makePackage('@clerk/backend')];
      const plan = buildPublishPlan(packages, VERSION);

      expect(plan.packages).toHaveLength(3);
      expect(plan.packages.map(e => e.name)).toEqual(['@clerk/shared', '@clerk/types', '@clerk/backend']);
    });

    test('sets timestamp to a number', () => {
      const plan = buildPublishPlan([makePackage('pkg-a')], VERSION);
      expect(typeof plan.timestamp).toBe('number');
    });

    test('assigns the provided version to all entries', () => {
      const packages = [makePackage('pkg-a'), makePackage('pkg-b')];
      const plan = buildPublishPlan(packages, VERSION);

      for (const entry of plan.packages) {
        expect(entry.version).toBe(VERSION);
      }
    });
  });

  describe('empty packages list', () => {
    test('returns an empty plan', () => {
      const plan = buildPublishPlan([], VERSION);
      expect(plan.packages).toEqual([]);
    });

    test('still has a timestamp and catalogs', () => {
      const plan = buildPublishPlan([], VERSION);
      expect(typeof plan.timestamp).toBe('number');
      expect(plan.catalogs).toEqual({});
    });
  });

  describe('packages with no workspace deps', () => {
    test('produces empty rewrittenDeps for packages with external deps only', () => {
      const packages = [makePackage('pkg-a', { react: '^18.0.0', lodash: '4.17.21' })];
      const plan = buildPublishPlan(packages, VERSION);

      expect(plan.packages[0].rewrittenDeps).toEqual({});
    });

    test('produces empty rewrittenDeps for packages with no deps at all', () => {
      const packages = [makePackage('pkg-a')];
      const plan = buildPublishPlan(packages, VERSION);

      expect(plan.packages[0].rewrittenDeps).toEqual({});
    });
  });

  describe('dep rewriting for in-scope workspace deps', () => {
    test('rewrites workspace deps that are in the publish set', () => {
      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared', { '@clerk/types': 'workspace:^' }),
      ];
      const plan = buildPublishPlan(packages, VERSION);

      expect(plan.packages[1].rewrittenDeps).toEqual({
        '@clerk/types': VERSION,
      });
    });

    test('does not rewrite deps that are not in the publish set', () => {
      const packages = [makePackage('@clerk/shared', { '@clerk/types': 'workspace:^', react: '^18.0.0' })];
      const plan = buildPublishPlan(packages, VERSION);

      // @clerk/types is not in the publish set, so no rewrite
      expect(plan.packages[0].rewrittenDeps).toEqual({});
    });

    test('rewrites multiple workspace deps', () => {
      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared'),
        makePackage('@clerk/backend', {
          '@clerk/types': 'workspace:^',
          '@clerk/shared': 'workspace:~',
          'external-lib': '^1.0.0',
        }),
      ];
      const plan = buildPublishPlan(packages, VERSION);

      expect(plan.packages[2].rewrittenDeps).toEqual({
        '@clerk/types': VERSION,
        '@clerk/shared': VERSION,
      });
    });
  });

  describe('existingVersions for unchanged packages', () => {
    test('uses existing version for deps that have an entry in existingVersions', () => {
      const existingVersions = new Map([['@clerk/types', '0.0.0-pkglab.1709654000000']]);
      // @clerk/types is NOT in the packages list but has an existing version
      const packages = [makePackage('@clerk/shared', { '@clerk/types': 'workspace:^' })];
      const plan = buildPublishPlan(packages, VERSION, {}, existingVersions);

      expect(plan.packages[0].rewrittenDeps).toEqual({
        '@clerk/types': '0.0.0-pkglab.1709654000000',
      });
    });

    test('in-scope packages take priority over existingVersions', () => {
      const existingVersions = new Map([['@clerk/types', '0.0.0-pkglab.1709654000000']]);
      // @clerk/types IS in the packages list AND has an existing version
      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared', { '@clerk/types': 'workspace:^' }),
      ];
      const plan = buildPublishPlan(packages, VERSION, {}, existingVersions);

      // In-scope version wins over existingVersions
      expect(plan.packages[1].rewrittenDeps).toEqual({
        '@clerk/types': VERSION,
      });
    });

    test('ignores existingVersions for deps not referenced by any package', () => {
      const existingVersions = new Map([['@clerk/unused', '0.0.0-pkglab.1709654000000']]);
      const packages = [makePackage('@clerk/shared', { react: '^18.0.0' })];
      const plan = buildPublishPlan(packages, VERSION, {}, existingVersions);

      expect(plan.packages[0].rewrittenDeps).toEqual({});
    });
  });

  describe('all dep field types', () => {
    test('rewrites dependencies', () => {
      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared', { '@clerk/types': 'workspace:^' }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps['@clerk/types']).toBe(VERSION);
    });

    test('rewrites peerDependencies', () => {
      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared', {}, { peerDependencies: { '@clerk/types': 'workspace:^' } }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps['@clerk/types']).toBe(VERSION);
    });

    test('rewrites optionalDependencies', () => {
      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared', {}, { optionalDependencies: { '@clerk/types': 'workspace:^' } }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps['@clerk/types']).toBe(VERSION);
    });

    test('does not rewrite devDependencies', () => {
      // buildPublishPlan only processes dependencies, peerDependencies, optionalDependencies
      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared', {}, { devDependencies: { '@clerk/types': 'workspace:^' } }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps).toEqual({});
    });

    test('rewrites across multiple dep fields in the same package', () => {
      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared'),
        makePackage('@clerk/backend', { '@clerk/shared': 'workspace:^' }, {
          peerDependencies: { '@clerk/types': 'workspace:*' },
        }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[2].rewrittenDeps).toEqual({
        '@clerk/shared': VERSION,
        '@clerk/types': VERSION,
      });
    });
  });

  describe('workspace: protocol is irrelevant to rewriting decision', () => {
    // buildPublishPlan rewrites based on set membership, not protocol parsing.
    // The actual workspace: protocol resolution happens in publishSinglePackage.
    // Here we verify that the dep value doesn't matter, only whether the name is in scope.

    test('rewrites workspace:^ deps in scope', () => {
      const packages = [
        makePackage('pkg-a'),
        makePackage('pkg-b', { 'pkg-a': 'workspace:^' }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps['pkg-a']).toBe(VERSION);
    });

    test('rewrites workspace:~ deps in scope', () => {
      const packages = [
        makePackage('pkg-a'),
        makePackage('pkg-b', { 'pkg-a': 'workspace:~' }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps['pkg-a']).toBe(VERSION);
    });

    test('rewrites workspace:* deps in scope', () => {
      const packages = [
        makePackage('pkg-a'),
        makePackage('pkg-b', { 'pkg-a': 'workspace:*' }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps['pkg-a']).toBe(VERSION);
    });

    test('rewrites workspace:^1.0.0 style deps in scope', () => {
      const packages = [
        makePackage('pkg-a'),
        makePackage('pkg-b', { 'pkg-a': 'workspace:^1.0.0' }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps['pkg-a']).toBe(VERSION);
    });

    test('rewrites plain version deps in scope', () => {
      const packages = [
        makePackage('pkg-a'),
        makePackage('pkg-b', { 'pkg-a': '^1.0.0' }),
      ];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[1].rewrittenDeps['pkg-a']).toBe(VERSION);
    });
  });

  describe('catalogs passthrough', () => {
    test('passes catalogs through to the plan', () => {
      const catalogs = {
        default: { react: '^18.0.0', typescript: '^5.0.0' },
        custom: { lodash: '4.17.21' },
      };
      const plan = buildPublishPlan([makePackage('pkg-a')], VERSION, catalogs);
      expect(plan.catalogs).toBe(catalogs);
    });

    test('defaults catalogs to empty object when not provided', () => {
      const plan = buildPublishPlan([makePackage('pkg-a')], VERSION);
      expect(plan.catalogs).toEqual({});
    });
  });

  describe('mixed scenarios', () => {
    test('handles a realistic dependency graph', () => {
      const existingVersions = new Map([['@clerk/localization', '0.0.0-pkglab.1709650000000']]);

      const packages = [
        makePackage('@clerk/types'),
        makePackage('@clerk/shared', { '@clerk/types': 'workspace:^' }),
        makePackage('@clerk/backend', {
          '@clerk/types': 'workspace:^',
          '@clerk/shared': 'workspace:^',
          '@clerk/localization': 'workspace:^',
        }),
        makePackage('@clerk/express', {
          '@clerk/backend': 'workspace:^',
          '@clerk/shared': 'workspace:^',
          tslib: '^2.0.0',
        }),
      ];

      const plan = buildPublishPlan(packages, VERSION, {}, existingVersions);

      // @clerk/types has no in-scope deps
      expect(plan.packages[0].rewrittenDeps).toEqual({});

      // @clerk/shared depends on @clerk/types (in scope)
      expect(plan.packages[1].rewrittenDeps).toEqual({
        '@clerk/types': VERSION,
      });

      // @clerk/backend depends on types, shared (in scope) and localization (existing)
      expect(plan.packages[2].rewrittenDeps).toEqual({
        '@clerk/types': VERSION,
        '@clerk/shared': VERSION,
        '@clerk/localization': '0.0.0-pkglab.1709650000000',
      });

      // @clerk/express depends on backend, shared (in scope), tslib (external, ignored)
      expect(plan.packages[3].rewrittenDeps).toEqual({
        '@clerk/backend': VERSION,
        '@clerk/shared': VERSION,
      });
    });

    test('self-referencing package name in deps gets rewritten', () => {
      // Edge case: a package lists itself as a dep (unusual but possible)
      const packages = [makePackage('pkg-a', { 'pkg-a': 'workspace:^' })];
      const plan = buildPublishPlan(packages, VERSION);
      expect(plan.packages[0].rewrittenDeps).toEqual({ 'pkg-a': VERSION });
    });
  });
});
