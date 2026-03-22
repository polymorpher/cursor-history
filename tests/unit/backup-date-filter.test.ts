/**
 * Tests for date-filtered backup: date parsing helpers and filtered backup config.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { parseSinceDate, parseRecentDuration } from '../../src/cli/commands/backup.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// parseSinceDate
// =============================================================================
describe('parseSinceDate', () => {
  it('parses ISO date-only string', () => {
    const d = parseSinceDate('2026-03-13');
    expect(d).toBeInstanceOf(Date);
    // Date-only strings are parsed as UTC midnight
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(2); // 0-indexed
    expect(d.getUTCDate()).toBe(13);
  });

  it('parses ISO date-time string', () => {
    const d = parseSinceDate('2026-03-13T10:00:00');
    expect(d).toBeInstanceOf(Date);
    expect(d.getHours()).toBe(10);
  });

  it('parses ISO date-time with timezone', () => {
    const d = parseSinceDate('2026-03-13T10:00:00+09:00');
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(new Date('2026-03-13T10:00:00+09:00').getTime());
  });

  it('throws on invalid date string', () => {
    expect(() => parseSinceDate('not-a-date')).toThrow('Invalid date');
  });

  it('throws on empty string', () => {
    expect(() => parseSinceDate('')).toThrow('Invalid date');
  });
});

// =============================================================================
// parseRecentDuration
// =============================================================================
describe('parseRecentDuration', () => {
  it('parses days (e.g. "7d")', () => {
    const now = Date.now();
    const d = parseRecentDuration('7d');
    const expected = now - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(d.getTime() - expected)).toBeLessThan(1000);
  });

  it('parses weeks (e.g. "2w")', () => {
    const d = parseRecentDuration('2w');
    const expected = new Date();
    expected.setDate(expected.getDate() - 14);
    // Allow larger tolerance for DST transitions
    expect(Math.abs(d.getTime() - expected.getTime())).toBeLessThan(2000);
  });

  it('parses hours (e.g. "4h")', () => {
    const now = Date.now();
    const d = parseRecentDuration('4h');
    const expected = now - 4 * 60 * 60 * 1000;
    expect(Math.abs(d.getTime() - expected)).toBeLessThan(1000);
  });

  it('parses months (e.g. "1m")', () => {
    const d = parseRecentDuration('1m');
    const expected = new Date();
    expected.setMonth(expected.getMonth() - 1);
    expect(Math.abs(d.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it('throws on invalid format', () => {
    expect(() => parseRecentDuration('7x')).toThrow('Invalid duration');
    expect(() => parseRecentDuration('abc')).toThrow('Invalid duration');
    expect(() => parseRecentDuration('')).toThrow('Invalid duration');
  });

  it('throws on missing number', () => {
    expect(() => parseRecentDuration('d')).toThrow('Invalid duration');
  });
});
