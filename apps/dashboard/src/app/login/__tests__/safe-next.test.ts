import { describe, expect, it } from 'vitest';
import { safeNextPath } from '../safe-next';

describe('safeNextPath', () => {
  it('passes through same-origin absolute paths', () => {
    expect(safeNextPath('/findings/aikido-154476805')).toBe('/findings/aikido-154476805');
    expect(safeNextPath('/')).toBe('/');
  });

  it('falls back to / when next is missing', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('')).toBe('/');
  });

  it('rejects external and protocol-relative URLs (open redirect)', () => {
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example/phish')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
  });

  it('rejects non-path garbage', () => {
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
    expect(safeNextPath('findings')).toBe('/');
  });
});
