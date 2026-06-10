import axios from 'axios';
import crypto from 'node:crypto';

// Thin HubSpot CRM client. Uses the private-app token directly.
// Region-agnostic base (api.hubapi.com) works for eu1/na1/etc.

const base = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';

function client() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN is not set');
  return axios.create({
    baseURL: base,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

/** List contact properties (used to populate the mapping UI dropdowns). */
export async function listContactProperties() {
  const { data } = await client().get('/crm/v3/properties/contacts');
  return data.results
    .filter((p) => !p.hidden && !p.calculated && p.modificationMetadata?.readOnlyValue !== true)
    .map((p) => ({ name: p.name, label: p.label, type: p.type }));
}

/** Ensure a custom property exists (used to provision UTM/attribution props for Feature #2). */
export async function ensureProperty({ name, label, type = 'string', fieldType = 'text', groupName = 'contactinformation' }) {
  try {
    await client().get(`/crm/v3/properties/contacts/${name}`);
    return { name, created: false };
  } catch (err) {
    if (err.response?.status !== 404) throw err;
    await client().post('/crm/v3/properties/contacts', { name, label, type, fieldType, groupName });
    return { name, created: true };
  }
}

/** Create a contact. `properties` is a flat { propertyName: value } object. */
export async function createContact(properties) {
  const { data } = await client().post('/crm/v3/objects/contacts', { properties });
  return data; // { id, properties, ... }
}

/** Update a contact by HubSpot id. */
export async function updateContact(hubspotId, properties) {
  const { data } = await client().patch(`/crm/v3/objects/contacts/${hubspotId}`, { properties });
  return data;
}

/** Fetch a contact by id (selected props; always includes lastmodifieddate). */
export async function getContact(hubspotId, props = ['email', 'firstname', 'lastname']) {
  const wanted = [...new Set([...props, 'lastmodifieddate'])];
  const { data } = await client().get(`/crm/v3/objects/contacts/${hubspotId}`, {
    params: { properties: wanted.join(',') },
  });
  return data;
}

/** Find a contact by email. Returns { id, properties } or null. */
export async function searchByEmail(email) {
  if (!email) return null;
  const { data } = await client().post('/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'firstname', 'lastname', 'lastmodifieddate'],
    limit: 1,
  });
  return data.results?.[0] || null;
}

/**
 * Upsert by email in one call — used by the Wix-form lead capture (Feature #2).
 * Creates if new, updates if the email already exists. Returns { id, created }.
 */
export async function upsertByEmail(email, properties) {
  const existing = await searchByEmail(email);
  if (existing) {
    await updateContact(existing.id, properties);
    return { id: existing.id, created: false };
  }
  const created = await createContact({ email, ...properties });
  return { id: created.id, created: true };
}

/** Lightweight connectivity check: token validity. */
export async function ping() {
  const { data } = await client().get('/crm/v3/objects/contacts', { params: { limit: 1 } });
  return { ok: true, sampleCount: data.results?.length ?? 0 };
}

/**
 * Verify a HubSpot webhook v3 signature.
 * signature = base64( HMAC-SHA256( clientSecret, method + uri + body + timestamp ) )
 */
export function verifyWebhookSignature({ method, uri, rawBody, signature, timestamp }) {
  const secret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!secret) return false;
  // Reject very old timestamps (replay protection, 5 min window).
  if (timestamp && Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
  const source = `${method}${uri}${rawBody}${timestamp}`;
  const digest = crypto.createHmac('sha256', secret).update(source).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}
