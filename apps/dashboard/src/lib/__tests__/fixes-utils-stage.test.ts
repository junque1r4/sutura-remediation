import { describe, it, expect } from 'vitest';
import { deriveStage, skipLabel } from '../fixes-utils';
import type { FixAttemptRow } from '../../types';

function makeRow(overrides: Partial<FixAttemptRow> = {}): FixAttemptRow {
  return {
    id: 'attempt-1',
    findingId: 'finding-1',
    orgId: 'org-1',
    promptSnapshot: '',
    generatedDiff: null,
    testResult: null,
    prUrl: null,
    prStatus: null,
    claudeModel: '',
    claudeTokensUsed: 0,
    createdAt: '2026-06-21T00:00:00.000Z',
    completedAt: '2026-06-21T00:00:01.000Z',
    attemptNumber: 1,
    parentAttemptId: null,
    status: 'failed',
    testOutput: null,
    testFilesAdded: null,
    validationStatus: null,
    scanOutput: null,
    scanTool: null,
    failureReason: null,
    ...overrides,
  } as FixAttemptRow;
}

describe('deriveStage for a skipped attempt', () => {
  it('renders a neutral gray stage, never red, for a verification-gate skip', () => {
    const stage = deriveStage(
      makeRow({ status: 'skipped', failureReason: 'not_exploitable' }),
    );
    expect(stage.tone).toBe('gray');
    expect(stage.label).toBe('Skipped: not exploitable');
  });

  it('renders neutral for an unreachable skip', () => {
    const stage = deriveStage(makeRow({ status: 'skipped', failureReason: 'unreachable' }));
    expect(stage.tone).toBe('gray');
    expect(stage.label).toBe('Skipped: unreachable');
  });

  it('renders neutral for a below-threshold triage skip', () => {
    const stage = deriveStage(
      makeRow({ status: 'skipped', failureReason: 'below_threshold' }),
    );
    expect(stage.tone).toBe('gray');
    expect(stage.label).toBe('Skipped: below threshold');
  });

  it('still renders an actual failure as red', () => {
    const stage = deriveStage(makeRow({ status: 'failed', failureReason: 'tests_failed' }));
    expect(stage.tone).toBe('red');
  });

  it('still renders an exhausted run as amber', () => {
    const stage = deriveStage(makeRow({ status: 'exhausted', failureReason: 'exhausted' }));
    expect(stage.tone).toBe('amber');
  });
});

describe('skipLabel', () => {
  it('falls back to a bare "Skipped" for an unknown reason', () => {
    expect(skipLabel('something_else')).toBe('Skipped');
    expect(skipLabel(null)).toBe('Skipped');
  });
});
