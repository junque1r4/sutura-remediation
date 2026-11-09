import { describe, it, expect } from 'vitest';
import { toDetectedToolchain } from '../toolchain-override';
import { detectToolchainFromManifests } from '../toolchain-detect';

describe('toDetectedToolchain', () => {
  const serialized = {
    language: 'dotnet',
    image: 'sutura/sandbox-base:latest',
    restoreCmd: ['sh', '-lc', 'dotnet restore'],
    testCmd: ['sh', '-lc', 'dotnet test --no-restore'],
    cachePaths: ['/work/.nuget-packages'],
    restoreNeedsPatch: false,
    appendTestPaths: false,
    testFramework: 'xunit',
    testFilePattern: 'Tests/{base}SuturaTests.cs',
  };

  it('converts testCmd to a function honoring appendTestPaths=false', () => {
    const tc = toDetectedToolchain(serialized);
    expect(tc.testCmd(['Tests/FooSuturaTests.cs'])).toEqual(['sh', '-lc', 'dotnet test --no-restore']);
  });

  it('appends paths when appendTestPaths=true', () => {
    const tc = toDetectedToolchain({ ...serialized, appendTestPaths: true });
    expect(tc.testCmd(['a.test'])).toEqual(['sh', '-lc', 'dotnet test --no-restore', 'a.test']);
  });

  it('maps unknown languages to "unknown" and keeps known languages', () => {
    expect(toDetectedToolchain(serialized).language).toBe('unknown');
    expect(toDetectedToolchain({ ...serialized, language: 'node' }).language).toBe('node');
  });

  it('preserves image, restoreCmd, cachePaths, framework and file pattern', () => {
    const tc = toDetectedToolchain(serialized);
    expect(tc.image).toBe('sutura/sandbox-base:latest');
    expect(tc.restoreCmd).toEqual(['sh', '-lc', 'dotnet restore']);
    expect(tc.installCmd).toEqual(['sh', '-lc', 'dotnet restore']); // deprecated alias
    expect(tc.cachePaths).toEqual(['/work/.nuget-packages']);
    expect(tc.restoreNeedsPatch).toBe(false);
    expect(tc.testFramework).toBe('xunit');
    expect(tc.testFilePattern).toBe('Tests/{base}SuturaTests.cs');
  });
});

describe('unknown toolchain fallback', () => {
  it('returns an empty testCmd so runTests reports an honest skip instead of exec true', () => {
    const tc = detectToolchainFromManifests({});
    expect(tc.testCmd([])).toEqual([]); // was ['true'] -- a fake green exit 0
  });
});
