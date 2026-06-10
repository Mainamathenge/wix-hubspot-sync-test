import crypto from 'node:crypto';

// ─── Field mapping + transforms ──────────────────────────────────────────────
// A "flat contact" is a plain object whose keys are *Wix field names* on the Wix
// side (e.g. firstName, lastName, email, phone, company) and *HubSpot property
// names* on the HubSpot side (e.g. firstname, lastname, email). The FieldMapping
// rows translate between the two key spaces.

/** Apply an optional transform to a single value. */
export function applyTransform(value, transform) {
  if (value == null) return value;
  const str = String(value);
  switch (transform) {
    case 'trim': return str.trim();
    case 'lowercase': return str.trim().toLowerCase();
    case 'uppercase': return str.trim().toUpperCase();
    default: return value;
  }
}

const wantsWixToHubspot = (d) => d === 'wixToHubspot' || d === 'bidirectional';
const wantsHubspotToWix = (d) => d === 'hubspotToWix' || d === 'bidirectional';

/**
 * Map a flat Wix contact -> HubSpot properties using the saved mappings.
 * Only mappings whose direction allows Wix→HubSpot are applied.
 */
export function mapWixToHubspot(flatWix, mappings) {
  const out = {};
  for (const m of mappings) {
    if (!wantsWixToHubspot(m.direction)) continue;
    const raw = flatWix[m.wixField];
    if (raw === undefined) continue; // field not present in this change → leave it alone
    out[m.hubspotProperty] = applyTransform(raw, m.transform);
  }
  return out;
}

/** Map HubSpot properties -> a flat Wix contact using the saved mappings. */
export function mapHubspotToWix(hubProps, mappings) {
  const out = {};
  for (const m of mappings) {
    if (!wantsHubspotToWix(m.direction)) continue;
    const raw = hubProps[m.hubspotProperty];
    if (raw === undefined) continue;
    out[m.wixField] = applyTransform(raw, m.transform);
  }
  return out;
}

/** The set of keys this side "manages" (so we can hash just those for echo detection). */
export function managedWixKeys(mappings) {
  return [...new Set(mappings.map((m) => m.wixField))];
}
export function managedHubspotKeys(mappings) {
  return [...new Set(mappings.map((m) => m.hubspotProperty))];
}

/** Pick a subset of an object by keys, dropping undefined values. */
export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * Stable content hash of a flat value object. Used for:
 *  - idempotency (don't re-write identical values)
 *  - echo/loop detection (recognise a webhook caused by our own write)
 * Keys are sorted and values normalised to strings so {a:1} and {a:"1"} match.
 */
export function valueHash(obj) {
  const normalised = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue; // treat empty == absent
    normalised[k] = String(v);
  }
  const json = JSON.stringify(normalised);
  return crypto.createHash('sha256').update(json).digest('hex');
}
