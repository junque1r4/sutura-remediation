import { describe, it, expect } from 'vitest';
import { mergeBackendFields } from '../findings-utils';
import type { Finding } from '../../types';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'aikido-123',
    orgId: '',
    scannerSource: 'aikido',
    externalId: '123',
    title: 'Example finding',
    description: 'Example finding',
    severity: 'high',
    cvssScore: 7.5,
    epssScore: null,
    cweId: null,
    cveId: null,
    filePath: null,
    lineRange: null,
    repo: 'acme/app',
    status: 'open',
    ingestedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    packageName: null,
    currentVersion: null,
    fixedVersion: null,
    rawPayload: null,
    ...overrides,
  };
}

describe('mergeBackendFields', () => {
  it('enriches a finding whose scanner + externalId matches a backend row', () => {
    const aikido = [makeFinding()];
    const backend = [
      makeFinding({
        id: 'backend-uuid', // backend keys by UUID, not the dashboard id
        verificationVerdict: { reachable: true } as Finding['verificationVerdict'],
        reachable: true,
        exploitability: 'critical',
        verifiedAt: '2026-02-02T00:00:00.000Z',
        signature: 'sig-abc',
        duplicateOf: null,
      }),
    ];

    const [merged] = mergeBackendFields(aikido, backend);

    // Backend-only fields are layered on...
    expect(merged.reachable).toBe(true);
    expect(merged.exploitability).toBe('critical');
    expect(merged.verifiedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(merged.signature).toBe('sig-abc');
    expect(merged.verificationVerdict).toEqual({ reachable: true });
    // ...while the live Aikido identity/id is preserved.
    expect(merged.id).toBe('aikido-123');
    expect(merged.title).toBe('Example finding');
  });

  it('leaves a finding unchanged when no backend row matches', () => {
    const aikido = [makeFinding({ id: 'aikido-999', externalId: '999' })];
    const backend = [
      makeFinding({ externalId: '123', reachable: true, signature: 'sig-abc' }),
    ];

    const [merged] = mergeBackendFields(aikido, backend);

    expect(merged.reachable).toBeUndefined();
    expect(merged.signature).toBeUndefined();
    expect(merged).toEqual(aikido[0]);
  });

  it('is a no-op when the backend array is empty', () => {
    const aikido = [makeFinding()];
    const result = mergeBackendFields(aikido, []);

    expect(result).toBe(aikido); // same reference, untouched
    expect(result[0]).toEqual(aikido[0]);
  });

  it('matches on scanner + externalId, not on differing scanner sources', () => {
    const aikido = [makeFinding({ scannerSource: 'aikido', externalId: '123' })];
    const backend = [
      makeFinding({ scannerSource: 'snyk', externalId: '123', reachable: true }),
    ];

    const [merged] = mergeBackendFields(aikido, backend);

    expect(merged.reachable).toBeUndefined();
  });
});
