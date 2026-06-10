import crypto from 'node:crypto';
import { prisma, safeLog } from '../store/db.js';
import {
  mapWixToHubspot, mapHubspotToWix,
  managedWixKeys, managedHubspotKeys,
  pick, valueHash,
} from './mapper.js';
import * as hubspot from '../auth/hubspot.js';
import * as wix from '../auth/wixContacts.js';

const DEDUPE_WINDOW_MS = Number(process.env.SYNC_DEDUPE_WINDOW_MS || 120_000);

const newCorrelationId = () => crypto.randomUUID();

function loadMappings(siteId) {
  return prisma.fieldMapping.findMany({ where: { siteId } });
}

/**
 * Loop guard, layer 1 (echo detection).
 * Returns true if a recent write WE made to `system` for `contactKey` produced
 * exactly these values — i.e. this inbound event is the echo of our own write.
 */
async function isOwnEcho(siteId, system, contactKey, hash) {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const hit = await prisma.syncLog.findFirst({
    where: { siteId, source: system, contactKey, valueHash: hash, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  });
  return Boolean(hit);
}

/** Record a write we just made TO `system` (target id + content hash). */
function recordWrite(siteId, system, contactKey, hash, correlationId) {
  return prisma.syncLog.create({
    data: { siteId, source: system, contactKey, valueHash: hash, correlationId },
  });
}

// ─── Wix change → HubSpot ────────────────────────────────────────────────────
export async function syncFromWix({ siteId, wixContactId, flatWix, updatedAt, correlationId = newCorrelationId() }) {
  const mappings = await loadMappings(siteId);
  if (!mappings.length) return { status: 'no-mappings', correlationId };

  // Layer 1: ignore the echo of our own previous write to Wix.
  const wixSubsetHash = valueHash(pick(flatWix, managedWixKeys(mappings)));
  if (await isOwnEcho(siteId, 'wix', wixContactId, wixSubsetHash)) {
    safeLog(`[sync ${correlationId}] wix→hs ignored: echo of our own write to wix:${wixContactId}`);
    return { status: 'ignored-echo', correlationId };
  }

  const hubProps = mapWixToHubspot(flatWix, mappings);
  if (!Object.keys(hubProps).length) return { status: 'nothing-mapped', correlationId };
  if (!hubProps.email && !(await linkFor(siteId, { wixContactId }))) {
    // can't create a HubSpot contact with no email and no existing link
    return { status: 'skipped-no-email', correlationId };
  }

  // Resolve / establish the HubSpot id.
  let link = await linkFor(siteId, { wixContactId });
  let hubspotId = link?.hubspotContactId;
  if (!hubspotId && hubProps.email) {
    const existing = await hubspot.searchByEmail(hubProps.email);
    if (existing) hubspotId = existing.id;
  }

  if (!hubspotId) {
    const created = await hubspot.createContact(hubProps);
    hubspotId = created.id;
    await ensureLink(siteId, wixContactId, hubspotId);
    await recordWrite(siteId, 'hubspot', hubspotId, valueHash(hubProps), correlationId);
    safeLog(`[sync ${correlationId}] wix→hs CREATE hubspot:${hubspotId} from wix:${wixContactId}`);
    return { status: 'created', target: 'hubspot', hubspotId, correlationId };
  }

  await ensureLink(siteId, wixContactId, hubspotId);

  // Layer 2: idempotency — skip if HubSpot already holds these values.
  const current = await hubspot.getContact(hubspotId, managedHubspotKeys(mappings).concat('lastmodifieddate'));
  const currentSubset = pick(current.properties || {}, managedHubspotKeys(mappings));
  if (valueHash(currentSubset) === valueHash(hubProps)) {
    return { status: 'in-sync', correlationId };
  }

  // Conflict rule: last-updated-wins. If HubSpot was modified more recently than
  // this Wix change, HubSpot wins this round and we don't overwrite.
  if (hubspotIsNewer(updatedAt, current.properties?.lastmodifieddate)) {
    safeLog(`[sync ${correlationId}] wix→hs conflict: hubspot newer, hubspot wins for hubspot:${hubspotId}`);
    return { status: 'conflict-hubspot-wins', correlationId };
  }

  await hubspot.updateContact(hubspotId, hubProps);
  await recordWrite(siteId, 'hubspot', hubspotId, valueHash(hubProps), correlationId);
  safeLog(`[sync ${correlationId}] wix→hs UPDATE hubspot:${hubspotId}`);
  return { status: 'updated', target: 'hubspot', hubspotId, correlationId };
}

// ─── HubSpot change → Wix ────────────────────────────────────────────────────
export async function syncFromHubspot({ siteId, hubspotContactId, hubProps, updatedAt, correlationId = newCorrelationId() }) {
  const mappings = await loadMappings(siteId);
  if (!mappings.length) return { status: 'no-mappings', correlationId };

  // Layer 1: ignore the echo of our own previous write to HubSpot.
  const hsSubsetHash = valueHash(pick(hubProps, managedHubspotKeys(mappings)));
  if (await isOwnEcho(siteId, 'hubspot', hubspotContactId, hsSubsetHash)) {
    safeLog(`[sync ${correlationId}] hs→wix ignored: echo of our own write to hubspot:${hubspotContactId}`);
    return { status: 'ignored-echo', correlationId };
  }

  const flatWix = mapHubspotToWix(hubProps, mappings);
  if (!Object.keys(flatWix).length) return { status: 'nothing-mapped', correlationId };

  let link = await linkFor(siteId, { hubspotContactId });
  let wixContactId = link?.wixContactId;
  if (!wixContactId && flatWix.email) {
    const existing = await wix.queryByEmail(siteId, flatWix.email);
    if (existing) wixContactId = existing.id;
  }

  if (!wixContactId) {
    const created = await wix.createContact(siteId, flatWix);
    wixContactId = created.id;
    await ensureLink(siteId, wixContactId, hubspotContactId);
    await recordWrite(siteId, 'wix', wixContactId, valueHash(pick(flatWix, managedWixKeys(mappings))), correlationId);
    safeLog(`[sync ${correlationId}] hs→wix CREATE wix:${wixContactId} from hubspot:${hubspotContactId}`);
    return { status: 'created', target: 'wix', wixContactId, correlationId };
  }

  await ensureLink(siteId, wixContactId, hubspotContactId);

  const current = await wix.getContact(siteId, wixContactId);
  const currentSubset = pick(current.flat || {}, managedWixKeys(mappings));
  const nextSubset = pick(flatWix, managedWixKeys(mappings));
  if (valueHash(currentSubset) === valueHash(nextSubset)) {
    return { status: 'in-sync', correlationId };
  }

  if (wixIsNewer(updatedAt, current.updatedAt)) {
    safeLog(`[sync ${correlationId}] hs→wix conflict: wix newer, wix wins for wix:${wixContactId}`);
    return { status: 'conflict-wix-wins', correlationId };
  }

  await wix.updateContact(siteId, wixContactId, flatWix, current.revision);
  await recordWrite(siteId, 'wix', wixContactId, valueHash(nextSubset), correlationId);
  safeLog(`[sync ${correlationId}] hs→wix UPDATE wix:${wixContactId}`);
  return { status: 'updated', target: 'wix', wixContactId, correlationId };
}

// ─── ID-link helpers (loop guard, layer 0: never create duplicates) ──────────
function linkFor(siteId, where) {
  return prisma.idLink.findFirst({ where: { siteId, ...where } });
}

async function ensureLink(siteId, wixContactId, hubspotContactId) {
  const existing = await prisma.idLink.findFirst({
    where: { siteId, OR: [{ wixContactId }, { hubspotContactId }] },
  });
  if (existing) return existing;
  return prisma.idLink.create({ data: { siteId, wixContactId, hubspotContactId } });
}

// ─── Conflict helpers (last-updated-wins) ────────────────────────────────────
function toMs(t) {
  if (!t) return null;
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}
function hubspotIsNewer(wixUpdatedAt, hubspotLastModified) {
  const a = toMs(wixUpdatedAt), b = toMs(hubspotLastModified);
  if (a == null || b == null) return false; // missing timestamps → source wins
  return b > a;
}
function wixIsNewer(hubspotUpdatedAt, wixUpdatedAt) {
  const a = toMs(hubspotUpdatedAt), b = toMs(wixUpdatedAt);
  if (a == null || b == null) return false;
  return b > a;
}
