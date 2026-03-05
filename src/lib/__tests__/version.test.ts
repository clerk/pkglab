import { describe, test, expect } from 'bun:test';

import { pkglabError } from '../errors';
import {
  ispkglabVersion,
  extractTimestamp,
  extractTag,
  sanitizeTag,
  generateVersion,
} from '../version';

describe('ispkglabVersion', () => {
  test('returns true for untagged pkglab versions', () => {
    expect(ispkglabVersion('0.0.0-pkglab.1709654321000')).toBe(true);
  });

  test('returns true for tagged pkglab versions', () => {
    expect(ispkglabVersion('0.0.0-pkglab-feat1.1709654321000')).toBe(true);
  });

  test('returns true for old format versions (backwards compat)', () => {
    expect(ispkglabVersion('0.0.0-pkglab.24-03-05--14-30-00.1709654321000')).toBe(true);
  });

  test('returns false for regular semver versions', () => {
    expect(ispkglabVersion('1.2.3')).toBe(false);
  });

  test('returns false for prerelease versions that are not pkglab', () => {
    expect(ispkglabVersion('0.0.0-beta.1')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(ispkglabVersion('')).toBe(false);
  });

  test('returns false for partial prefix match', () => {
    expect(ispkglabVersion('0.0.0-pkg')).toBe(false);
    expect(ispkglabVersion('0.0.0-pkgla')).toBe(false);
  });

  test('returns false when prefix is followed by unexpected character', () => {
    // "0.0.0-pkglab" followed by something other than '.' or '-'
    expect(ispkglabVersion('0.0.0-pkglabX')).toBe(false);
    expect(ispkglabVersion('0.0.0-pkglab_foo')).toBe(false);
  });

  test('returns false when base matches exactly but has no suffix', () => {
    // version === "0.0.0-pkglab" exactly, next char is undefined
    expect(ispkglabVersion('0.0.0-pkglab')).toBe(false);
  });

  test('returns true for minimal valid tagged version', () => {
    expect(ispkglabVersion('0.0.0-pkglab-a.1')).toBe(true);
  });

  test('returns true for minimal valid untagged version', () => {
    expect(ispkglabVersion('0.0.0-pkglab.1')).toBe(true);
  });
});

describe('extractTimestamp', () => {
  test('extracts timestamp from untagged version', () => {
    expect(extractTimestamp('0.0.0-pkglab.1709654321000')).toBe(1709654321000);
  });

  test('extracts timestamp from tagged version', () => {
    expect(extractTimestamp('0.0.0-pkglab-feat1.1709654321000')).toBe(1709654321000);
  });

  test('extracts timestamp from old format version', () => {
    expect(extractTimestamp('0.0.0-pkglab.24-03-05--14-30-00.1709654321000')).toBe(1709654321000);
  });

  test('extracts timestamp from regular semver (last segment after dot)', () => {
    // It just parses after last dot, doesn't require pkglab prefix
    expect(extractTimestamp('1.2.3')).toBe(3);
  });

  test('returns NaN for string with no dots', () => {
    expect(extractTimestamp('nodots')).toBeNaN();
  });

  test('returns NaN for empty string', () => {
    expect(extractTimestamp('')).toBeNaN();
  });

  test('returns NaN when text after last dot is not a number', () => {
    expect(extractTimestamp('0.0.0-pkglab.abc')).toBeNaN();
  });

  test('handles single dot at the end', () => {
    // "foo." -> slice after dot is "" -> parseInt("", 10) -> NaN
    expect(extractTimestamp('foo.')).toBeNaN();
  });

  test('handles dot at the start', () => {
    expect(extractTimestamp('.12345')).toBe(12345);
  });
});

describe('extractTag', () => {
  test('returns null for non-pkglab versions', () => {
    expect(extractTag('1.2.3')).toBeNull();
  });

  test('returns null for untagged pkglab versions', () => {
    expect(extractTag('0.0.0-pkglab.1709654321000')).toBeNull();
  });

  test('extracts tag from tagged version', () => {
    expect(extractTag('0.0.0-pkglab-feat1.1709654321000')).toBe('feat1');
  });

  test('extracts multi-segment tag with dashes', () => {
    expect(extractTag('0.0.0-pkglab-my-cool-feature.1709654321000')).toBe('my-cool-feature');
  });

  test('returns null for empty string', () => {
    expect(extractTag('')).toBeNull();
  });

  test('returns null when tag section has no trailing dot', () => {
    // "0.0.0-pkglab-nodot" is a pkglab version? Let's check:
    // starts with "0.0.0-pkglab", next char is '-' so ispkglabVersion is true
    // rest = "nodot", lastDot = -1, returns null
    expect(extractTag('0.0.0-pkglab-nodot')).toBeNull();
  });

  test('extracts tag when tag contains numbers', () => {
    expect(extractTag('0.0.0-pkglab-feat123.1709654321000')).toBe('feat123');
  });

  test('handles old format (dot after pkglab, not dash)', () => {
    // next char is '.', not '-', so returns null (untagged)
    expect(extractTag('0.0.0-pkglab.24-03-05--14-30-00.1709654321000')).toBeNull();
  });

  test('extracts tag with dots in it (takes everything before last dot)', () => {
    // "0.0.0-pkglab-a.b.123" -> rest = "a.b.123", lastDot at index 3, tag = "a.b"
    expect(extractTag('0.0.0-pkglab-a.b.123')).toBe('a.b');
  });
});

describe('sanitizeTag', () => {
  test('passes through simple alphanumeric tags', () => {
    expect(sanitizeTag('feat1')).toBe('feat1');
  });

  test('replaces slashes with dashes', () => {
    expect(sanitizeTag('feature/my-branch')).toBe('feature-my-branch');
  });

  test('removes special characters', () => {
    expect(sanitizeTag('feat@1!2#3')).toBe('feat123');
  });

  test('collapses multiple consecutive dashes', () => {
    expect(sanitizeTag('a---b')).toBe('a-b');
  });

  test('strips leading and trailing dashes', () => {
    expect(sanitizeTag('-hello-')).toBe('hello');
    expect(sanitizeTag('--hello--')).toBe('hello');
  });

  test('handles slash at start and end', () => {
    expect(sanitizeTag('/hello/')).toBe('hello');
  });

  test('handles complex branch names', () => {
    expect(sanitizeTag('refs/heads/feature/JIRA-123-cool-stuff')).toBe('refs-heads-feature-JIRA-123-cool-stuff');
  });

  test('truncates to 50 characters', () => {
    const long = 'a'.repeat(60);
    const result = sanitizeTag(long);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toBe('a'.repeat(50));
  });

  test('strips trailing dashes after truncation', () => {
    // Create a string where character 50 would leave a trailing dash
    const tag = 'a'.repeat(49) + '-b';
    // Length is 51, gets sliced to 50: "aaa...a-", trailing dash stripped
    const result = sanitizeTag(tag);
    expect(result).toBe('a'.repeat(49));
    expect(result.endsWith('-')).toBe(false);
  });

  test('throws pkglabError when result is empty after sanitization', () => {
    expect(() => sanitizeTag('!!!')).toThrow(pkglabError);
    expect(() => sanitizeTag('!!!')).toThrow('Tag "!!!" is empty after sanitization');
  });

  test('throws pkglabError for empty string input', () => {
    expect(() => sanitizeTag('')).toThrow(pkglabError);
  });

  test('throws pkglabError for string of only special characters', () => {
    expect(() => sanitizeTag('@#$%^&*()')).toThrow(pkglabError);
  });

  test('throws pkglabError for string of only slashes', () => {
    // slashes become dashes, then leading/trailing dashes stripped -> empty
    expect(() => sanitizeTag('///')).toThrow(pkglabError);
  });

  test('throws pkglabError for string of only dashes', () => {
    expect(() => sanitizeTag('---')).toThrow(pkglabError);
  });

  test('preserves uppercase letters', () => {
    expect(sanitizeTag('MyFeature')).toBe('MyFeature');
  });

  test('handles mixed slashes and special chars', () => {
    expect(sanitizeTag('feat/cool_thing@v2')).toBe('feat-coolthingv2');
  });

  test('underscores are removed', () => {
    expect(sanitizeTag('snake_case')).toBe('snakecase');
  });
});

describe('generateVersion', () => {
  test('generates untagged version without tag argument', () => {
    const version = generateVersion();
    expect(version).toMatch(/^0\.0\.0-pkglab\.\d+$/);
  });

  test('generates tagged version with tag argument', () => {
    const version = generateVersion('feat1');
    expect(version).toMatch(/^0\.0\.0-pkglab-feat1\.\d+$/);
  });

  test('generated versions are valid pkglab versions', () => {
    expect(ispkglabVersion(generateVersion())).toBe(true);
    expect(ispkglabVersion(generateVersion('mytag'))).toBe(true);
  });

  test('extractTag round-trips on tagged versions', () => {
    const version = generateVersion('feat1');
    expect(extractTag(version)).toBe('feat1');
  });

  test('extractTag returns null for untagged generated versions', () => {
    const version = generateVersion();
    expect(extractTag(version)).toBeNull();
  });

  test('extractTimestamp returns a valid number', () => {
    const version = generateVersion();
    const ts = extractTimestamp(version);
    expect(ts).not.toBeNaN();
    expect(ts).toBeGreaterThan(0);
  });

  test('monotonically increasing timestamps across rapid calls', () => {
    const v1 = generateVersion();
    const v2 = generateVersion();
    const v3 = generateVersion();

    const ts1 = extractTimestamp(v1);
    const ts2 = extractTimestamp(v2);
    const ts3 = extractTimestamp(v3);

    expect(ts2).toBeGreaterThan(ts1);
    expect(ts3).toBeGreaterThan(ts2);
  });

  test('monotonicity holds across tagged and untagged calls', () => {
    const v1 = generateVersion('a');
    const v2 = generateVersion();
    const v3 = generateVersion('b');

    const ts1 = extractTimestamp(v1);
    const ts2 = extractTimestamp(v2);
    const ts3 = extractTimestamp(v3);

    expect(ts2).toBeGreaterThan(ts1);
    expect(ts3).toBeGreaterThan(ts2);
  });

  test('empty string tag is treated as no tag', () => {
    const version = generateVersion('');
    // empty string is falsy, so no tag
    expect(version).toMatch(/^0\.0\.0-pkglab\.\d+$/);
  });

  test('timestamp is close to Date.now()', () => {
    const before = Date.now();
    const version = generateVersion();
    const ts = extractTimestamp(version);
    // Should be >= before (could be higher due to monotonicity guard)
    expect(ts).toBeGreaterThanOrEqual(before);
    // But not wildly different (within 1 second)
    expect(ts - before).toBeLessThan(1000);
  });
});
