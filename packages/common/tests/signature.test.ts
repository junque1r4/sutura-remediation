import { describe, it, expect } from 'vitest';
import type { NormalizedFinding } from '../src';
import { normalizeTitle, lineRangeBucket, computeSignature } from '../src';

const SHA256_HEX = /^[0-9a-f]{64}$/;

const makeFinding = (overrides: Partial<NormalizedFinding> = {}): NormalizedFinding => ({
  externalId: 'ext-1',
  scanner: 'aikido',
  title: 'Prototype Pollution in lodash',
  description: 'lodash < 4.17.21 is vulnerable to prototype pollution',
  severity: 'high',
  repo: 'org/api-service',
  packageName: 'lodash',
  cveId: 'CVE-2021-23337',
  rawPayload: {},
  ...overrides,
});

describe('normalizeTitle', () => {
  it('lowercases', () => {
    expect(normalizeTitle('SQL Injection')).toBe('sql injection');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeTitle('SQL   Injection\tin\nlogin')).toBe('sql injection in login');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeTitle('  Cross Site Scripting  ')).toBe('cross site scripting');
  });

  it('is idempotent', () => {
    const once = normalizeTitle('  Foo   BAR ');
    expect(normalizeTitle(once)).toBe(once);
  });
});

describe('lineRangeBucket', () => {
  it('returns empty string for missing range', () => {
    expect(lineRangeBucket()).toBe('');
    expect(lineRangeBucket(null)).toBe('');
    expect(lineRangeBucket(undefined)).toBe('');
  });

  it('returns empty string for unparseable range', () => {
    expect(lineRangeBucket('[]')).toBe('');
    expect(lineRangeBucket('nope')).toBe('');
  });

  it('buckets the start line into 50-line buckets', () => {
    expect(lineRangeBucket('[0,5]')).toBe('0');
    expect(lineRangeBucket('[49,60]')).toBe('0');
    expect(lineRangeBucket('[50,60]')).toBe('1');
    expect(lineRangeBucket('[123,140]')).toBe('2');
  });

  it('puts nearby lines in the same bucket (drift tolerance)', () => {
    expect(lineRangeBucket('[100,110]')).toBe(lineRangeBucket('[120,130]'));
  });

  it('puts far-apart lines in different buckets', () => {
    expect(lineRangeBucket('[10,20]')).not.toBe(lineRangeBucket('[200,210]'));
  });
});

describe('computeSignature', () => {
  it('returns a 64-char lowercase hex sha256 digest', () => {
    expect(computeSignature(makeFinding())).toMatch(SHA256_HEX);
  });

  it('is deterministic for identical input', () => {
    expect(computeSignature(makeFinding())).toBe(computeSignature(makeFinding()));
  });

  it('ignores scanner / externalId differences (same issue, two scanners)', () => {
    const aikido = makeFinding({ scanner: 'aikido', externalId: 'aikido-99' });
    const snyk = makeFinding({ scanner: 'snyk', externalId: 'SNYK-JS-LODASH-1' });
    expect(computeSignature(aikido)).toBe(computeSignature(snyk));
  });

  it('ignores title casing / whitespace', () => {
    const a = makeFinding({ title: 'Prototype Pollution in lodash' });
    const b = makeFinding({ title: '  prototype   POLLUTION in lodash ' });
    expect(computeSignature(a)).toBe(computeSignature(b));
  });

  it('differs when the CVE differs', () => {
    const a = makeFinding({ cveId: 'CVE-2021-23337' });
    const b = makeFinding({ cveId: 'CVE-2020-8203' });
    expect(computeSignature(a)).not.toBe(computeSignature(b));
  });

  it('differs when the repo differs (never collide across repos)', () => {
    const a = makeFinding({ repo: 'org/api-service' });
    const b = makeFinding({ repo: 'org/web-app' });
    expect(computeSignature(a)).not.toBe(computeSignature(b));
  });

  it('differs when the package differs', () => {
    const a = makeFinding({ packageName: 'lodash', cveId: undefined, cweId: undefined, description: 'x' });
    const b = makeFinding({ packageName: 'minimist', cveId: undefined, cweId: undefined, description: 'x' });
    expect(computeSignature(a)).not.toBe(computeSignature(b));
  });

  it('collapses small line drift within a bucket for source findings', () => {
    const a = makeFinding({
      packageName: undefined,
      cveId: undefined,
      cweId: 'CWE-89',
      filePath: 'src/db.ts',
      lineRange: [100, 110],
    });
    const b = makeFinding({
      packageName: undefined,
      cveId: undefined,
      cweId: 'CWE-89',
      filePath: 'src/db.ts',
      lineRange: [120, 130],
    });
    expect(computeSignature(a)).toBe(computeSignature(b));
  });

  it('distinguishes findings in different line buckets', () => {
    const a = makeFinding({
      packageName: undefined,
      cveId: undefined,
      cweId: 'CWE-89',
      filePath: 'src/db.ts',
      lineRange: [10, 20],
    });
    const b = makeFinding({
      packageName: undefined,
      cveId: undefined,
      cweId: 'CWE-89',
      filePath: 'src/db.ts',
      lineRange: [400, 410],
    });
    expect(computeSignature(a)).not.toBe(computeSignature(b));
  });

  it('falls back to cweId then normalized description when no cve', () => {
    const withCwe = makeFinding({ cveId: undefined, cweId: 'CWE-79' });
    const withDesc = makeFinding({ cveId: undefined, cweId: undefined, description: 'Some XSS issue' });
    // Both are well-defined, deterministic, and distinct from one another.
    expect(computeSignature(withCwe)).toMatch(SHA256_HEX);
    expect(computeSignature(withDesc)).toMatch(SHA256_HEX);
    expect(computeSignature(withCwe)).not.toBe(computeSignature(withDesc));
  });
});
