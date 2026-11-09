/**
 * Recompute the line counts in unified-diff hunk headers.
 *
 * LLM-generated diffs frequently carry wrong `@@ -a,b +c,d @@` counts. We used
 * to lean on `git apply --recount`, but recount does not stop at the declared
 * hunk end: in a multi-file patch it scans into the next file's `--- a/...`
 * header, absorbs it as a deletion line, and the patch stops applying even
 * when every hunk is otherwise perfect (observed live 2026-06-11, three
 * patch_reject attempts in a row). `patch -p1` is strict about counts, so the
 * fallback rejected the same diffs as malformed.
 *
 * Fixing the counts here is deterministic and lets both appliers run without
 * count-tolerance flags. Only the numbers in hunk headers are rewritten;
 * every other byte of the diff passes through untouched, and headers whose
 * counts are already accurate (including the omitted-count `@@ -a +c @@`
 * shorthand) are left as-is.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A `--- a/...` line followed by `+++ b/...` marks the next file section. */
function isFileBoundary(lines: string[], i: number): boolean {
  return lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
}

function isHunkBoundary(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    HUNK_HEADER.test(line) ||
    line.startsWith('diff ') ||
    line.startsWith('Index: ') ||
    isFileBoundary(lines, i)
  );
}

/**
 * Strip the `read_file` line-number annotation that LLMs sometimes copy into a
 * unified diff's body lines, which is a recurring cause of patch_reject.
 *
 * The fix agent reads file content via the `read_file` tool, which presents it
 * as `<n>\t<text>` (and the model occasionally renders the prefix as `<n>$\t`).
 * The model then echoes that prefix into the diff's REMOVED / CONTEXT lines:
 *
 *   -1$\tusing System;      (should be)   -using System;
 *
 * so the line no longer matches the file and `git apply` rejects the whole
 * patch ("corrupt patch" / context mismatch). This strips a leading
 * `<digits>$?\t` from removed (`-`) and context (` `) body lines only. It never
 * touches:
 *   - added (`+`) lines, which the agent authors fresh (and which a real diff
 *     may legitimately add starting with digits+tab),
 *   - structural lines (`@@`, `---`, `+++`, `diff`) -- no header has a digit
 *     immediately after its leading `-`/space, so the regex can't match them.
 *
 * Intended as a REPAIR pass invoked only when normal application already
 * failed, and re-validated by re-applying: a well-formed diff is never altered
 * in the apply path, and a mis-strip simply leaves the (already failing) apply
 * failing -- it can never turn a passing apply into a failing one.
 */
const READFILE_LINENO_PREFIX = /^([- ])\d+\$?\t/;
export function stripReadFileLineNumbers(diff: string): string {
  const lines = diff.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip structural lines defensively (the regex already excludes them, but
    // this keeps intent explicit and guards odd inputs).
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (READFILE_LINENO_PREFIX.test(line)) {
      lines[i] = line.replace(READFILE_LINENO_PREFIX, '$1');
      changed = true;
    }
  }
  return changed ? lines.join('\n') : diff;
}

/**
 * Re-add a dropped UTF-8 BOM to a unified diff's first-line body so the hunk
 * matches the on-disk file again.
 *
 * Source files (notably .NET .cs) frequently begin with a UTF-8 BOM (U+FEFF,
 * `0xEF 0xBB 0xBF`). The fix agent reads the file, the BOM is an invisible byte
 * at the start of line 1, and the model silently omits it when it reproduces
 * that line in the diff -- so `git apply` / `patch` see a context mismatch on
 * line 1 and reject the whole patch (observed live: job-24 attempt-1
 * patch_reject). The BOM is not whitespace, so `--ignore-whitespace` does not
 * help.
 *
 * This is a REPAIR pass, invoked only after normal application already failed,
 * given a `firstLineOf(path)` lookup that returns the file's actual first line
 * from the workspace (BOM included). For each file section whose FIRST hunk
 * starts at line 1:
 *   - The first old-side body line (`-` removed or ` ` context) is reconciled
 *     to the on-disk line: only when the on-disk line minus its BOM exactly
 *     equals the diff line's content do we prepend the BOM -- so we never
 *     corrupt a line that mismatches for some other reason.
 *   - When line 1 is *replaced* (the first old-side line is a removed `-` line
 *     and the new side also starts at line 1), the BOM is mirrored onto the
 *     first added (`+`) line. The PR is built from the post-patch file content,
 *     so without this the patched file would silently lose its BOM.
 *
 * No-op when the lookup reports no BOM, when the diff already carries it, or
 * when the first hunk does not touch line 1. Like the other passes, a mis-apply
 * can only leave an already-failing patch failing -- it can never turn a
 * passing apply into a failing one.
 */
const BOM = '﻿';
const RECONCILE_HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function diffPathFromHeader(line: string): string | null {
  // `+++ b/path/to/file.cs` (optionally followed by a tab + timestamp).
  const m = /^\+\+\+ (.+)$/.exec(line);
  if (!m) return null;
  const raw = m[1].split('\t')[0].trim();
  if (raw === '/dev/null' || raw === '') return null;
  return raw.replace(/^b\//, '');
}

export function reconcileLeadingBom(
  diff: string,
  firstLineOf: (path: string) => string | null,
): string {
  const lines = diff.split('\n');
  let changed = false;
  let currentPath: string | null = null;
  let firstHunkHandled = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('--- ')) {
      // Start of a new file section; the path comes from the following `+++`.
      currentPath = null;
      firstHunkHandled = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      currentPath = diffPathFromHeader(line);
      continue;
    }

    const hh = RECONCILE_HUNK_HEADER.exec(line);
    if (!hh) continue;
    if (firstHunkHandled || !currentPath) continue;
    firstHunkHandled = true;

    const oldStart = parseInt(hh[1], 10);
    const newStart = parseInt(hh[2], 10);
    if (oldStart !== 1) continue;

    const onDisk = firstLineOf(currentPath);
    if (!onDisk || !onDisk.startsWith(BOM)) continue;
    const onDiskNoBom = onDisk.slice(BOM.length);

    // Reconcile the first old-side line (removed or context) against the file.
    let oldLine1Removed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j];
      if (RECONCILE_HUNK_HEADER.test(body) || body.startsWith('--- ')) break;
      const marker = body[0];
      if (marker !== '-' && marker !== ' ') continue;
      const content = body.slice(1);
      if (content === onDiskNoBom) {
        lines[j] = `${marker}${BOM}${content}`;
        changed = true;
      }
      oldLine1Removed = marker === '-';
      break;
    }

    // When line 1 is replaced, mirror the BOM onto the new first line so the
    // post-patch file (which becomes the PR) keeps its BOM.
    if (oldLine1Removed && newStart === 1) {
      for (let j = i + 1; j < lines.length; j++) {
        const body = lines[j];
        if (RECONCILE_HUNK_HEADER.test(body) || body.startsWith('--- ')) break;
        if (!body.startsWith('+')) continue;
        const content = body.slice(1);
        if (!content.startsWith(BOM)) {
          lines[j] = `+${BOM}${content}`;
          changed = true;
        }
        break;
      }
    }
  }

  return changed ? lines.join('\n') : diff;
}

export function recountUnifiedDiff(diff: string): string {
  const lines = diff.split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const m = HUNK_HEADER.exec(lines[i]);
    if (!m) continue;

    const [, oldStart, oldDecl, newStart, newDecl, trailer] = m;

    // Count the hunk body. An entirely empty line inside a hunk is a context
    // line whose leading space was stripped (common in LLM output); a trailing
    // empty line from the diff's final newline is excluded by the boundary
    // scan ending the body at the next header or end of input.
    let oldCount = 0;
    let newCount = 0;
    let end = i + 1;
    while (end < lines.length && !isHunkBoundary(lines, end)) {
      const line = lines[end];
      if (line.startsWith('\\')) {
        // "\ No newline at end of file" -- annotates the previous line.
      } else if (line.startsWith('-')) {
        oldCount++;
      } else if (line.startsWith('+')) {
        newCount++;
      } else {
        // ' ' context, or '' stripped-empty context.
        oldCount++;
        newCount++;
      }
      end++;
    }
    // The patch file's own final newline shows up as one empty element after
    // split('\n'); it is not a hunk line, so drop exactly one trailing blank
    // when the hunk runs to end of input.
    if (end === lines.length && end - 1 > i && lines[end - 1] === '') {
      oldCount--;
      newCount--;
    }

    const declaredOld = oldDecl === undefined ? 1 : parseInt(oldDecl, 10);
    const declaredNew = newDecl === undefined ? 1 : parseInt(newDecl, 10);
    if (declaredOld !== oldCount || declaredNew !== newCount) {
      lines[i] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${trailer}`;
      changed = true;
    }
    i = end - 1;
  }

  return changed ? lines.join('\n') : diff;
}
