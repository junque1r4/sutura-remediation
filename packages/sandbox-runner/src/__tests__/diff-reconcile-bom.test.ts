import { describe, it, expect } from 'vitest';
import { reconcileLeadingBom } from '../diff-normalize';

const BOM = '﻿';

describe('reconcileLeadingBom', () => {
  it('re-adds a dropped BOM to the first removed line so the hunk matches the file', () => {
    // The on-disk file starts with a UTF-8 BOM; the model dropped it in the diff.
    const corrupt = [
      '--- a/Engine.cs',
      '+++ b/Engine.cs',
      '@@ -1,3 +1,3 @@',
      '-using System;',
      ' using System.Text;',
      ' namespace ExampleApp;',
      '+using System.Security.Cryptography;',
      '',
    ].join('\n');

    const out = reconcileLeadingBom(corrupt, (path) =>
      path === 'Engine.cs' ? `${BOM}using System;` : null,
    );

    // The first removed line now carries the BOM so `git apply` context matches.
    expect(out).toContain(`-${BOM}using System;`);
    // Untouched body lines are preserved.
    expect(out).toContain(' using System.Text;');
  });

  it('mirrors the BOM onto the replacement + line when line 1 is replaced (PR keeps the BOM)', () => {
    // Line 1 is replaced: removed `-using System;` immediately followed by an added line.
    const corrupt = [
      '--- a/Engine.cs',
      '+++ b/Engine.cs',
      '@@ -1,2 +1,2 @@',
      '-using System;',
      '+using System.Security.Cryptography;',
      ' namespace ExampleApp;',
      '',
    ].join('\n');

    const out = reconcileLeadingBom(corrupt, () => `${BOM}using System;`);

    expect(out).toContain(`-${BOM}using System;`);
    // The new first line must also carry the BOM, because the PR is built from the
    // post-patch file content -- otherwise the patched file would silently lose its BOM.
    expect(out).toContain(`+${BOM}using System.Security.Cryptography;`);
  });

  it('re-adds the BOM to a context line when the first hunk line is unchanged context', () => {
    const corrupt = [
      '--- a/Engine.cs',
      '+++ b/Engine.cs',
      '@@ -1,3 +1,4 @@',
      ' using System;',
      ' using System.Text;',
      '+using System.Security.Cryptography;',
      ' namespace ExampleApp;',
      '',
    ].join('\n');

    const out = reconcileLeadingBom(corrupt, () => `${BOM}using System;`);

    expect(out).toContain(` ${BOM}using System;`);
    // A pure-context first line is never duplicated onto an added line.
    expect(out).toContain('+using System.Security.Cryptography;');
    expect(out).not.toContain(`+${BOM}`);
  });

  it('is a no-op when the on-disk first line has no BOM', () => {
    const clean = [
      '--- a/Engine.cs',
      '+++ b/Engine.cs',
      '@@ -1,2 +1,2 @@',
      '-using System;',
      '+using System.Security.Cryptography;',
      ' namespace ExampleApp;',
      '',
    ].join('\n');

    expect(reconcileLeadingBom(clean, () => 'using System;')).toBe(clean);
  });

  it('is a no-op when the diff already carries the BOM', () => {
    const already = [
      '--- a/Engine.cs',
      '+++ b/Engine.cs',
      '@@ -1,2 +1,2 @@',
      `-${BOM}using System;`,
      `+${BOM}using System.Security.Cryptography;`,
      ' namespace ExampleApp;',
      '',
    ].join('\n');

    expect(reconcileLeadingBom(already, () => `${BOM}using System;`)).toBe(already);
  });

  it('only touches hunks that start at line 1, not later hunks', () => {
    const corrupt = [
      '--- a/Engine.cs',
      '+++ b/Engine.cs',
      '@@ -40,2 +40,3 @@',
      '-using System;',
      '+using System.Security.Cryptography;',
      ' namespace ExampleApp;',
      '',
    ].join('\n');

    // Even if lookup reports a BOM, a hunk that does not touch line 1 is left alone.
    expect(reconcileLeadingBom(corrupt, () => `${BOM}using System;`)).toBe(corrupt);
  });

  it('handles a missing lookup (null) gracefully as a no-op', () => {
    const diff = [
      '--- a/Engine.cs',
      '+++ b/Engine.cs',
      '@@ -1,2 +1,2 @@',
      '-using System;',
      '+using System.Security.Cryptography;',
      ' namespace ExampleApp;',
      '',
    ].join('\n');

    expect(reconcileLeadingBom(diff, () => null)).toBe(diff);
  });
});
