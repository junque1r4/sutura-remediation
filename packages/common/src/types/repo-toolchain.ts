/** Serializable per-repo sandbox toolchain, derived from a developer-authored
 *  prompt. The function-valued DetectedToolchain.testCmd cannot cross process
 *  or JSON boundaries, hence this flat shape. */
export interface SerializedToolchain {
  language: string;
  /** Must be one of SANDBOX_IMAGE_ALLOWLIST. */
  image: string;
  /** Networked package-resolution command -- the ONLY step granted egress.
   *  May be [] (e.g. a baked toolchain with no deps to restore). */
  restoreCmd: string[];
  /** Offline build+test command. Runs with --network=none. Never empty. */
  testCmd: string[];
  /** Absolute dirs holding the resolved package cache. Snapshotted into the
   *  per-repo read-only cache volume and mounted read-only during build+test.
   *  Defaults to []. */
  cachePaths: string[];
  /** True only for dependency/SCA fixes whose patch edits the manifest, so the
   *  restore must see the patched tree. Default false: code fixes restore the
   *  clean tree, which fully air-gaps the untrusted build+test phase. */
  restoreNeedsPatch: boolean;
  /** Append generated test file paths as extra argv entries. */
  appendTestPaths: boolean;
  testFramework: string;
  testFilePattern: string;
}

export type RepoToolchainStatus = 'supported' | 'custom_ready' | 'needs_prompt' | 'error';

export interface RepoPromptStatus {
  repo: string;
  kind: 'test_environment';
  hasPrompt: boolean;
  /** Server-generated at write time; the only fragment the UI ever sees. */
  preview: string;
  promptLength: number;
  updatedAt: string | null;
}

export interface RepoToolchainCheckResult {
  repo: string;
  status: RepoToolchainStatus;
  language: string | null;
  testFramework: string | null;
  detail: string | null;
  checkedAt: string;
}

export const SANDBOX_IMAGE_ALLOWLIST = [
  'sutura/sandbox-base:latest',
  'sutura/sandbox-node:latest',
  'sutura/sandbox-python:latest',
  'sutura/sandbox-go:latest',
  'sutura/sandbox-ruby:latest',
  'sutura/sandbox-java:latest',
  'sutura/sandbox-dotnet:latest',
] as const;

export const REPO_PROMPT_MAX_LENGTH = 16_384;

const MAX_STR = 512;
const MAX_ARGV = 32;

function assertArgv(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a string array`);
  if (!allowEmpty && value.length === 0) throw new Error(`${field} must not be empty`);
  if (value.length > MAX_ARGV) throw new Error(`${field} exceeds max length`);
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error(`${field} must contain only strings`);
    if (entry.length > 4096) throw new Error(`${field} entry exceeds max length`);
  }
  return value as string[];
}

function assertStr(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_STR) throw new Error(`${field} exceeds max length`);
  return value;
}

/** Validate cachePaths: an argv-bounded array of absolute path strings. */
function assertPaths(value: unknown, field: string): string[] {
  const argv = assertArgv(value, field, true);
  for (const p of argv) {
    if (!p.startsWith('/')) throw new Error(`${field} entries must be absolute paths, got: ${p}`);
  }
  return argv;
}

/** Validate untrusted JSON (LLM output or decrypted DB blob) into a
 *  SerializedToolchain. Throws with a field-specific message on any mismatch. */
export function validateSerializedToolchain(value: unknown): SerializedToolchain {
  if (typeof value !== 'object' || value === null) throw new Error('toolchain must be an object');
  const v = value as Record<string, unknown>;
  const image = assertStr(v.image, 'image');
  if (!(SANDBOX_IMAGE_ALLOWLIST as readonly string[]).includes(image)) {
    throw new Error(`image must be one of the sutura sandbox images, got: ${image}`);
  }
  if (typeof v.appendTestPaths !== 'boolean') throw new Error('appendTestPaths must be a boolean');

  // Back-compat: the field was renamed installCmd -> restoreCmd. Accept either
  // on input (restoreCmd wins) and normalize to restoreCmd on output. The error
  // message names whichever key the caller actually supplied.
  const restoreKey = v.restoreCmd !== undefined ? 'restoreCmd' : 'installCmd';
  const restoreRaw = v.restoreCmd !== undefined ? v.restoreCmd : (v.installCmd ?? []);
  const restoreNeedsPatch = v.restoreNeedsPatch ?? false;
  if (typeof restoreNeedsPatch !== 'boolean') {
    throw new Error('restoreNeedsPatch must be a boolean');
  }

  return {
    language: assertStr(v.language, 'language'),
    image,
    restoreCmd: assertArgv(restoreRaw, restoreKey, true),
    testCmd: assertArgv(v.testCmd, 'testCmd', false),
    cachePaths: v.cachePaths !== undefined ? assertPaths(v.cachePaths, 'cachePaths') : [],
    restoreNeedsPatch,
    appendTestPaths: v.appendTestPaths,
    testFramework: assertStr(v.testFramework, 'testFramework'),
    testFilePattern: assertStr(v.testFilePattern, 'testFilePattern'),
  };
}
