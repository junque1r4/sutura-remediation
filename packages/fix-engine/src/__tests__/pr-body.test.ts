import { describe, it, expect, vi } from 'vitest';
import { buildValidatedPrBody } from '../pipeline/submitter';

const base = {
  findingTitle: 'Use of broken or outdated encryption in Engine.cs',
  severity: 'medium',
  findingId: '76121446',
  model: 'claude-sonnet-4-6',
  files: [
    { path: 'ExampleApp.Security/Encryption/Engine.cs' },
    { path: 'ExampleAppWebAPI/Helpers/ExampleEncryptionHelper.cs' },
  ],
  testFilePaths: ['Tests/EncryptionEngineSuturaTests.cs'],
};

describe('buildValidatedPrBody', () => {
  it('uses the agent narrative as the body substance when present', () => {
    const narrative = [
      '### Summary',
      'Replaced MD5+3DES-ECB with AES-256-CBC.',
      '### Caveats & notes',
      'Data encrypted with the old scheme will no longer decrypt.',
    ].join('\n');

    const body = buildValidatedPrBody({
      ...base,
      narrative,
      evidence: { scanTool: 'semgrep', scanResolved: true, testsOutcome: 'passed', bypassChecked: true, rounds: 1 },
    });

    // Narrative substance is present...
    expect(body).toContain('### Summary');
    expect(body).toContain('Replaced MD5+3DES-ECB with AES-256-CBC.');
    expect(body).toContain('### Caveats & notes');
    expect(body).toContain('no longer decrypt');
    // ...and the deterministic evidence section is appended.
    expect(body).toContain('### Validation evidence');
    expect(body).toContain('Re-scanned with **semgrep**');
    expect(body).toContain('Sandbox build + generated tests **passed**');
    expect(body).toContain('found **no bypass**');
    expect(body).toContain('Reached in **1** generate→validate round.');
    // The static "Changes" fallback should NOT appear when a narrative is used.
    expect(body).not.toContain('### Changes');
  });

  it('falls back to a change summary (listing files + tests) when narrative is absent', () => {
    const body = buildValidatedPrBody({
      ...base,
      evidence: { scanTool: 'semgrep', scanResolved: true, testsOutcome: 'skipped', rounds: 2 },
    });

    expect(body).toContain('### Changes');
    expect(body).toContain('Applied to 2 files');
    expect(body).toContain('`ExampleApp.Security/Encryption/Engine.cs`');
    expect(body).toContain('`ExampleAppWebAPI/Helpers/ExampleEncryptionHelper.cs`');
    expect(body).toContain('### Tests added');
    expect(body).toContain('`Tests/EncryptionEngineSuturaTests.cs`');
    // Evidence reflects the scoped "no test project" case + plural rounds.
    expect(body).toContain('generated tests could not execute');
    expect(body).toContain('Reached in **2** generate→validate rounds.');
  });

  it('always includes the caveats review item and the automation footer', () => {
    const body = buildValidatedPrBody({ ...base });
    expect(body).toMatch(/Assess the caveats above .*before merging/);
    expect(body).toContain('Automated by Sutura');
  });
});

// ---------------------------------------------------------------------------
// generatePrNarrative -- mock the Anthropic SDK so no network call happens.
// ---------------------------------------------------------------------------

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { generatePrNarrative } from '../pipeline/pr-narrative';
import type { NormalizedFinding } from '@sutura/common';

const FINDING: NormalizedFinding = {
  externalId: '76121446',
  scanner: 'aikido',
  title: 'Use of broken or outdated encryption',
  description: 'MD5+3DES+ECB',
  severity: 'medium',
  repo: 'acme/api',
  filePath: 'Engine.cs',
  cweId: 'CWE-327',
  rawPayload: {},
};

describe('generatePrNarrative', () => {
  it('returns the agent markdown on success', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '### Summary\nFixed it.\n### Caveats & notes\nLegacy data.' }],
    });
    const out = await generatePrNarrative({
      finding: FINDING,
      diff: '--- a/Engine.cs\n+++ b/Engine.cs\n@@ -1 +1 @@\n-MD5\n+AES',
      testFiles: [{ path: 'T.cs', content: 'assert roundtrip' }],
      evidence: { scanTool: 'semgrep', testsOutcome: 'passed', bypassChecked: true, rounds: 1 },
      anthropicApiKey: 'k',
    });
    expect(out).toContain('### Summary');
    expect(out).toContain('### Caveats & notes');
  });

  it('returns null (non-blocking) when the API call throws', async () => {
    createMock.mockRejectedValueOnce(new Error('boom'));
    const out = await generatePrNarrative({
      finding: FINDING,
      diff: 'd',
      testFiles: [],
      anthropicApiKey: 'k',
    });
    expect(out).toBeNull();
  });

  it('returns null when no API key is provided (no call attempted)', async () => {
    createMock.mockClear();
    const out = await generatePrNarrative({ finding: FINDING, diff: 'd', testFiles: [], anthropicApiKey: '' });
    expect(out).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});
