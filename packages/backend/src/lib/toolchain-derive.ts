import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CLAUDE_MODEL, validateSerializedToolchain, SANDBOX_IMAGE_ALLOWLIST, type SerializedToolchain } from '@sutura/common';

const MODEL = DEFAULT_CLAUDE_MODEL;

const SET_TOOLCHAIN: Anthropic.Tool = {
  name: 'set_toolchain',
  description: 'Declare the sandbox toolchain configuration for this repository.',
  input_schema: {
    type: 'object',
    properties: {
      language: { type: 'string' },
      image: { type: 'string', enum: [...SANDBOX_IMAGE_ALLOWLIST] },
      restoreCmd: {
        type: 'array',
        items: { type: 'string' },
        description: 'Networked package-resolution command (the only step with egress). May be empty for a baked toolchain with no deps.',
      },
      testCmd: { type: 'array', items: { type: 'string' } },
      cachePaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute dirs UNDER /cache holding the resolved package cache (e.g. /cache/nuget, /cache/npm). /cache is a per-repo volume: read-write only while it is being warmed, read-only on every fix attempt. May be empty.',
      },
      restoreNeedsPatch: {
        type: 'boolean',
        description: 'True only for dependency/version-bump fixes whose patch edits the manifest. False for code fixes.',
      },
      appendTestPaths: { type: 'boolean' },
      testFramework: { type: 'string' },
      testFilePattern: { type: 'string' },
    },
    required: ['language', 'image', 'restoreCmd', 'testCmd', 'cachePaths', 'restoreNeedsPatch', 'appendTestPaths', 'testFramework', 'testFilePattern'],
  },
};

export async function deriveToolchainFromPrompt(input: {
  repo: string;
  developerPrompt: string;
  rootListing: string[];
  manifests: Record<string, string | null>;
  anthropicApiKey: string;
}): Promise<SerializedToolchain> {
  const client = new Anthropic({ apiKey: input.anthropicApiKey });
  const system = [
    'You translate developer-written test-environment instructions into a sandbox toolchain config.',
    'Constraints of the sandbox:',
    `- The container image must be one of: ${SANDBOX_IMAGE_ALLOWLIST.join(', ')} (Debian-based; sandbox-base has git, curl, python3; sandbox-node bakes Node; sandbox-dotnet bakes the .NET SDK -- ALWAYS prefer a baked image over downloading an SDK in restoreCmd).`,
    '- restoreCmd is the ONLY step with network egress. It resolves dependencies ONLY (e.g. dotnet restore, npm ci) into the package cache under /cache. Do NOT install a language SDK here if a baked image already has it. Point package managers at /cache via env (e.g. NUGET_PACKAGES=/cache/nuget; npm ci --cache /cache/npm). Keep it side-effect-free beyond populating /cache.',
    '- testCmd runs with NO network access. It must build and test fully offline, reading dependencies from the (read-only) /cache populated by restoreCmd (e.g. NUGET_PACKAGES=/cache/nuget dotnet test --no-restore, or an offline test runner). NEVER write to /cache from testCmd -- it is read-only during the test phase.',
    '- Keep testCmd output MINIMAL so the pass/fail summary survives log capture (output is truncated to a few hundred KB and used as retry feedback). Large monorepos emit thousands of build warnings that otherwise bury the result. Suppress build noise: e.g. dotnet test --verbosity quiet -clp:ErrorsOnly (the final "Passed!/Failed:" summary still prints); npm/vitest already default to terse reporters. Always scope the run to the generated tests (a name filter, e.g. dotnet --filter "FullyQualifiedName~Sutura") and fail when zero match (RunConfiguration.TreatNoTestsAsError=true) so a no-op never looks green.',
    '- cachePaths lists the absolute dirs UNDER /cache that restoreCmd populates, so they can be reused read-only across runs. /cache is a per-repo cache volume; /work is the per-attempt workspace. Caches that must survive across attempts go under /cache, not /work.',
    '- restoreNeedsPatch: set true ONLY for dependency/version-bump fixes whose patch edits the dependency manifest (so restore must run after the patch). For ordinary code fixes set false -- then restore runs on the clean tree and the patched build+test phase is fully air-gapped.',
    "- Commands are argv arrays exec'd directly (no host shell); use ['sh','-lc','...'] for shell features.",
    '- testFilePattern is the convention for NEW regression test files, with {base} as the source-file basename.',
    'Call set_toolchain exactly once.',
  ].join('\n');
  const user = [
    `Repository: ${input.repo}`,
    `Top-level files: ${input.rootListing.slice(0, 100).join(', ')}`,
    `Developer instructions:\n---\n${input.developerPrompt}\n---`,
  ].join('\n\n');

  const resp = await client.messages.create({
    model: MODEL, max_tokens: 1024, system,
    tools: [SET_TOOLCHAIN], tool_choice: { type: 'tool', name: 'set_toolchain' },
    messages: [{ role: 'user', content: user }],
  });
  const use = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!use) throw new Error('model did not return a toolchain');
  return validateSerializedToolchain(use.input);   // image allowlist enforced here regardless of model output
}
