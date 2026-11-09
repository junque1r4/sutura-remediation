import type { NormalizedFinding, SerializedToolchain } from '@sutura/common';

export interface WorkspaceHandle {
  /** Unique workspace id (also the dockerode container id once created). */
  id: string;
  /** Image used for the long-lived workspace container. */
  image: string;
  /** Path inside the container where the repo lives (always /work). */
  rootPath: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Shell-formatted command that produced this result. Surfaced to the
   *  dashboard so the timeline header reads "npm install" instead of just
   *  "Install". For "no-op" branches (skipped install/tests) holds a
   *  human-readable placeholder. */
  command: string;
}

export type Language = 'node' | 'python' | 'go' | 'java' | 'ruby' | 'unknown';

export interface DetectedToolchain {
  language: Language;
  /** Docker image tag to use for the workspace container (extends sutura/sandbox-base). */
  image: string;
  /** Networked package-resolution command, e.g. ['npm','ci']. The ONLY step
   *  granted egress. Empty if nothing to restore. */
  restoreCmd: string[];
  /** @deprecated alias of restoreCmd kept for in-flight callers. */
  installCmd: string[];
  /** Build the (offline) test command for a list of test paths. */
  testCmd: (paths: string[]) => string[];
  /** Absolute dirs holding the resolved package cache (snapshotted to / mounted
   *  from the per-repo read-only cache volume). Empty for manifest-detected
   *  toolchains until they declare one. */
  cachePaths: string[];
  /** True only for dependency/SCA fixes whose patch edits the manifest. */
  restoreNeedsPatch: boolean;
  /** Identifier for the test framework, used in API responses. */
  testFramework: string;
  /** Convention for new test file paths, e.g. '__tests__/{base}.sutura.test.ts'. */
  testFilePattern: string;
}

export interface FileWrite {
  path: string;
  content: string;
}

export interface ApplyPatchResult {
  ok: boolean;
  /** Combined stdout+stderr from `git apply`; populated on failure. */
  rejects?: string;
  /** Which applier ran: 'git apply' (preferred) or 'patch -p1' (fallback). */
  command: string;
}

export interface CreateWorkspaceOpts {
  /** Developer-taught toolchain for repos the manifest detector can't handle.
   *  Pre-validated upstream (validateSerializedToolchain); pins the workspace
   *  image and replaces manifest detection for this workspace only. */
  toolchainOverride?: SerializedToolchain;
  /** Name of a per-repo dependency cache volume to mount at /cache. The prewarm
   *  job populates it once (cacheReadOnly false); every fix attempt mounts it
   *  read-only (cacheReadOnly true) so untrusted patch code can neither poison
   *  the cache nor re-pay the restore. Toolchains point package-manager caches
   *  under /cache (e.g. NUGET_PACKAGES=/cache/nuget). */
  cacheVolume?: string;
  /** Mount the cache volume read-only. Always true for attempts; false only for
   *  the prewarm job that builds the cache. Ignored without cacheVolume. */
  cacheReadOnly?: boolean;
}

export interface SandboxRunner {
  /** Materialize a workspace from a tarball of the repo at the target ref. */
  createWorkspace(repoTarball: Buffer, opts?: CreateWorkspaceOpts): Promise<WorkspaceHandle>;
  /** Inspect the workspace to figure out language and how to run tests. */
  detectToolchain(ws: WorkspaceHandle): Promise<DetectedToolchain>;
  /** Apply a unified diff via `git apply` inside the container. */
  applyPatch(ws: WorkspaceHandle, unifiedDiff: string): Promise<ApplyPatchResult>;
  /** Write arbitrary files (used by the agent to author tests). */
  writeFiles(ws: WorkspaceHandle, files: FileWrite[]): Promise<void>;
  /** Read a file out of the workspace post-patch. */
  readFile(ws: WorkspaceHandle, path: string): Promise<string>;
  /** Dependency-resolution phase. Grants network egress (package manager only)
   *  unless opts.offline is set -- then it runs --network=none, resolving from a
   *  prewarmed read-only cache so the attempt stays air-gapped. */
  restore(
    ws: WorkspaceHandle,
    timeoutMs?: number,
    opts?: { offline?: boolean; cwd?: string },
  ): Promise<RunResult>;
  /** @deprecated alias of restore(). */
  install(ws: WorkspaceHandle, timeoutMs?: number): Promise<RunResult>;
  /** Run build+tests with --network=none. opts.cwd scopes the run to a
   *  subproject directory (e.g. just the project containing the finding). */
  runTests(
    ws: WorkspaceHandle,
    paths: string[],
    timeoutMs?: number,
    opts?: { cwd?: string },
  ): Promise<RunResult>;
  /** Commit the current /work tree as a git snapshot. Taken once after the
   *  clean restore so a remediation round can revert source edits without
   *  re-extracting the tarball or re-resolving dependencies. */
  snapshotTree(ws: WorkspaceHandle): Promise<void>;
  /** Revert /work to the last snapshotTree() commit: discards the round's patch
   *  and any stray files, leaving a clean source tree (build/dependency caches
   *  committed in the snapshot survive). Throws if no snapshot exists. */
  resetTree(ws: WorkspaceHandle): Promise<void>;
  /** Throw if /work exceeds the configured disk ceiling (no-op when unset). */
  assertDiskUnderCeiling(ws: WorkspaceHandle): Promise<void>;
  /** Manifest fingerprint a cache volume was built from, or null if absent/stale. */
  getCacheVolumeManifest(name: string): Promise<string | null>;
  /** Drop and recreate a cache volume empty, stamped with the new fingerprint. */
  recreateCacheVolume(name: string, manifestFingerprint: string): Promise<void>;
  /** Generic exec; caller chooses network mode via the wrapper. */
  exec(ws: WorkspaceHandle, cmd: string[], timeoutMs?: number, opts?: ExecOpts): Promise<RunResult>;
  /** Tear down the workspace container and any anonymous volumes. */
  cleanup(ws: WorkspaceHandle): Promise<void>;
}

export interface ExecOpts {
  /** If true, run with --network=none. */
  isolateNetwork?: boolean;
  /** Working dir inside the container; defaults to /work. */
  cwd?: string;
  /** Extra env vars. */
  env?: Record<string, string>;
  /**
   * Bytes to feed to the command's stdin (then EOF). Used to pipe a tar archive
   * into `tar -x` so files can be uploaded into a ReadonlyRootfs container --
   * dockerode's putArchive is rejected by the daemon on read-only rootfs even
   * when the destination is a writable tmpfs mount.
   */
  input?: Buffer;
}

export type ScanVerdict = 'resolved' | 'still_vulnerable' | 'inconclusive';

export interface ScanResult {
  verdict: ScanVerdict;
  /** Scanner identifier used (e.g. 'aikido-local', 'npm-audit', 'osv-scanner', 'semgrep'). */
  tool: string;
  /** Raw output (capped). */
  output: string;
  /** Identifiers (CVE / rule IDs) that are still present after the patch. */
  matched: string[];
  /** Whether the scan invocation itself timed out. */
  timedOut: boolean;
  /** Shell-formatted command that produced this result. */
  command: string;
}

export interface ScanOptions {
  /**
   * Aikido API key (`client_id:client_secret`). When provided, runSecurityScan
   * will try the Aikido local CLI first and fall back to OSS scanners only if
   * the CLI is unavailable or returns inconclusive.
   */
  aikidoApiKey?: string;
}

/** Re-exported for convenience -- scanners take a finding to pick the right tool. */
export type { NormalizedFinding };
