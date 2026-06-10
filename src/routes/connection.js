import { Router } from 'express';
import * as wix from '../auth/wix.js';
import { ping as hubspotPing } from '../auth/hubspot.js';
import { requireApiKey, siteId } from './guard.js';

export const connectionRouter = Router();

// In the current Wix model there is no install-redirect/callback — a site is
// connected by registering its instanceId (auto via the App Instance Installed
// webhook, or manually here), after which tokens are minted on demand.

/** Manually register a Wix instanceId (testing / fallback). */
connectionRouter.post('/wix/instance', requireApiKey, async (req, res) => {
  const { instanceId } = req.body || {};
  if (!instanceId) return res.status(400).json({ error: 'instanceId required' });
  const result = await wix.registerInstance(instanceId, siteId(req));
  res.json({ ok: true, ...result });
});

connectionRouter.get('/status', requireApiKey, async (req, res) => {
  const status = await wix.getStatus(siteId(req));
  let hubspotOk = false;
  try { hubspotOk = (await hubspotPing()).ok; } catch { hubspotOk = false; }
  res.json({ ...status, hubspotReachable: hubspotOk });
});

connectionRouter.post('/wix/disconnect', requireApiKey, async (req, res) => {
  await wix.disconnect(siteId(req));
  res.json({ ok: true });
});
