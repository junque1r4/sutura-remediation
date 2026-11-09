import { describe, it, expect } from 'vitest';
import { assemblePrompt, buildSystemPrompt, buildRetryFeedback } from '../pipeline/prompt';
import type { FixContext } from '../pipeline/context';
import type { NormalizedFinding } from '@sutura/common';

function makeFinding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    externalId: 'cve-2024-1234',
    scanner: 'snyk',
    title: 'SQL Injection in user query',
    description: 'User input is directly interpolated into SQL queries without sanitization.',
    severity: 'critical',
    cveId: 'CVE-2024-1234',
    cweId: 'CWE-89',
    filePath: 'src/db/user.ts',
    lineRange: [42, 58],
    packageName: 'pg',
    currentVersion: '8.7.0',
    fixedVersion: '8.11.0',
    repo: 'owner/myapp',
    rawPayload: {},
    ...overrides,
  };
}

function makeFullContext(): FixContext {
  return {
    finding: makeFinding(),
    orgId: 'org-abc',
    customPrompts: {
      environmentSetup: 'Use Node 20, run `npm install`',
      testingInstructions: 'Run `npm test` and ensure all tests pass',
      codeConventions: 'Use TypeScript strict mode',
      dependencyRules: 'Do not upgrade major versions without approval',
      businessContext: 'This is a financial app; data integrity is critical',
    },
    relevantCode: [
      '// File: src/db/user.ts\nfunction getUser(id: string) { return db.query(`SELECT * FROM users WHERE id = ${id}`); }',
      '// File: src/db/index.ts\nexport { db } from "./client";',
    ],
    vulnerableFileContent:
      'import { db } from "./index";\n\nexport function getUser(id: string) {\n  return db.query(`SELECT * FROM users WHERE id = ${id}`);\n}',
  };
}

describe('assemblePrompt', () => {
  describe('with all fields', () => {
    it('includes the system role', () => {
      const prompt = assemblePrompt(makeFullContext());
      expect(prompt).toContain('security engineer');
      expect(prompt).toContain('vulnerability');
    });

    it('includes vulnerability details', () => {
      const prompt = assemblePrompt(makeFullContext());
      expect(prompt).toContain('SQL Injection in user query');
      expect(prompt).toContain('CRITICAL');
      expect(prompt).toContain('User input is directly interpolated');
      expect(prompt).toContain('CVE-2024-1234');
      expect(prompt).toContain('CWE-89');
      expect(prompt).toContain('src/db/user.ts');
      expect(prompt).toContain('42-58');
      expect(prompt).toContain('pg');
      expect(prompt).toContain('8.7.0');
      expect(prompt).toContain('8.11.0');
    });

    it('includes vulnerable file content', () => {
      const prompt = assemblePrompt(makeFullContext());
      expect(prompt).toContain('Vulnerable File Content');
      expect(prompt).toContain('getUser');
    });

    it('includes relevant code context', () => {
      const prompt = assemblePrompt(makeFullContext());
      expect(prompt).toContain('Related Code Context');
      expect(prompt).toContain('src/db/user.ts');
    });

    it('includes all custom prompts', () => {
      const prompt = assemblePrompt(makeFullContext());
      expect(prompt).toContain('Environment Setup');
      expect(prompt).toContain('Use Node 20');
      expect(prompt).toContain('Testing Instructions');
      expect(prompt).toContain('npm test');
      expect(prompt).toContain('Code Conventions');
      expect(prompt).toContain('TypeScript strict mode');
      expect(prompt).toContain('Dependency Rules');
      expect(prompt).toContain('major versions');
      expect(prompt).toContain('Business Context');
      expect(prompt).toContain('financial app');
    });

    it('includes output format instructions with diff block example', () => {
      const prompt = assemblePrompt(makeFullContext());
      expect(prompt).toContain('Output Format');
      expect(prompt).toContain('```diff');
      expect(prompt).toContain('unified diff');
    });

    it('matches expected structure (snapshot-style)', () => {
      const prompt = assemblePrompt(makeFullContext());
      const sections = [
        'security engineer',
        '## Vulnerability Details',
        '## Vulnerable File Content',
        '## Related Code Context',
        '## Environment Setup',
        '## Testing Instructions',
        '## Code Conventions',
        '## Dependency Rules',
        '## Business Context',
        '## Output Format',
      ];
      for (const section of sections) {
        expect(prompt).toContain(section);
      }
    });
  });

  describe('buildSystemPrompt (agentic path)', () => {
    it('instructs the agent to grep for and patch duplicate instances', () => {
      const sys = buildSystemPrompt();
      expect(sys).toMatch(/duplicate/i);
      expect(sys).toContain('grep_code');
      expect(sys).toMatch(/every reachable instance/i);
      // Multi-file/multi-project diffs must be explicitly allowed.
      expect(sys).toMatch(/multi-file/i);
      expect(sys).toMatch(/projects/i);
    });
  });

  describe('buildRetryFeedback', () => {
    it('frames an adversarial defeat with the evidence and a duplicate-hunt directive', () => {
      const fb = buildRetryFeedback(2, {
        stage: 'adversarial_validation',
        output: 'ExampleEncryptionHelper.cs still uses MD5+3DES',
      });
      expect(fb).toMatch(/defeated your fix/i);
      expect(fb).toContain('ExampleEncryptionHelper.cs still uses MD5+3DES');
      expect(fb).toContain('grep_code');
      expect(fb).toMatch(/every/i);
    });

    it('frames a patch-apply failure as a context mismatch to correct', () => {
      const fb = buildRetryFeedback(2, { stage: 'patch', output: 'error: patch does not apply' });
      expect(fb).toMatch(/failed to apply/i);
      expect(fb).toContain('error: patch does not apply');
    });

    it('keeps the special CI framing', () => {
      const fb = buildRetryFeedback(2, { stage: 'ci', output: 'build broke' });
      expect(fb).toMatch(/GitHub Actions failed/i);
      expect(fb).toContain('build broke');
    });
  });

  describe('with minimal fields', () => {
    it('omits optional sections when not provided', () => {
      const ctx: FixContext = {
        finding: makeFinding({
          cveId: undefined,
          cweId: undefined,
          filePath: undefined,
          lineRange: undefined,
          packageName: undefined,
          currentVersion: undefined,
          fixedVersion: undefined,
        }),
        orgId: 'org-xyz',
        customPrompts: {},
        relevantCode: [],
        vulnerableFileContent: null,
      };

      const prompt = assemblePrompt(ctx);

      expect(prompt).toContain('SQL Injection in user query');
      expect(prompt).not.toContain('CVE');
      expect(prompt).not.toContain('CWE');
      expect(prompt).not.toContain('Vulnerable File Content');
      expect(prompt).not.toContain('Related Code Context');
      expect(prompt).not.toContain('Environment Setup');
      expect(prompt).not.toContain('Testing Instructions');
      // Output format should always be present
      expect(prompt).toContain('Output Format');
    });

    it('still includes core vulnerability info', () => {
      const ctx: FixContext = {
        finding: makeFinding({ cveId: undefined, filePath: undefined }),
        orgId: 'org-xyz',
        customPrompts: {},
        relevantCode: [],
        vulnerableFileContent: null,
      };

      const prompt = assemblePrompt(ctx);
      expect(prompt).toContain('SQL Injection in user query');
      expect(prompt).toContain('CRITICAL');
    });
  });
});
