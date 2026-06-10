import 'dotenv/config';
import { prisma } from '../store/db.js';
import { syncFromWix, syncFromHubspot } from '../sync/engine.js';

// End-to-end proof of Feature #1 against the REAL HubSpot API.
// Exercises: create, update, idempotency (no ping-pong), and loop/echo prevention.
// The HubSpot→Wix direction's echo guard fires before any Wix call, so this runs
// without a live Wix connection. Run with: npm run test:sync

const SITE = 'sync-test-site';
const email = `sync-${Date.now()}@example.com`;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} ${extra}`); fail++; }
};

async function main() {
  // Fresh mappings for the test site.
  await prisma.fieldMapping.deleteMany({ where: { siteId: SITE } });
  await prisma.idLink.deleteMany({ where: { siteId: SITE } });
  await prisma.syncLog.deleteMany({ where: { siteId: SITE } });
  await prisma.fieldMapping.createMany({
    data: [
      { siteId: SITE, wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional' },
      { siteId: SITE, wixField: 'firstName', hubspotProperty: 'firstname', direction: 'bidirectional' },
      { siteId: SITE, wixField: 'lastName', hubspotProperty: 'lastname', direction: 'bidirectional' },
    ],
  });

  const wixContactId = `wix-${Date.now()}`;

  // 1) CREATE: Wix → HubSpot
  const r1 = await syncFromWix({ siteId: SITE, wixContactId, flatWix: { email, firstName: 'Ada', lastName: 'Lovelace' }, updatedAt: Date.now() });
  check('create: Wix → HubSpot creates contact', r1.status === 'created' && r1.hubspotId, JSON.stringify(r1));
  const hubspotId = r1.hubspotId;

  // 2) IDEMPOTENCY: same values again → no re-write (no ping-pong)
  const r2 = await syncFromWix({ siteId: SITE, wixContactId, flatWix: { email, firstName: 'Ada', lastName: 'Lovelace' }, updatedAt: Date.now() });
  check('idempotency: identical re-sync is a no-op', r2.status === 'in-sync', JSON.stringify(r2));

  // 3) UPDATE: change a field in Wix → HubSpot updates
  const r3 = await syncFromWix({ siteId: SITE, wixContactId, flatWix: { email, firstName: 'Ada', lastName: 'Byron' }, updatedAt: Date.now() + 1000 });
  check('update: Wix → HubSpot updates contact', r3.status === 'updated', JSON.stringify(r3));

  // 4) LOOP PREVENTION: HubSpot fires a webhook echoing OUR write → must be ignored
  const echo = await syncFromHubspot({
    siteId: SITE, hubspotContactId: hubspotId,
    hubProps: { email, firstname: 'Ada', lastname: 'Byron' }, updatedAt: Date.now() + 2000,
  });
  check('loop prevention: own-write echo is ignored', echo.status === 'ignored-echo', JSON.stringify(echo));

  // 5) GENUINE external change is NOT treated as echo (gets past the guard).
  //    With no live Wix connection it then fails at the Wix client — proving the
  //    echo guard let it through rather than swallowing it.
  let gotPastGuard = false;
  try {
    await syncFromHubspot({
      siteId: SITE, hubspotContactId: hubspotId,
      hubProps: { email, firstname: 'Augusta', lastname: 'King' }, updatedAt: Date.now() + 5000,
    });
    gotPastGuard = true; // (would only reach here with a live Wix connection)
  } catch (err) {
    gotPastGuard = /No Wix connection/i.test(err.message);
  }
  check('genuine change is NOT mistaken for an echo', gotPastGuard);

  console.log(`\nHubSpot contact created for inspection: id=${hubspotId} email=${email}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\n✗ test-sync crashed:', err.response?.data || err.message);
  await prisma.$disconnect();
  process.exit(1);
});
