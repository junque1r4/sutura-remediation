import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The SUTURA_VALIDATED_FIX_DISABLED kill switch must stop the validated-fix
 * worker from doing any work: when engaged it records an audit entry and
 * returns the kill_switch result, short-circuiting before any finding lookup,
 * credential mint, LLM call, or sandbox run. We test the extracted
 * killSwitchShortCircuit helper so the safety branch is locked without standing
 * up a Redis-backed Worker.
 */
// vi.hoisted so the spy exists before the hoisted vi.mock + the static import
// of validation-worker (which loads db/audit-log) run.
const logAction = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../db/audit-log', () => ({ logAction }));

import { killSwitchShortCircuit } from '../validation-worker';

const ORIGINAL = process.env.SUTURA_VALIDATED_FIX_DISABLED;

beforeEach(() => {
  logAction.mockClear();
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SUTURA_VALIDATED_FIX_DISABLED;
  else process.env.SUTURA_VALIDATED_FIX_DISABLED = ORIGINAL;
});

describe('killSwitchShortCircuit', () => {
  it('returns null and logs nothing when the switch is OFF', async () => {
    delete process.env.SUTURA_VALIDATED_FIX_DISABLED;
    const res = await killSwitchShortCircuit('org-1', 'finding-1');
    expect(res).toBeNull();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('short-circuits with kill_switch and writes an audit entry when ON', async () => {
    process.env.SUTURA_VALIDATED_FIX_DISABLED = '1';
    const res = await killSwitchShortCircuit('org-9', 'finding-42');
    expect(res).toEqual({ ok: false, reason: 'kill_switch' });
    expect(logAction).toHaveBeenCalledTimes(1);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: 'org-9',
        actor: 'validation-worker',
        action: 'validated_fix.killed',
        resource_type: 'finding',
        resource_id: 'finding-42',
        metadata_json: { reason: 'kill_switch' },
      }),
    );
  });

  it('treats any value other than "1" as OFF', async () => {
    process.env.SUTURA_VALIDATED_FIX_DISABLED = 'true';
    expect(await killSwitchShortCircuit('org-1', 'finding-1')).toBeNull();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('still short-circuits even if the audit write fails (never throws)', async () => {
    process.env.SUTURA_VALIDATED_FIX_DISABLED = '1';
    logAction.mockRejectedValueOnce(new Error('db down'));
    const res = await killSwitchShortCircuit('org-1', 'finding-1');
    expect(res).toEqual({ ok: false, reason: 'kill_switch' });
  });
});
