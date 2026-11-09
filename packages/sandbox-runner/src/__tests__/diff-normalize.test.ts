import { describe, it, expect } from 'vitest';
import { recountUnifiedDiff } from '../diff-normalize';

/**
 * Regression for the 2026-06-11 patch_reject exhaustion: the LLM emitted a
 * two-file diff whose hunk headers under-counted the added lines. `git apply
 * --recount` does not stop at the declared hunk end, so it swallowed the next
 * file's `--- a/...` header as a deletion line and the patch never applied;
 * `patch -p1` is strict about counts and called the diff malformed. We now
 * recompute the counts ourselves before staging the patch.
 */

const WRONG_COUNTS = [
  '--- a/src/one.cs',
  '+++ b/src/one.cs',
  '@@ -10,3 +10,2 @@ class One',
  ' context1',
  '-removed1',
  '+added1',
  '+added2',
  ' context2',
  '--- a/src/two.cs',
  '+++ b/src/two.cs',
  '@@ -5,2 +5,9 @@',
  ' ctx',
  '+only addition',
  '',
].join('\n');

const FIXED_COUNTS = [
  '--- a/src/one.cs',
  '+++ b/src/one.cs',
  '@@ -10,3 +10,4 @@ class One',
  ' context1',
  '-removed1',
  '+added1',
  '+added2',
  ' context2',
  '--- a/src/two.cs',
  '+++ b/src/two.cs',
  '@@ -5,1 +5,2 @@',
  ' ctx',
  '+only addition',
  '',
].join('\n');

describe('recountUnifiedDiff', () => {
  it('recomputes wrong hunk counts across multiple bare ---/+++ file sections', () => {
    expect(recountUnifiedDiff(WRONG_COUNTS)).toBe(FIXED_COUNTS);
  });

  it('returns an already-correct diff byte-for-byte unchanged', () => {
    expect(recountUnifiedDiff(FIXED_COUNTS)).toBe(FIXED_COUNTS);
  });

  it('keeps omitted-count headers (count 1 implied) when they are accurate', () => {
    const diff = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    expect(recountUnifiedDiff(diff)).toBe(diff);
  });

  it('treats a completely empty body line as shared context', () => {
    const diff = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,9 @@',
      ' line1',
      '',
      '',
    ].join('\n');
    const out = recountUnifiedDiff(diff);
    expect(out).toContain('@@ -1,2 +1,2 @@');
  });

  it('does not count "\\ No newline at end of file" markers', () => {
    const diff = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,9 +1,9 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const out = recountUnifiedDiff(diff);
    expect(out).toContain('@@ -1,1 +1,1 @@');
    expect(out).toContain('\\ No newline at end of file');
  });

  it('handles diff --git style headers between hunks', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 111..222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,5 @@',
      '-old',
      '+new',
      'diff --git a/b.txt b/b.txt',
      'index 333..444 100644',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -2,9 +2,1 @@',
      ' ctx',
      '+added',
      '',
    ].join('\n');
    const out = recountUnifiedDiff(diff);
    expect(out).toContain('@@ -1,1 +1,1 @@');
    expect(out).toContain('@@ -2,1 +2,2 @@');
    expect(out).toContain('index 111..222 100644');
  });

  it('fixes the second hunk of the same file too', () => {
    const diff = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      ' ctx',
      '+added',
      '@@ -10,5 +11,5 @@',
      ' ctx2',
      '-gone',
      '',
    ].join('\n');
    const out = recountUnifiedDiff(diff);
    expect(out).toContain('@@ -1,1 +1,2 @@');
    expect(out).toContain('@@ -10,2 +11,1 @@');
  });
});
