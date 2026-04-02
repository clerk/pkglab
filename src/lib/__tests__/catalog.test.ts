import { describe, test, expect } from 'bun:test';

import type { CatalogData } from '../catalog';

import { findCatalogEntry } from '../catalog';

describe('findCatalogEntry', () => {
  test('finds package in default catalog field', () => {
    const data: CatalogData = {
      catalog: {
        '@clerk/shared': '^1.0.0',
        '@clerk/types': '^2.0.0',
      },
    };

    const result = findCatalogEntry(data, '@clerk/shared');
    expect(result).toEqual({ catalogName: 'default', version: '^1.0.0' });
  });

  test('finds package in a named catalogs entry', () => {
    const data: CatalogData = {
      catalogs: {
        react: {
          react: '^18.0.0',
          'react-dom': '^18.0.0',
        },
        clerk: {
          '@clerk/shared': '^1.0.0',
        },
      },
    };

    const result = findCatalogEntry(data, '@clerk/shared');
    expect(result).toEqual({ catalogName: 'clerk', version: '^1.0.0' });
  });

  test('prefers default catalog over named catalogs', () => {
    const data: CatalogData = {
      catalog: {
        '@clerk/shared': '^1.0.0',
      },
      catalogs: {
        clerk: {
          '@clerk/shared': '^2.0.0',
        },
      },
    };

    const result = findCatalogEntry(data, '@clerk/shared');
    expect(result).toEqual({ catalogName: 'default', version: '^1.0.0' });
  });

  test('returns null when package is not in any catalog', () => {
    const data: CatalogData = {
      catalog: {
        react: '^18.0.0',
      },
      catalogs: {
        clerk: {
          '@clerk/types': '^1.0.0',
        },
      },
    };

    const result = findCatalogEntry(data, '@clerk/shared');
    expect(result).toBeNull();
  });

  test('returns null when data has no catalog fields', () => {
    const data: CatalogData = {};

    const result = findCatalogEntry(data, '@clerk/shared');
    expect(result).toBeNull();
  });

  test('returns null when catalogs object has empty entries', () => {
    const data: CatalogData = {
      catalogs: {
        empty: {},
      },
    };

    const result = findCatalogEntry(data, '@clerk/shared');
    expect(result).toBeNull();
  });
});
