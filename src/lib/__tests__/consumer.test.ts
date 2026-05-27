import { describe, test, expect } from 'bun:test';

import { removepkglabBlock, MARKER_START } from '../consumer';

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
    const content = ['before', '', MARKER_START, 'registry=http://127.0.0.1:4873', MARKER_END, '', 'after'].join('\n');

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
