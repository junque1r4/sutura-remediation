import { describe, it, expect, vi } from 'vitest';
import { evaluateToolchain } from '../toolchain-check';

describe('evaluateToolchain', () => {
  it('node + vitest manifests -> supported', async () => {
    const res = await evaluateToolchain({
      manifests: { 'package.json': JSON.stringify({ devDependencies: { vitest: '^1' } }) },
      rootListing: ['package.json', 'src'],
      developerPrompt: null,
      derive: vi.fn(),
    });
    expect(res.status).toBe('supported');
    expect(res.testFramework).toBe('vitest');
  });

  it('unknown manifests without prompt -> needs_prompt with a hint', async () => {
    const res = await evaluateToolchain({
      manifests: {}, rootListing: ['ExampleApp.sln', 'ExampleAppWebAPI.csproj'],
      developerPrompt: null, derive: vi.fn(),
    });
    expect(res.status).toBe('needs_prompt');
    expect(res.detail).toMatch(/\.sln/);
  });

  it('node WITHOUT any test runner -> needs_prompt (a language match alone is not coverage)', async () => {
    const res = await evaluateToolchain({
      manifests: { 'package.json': JSON.stringify({ dependencies: { express: '^4' } }) },
      rootListing: ['package.json'], developerPrompt: null, derive: vi.fn(),
    });
    expect(res.status).toBe('needs_prompt');
  });

  it('unknown manifests with prompt -> derives, validates, returns custom_ready', async () => {
    const derived = {
      language: 'dotnet', image: 'sutura/sandbox-base:latest', installCmd: ['sh','-lc','dotnet restore'],
      testCmd: ['sh','-lc','dotnet test'], appendTestPaths: false, testFramework: 'xunit',
      testFilePattern: 'Tests/{base}SuturaTests.cs',
    };
    const derive = vi.fn().mockResolvedValue(derived);
    const res = await evaluateToolchain({
      manifests: {}, rootListing: ['ExampleApp.sln'], developerPrompt: 'use dotnet 8', derive,
    });
    expect(res.status).toBe('custom_ready');
    expect(res.derivedConfig).toEqual(derived);
  });

  it('derivation throwing -> status error, no config stored', async () => {
    const derive = vi.fn().mockRejectedValue(new Error('image must be one of...'));
    const res = await evaluateToolchain({
      manifests: {}, rootListing: [], developerPrompt: 'x', derive,
    });
    expect(res.status).toBe('error');
    expect(res.derivedConfig).toBeNull();
  });
});
