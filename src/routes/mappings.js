import { Router } from 'express';
import { prisma } from '../store/db.js';
import { listContactProperties } from '../auth/hubspot.js';
import { requireApiKey, siteId } from './guard.js';

export const mappingsRouter = Router();
mappingsRouter.use(requireApiKey);

const DIRECTIONS = ['wixToHubspot', 'hubspotToWix', 'bidirectional'];
const TRANSFORMS = [null, 'trim', 'lowercase', 'uppercase'];

// The Wix contact fields the engine knows how to read/write (drives the left dropdown).
const WIX_FIELDS = [
  { name: 'firstName', label: 'First name' },
  { name: 'lastName', label: 'Last name' },
  { name: 'email', label: 'Email' },
  { name: 'phone', label: 'Phone' },
  { name: 'company', label: 'Company' },
];

/** Options for the mapping table dropdowns. */
mappingsRouter.get('/options', async (req, res) => {
  try {
    const hubspotProperties = await listContactProperties();
    res.json({ wixFields: WIX_FIELDS, hubspotProperties, directions: DIRECTIONS, transforms: TRANSFORMS.filter(Boolean) });
  } catch (err) {
    res.status(502).json({ error: 'failed to load HubSpot properties', detail: err.response?.status || err.message });
  }
});

/** List saved mappings for the site. */
mappingsRouter.get('/', async (req, res) => {
  const rows = await prisma.fieldMapping.findMany({ where: { siteId: siteId(req) }, orderBy: { createdAt: 'asc' } });
  res.json(rows);
});

/**
 * Replace the full mapping set for the site (the "Save mapping" button).
 * Validates direction/transform and rejects duplicate HubSpot targets.
 */
mappingsRouter.put('/', async (req, res) => {
  const site = siteId(req);
  const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : null;
  if (!mappings) return res.status(400).json({ error: 'body.mappings[] required' });

  const seenHubspot = new Set();
  for (const m of mappings) {
    if (!m.wixField || !m.hubspotProperty) return res.status(400).json({ error: 'each mapping needs wixField and hubspotProperty' });
    if (!DIRECTIONS.includes(m.direction)) return res.status(400).json({ error: `invalid direction: ${m.direction}` });
    if (m.transform && !TRANSFORMS.includes(m.transform)) return res.status(400).json({ error: `invalid transform: ${m.transform}` });
    if (seenHubspot.has(m.hubspotProperty)) return res.status(409).json({ error: `duplicate HubSpot property: ${m.hubspotProperty}` });
    seenHubspot.add(m.hubspotProperty);
  }

  // Atomic replace.
  await prisma.$transaction([
    prisma.fieldMapping.deleteMany({ where: { siteId: site } }),
    prisma.fieldMapping.createMany({
      data: mappings.map((m) => ({
        siteId: site,
        wixField: m.wixField,
        hubspotProperty: m.hubspotProperty,
        direction: m.direction,
        transform: m.transform || null,
      })),
    }),
  ]);

  const rows = await prisma.fieldMapping.findMany({ where: { siteId: site }, orderBy: { createdAt: 'asc' } });
  res.json(rows);
});
