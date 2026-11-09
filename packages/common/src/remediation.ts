export type RemediationClass = 'code' | 'advisory';

export interface ContainerRemediation {
  image: string;
  packageName?: string;
  fromVersion?: string;
  toVersion?: string;
  attackSurface?: string;
}

/**
 * Classify how a finding should be remediated.
 *
 * Container-image findings (e.g. Aikido docker_container vulns) have no source
 * file to patch and must be routed away from the code-fix agent. Findings tied
 * to a code repository flow to the agent as usual.
 */
export function classifyRemediationClass(input: {
  repo?: string | null;
  rawPayload?: Record<string, unknown> | null;
}): RemediationClass {
  const rp = input.rawPayload ?? {};

  if (typeof rp.code_repo_name === 'string' && rp.code_repo_name.length > 0) {
    return 'code';
  }

  if (
    (typeof rp.container_repo_name === 'string' && rp.container_repo_name.length > 0) ||
    rp.attack_surface === 'docker_container'
  ) {
    return 'advisory';
  }

  const repo = input.repo;
  if (typeof repo === 'string' && repo.length > 0 && repo.toLowerCase() !== 'unknown') {
    return 'code';
  }

  return 'advisory';
}

/**
 * Extract container-image remediation details from a raw scanner payload.
 * Returns null unless a non-empty container_repo_name is present.
 */
export function getContainerRemediation(
  rawPayload: Record<string, unknown> | null | undefined,
): ContainerRemediation | null {
  const rp = rawPayload ?? {};

  const image = rp.container_repo_name;
  if (typeof image !== 'string' || image.length === 0) {
    return null;
  }

  const result: ContainerRemediation = { image };

  if (typeof rp.affected_package === 'string' && rp.affected_package.length > 0) {
    result.packageName = rp.affected_package;
  }
  if (typeof rp.installed_version === 'string' && rp.installed_version.length > 0) {
    result.fromVersion = rp.installed_version;
  }
  if (Array.isArray(rp.patched_versions) && typeof rp.patched_versions[0] === 'string') {
    result.toVersion = rp.patched_versions[0];
  }
  if (typeof rp.attack_surface === 'string' && rp.attack_surface.length > 0) {
    result.attackSurface = rp.attack_surface;
  }

  return result;
}
