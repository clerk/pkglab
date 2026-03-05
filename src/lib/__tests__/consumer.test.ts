import { describe, test, expect } from 'bun:test';
import { removepkglabBlock, findCatalogEntry, MARKER_START } from '../consumer';
import type { CatalogData } from '../consumer';

const MARKER_END = '# pkglab-end';

describe('removepkglabBlock', () => {
  test('removes a single pkglab block', () => {
    const content = [
      'some-config=true',
      MARKER_START,
      'registry=http://127.0.0.1:4873',
      MARKER_END,
      'other-config=false',
    ].join('\n');

    const result = removepkglabBlock(content);
    expect(result).toBe('some-config=true\n\nother-config=false\n');
  });

  test('removes multiple pkglab blocks', () => {
    const content = [
      'line1',
      MARKER_START,
      'block1-content',
      MARKER_END,
      'line2',
      MARKER_START,
      'block2-content',
      MARKER_END,
      'line3',
    ].join('\n');

    const result = removepkglabBlock(content);
    expect(result).toBe('line1\n\nline2\n\nline3\n');
  });

  test('normalizes consecutive newlines (3+) to double newlines', () => {
    const content = [
      'before',
      '',
      MARKER_START,
      'registry=http://127.0.0.1:4873',
      MARKER_END,
      '',
      'after',
    ].join('\n');

    const result = removepkglabBlock(content);
    // After removal, "before\n\n\n\nafter" would have 4+ newlines, collapsed to \n\n
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toBe('before\n\nafter\n');
  });

  test('trims and appends a single trailing newline', () => {
    const content = MARKER_START + '\nstuff\n' + MARKER_END + '\n\n\n';

    const result = removepkglabBlock(content);
    expect(result).toBe('\n');
    expect(result.endsWith('\n')).toBe(true);
    expect(result.endsWith('\n\n')).toBe(false);
  });

  test('returns content unchanged (except trim+newline) when no markers present', () => {
    const content = 'registry=https://registry.npmjs.org\nsome-setting=true';

    const result = removepkglabBlock(content);
    expect(result).toBe('registry=https://registry.npmjs.org\nsome-setting=true\n');
  });

  test('handles content that is only a pkglab block', () => {
    const content = MARKER_START + '\nregistry=http://127.0.0.1:4873\n' + MARKER_END;

    const result = removepkglabBlock(content);
    // After removing the block, only whitespace remains, trimmed to empty + \n
    expect(result).toBe('\n');
  });
});

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
