import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/organizations', () => ({
  getOrganization: vi.fn(),
  updateSettings: vi.fn(),
  updateCustomPrompts: vi.fn(),
}));

import { organizationsRouter } from '../organizations';
import { getOrganization, updateSettings, updateCustomPrompts } from '../../db/organizations';

function makeReq(overrides: any = {}): any {
  return {
    query: {},
    params: {},
    body: {},
    orgId: 'org-1',
    actor: 'user@test.com',
    headers: {},
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeNext(): any {
  return vi.fn();
}

function getHandler(router: any, method: string, path: string): Function {
  const layer = router.stack.find((l: any) => {
    if (!l.route) return false;
    return l.route.path === path && l.route.methods[method];
  });
  if (!layer) throw new Error(`No ${method} ${path} handler found`);
  return layer.route.stack[0].handle;
}

const mockDbOrg = {
  id: 'org-1',
  name: 'Test Org',
  plan: 'pro',
  settings_json: { autoFixSeverityThreshold: 'high' },
  custom_prompts_json: { systemPrompt: 'Be helpful' },
  created_at: '2024-01-01T00:00:00Z',
};

const expectedApiOrg = {
  id: 'org-1',
  name: 'Test Org',
  plan: 'pro',
  settings: { autoFixSeverityThreshold: 'high' },
  customPrompts: { systemPrompt: 'Be helpful' },
  createdAt: '2024-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /', () => {
  it('returns org with mapped fields', async () => {
    vi.mocked(getOrganization).mockResolvedValue(mockDbOrg);

    const handler = getHandler(organizationsRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(getOrganization).toHaveBeenCalledWith('org-1');
    expect(res.json).toHaveBeenCalledWith(expectedApiOrg);
    expect(next).not.toHaveBeenCalled();
  });

  it('maps settings_json to settings, custom_prompts_json to customPrompts, created_at to createdAt', async () => {
    vi.mocked(getOrganization).mockResolvedValue(mockDbOrg);

    const handler = getHandler(organizationsRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    const callArg = res.json.mock.calls[0][0];
    expect(callArg.settings).toEqual(mockDbOrg.settings_json);
    expect(callArg.customPrompts).toEqual(mockDbOrg.custom_prompts_json);
    expect(callArg.createdAt).toEqual(mockDbOrg.created_at);
    // Should not have raw snake_case fields
    expect(callArg.settings_json).toBeUndefined();
    expect(callArg.custom_prompts_json).toBeUndefined();
    expect(callArg.created_at).toBeUndefined();
  });

  it('returns 404 when org not found', async () => {
    vi.mocked(getOrganization).mockResolvedValue(null);

    const handler = getHandler(organizationsRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Organization not found' });
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(getOrganization).mockRejectedValue(err);

    const handler = getHandler(organizationsRouter, 'get', '/');
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('PATCH /settings', () => {
  it('calls updateSettings and returns mapped org', async () => {
    const newSettings = { autoFixSeverityThreshold: 'critical' };
    const updatedOrg = { ...mockDbOrg, settings_json: newSettings };
    vi.mocked(updateSettings).mockResolvedValue(updatedOrg);

    const handler = getHandler(organizationsRouter, 'patch', '/settings');
    const req = makeReq({ body: newSettings });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(updateSettings).toHaveBeenCalledWith('org-1', newSettings);
    expect(res.json).toHaveBeenCalledWith({
      ...expectedApiOrg,
      settings: newSettings,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(updateSettings).mockRejectedValue(err);

    const handler = getHandler(organizationsRouter, 'patch', '/settings');
    const req = makeReq({ body: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('PATCH /prompts', () => {
  it('calls updateCustomPrompts and returns mapped org', async () => {
    const newPrompts = { systemPrompt: 'New prompt' };
    const updatedOrg = { ...mockDbOrg, custom_prompts_json: newPrompts };
    vi.mocked(updateCustomPrompts).mockResolvedValue(updatedOrg);

    const handler = getHandler(organizationsRouter, 'patch', '/prompts');
    const req = makeReq({ body: newPrompts });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(updateCustomPrompts).toHaveBeenCalledWith('org-1', newPrompts);
    expect(res.json).toHaveBeenCalledWith({
      ...expectedApiOrg,
      customPrompts: newPrompts,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next(err) on error', async () => {
    const err = new Error('DB error');
    vi.mocked(updateCustomPrompts).mockRejectedValue(err);

    const handler = getHandler(organizationsRouter, 'patch', '/prompts');
    const req = makeReq({ body: {} });
    const res = makeRes();
    const next = makeNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
