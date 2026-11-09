import type { SandboxRunner, WorkspaceHandle } from '@sutura/sandbox-runner';

const ROOT_PATH = '/work';

/**
 * Project manifests that mark a buildable sub-unit. Used to scope restore +
 * build/test to just the project containing a finding, instead of restoring an
 * entire multi-project solution. The dominant motivation is .NET (`dotnet
 * restore` with no arg restores every project in the .sln, dragging in
 * unrelated heavyweight graphs -- desktop/graphics projects with huge native
 * packages and slow private feeds -- which blows the install timeout). The set
 * generalizes to other multi-project ecosystems (Java/Gradle, Go, Rust, Node
 * workspaces).
 */
const PROJECT_MANIFEST_GLOBS = [
  '*.csproj',
  '*.fsproj',
  '*.vbproj',
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'Cargo.toml',
];

// Walk up from the finding's file to the nearest directory that holds a project
// manifest. Prints that dir (relative to /work) or nothing. Stops before the
// repo root: a manifest only at the root means a single-project repo, where
// scoping is a no-op and we want to preserve the legacy whole-tree behavior.
const WALK_SCRIPT = `
f="$1"
d=$(dirname "$f")
while [ "$d" != "." ] && [ "$d" != "/" ] && [ -n "$d" ]; do
  for pat in ${PROJECT_MANIFEST_GLOBS.join(' ')}; do
    for m in "$d"/$pat; do
      [ -e "$m" ] && { printf '%s\\n' "$d"; exit 0; }
    done
  done
  d=$(dirname "$d")
done
`;

/**
 * True when a non-zero test run means "the project compiled but exposes no
 * runnable tests" (e.g. a scoped library with no test framework, often surfaced
 * via `dotnet test ... RunConfiguration.TreatNoTestsAsError=true`), as opposed
 * to a genuine compile or test failure. A real build failure (`Build FAILED`,
 * `error CS...`) is never treated as "no tests": those must still fail hard.
 * Used only when a scope is active, so unscoped single-project repos keep their
 * strict test gate.
 */
const NO_TESTS_MARKERS = [
  'no test is available',
  'no tests were found',
  'no test matches',
  'no tests to run',
  'no test to run',
  'treatnotestsaserror',
];
export function looksLikeNoTestsToRun(output: string): boolean {
  const o = output.toLowerCase();
  if (o.includes('build failed') || /error\s+cs\d/.test(o)) return false;
  return NO_TESTS_MARKERS.some((m) => o.includes(m));
}

/**
 * Resolve the workspace-absolute directory of the project that encloses the
 * finding's file, or null when there is no enclosing SUB-project (file at the
 * repo root, single-project repo, or no filePath). A non-null result is passed
 * as the `cwd` for restore + build/test so they operate on just that project.
 *
 * Safe by construction: returns null for single-project layouts, so those repos
 * keep their exact current behavior (whole-tree restore from /work).
 */
export async function resolveProjectScope(
  runner: SandboxRunner,
  ws: WorkspaceHandle,
  filePath: string | undefined,
): Promise<string | null> {
  if (!filePath) return null;
  // Normalize: strip a leading ./ and any leading slash so the path is relative
  // to /work for the in-container walk.
  const rel = filePath.replace(/^\.?\//, '');
  if (!rel || rel.startsWith('..')) return null;
  try {
    const res = await runner.exec(ws, ['sh', '-c', WALK_SCRIPT, 'scope', rel], 10_000, {
      cwd: ROOT_PATH,
      isolateNetwork: true,
    });
    const dir = res.stdout.trim().split('\n').filter(Boolean).pop();
    if (!dir || dir === '.' || dir === '/' || dir.startsWith('..')) return null;
    return `${ROOT_PATH}/${dir.replace(/^\.?\//, '')}`;
  } catch {
    // Best-effort: on any failure, decline to scope and let the caller fall back
    // to the legacy whole-tree restore.
    return null;
  }
}
