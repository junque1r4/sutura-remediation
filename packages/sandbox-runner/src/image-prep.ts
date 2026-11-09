import Docker from 'dockerode';
import { getDockerConnectionOptions, type DockerConnectionOptions } from './sandbox-config';

const REQUIRED_IMAGES = [
  'sutura/sandbox-base:latest',
  'sutura/sandbox-node:latest',
  'sutura/sandbox-python:latest',
];

// Only images a Dockerfile actually ships for. go/ruby are deliberately NOT
// listed: no Dockerfile.go / Dockerfile.ruby exists yet, so warning about them
// at boot is unactionable noise -- toolchain-detect still prefers those tags
// and docker-runner falls back to sandbox-base when they are absent. Re-add
// them here when their Dockerfiles land.
const OPTIONAL_IMAGES = ['sutura/sandbox-java:latest'];

export interface ImagePrepResult {
  present: string[];
  missingRequired: string[];
  missingOptional: string[];
}

/**
 * Check whether the sandbox images exist locally. We do NOT pull them here --
 * these are built locally from packages/sandbox-runner/Dockerfile.* . The worker
 * calls this once at startup and logs a warning rather than crashing if optional
 * images are missing; missing required images cause the validated-fix worker to
 * fail-fast on its first job.
 */
export async function ensureSandboxImagesPulled(
  connection: DockerConnectionOptions = getDockerConnectionOptions(),
): Promise<ImagePrepResult> {
  const docker = new Docker(connection);
  const images = await docker.listImages();
  const tags = new Set<string>();
  for (const img of images) {
    for (const t of img.RepoTags ?? []) tags.add(t);
  }

  const present: string[] = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  for (const name of REQUIRED_IMAGES) {
    (tags.has(name) ? present : missingRequired).push(name);
  }
  for (const name of OPTIONAL_IMAGES) {
    (tags.has(name) ? present : missingOptional).push(name);
  }
  return { present, missingRequired, missingOptional };
}
