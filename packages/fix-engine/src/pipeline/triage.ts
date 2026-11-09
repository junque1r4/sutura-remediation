import type { NormalizedFinding, Severity } from '@sutura/common';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface TriageResult {
  finding: NormalizedFinding;
  shouldFix: boolean;
  reason?: string;
}

export function triage(
  finding: NormalizedFinding,
  autoFixThreshold: Severity = 'medium',
): TriageResult {
  const findingLevel = SEVERITY_ORDER[finding.severity];
  const thresholdLevel = SEVERITY_ORDER[autoFixThreshold];

  if (findingLevel < thresholdLevel) {
    return {
      finding,
      shouldFix: false,
      reason: `Severity ${finding.severity} is below auto-fix threshold ${autoFixThreshold}`,
    };
  }

  return { finding, shouldFix: true };
}
