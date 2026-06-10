// Simple bearer-token guard for dashboard/API + sync endpoints.
// The dashboard sends `Authorization: Bearer <DASHBOARD_API_KEY>`; webhooks use
// their own signature verification instead and are NOT guarded by this.
export function requireApiKey(req, res, next) {
  const expected = process.env.DASHBOARD_API_KEY;
  if (!expected) return res.status(500).json({ error: 'DASHBOARD_API_KEY not configured' });
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/** The site this request operates on. Single-tenant default for the take-home. */
export function siteId(req) {
  return req.query.siteId || req.body?.siteId || process.env.DEFAULT_SITE_ID || 'default-site';
}
