# Wix ↔ HubSpot Integration

Reliable bi-directional contact sync **and** Wix-form lead capture between a Wix site and
HubSpot, built as a **self-hosted Node/Express app** (no Zapier, no API keys in the frontend).

- **Feature #1** — two-way contact sync with conflict handling + infinite-loop prevention
- **Feature #2** — Wix form submissions → HubSpot lead with UTM / source attribution
- OAuth + encrypted token storage, a field-mapping dashboard (React), safe logging

---

## A) API Plan — what each feature uses and why

### Feature #1 — Bi-directional contact sync
| Need | API | Why |
|---|---|---|
| Read/write Wix contacts | **Wix CRM Contacts API v4** (`/contacts/v4/contacts`) | Native contact CRUD on the Wix side |
| Inbound Wix changes | **Wix Webhooks** (contact created/updated) | Push-based; avoids polling |
| Read/write HubSpot contacts | **HubSpot CRM Contacts API v3** | Contact CRUD on the HubSpot side |
| Find existing contact | **HubSpot CRM Search API** (by email) | De-dupe before create → one canonical contact |
| Inbound HubSpot changes | **HubSpot Webhooks** (`contact.creation`, `contact.propertyChange`) | Push-based inbound sync |
| Mapping dropdowns | **HubSpot Properties API** + Wix contact schema | Populate the field-mapping UI |

### Feature #2 — Form & lead capture
Chosen approach: **Wix Forms → push to HubSpot** (more control over attribution).
| Need | API | Why |
|---|---|---|
| Capture submissions | **Wix form submit → our webhook** (Velo/automation) | Fires on every Wix form submit |
| Create/update lead | **HubSpot Contacts API** (upsert by email) | Reuses the sync layer |
| UTM / source props | **HubSpot Properties API** (custom props) | Stores utm_source/medium/campaign/term/content, page URL, referrer, timestamp |

### Security
- **Wix:** OAuth 2.0 **client_credentials** grant (Wix's current model) — the install's `instanceId`
  is captured via the *App Instance Installed* webhook, then short-lived (~4h) access tokens are minted
  on demand from App ID + App Secret + instanceId and cached **encrypted at rest**. No token is exposed
  to the browser.
- **HubSpot:** private-app token, stored **encrypted at rest** (AES-256-GCM), never sent to the browser.

---

## Platform constraint (why HubSpot uses a private-app token)

HubSpot **disabled new legacy public OAuth apps** for new developer accounts — public apps now
require the `hs project create` CLI flow. For a single-portal take-home, the supported path is a
**private app**, which authenticates with a long-lived access token instead of the
authorize→code→refresh browser flow. To still satisfy the OAuth/refresh requirement honestly:

- The **Wix side uses real OAuth 2.0** (client_credentials grant, `src/auth/wix.js`). Wix recently
  consolidated self-hosted apps onto this model: there is no install-redirect/refresh-token flow —
  you identify the install by `instanceId` and mint tokens that expire in ~4h (rotation by re-issuance).
- The **HubSpot token is encrypted at rest** and decrypted only in memory at call time.
- The token-handling interface in `src/store/crypto.js` is identical to what a public-app OAuth
  flow would use, so swapping in the public-app flow later changes only `src/auth/hubspot.js`.

---

## Architecture

```
Wix site ──webhook──▶  Express backend  ──REST──▶ HubSpot
   ▲                   ├─ /auth            Wix OAuth + status/disconnect
   │                   ├─ /api/mappings    field-mapping CRUD (API-key guarded)
   │                   ├─ /api/sync/*       manual sync triggers (guarded; for testing)
   └──REST─────────────┤─ /webhooks/hubspot inbound HubSpot → Wix (signature verified)
                       ├─ /webhooks/wix     inbound Wix → HubSpot + form capture
                       └─ /dashboard        React app (connect + mapping table)
                          │
                          └─ SQLite (Prisma): Connection, FieldMapping, IdLink, SyncLog, FormEvent
```

### Loop prevention (the core of bi-directional sync)
1. **ID mapping** (`IdLink`): permanent `wixContactId ↔ hubspotContactId` link → never creates duplicates.
2. **Idempotency** (`SyncLog.valueHash`): every write logs a content hash; if the target already holds
   those values, the write is skipped — no needless updates.
3. **Echo / origin guard**: every write logs `(source, contactKey, valueHash)`. An inbound webhook whose
   values hash-match a recent write **we** made (within `SYNC_DEDUPE_WINDOW_MS`) is recognised as our own
   echo and ignored → stops the ping-pong.
4. **Conflict rule**: **last-updated-wins** — Wix `lastUpdatedDate` vs HubSpot `lastmodifieddate`; the
   more recently edited side wins a contested round.
5. **Correlation id**: every sync run carries a `correlationId` threaded through logs for traceability.

See `src/sync/engine.js` (orchestration) and `src/sync/mapper.js` (mapping, transforms, hashing).

---

## Setup

```bash
# 1. Install
npm install

# 2. Env
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # -> ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # -> DASHBOARD_API_KEY
#   Fill in HUBSPOT_ACCESS_TOKEN (real private-app token), HUBSPOT_CLIENT_SECRET,
#   WIX_APP_ID / WIX_APP_SECRET, PUBLIC_URL.

# 3. Database (SQLite via Prisma)
npm run db:push

# 4. Build the dashboard
npm run build

# 5. Run
npm start                 # http://localhost:3000/health  +  /dashboard
ngrok http 3000           # set the https URL as PUBLIC_URL + the Wix/HubSpot webhook URLs
```

### HubSpot private app — scopes (least privilege)
`crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`,
`crm.schemas.contacts.write` (only to auto-create the UTM properties for Feature #2).

### Connecting a Wix site (client_credentials model)
In the Wix Dev Center → **Build your app**:
1. **OAuth** page → copy **App ID** + **App Secret Key** into `.env` (`WIX_APP_ID`, `WIX_APP_SECRET`).
   *(There is no App URL / Redirect URL to set — the current model doesn't use the install redirect.)*
2. **Permissions** → add **Read Contacts** + **Manage Contacts**.
3. **Webhooks** → add **App Instance Installed** → `https://<PUBLIC_URL>/webhooks/wix/app-installed`,
   and (for live Wix→HubSpot) **Contact Created/Updated**.
4. **Install** the app on a test site. The App Instance Installed webhook fires and we store the
   `instanceId` (also logged to the server). Tokens are then minted on demand.

No webhook yet? Register the `instanceId` manually:
```bash
curl -X POST http://localhost:3000/auth/wix/instance \
  -H "Authorization: Bearer $DASHBOARD_API_KEY" -H 'Content-Type: application/json' \
  -d '{"instanceId":"<YOUR_INSTANCE_ID>"}'
```
Confirm with `GET /auth/status` → `{"wixConnected":true,...}`.

---

## Testing

```bash
npm run test:mapper    # offline: mapping, transforms, hashing, echo-detection logic (no creds)
npm run test:hubspot   # live:    proves the HubSpot token + 3 scopes work (creates 1 test contact)
npm run test:sync      # live:    create → update → idempotency → loop-prevention end-to-end on HubSpot
```

`test:sync` proves the acceptance criteria for Feature #1:
create works, a repeat sync is a no-op (no ping-pong), an update propagates, and the HubSpot echo of
our own write is ignored while a genuine external change is not.

> The live tests need a **real** `HUBSPOT_ACCESS_TOKEN` in `.env`. The committed `.env.example`
> ships a placeholder; the offline `test:mapper` runs with no credentials.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` `/health/hubspot` | — | Liveness / HubSpot connectivity |
| POST | `/webhooks/wix/app-installed` | Wix JWT | Capture instanceId on app install |
| POST | `/auth/wix/instance` | API key | Manually register a Wix instanceId |
| GET | `/auth/status` | API key | Connection status (Wix + HubSpot) |
| POST | `/auth/wix/disconnect` | API key | Disconnect Wix, wipe tokens |
| GET | `/api/mappings/options` | API key | Dropdown data (Wix fields, HubSpot props) |
| GET | `/api/mappings` | API key | List saved mappings |
| PUT | `/api/mappings` | API key | Save mappings (validates dupes/direction) |
| POST | `/api/sync/from-wix` | API key | Manual Wix→HubSpot sync (testing) |
| POST | `/api/sync/from-hubspot` | API key | Manual HubSpot→Wix sync (testing) |
| POST | `/webhooks/hubspot` | HMAC signature | Inbound HubSpot → Wix |
| POST | `/webhooks/wix/contacts` | Wix JWT | Inbound Wix → HubSpot (Contact created/updated) |
| POST | `/webhooks/wix/form` | shared secret | **Feature #2** form capture |

API-key endpoints expect `Authorization: Bearer <DASHBOARD_API_KEY>`.

---

## Field mapping

The dashboard table maps **Wix field → HubSpot property** with a per-row **direction**
(`Wix → HubSpot`, `HubSpot → Wix`, `Wix ↔ HubSpot`) and an optional **transform**
(`trim`, `lowercase`, `uppercase`). "Save mapping" validates that no HubSpot property is
targeted twice. Saved rules take effect on the next sync — no code changes. Persisted in the
`FieldMapping` table; the engine reads them on every sync via `loadMappings(siteId)`.

Supported Wix fields out of the box: `firstName`, `lastName`, `email`, `phone`, `company`.

---

## Feature #2 — Wix form → HubSpot (UTM attribution)

On the Wix site, send each submission to `POST {PUBLIC_URL}/webhooks/wix/form`. Velo example:

```js
// Wix page code — capture UTM from the URL and POST the submission to the backend.
import wixLocation from 'wix-location';

$w('#myForm').onWixFormSubmit(async (event) => {
  const f = event.fields; // { email, firstName, ... } depends on your form
  const q = wixLocation.query; // utm_* params on the landing URL
  await fetch('https://YOUR_PUBLIC_URL/webhooks/wix/form', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wix-webhook-secret': 'YOUR_WIX_WEBHOOK_SECRET' },
    body: JSON.stringify({
      email: f.email, firstName: f.firstName, lastName: f.lastName,
      phone: f.phone, company: f.company, formId: 'contact-form',
      utm: { source: q.utm_source, medium: q.utm_medium, campaign: q.utm_campaign,
             term: q.utm_term, content: q.utm_content },
      pageUrl: wixLocation.url, referrer: document.referrer, timestamp: Date.now(),
    }),
  });
});
```

The backend upserts the HubSpot contact by email and writes attribution to custom contact
properties (auto-created on first use): `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`, `wix_page_url`, `wix_referrer`. Each submission is also recorded in the `FormEvent`
table for observability. **Result:** a Wix form submit creates/updates a HubSpot contact within
seconds, with UTM/source visible as HubSpot properties.

---

## Security notes
- Tokens encrypted at rest (AES-256-GCM); decrypted only in memory at call time.
- `.env` is git-ignored; only `.env.example` (placeholders) is committed.
- `safeLog()` redacts tokens / Bearer headers / secret fields from all logs — no tokens or PII logged.
- Sync + mapping endpoints require the dashboard API key; webhooks verify HMAC signature (HubSpot)
  or a shared secret (Wix). Tokens are never exposed to the browser.

## What a reviewer needs to test live
1. A HubSpot **private-app token** with the scopes above → `HUBSPOT_ACCESS_TOKEN` (+ `HUBSPOT_CLIENT_SECRET`).
2. (For the Wix side) a Wix app's `WIX_APP_ID` / `WIX_APP_SECRET` and the app installed on a site.

With (1) alone you can run `npm run test:sync` and use the dashboard mapping table end-to-end against HubSpot.

## Project structure
```
src/
  server.js            Express app + route mounts
  store/  crypto.js    AES-256-GCM encrypt/decrypt
          db.js        Prisma client + safeLog redaction
  auth/   hubspot.js   HubSpot CRM client + webhook signature verify
          wix.js       Wix OAuth (client_credentials token minting + caching)
          wixContacts.js  Wix Contacts v4 REST client (flat ⇄ Wix `info`)
  sync/   mapper.js    field mapping, transforms, value hashing
          engine.js    upsert, ID-link, idempotency, echo guard, conflict rule
  routes/ guard.js     API-key middleware
          mappings.js  mapping CRUD + dropdown options
          connection.js Wix OAuth endpoints + status/disconnect
          webhooksHubspot.js / webhooksWix.js
  dashboard/           React app (Vite) — connect + mapping table
  scripts/             test-hubspot / test-sync / test-mapper
prisma/schema.prisma   Connection, FieldMapping, IdLink, SyncLog, FormEvent
```
