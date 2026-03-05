import { describe, test, expect } from 'bun:test';
import { normalizeScope, getPositionalArgs } from '../args';

describe('normalizeScope', () => {
  test('normalizes plain scope name', () => {
    expect(normalizeScope('clerk')).toBe('@clerk/');
  });

  test('normalizes @-prefixed scope', () => {
    expect(normalizeScope('@clerk')).toBe('@clerk/');
  });

  test('returns null for empty string', () => {
    expect(normalizeScope('')).toBeNull();
  });

  test('returns null for just "@"', () => {
    expect(normalizeScope('@')).toBeNull();
  });

  test('returns null when input contains a slash', () => {
    expect(normalizeScope('clerk/')).toBeNull();
    expect(normalizeScope('@clerk/')).toBeNull();
    expect(normalizeScope('clerk/shared')).toBeNull();
  });

  test('handles single character scope', () => {
    expect(normalizeScope('x')).toBe('@x/');
    expect(normalizeScope('@x')).toBe('@x/');
  });

  test('handles scope with hyphens and dots', () => {
    expect(normalizeScope('my-org')).toBe('@my-org/');
    expect(normalizeScope('@my.org')).toBe('@my.org/');
  });
});

describe('getPositionalArgs', () => {
  test('returns positional args from _ property', () => {
    expect(getPositionalArgs({ _: ['foo', 'bar'] })).toEqual(['foo', 'bar']);
  });

  test('returns empty array when _ is undefined', () => {
    expect(getPositionalArgs({})).toEqual([]);
  });

  test('returns empty array when args object has other keys but no _', () => {
    expect(getPositionalArgs({ verbose: true, tag: 'feat' })).toEqual([]);
  });

  test('returns empty array for empty _ array', () => {
    expect(getPositionalArgs({ _: [] })).toEqual([]);
  });

  test('ignores non-positional properties', () => {
    expect(getPositionalArgs({ _: ['pkg'], force: true })).toEqual(['pkg']);
  });
});
