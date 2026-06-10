import { Router, text } from 'express';
import crypto from 'node:crypto';
import { syncFromWix } from '../sync/engine.js';
import { upsertByEmail, ensureProperty } from '../auth/hubspot.js';
import { registerInstance } from '../auth/wix.js';
import { getContact as getWixContact, normalize as normalizeWixContact } from '../auth/wixContacts.js';
import { prisma, safeLog } from '../store/db.js';

export const wixWebhookRouter = Router();

const DEFAULT_SITE = process.env.DEFAULT_SITE_ID || 'default-site';

// ─── App Instance Installed webhook → capture instanceId ─────────────────────
// Wix delivers webhooks as a signed JWT (text body). We decode the payload and
// pull out the instanceId so we can mint tokens for the site.
wixWebhookRouter.post('/app-installed', text({ type: '*/*' }), async (req, res) => {
  try {
    const jwtStr = (typeof req.body === 'string' ? req.body : req.rawBody?.toString('utf8') || '').trim();
    const claims = decodeJwtPayload(jwtStr);
    const instanceId = findKey(claims, 'instanceId');
    if (!instanceId) { safeLog('[webhook wix] app-installed: no instanceId found'); return res.status(400).json({ error: 'no instanceId' }); }
    await registerInstance(instanceId, DEFAULT_SITE);
    res.json({ ok: true });
  } catch (err) {
    safeLog('[webhook wix] app-installed failed:', err.message);
    res.status(400).json({ error: 'bad payload' });
  }
});

/** Decode (without verifying) the payload of a Wix webhook JWT. */
function decodeJwtPayload(jwt) {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Recursively JSON.parse any stringified-JSON values so the whole event is one object. */
function deepParse(node, depth = 0) {
  if (depth > 8) return node;
  if (typeof node === 'string') {
    const t = node.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { return deepParse(JSON.parse(t), depth + 1); } catch { return node; } }
    return node;
  }
  if (Array.isArray(node)) return node.map((v) => deepParse(v, depth + 1));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepParse(v, depth + 1);
    return out;
  }
  return node;
}

/** Find the Wix contact resource inside the event (it has an `info` block). */
function findContactEntity(node, depth = 0) {
  if (node == null || depth > 8 || typeof node !== 'object') return null;
  if (node.info && (node.id || node.revision)) return node;
  for (const v of Object.values(node)) {
    const found = findContactEntity(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Wix nests + sometimes stringifies payloads — search recursively for a key. */
function findKey(node, key, depth = 0) {
  if (node == null || depth > 8) return null;
  if (typeof node === 'string') {
    const t = node.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { return findKey(JSON.parse(t), key, depth + 1); } catch { return null; } }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (node[key] != null && typeof node[key] !== 'object') return node[key];
  for (const v of Object.values(node)) {
    const found = findKey(v, key, depth + 1);
    if (found) return found;
  }
  return null;
}

// UTM / attribution properties we write on HubSpot for Feature #2.
const UTM_PROPS = [
  { name: 'utm_source', label: 'UTM Source' },
  { name: 'utm_medium', label: 'UTM Medium' },
  { name: 'utm_campaign', label: 'UTM Campaign' },
  { name: 'utm_term', label: 'UTM Term' },
  { name: 'utm_content', label: 'UTM Content' },
  { name: 'wix_page_url', label: 'Wix Page URL' },
  { name: 'wix_referrer', label: 'Wix Referrer' },
];
let utmPropsReady = false;
async function ensureUtmProps() {
  if (utmPropsReady) return;
  for (const p of UTM_PROPS) {
    try { await ensureProperty(p); } catch (e) { safeLog(`[form] could not ensure prop ${p.name}:`, e.response?.status || e.message); }
  }
  utmPropsReady = true;
}

// ─── Feature #1 inbound: Wix contact created/updated ─────────────────────────
// Wix delivers a signed JWT (text body) wrapping a domain event. We decode it,
// pull the contact's entityId, then fetch the live contact for reliable values
// and hand it to the sync engine. (The engine's loop guard ignores the echo of
// our own HubSpot→Wix writes.) A plain-JSON body is also accepted as a fallback
// for Velo/Automation-pushed events.
wixWebhookRouter.post('/contacts', text({ type: '*/*' }), async (req, res) => {
  res.json({ received: true });
  try {
    // Wix wraps the event as a JWT whose `data` is doubly-stringified JSON.
    // deepParse turns the whole thing into a plain object we can read.
    const event = deepParse(parseWixBody(req));
    const contactId = findKey(event, 'entityId') || findKey(event, 'contactId');
    if (!contactId) { safeLog('[webhook wix] contacts: no entityId in payload'); return; }

    // Read the contact straight from the event payload when present
    // (createdEvent.entity / updatedEvent.currentEntity); otherwise fetch it live.
    let flatWix, updatedAt;
    const entity = findContactEntity(event);
    if (entity) {
      const n = normalizeWixContact(entity);
      flatWix = n.flat; updatedAt = n.updatedAt;
    } else {
      try {
        const current = await getWixContact(DEFAULT_SITE, String(contactId));
        flatWix = current.flat; updatedAt = current.updatedAt;
      } catch (e) {
        if (e.response?.data?.details?.applicationError?.code === 'CONTACT_NOT_FOUND') {
          safeLog(`[webhook wix] contact ${contactId} not found (likely a Test payload) — skipping`);
          return;
        }
        throw e;
      }
    }

    const r = await syncFromWix({ siteId: DEFAULT_SITE, wixContactId: String(contactId), flatWix, updatedAt });
    safeLog(`[webhook wix] contact ${contactId} → ${r.status}`);
  } catch (err) {
    safeLog('[webhook wix] contact sync failed:', err.response?.data || err.message);
  }
});

// ─── Feature #2: Wix form submission → HubSpot lead with UTM attribution ─────
wixWebhookRouter.post('/form', async (req, res) => {
  if (!devSecretOk(req)) return res.status(401).json({ error: 'unauthorized' });

  const b = req.body || {};
  const email = b.email || b.contact?.email;
  if (!email) return res.status(400).json({ error: 'email required' });

  const utm = {
    utm_source: b.utm_source ?? b.utm?.source,
    utm_medium: b.utm_medium ?? b.utm?.medium,
    utm_campaign: b.utm_campaign ?? b.utm?.campaign,
    utm_term: b.utm_term ?? b.utm?.term,
    utm_content: b.utm_content ?? b.utm?.content,
    wix_page_url: b.pageUrl,
    wix_referrer: b.referrer,
  };

  try {
    await ensureUtmProps();
    const properties = clean({
      firstname: b.firstName ?? b.firstname,
      lastname: b.lastName ?? b.lastname,
      phone: b.phone,
      company: b.company,
      ...utm,
    });
    const { id, created } = await upsertByEmail(email, properties);

    await prisma.formEvent.create({
      data: {
        siteId: DEFAULT_SITE,
        formId: b.formId ?? null,
        email,
        utm: JSON.stringify(clean(utm)),
        pageUrl: b.pageUrl ?? null,
        referrer: b.referrer ?? null,
        hubspotContactId: id,
      },
    });

    safeLog(`[form] lead captured email=${email} hubspot:${id} created=${created}`);
    res.json({ ok: true, hubspotContactId: id, created });
  } catch (err) {
    safeLog('[form] capture failed:', err.response?.data || err.message);
    res.status(502).json({ error: 'capture failed' });
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────
/** A Wix webhook may arrive as a JWT (text) or as plain JSON (Velo/Automation). */
function parseWixBody(req) {
  if (typeof req.body === 'string') {
    const raw = req.body.trim();
    if (raw.split('.').length === 3) return decodeJwtPayload(raw); // JWT
    return raw ? JSON.parse(raw) : {};
  }
  return req.body || {}; // already parsed by express.json
}
function devSecretOk(req) {
  const expected = process.env.WIX_WEBHOOK_SECRET;
  if (!expected || process.env.WEBHOOK_DEV_BYPASS === '1') return true;
  const got = req.get('x-wix-webhook-secret') || '';
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; }
}
function pickFlat(o = {}) {
  const { firstName, lastName, email, phone, company } = o;
  return clean({ firstName, lastName, email, phone, company });
}
function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}
