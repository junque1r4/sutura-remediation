import { describe, expect, it } from 'vitest';
import { prependPriorAnalysis } from '../pipeline/validated/orchestrator';

const BASE_PROMPT = '# System role\n\n## Vulnerability Details\n...';

describe('prependPriorAnalysis', () => {
  it('returns the base prompt unchanged when no analysis is supplied', () => {
    expect(prependPriorAnalysis(BASE_PROMPT, undefined)).toBe(BASE_PROMPT);
    expect(prependPriorAnalysis(BASE_PROMPT, '')).toBe(BASE_PROMPT);
    expect(prependPriorAnalysis(BASE_PROMPT, '   \n\t')).toBe(BASE_PROMPT);
  });

  it('prepends a "## Prior Analysis" section above the base prompt', () => {
    const analysis = [
      '### Risk Assessment',
      'high impact xss',
      '',
      '### Recommended Fix',
      'bump dompurify to 3.4.1',
    ].join('\n');
    const out = prependPriorAnalysis(BASE_PROMPT, analysis);
    expect(out.startsWith('## Prior Analysis')).toBe(true);
    expect(out).toContain('### Recommended Fix');
    expect(out).toContain('bump dompurify to 3.4.1');
    expect(out).toContain(BASE_PROMPT);
    // The base prompt must appear AFTER the analysis section.
    expect(out.indexOf('## Vulnerability Details')).toBeGreaterThan(
      out.indexOf('## Prior Analysis'),
    );
  });

  it('keeps the tail when the analysis exceeds the byte cap', () => {
    const tail = '### Recommended Fix\nbump dompurify to 3.4.1';
    const padding = 'x'.repeat(20_000);
    const huge = `${padding}\n${tail}`;
    const out = prependPriorAnalysis(BASE_PROMPT, huge);
    expect(out).toContain(tail);
    // The leading padding should have been dropped.
    expect(out).not.toContain('x'.repeat(15_000));
    // Total output should be bounded (analysis cap + base prompt + section header).
    expect(out.length).toBeLessThan(13_000 + BASE_PROMPT.length);
  });
});
