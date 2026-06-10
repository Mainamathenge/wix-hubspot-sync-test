import axios from 'axios';
import { prisma, safeLog } from '../store/db.js';
import { encrypt, decrypt } from '../store/crypto.js';

// Wix App OAuth 2.0 — current model (client_credentials grant).
// Wix consolidated onto: identify the install by `instanceId`, then mint a
// short-lived (~4h) access token from App ID + App Secret + instanceId. There is
// no install-redirect handshake and no refresh token; we re-mint on expiry.
//   POST https://www.wixapis.com/oauth2/token
//   { grant_type: "client_credentials", client_id, client_secret, instance_id }
// instanceId arrives via the "App Instance Installed" webhook (or manual entry).

const TOKEN_URL = 'https://www.wixapis.com/oauth2/token';
const APP_ID = process.env.WIX_APP_ID;
const APP_SECRET = process.env.WIX_APP_SECRET;
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4h fallback if expires_in is absent

const site = (siteId) => siteId || process.env.DEFAULT_SITE_ID || 'default-site';

/**
 * Register an installed site: persist its instanceId so we can mint tokens.
 * Called by the App Instance Installed webhook and by the manual endpoint.
 */
export async function registerInstance(instanceId, siteId) {
  const s = site(siteId);
  await prisma.connection.upsert({
    where: { siteId: s },
    create: { siteId: s, wixInstanceId: instanceId, status: 'connected' },
    update: { wixInstanceId: instanceId, status: 'connected', wixAccessToken: null, wixTokenExpiry: null },
  });
  safeLog(`[wix] registered instance for site ${s} (instanceId=${instanceId})`);
  return { siteId: s, instanceId };
}

/**
 * Return a valid Wix access token, minting (and caching) a fresh one via the
 * client_credentials grant when the cached token is missing/expired.
 * Name kept stable so the contacts client doesn't need to change.
 */
export async function getValidAccessToken(siteId) {
  const s = site(siteId);
  const conn = await prisma.connection.findUnique({ where: { siteId: s } });
  if (!conn?.wixInstanceId) throw new Error(`No Wix connection for site ${s}`);

  const cached = conn.wixAccessToken && conn.wixTokenExpiry && conn.wixTokenExpiry.getTime() - 30_000 > Date.now();
  if (cached) return decrypt(conn.wixAccessToken);

  const { data } = await axios.post(TOKEN_URL, {
    grant_type: 'client_credentials',
    client_id: APP_ID,
    client_secret: APP_SECRET,
    instance_id: conn.wixInstanceId,
  }, { headers: { 'Content-Type': 'application/json' } });

  const ttl = (Number(data.expires_in) * 1000) || DEFAULT_TTL_MS;
  await prisma.connection.update({
    where: { siteId: s },
    data: { wixAccessToken: encrypt(data.access_token), wixTokenExpiry: new Date(Date.now() + ttl) },
  });
  return data.access_token;
}

/** Disconnect: drop the instance + cached token. */
export async function disconnect(siteId) {
  const s = site(siteId);
  await prisma.connection.update({
    where: { siteId: s },
    data: { wixInstanceId: null, wixAccessToken: null, wixTokenExpiry: null, status: 'disconnected' },
  }).catch(() => {});
  safeLog(`[wix] site ${s} disconnected`);
}

export async function getStatus(siteId) {
  const conn = await prisma.connection.findUnique({ where: { siteId: site(siteId) } });
  return {
    wixConnected: Boolean(conn?.wixInstanceId) && conn?.status === 'connected',
    wixInstanceId: conn?.wixInstanceId || null,
    hubspotConnected: Boolean(process.env.HUBSPOT_ACCESS_TOKEN),
  };
}
