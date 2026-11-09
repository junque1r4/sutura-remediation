import type { DetectedToolchain, Language } from './types';

const NODE_IMAGE = 'sutura/sandbox-node:latest';
const PYTHON_IMAGE = 'sutura/sandbox-python:latest';
const GO_IMAGE = 'sutura/sandbox-go:latest';
const RUBY_IMAGE = 'sutura/sandbox-ruby:latest';
const JAVA_IMAGE = 'sutura/sandbox-java:latest';
const BASE_IMAGE = 'sutura/sandbox-base:latest';

/** Root-level manifest files that drive toolchain (and thus image) detection.
 *  Single source of truth -- the docker runner and the backend's repo check
 *  both fetch exactly this set before calling detectToolchainFromManifests. */
export const MANIFEST_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
] as const;

interface NodePkg {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/**
 * Decide language + how to install + how to run tests purely from manifests.
 * Manifests is a map of well-known filenames to their contents (or null if
 * absent) -- DockerSandboxRunner.detectToolchain shells out cat for each.
 */
/** Manifest detectors predate the restore/cache split, so they build the older
 *  shape; normalizeDetected fills the newer fields. */
type RawToolchain = Omit<DetectedToolchain, 'restoreCmd' | 'cachePaths' | 'restoreNeedsPatch'>;

/** Fill the restore/cache fields for a manifest-detected toolchain: its install
 *  command is its restore command, it declares no cache dir (built-in images
 *  already bundle the SDK; per-repo caching is opt-in via a developer prompt),
 *  and it restores the clean tree (code fixes don't change manifests here). */
function normalizeDetected(raw: RawToolchain): DetectedToolchain {
  return { ...raw, restoreCmd: raw.installCmd, cachePaths: [], restoreNeedsPatch: false };
}

export function detectToolchainFromManifests(
  manifests: Record<string, string | null>,
): DetectedToolchain {
  return normalizeDetected(detectRawFromManifests(manifests));
}

function detectRawFromManifests(manifests: Record<string, string | null>): RawToolchain {
  if (manifests['package.json']) {
    return detectNode(manifests);
  }
  if (manifests['pyproject.toml'] || manifests['requirements.txt']) {
    return detectPython(manifests);
  }
  if (manifests['go.mod']) {
    return detectGo();
  }
  if (manifests['Gemfile']) {
    return detectRuby();
  }
  if (manifests['pom.xml'] || manifests['build.gradle']) {
    return detectJava(manifests);
  }
  return {
    language: 'unknown' as Language,
    image: BASE_IMAGE,
    installCmd: [],
    // Empty so runTests reports an honest "(skipped: no tests for detected
    // toolchain)" instead of a fake green `$ true` exit 0.
    testCmd: () => [],
    testFramework: 'none',
    testFilePattern: '__sutura__/{base}.test',
  };
}

// ---------------- per-language ----------------

function detectNode(manifests: Record<string, string | null>): RawToolchain {
  let pkg: NodePkg = {};
  try {
    pkg = JSON.parse(manifests['package.json'] ?? '{}') as NodePkg;
  } catch {
    pkg = {};
  }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  // Lockfile-first install with a non-frozen fallback. Strict (`npm ci`,
  // `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`) is
  // preferred for reproducibility, but Sutura's fix diffs frequently bump
  // a single dependency in `package.json` without regenerating the entire
  // lockfile -- which strict-mode rejects (`npm ci` errors with EUSAGE
  // "lock file's foo@X does not satisfy foo@Y"). The non-strict variant
  // reconciles the lockfile to the new package.json so the install
  // proceeds and the test/scan stages can verify the fix.
  const installCmd = manifests['pnpm-lock.yaml']
    ? ['sh', '-lc', 'pnpm install --frozen-lockfile || pnpm install']
    : manifests['yarn.lock']
      ? ['sh', '-lc', 'yarn install --frozen-lockfile || yarn install']
      : manifests['package-lock.json']
        ? ['sh', '-lc', 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund']
        : ['sh', '-lc', 'npm install --no-audit --no-fund'];

  // Default to "no tests" so projects without a runner skip the test step
  // entirely (the runner returns exit 0 with a "no tests" stdout when the
  // command array is empty). This matters for SCA fixes -- many real-world
  // package.json files lack a `test` script, and we don't want to fail an
  // otherwise-valid version bump just because `npm test` errors with
  // "Missing script: test". The scan step is still authoritative.
  let framework = 'none';
  let testCmd: (paths: string[]) => string[] = () => [];
  let pattern = '__tests__/{base}.sutura.test.ts';

  if ('vitest' in allDeps) {
    framework = 'vitest';
    testCmd = (paths) =>
      paths.length > 0 ? ['npx', 'vitest', 'run', ...paths] : ['npx', 'vitest', 'run'];
    pattern = '__tests__/{base}.sutura.test.ts';
  } else if ('jest' in allDeps) {
    framework = 'jest';
    testCmd = (paths) =>
      paths.length > 0 ? ['npx', 'jest', ...paths, '--ci'] : ['npx', 'jest', '--ci'];
    pattern = '__tests__/{base}.sutura.test.js';
  } else if ('mocha' in allDeps) {
    framework = 'mocha';
    testCmd = (paths) =>
      paths.length > 0 ? ['npx', 'mocha', ...paths] : ['npx', 'mocha'];
    pattern = 'test/{base}.sutura.test.js';
  } else if (pkg.scripts?.test) {
    framework = 'npm-test';
    testCmd = () => ['npm', 'test'];
  }

  return {
    language: 'node',
    image: NODE_IMAGE,
    installCmd,
    testCmd,
    testFramework: framework,
    testFilePattern: pattern,
  };
}

function detectPython(manifests: Record<string, string | null>): RawToolchain {
  // Debian's system Python (sandbox-base) is marked externally-managed (PEP
  // 668), so a bare `pip install` aborts with "externally-managed-environment".
  // The sandbox container is ephemeral and single-purpose, so installing into
  // system site-packages is fine -- `--break-system-packages` is the supported
  // opt-out.
  const installCmd = manifests['pyproject.toml']
    ? [
        'sh',
        '-lc',
        'pip install --break-system-packages -e .[test] || pip install --break-system-packages -e . || true',
      ]
    : ['pip', 'install', '--break-system-packages', '-r', 'requirements.txt'];

  return {
    language: 'python',
    image: PYTHON_IMAGE,
    installCmd,
    testCmd: (paths) => (paths.length > 0 ? ['pytest', '-q', ...paths] : ['pytest', '-q']),
    testFramework: 'pytest',
    testFilePattern: 'tests/test_{base}_sutura.py',
  };
}

function detectGo(): RawToolchain {
  return {
    language: 'go',
    image: GO_IMAGE,
    installCmd: ['go', 'mod', 'download'],
    testCmd: (paths) => (paths.length > 0 ? ['go', 'test', ...paths] : ['go', 'test', './...']),
    testFramework: 'go test',
    testFilePattern: '{dir}/{base}_sutura_test.go',
  };
}

function detectRuby(): RawToolchain {
  return {
    language: 'ruby',
    image: RUBY_IMAGE,
    installCmd: ['bundle', 'install'],
    testCmd: (paths) =>
      paths.length > 0 ? ['bundle', 'exec', 'rspec', ...paths] : ['bundle', 'exec', 'rspec'],
    testFramework: 'rspec',
    testFilePattern: 'spec/{base}_sutura_spec.rb',
  };
}

function detectJava(manifests: Record<string, string | null>): RawToolchain {
  const isMaven = manifests['pom.xml'] != null;
  return {
    language: 'java',
    image: JAVA_IMAGE,
    installCmd: isMaven ? ['mvn', '-q', 'dependency:resolve'] : ['gradle', 'dependencies', '-q'],
    testCmd: () => (isMaven ? ['mvn', '-q', 'test'] : ['gradle', 'test', '-q']),
    testFramework: isMaven ? 'maven-surefire' : 'gradle',
    testFilePattern: 'src/test/java/{pkg}/{base}SuturaTest.java',
  };
}
