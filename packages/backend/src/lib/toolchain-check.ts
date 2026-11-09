import { detectToolchainFromManifests, MANIFEST_FILES } from '@sutura/sandbox-runner';
import type { SerializedToolchain, RepoToolchainStatus } from '@sutura/common';

export interface ToolchainEvaluation {
  status: RepoToolchainStatus;
  language: string | null;
  testFramework: string | null;
  detail: string | null;
  derivedConfig: SerializedToolchain | null;
}

/** Pure decision core -- DI'd inputs so it unit-tests without GitHub/Anthropic. */
export async function evaluateToolchain(input: {
  manifests: Record<string, string | null>;
  rootListing: string[];
  developerPrompt: string | null;
  derive: (developerPrompt: string, rootListing: string[], manifests: Record<string, string | null>) => Promise<SerializedToolchain>;
}): Promise<ToolchainEvaluation> {
  const detected = detectToolchainFromManifests(input.manifests);
  const hasRealTests = detected.language !== 'unknown' && detected.testFramework !== 'none';
  if (hasRealTests) {
    return { status: 'supported', language: detected.language, testFramework: detected.testFramework, detail: null, derivedConfig: null };
  }
  const hint = buildHint(input.rootListing, detected.language);
  if (!input.developerPrompt) {
    return { status: 'needs_prompt', language: detected.language === 'unknown' ? null : detected.language, testFramework: null, detail: hint, derivedConfig: null };
  }
  try {
    const config = await input.derive(input.developerPrompt, input.rootListing, input.manifests);
    return { status: 'custom_ready', language: config.language, testFramework: config.testFramework, detail: null, derivedConfig: config };
  } catch (err) {
    return { status: 'error', language: null, testFramework: null, detail: `derivation failed: ${err instanceof Error ? err.message : String(err)}`, derivedConfig: null };
  }
}

function buildHint(rootListing: string[], language: string): string {
  const markers = rootListing.filter((f) => /\.(sln|csproj|fsproj)$|^(Cargo\.toml|composer\.json|mix\.exs|CMakeLists\.txt)$/i.test(f));
  if (markers.length > 0) return `No supported test toolchain detected. Found: ${markers.slice(0, 5).join(', ')}. Teach Claude how to set up this environment.`;
  if (language !== 'unknown') return `Detected ${language} but no test runner. Teach Claude how to run this repo's tests.`;
  return 'No supported test toolchain detected. Teach Claude how to set up this environment.';
}

/** GitHub-backed wrapper used by the route: fetches root tree + manifests with
 *  the org's installation token, then delegates to evaluateToolchain. */
export async function fetchRepoContext(repo: string, githubToken: string): Promise<{
  manifests: Record<string, string | null>; rootListing: string[];
}> {
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD`, { headers: { ...headers, Accept: 'application/vnd.github+json' } });
  if (!treeRes.ok) throw new Error(`GitHub tree fetch failed: ${treeRes.status}`);
  const tree = (await treeRes.json()) as { tree?: Array<{ path: string }> };
  const rootListing = (tree.tree ?? []).map((e) => e.path);

  const manifests: Record<string, string | null> = {};
  await Promise.all(MANIFEST_FILES.map(async (file) => {
    if (!rootListing.includes(file)) { manifests[file] = null; return; }
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${file}`, { headers });
    manifests[file] = res.ok ? await res.text() : null;
  }));
  return { manifests, rootListing };
}
