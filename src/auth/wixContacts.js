import axios from 'axios';
import { getValidAccessToken } from './wix.js';

// Wix CRM Contacts API v4 client. Speaks the REST API directly with the
// site's OAuth access token (refreshed on demand by wix.js). Translates
// between Wix's nested `info` shape and the flat contact the sync engine uses.

const BASE = 'https://www.wixapis.com/contacts/v4/contacts';

async function client(siteId) {
  const token = await getValidAccessToken(siteId);
  return axios.create({
    baseURL: BASE,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

/** Flat { firstName,lastName,email,phone,company } → Wix `info` object. */
function flatToInfo(flat) {
  const info = {};
  if (flat.firstName !== undefined || flat.lastName !== undefined) {
    info.name = { first: flat.firstName ?? '', last: flat.lastName ?? '' };
  }
  if (flat.email !== undefined) info.emails = { items: [{ tag: 'MAIN', email: flat.email }] };
  if (flat.phone !== undefined) info.phones = { items: [{ tag: 'MAIN', phone: flat.phone }] };
  if (flat.company !== undefined) info.company = flat.company;
  return info;
}

/** Wix contact resource → { id, revision, updatedAt, flat }. */
export function normalize(contact) {
  const info = contact.info || {};
  return {
    id: contact.id,
    revision: contact.revision,
    updatedAt: contact.lastUpdatedDate || contact._updatedDate || contact.lastActivity?.activityDate,
    flat: {
      firstName: info.name?.first,
      lastName: info.name?.last,
      email: info.emails?.items?.[0]?.email ?? contact.primaryInfo?.email,
      phone: info.phones?.items?.[0]?.phone ?? contact.primaryInfo?.phone,
      company: info.company,
    },
  };
}

export async function createContact(siteId, flat) {
  const c = await client(siteId);
  const { data } = await c.post('', { info: flatToInfo(flat) });
  return normalize(data.contact);
}

export async function updateContact(siteId, contactId, flat, revision) {
  const c = await client(siteId);
  // Wix v4 Update Contact wants `info` + `revision` at the top level of the body.
  const { data } = await c.patch(`/${contactId}`, { info: flatToInfo(flat), revision: String(revision) });
  return normalize(data.contact || data);
}

export async function getContact(siteId, contactId) {
  const c = await client(siteId);
  const { data } = await c.get(`/${contactId}`);
  return normalize(data.contact);
}

/** Find a contact by email. Returns the normalized contact or null. */
export async function queryByEmail(siteId, email) {
  if (!email) return null;
  const c = await client(siteId);
  const { data } = await c.post('/query', {
    query: { filter: { 'info.emails.email': { $eq: email } }, paging: { limit: 1 } },
  });
  const first = data.contacts?.[0];
  return first ? normalize(first) : null;
}
