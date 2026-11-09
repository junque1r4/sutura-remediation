import { describe, it, expect } from 'vitest';
import { validateSerializedToolchain, SANDBOX_IMAGE_ALLOWLIST } from '../types/repo-toolchain';

const valid = {
  language: 'dotnet',
  image: 'sutura/sandbox-dotnet:latest',
  restoreCmd: ['sh', '-lc', 'dotnet restore'],
  testCmd: ['sh', '-lc', 'dotnet build --no-restore && dotnet test --no-build'],
  cachePaths: ['/work/.nuget-packages'],
  restoreNeedsPatch: false,
  appendTestPaths: false,
  testFramework: 'xunit',
  testFilePattern: 'Tests/{base}SuturaTests.cs',
};

describe('validateSerializedToolchain', () => {
  it('accepts a valid config and round-trips it', () => {
    expect(validateSerializedToolchain(valid)).toEqual(valid);
  });

  it('rejects an image outside the allowlist', () => {
    expect(() => validateSerializedToolchain({ ...valid, image: 'evil/image:latest' })).toThrow(
      /image/,
    );
    expect(SANDBOX_IMAGE_ALLOWLIST).toContain('sutura/sandbox-base:latest');
  });

  it('accepts the baked dotnet image', () => {
    expect(SANDBOX_IMAGE_ALLOWLIST).toContain('sutura/sandbox-dotnet:latest');
    expect(
      validateSerializedToolchain({ ...valid, image: 'sutura/sandbox-dotnet:latest' }).image,
    ).toBe('sutura/sandbox-dotnet:latest');
  });

  it('defaults cachePaths to [] and restoreNeedsPatch to false', () => {
    const { cachePaths: _c, restoreNeedsPatch: _r, ...rest } = valid;
    const out = validateSerializedToolchain(rest);
    expect(out.cachePaths).toEqual([]);
    expect(out.restoreNeedsPatch).toBe(false);
  });

  it('honors restoreNeedsPatch=true and absolute cachePaths', () => {
    const out = validateSerializedToolchain({
      ...valid,
      restoreNeedsPatch: true,
      cachePaths: ['/work/.nuget-packages', '/work/node_modules'],
    });
    expect(out.restoreNeedsPatch).toBe(true);
    expect(out.cachePaths).toEqual(['/work/.nuget-packages', '/work/node_modules']);
  });

  it('rejects non-absolute cachePaths', () => {
    expect(() =>
      validateSerializedToolchain({ ...valid, cachePaths: ['relative/dir'] }),
    ).toThrow(/cachePaths/);
  });

  it('back-compat: legacy installCmd maps to restoreCmd', () => {
    const { restoreCmd: _omit, ...rest } = valid;
    const out = validateSerializedToolchain({ ...rest, installCmd: ['npm', 'ci'] });
    expect(out.restoreCmd).toEqual(['npm', 'ci']);
    expect((out as Record<string, unknown>).installCmd).toBeUndefined();
  });

  it('rejects empty testCmd and non-string argv entries', () => {
    expect(() => validateSerializedToolchain({ ...valid, testCmd: [] })).toThrow(/testCmd/);
    const { restoreCmd: _omit, ...rest } = valid;
    expect(() => validateSerializedToolchain({ ...rest, installCmd: [42] })).toThrow(/installCmd/);
  });

  it('allows an empty restoreCmd (baked-only toolchain)', () => {
    expect(validateSerializedToolchain({ ...valid, restoreCmd: [] }).restoreCmd).toEqual([]);
  });

  it('rejects oversized fields', () => {
    expect(() => validateSerializedToolchain({ ...valid, testFilePattern: 'x'.repeat(600) })).toThrow(
      /length/,
    );
  });

  it('rejects missing appendTestPaths', () => {
    const { appendTestPaths: _omit, ...rest } = valid;
    expect(() => validateSerializedToolchain(rest)).toThrow(/appendTestPaths/);
  });
});
