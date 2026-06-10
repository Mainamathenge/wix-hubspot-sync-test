import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLog } from './store/db.js';
import { ping } from './auth/hubspot.js';
import { mappingsRouter } from './routes/mappings.js';
import { connectionRouter } from './routes/connection.js';
import { hubspotWebhookRouter } from './routes/webhooksHubspot.js';
import { wixWebhookRouter } from './routes/webhooksWix.js';
import { requireApiKey, siteId } from './routes/guard.js';
import { syncFromWix, syncFromHubspot } from './sync/engine.js';
import { getContact } from './auth/hubspot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Capture raw body for webhook signature verification.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Health & connectivity
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/health/hubspot', async (_req, res) => {
  try { res.json(await ping()); }
  catch (err) { res.status(502).json({ ok: false, error: err.response?.status || err.message }); }
});

// Routes
app.use('/auth', connectionRouter);            // Wix OAuth + status/disconnect
app.use('/api/mappings', mappingsRouter);      // Field-mapping CRUD (API-key guarded)
app.use('/webhooks/hubspot', hubspotWebhookRouter); // Inbound HubSpot → Wix
app.use('/webhooks/wix', wixWebhookRouter);    // Inbound Wix → HubSpot + form capture

// ─── Manual sync trigger (guarded) — for testing without live webhooks
app.post('/api/sync/from-wix', requireApiKey, async (req, res) => {
  try {
    const { wixContactId, flatWix, updatedAt } = req.body;
    const result = await syncFromWix({ siteId: siteId(req), wixContactId, flatWix, updatedAt });
    res.json(result);
  } catch (err) { res.status(502).json({ error: err.response?.data || err.message }); }
});
app.post('/api/sync/from-hubspot', requireApiKey, async (req, res) => {
  try {
    const { hubspotContactId } = req.body;
    const full = await getContact(hubspotContactId, ['email', 'firstname', 'lastname', 'phone', 'company']);
    const result = await syncFromHubspot({
      siteId: siteId(req), hubspotContactId,
      hubProps: full.properties || {}, updatedAt: full.properties?.lastmodifieddate,
    });
    res.json(result);
  } catch (err) { res.status(502).json({ error: err.response?.data || err.message }); }
});

// ─── Dashboard (React build) ──────────────────────────────
const dashboardDist = path.join(__dirname, 'dashboard', 'dist');
app.use('/dashboard', express.static(dashboardDist));
app.get('/dashboard/*', (_req, res) => res.sendFile(path.join(dashboardDist, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => safeLog(`Server listening on :${PORT} (public: ${process.env.PUBLIC_URL || 'not set'})`));
