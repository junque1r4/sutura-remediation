import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { OrganizationSettings, CustomPrompts } from '@sutura/common';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getOrganization, updateSettings, updateCustomPrompts } from '../db/organizations';

export const organizationsRouter = Router();

// GET / -- get current org (use req.orgId)
organizationsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const org = await getOrganization(authReq.orgId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }
    res.json({
      id: org.id,
      name: org.name,
      plan: org.plan,
      settings: org.settings_json,
      customPrompts: org.custom_prompts_json,
      createdAt: org.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /settings -- update settings ({ settings: {...} } in body)
organizationsRouter.patch('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    // The dashboard sends `{ settings: {...} }` so we extract the inner object;
    // saving the wrapped body verbatim caused settings to nest one level deeper
    // on every update (settings.settings.settings.integrations...).
    const incoming = (req.body?.settings ?? req.body) as OrganizationSettings;
    const org = await updateSettings(authReq.orgId, incoming);
    res.json({
      id: org.id,
      name: org.name,
      plan: org.plan,
      settings: org.settings_json,
      customPrompts: org.custom_prompts_json,
      createdAt: org.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /prompts -- update custom prompts
organizationsRouter.patch('/prompts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const org = await updateCustomPrompts(authReq.orgId, req.body as CustomPrompts);
    res.json({
      id: org.id,
      name: org.name,
      plan: org.plan,
      settings: org.settings_json,
      customPrompts: org.custom_prompts_json,
      createdAt: org.created_at,
    });
  } catch (err) {
    next(err);
  }
});
