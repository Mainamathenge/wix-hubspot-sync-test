import { Router } from 'express';
import { verifyWebhookSignature, getContact } from '../auth/hubspot.js';
import { syncFromHubspot } from '../sync/engine.js';
import { managedHubspotKeys } from '../sync/mapper.js';
import { prisma, safeLog } from '../store/db.js';

export const hubspotWebhookRouter = Router();

const DEFAULT_SITE = process.env.DEFAULT_SITE_ID || 'default-site';

/**
 * HubSpot subscription events: contact.creation, contact.propertyChange.
 * Body is an array of event objects, each with an objectId (contact id).
 */
hubspotWebhookRouter.post('/', async (req, res) => {
  // Signature verification (skippable in local dev via WEBHOOK_DEV_BYPASS=1).
  const ok = process.env.WEBHOOK_DEV_BYPASS === '1' || verifyWebhookSignature({
    method: 'POST',
    uri: `${process.env.PUBLIC_URL}/webhooks/hubspot`,
    rawBody: req.rawBody?.toString('utf8') || '',
    signature: req.get('x-hubspot-signature-v3'),
    timestamp: req.get('x-hubspot-request-timestamp'),
  });
  if (!ok) return res.status(401).json({ error: 'bad signature' });

  // Ack fast; process async so HubSpot doesn't retry on slow syncs.
  res.json({ received: true });

  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const ev of events) {
    const hubspotContactId = String(ev.objectId ?? ev.object_id ?? '');
    if (!hubspotContactId) continue;
    try {
      const mappings = await prisma.fieldMapping.findMany({ where: { siteId: DEFAULT_SITE } });
      const props = managedHubspotKeys(mappings);
      const full = await getContact(hubspotContactId, props);
      await syncFromHubspot({
        siteId: DEFAULT_SITE,
        hubspotContactId,
        hubProps: full.properties || {},
        updatedAt: full.properties?.lastmodifieddate,
      });
    } catch (err) {
      safeLog(`[webhook hubspot] failed for contact ${hubspotContactId}:`, err.response?.data || err.message);
    }
  }
});
