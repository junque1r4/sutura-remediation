import { describe, it, expect } from 'vitest';
import { stripReadFileLineNumbers } from '../diff-normalize';

describe('stripReadFileLineNumbers', () => {
  it('strips read_file line-number prefixes from removed lines (the patch_reject artifact)', () => {
    // The fix agent saw `read_file` output (`<n>\t<text>`, sometimes `<n>$\t`)
    // and echoed those prefixes into the diff's removed lines.
    const corrupt = [
      '--- a/Engine.cs',
      '+++ b/Engine.cs',
      '@@ -1,3 +1,3 @@',
      '-1$\tusing System;',
      '-2$\tusing System.Security;',
      '-3$\tusing System.Text;',
      '+using System;',
      '+using System.Security.Cryptography;',
      '+using System.Text;',
      '',
    ].join('\n');

    const out = stripReadFileLineNumbers(corrupt);
    expect(out).toContain('-using System;');
    expect(out).toContain('-using System.Security;');
    expect(out).not.toContain('-1$');
    expect(out).not.toContain('$\t');
    // Added lines are untouched.
    expect(out).toContain('+using System.Security.Cryptography;');
  });

  it('strips the plain `<n>\\t` form (no $) on removed and context lines', () => {
    const corrupt = ['@@ -1,2 +1,2 @@', '-10\told value', ' 11\tcontext', '+new value', ''].join('\n');
    const out = stripReadFileLineNumbers(corrupt);
    expect(out).toContain('-old value');
    expect(out).toContain(' context');
    expect(out).toContain('+new value');
  });

  it('never touches added lines or structural headers', () => {
    // A legitimately-added line that begins with digits+tab must survive intact.
    const diff = ['--- a/data.tsv', '+++ b/data.tsv', '@@ -1 +1,2 @@', ' 1\tkeep', '+2\tadded row', ''].join('\n');
    const out = stripReadFileLineNumbers(diff);
    expect(out).toContain('+2\tadded row'); // added line preserved verbatim
    expect(out).toContain('--- a/data.tsv');
    expect(out).toContain('+++ b/data.tsv');
  });

  it('is a no-op for a clean diff', () => {
    const clean = ['--- a/f.cs', '+++ b/f.cs', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
    expect(stripReadFileLineNumbers(clean)).toBe(clean);
  });
});
