import { describe, it, expect } from 'vitest';
import { classifyRemediationClass, getContainerRemediation } from '../src';

describe('classifyRemediationClass', () => {
  it('returns "code" when code_repo_name is present', () => {
    expect(
      classifyRemediationClass({
        repo: 'unknown',
        rawPayload: { code_repo_name: 'acme/backend' },
      }),
    ).toBe('code');
  });

  it('returns "advisory" for a docker_container finding with container_repo_name', () => {
    expect(
      classifyRemediationClass({
        repo: 'unknown',
        rawPayload: {
          container_repo_name: 'acme/api-image',
          attack_surface: 'docker_container',
        },
      }),
    ).toBe('advisory');
  });

  it('returns "advisory" when attack_surface is docker_container with no container_repo_name', () => {
    expect(
      classifyRemediationClass({
        repo: 'unknown',
        rawPayload: { attack_surface: 'docker_container' },
      }),
    ).toBe('advisory');
  });

  it('returns "code" for null/empty rawPayload with a real repo', () => {
    expect(classifyRemediationClass({ repo: 'acme/backend', rawPayload: null })).toBe('code');
    expect(classifyRemediationClass({ repo: 'acme/backend', rawPayload: {} })).toBe('code');
  });

  it('returns "advisory" for null rawPayload with repo "unknown"', () => {
    expect(classifyRemediationClass({ repo: 'unknown', rawPayload: null })).toBe('advisory');
    expect(classifyRemediationClass({ repo: 'UNKNOWN', rawPayload: null })).toBe('advisory');
    expect(classifyRemediationClass({ repo: null, rawPayload: null })).toBe('advisory');
  });
});

describe('getContainerRemediation', () => {
  it('returns image/package/from/to for a container payload', () => {
    expect(
      getContainerRemediation({
        container_repo_name: 'acme/api-image',
        affected_package: 'gnutls',
        installed_version: '3.7.1',
        patched_versions: ['3.7.9', '3.8.0'],
        attack_surface: 'docker_container',
      }),
    ).toEqual({
      image: 'acme/api-image',
      packageName: 'gnutls',
      fromVersion: '3.7.1',
      toVersion: '3.7.9',
      attackSurface: 'docker_container',
    });
  });

  it('omits undefined optional fields', () => {
    expect(getContainerRemediation({ container_repo_name: 'acme/api-image' })).toEqual({
      image: 'acme/api-image',
    });
  });

  it('returns null when container_repo_name is missing or empty', () => {
    expect(getContainerRemediation(null)).toBeNull();
    expect(getContainerRemediation(undefined)).toBeNull();
    expect(getContainerRemediation({})).toBeNull();
    expect(getContainerRemediation({ container_repo_name: '' })).toBeNull();
    expect(getContainerRemediation({ attack_surface: 'docker_container' })).toBeNull();
  });
});
