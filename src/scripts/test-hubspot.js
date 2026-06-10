import 'dotenv/config';
import { ping, listContactProperties, createContact } from '../auth/hubspot.js';

// Run with: npm run test:hubspot
// Proves the private-app token + scopes work against the real API.

async function main() {
  console.log('→ Testing HubSpot connectivity...\n');

  // 1. Token + crm.objects.contacts.read
  const p = await ping();
  console.log(`✓ Contacts API reachable (read scope OK). Sample rows: ${p.sampleCount}`);

  // 2. crm.schemas.contacts.read — needed for the mapping UI dropdowns
  const props = await listContactProperties();
  console.log(`✓ Properties API reachable (schema scope OK). ${props.length} contact properties available.`);
  console.log(`  e.g. ${props.slice(0, 5).map((x) => x.name).join(', ')}`);

  // 3. crm.objects.contacts.write — create a throwaway test contact
  const stamp = Date.now();
  const created = await createContact({
    email: `sync-test-${stamp}@example.com`,
    firstname: 'Sync',
    lastname: 'Test',
  });
  console.log(`✓ Write scope OK. Created test contact id=${created.id}`);

  console.log('\nAll three scopes verified. HubSpot side is ready. ✅');
}

main().catch((err) => {
  const status = err.response?.status;
  const body = err.response?.data;
  console.error('\n✗ HubSpot test failed.');
  if (status) console.error(`  HTTP ${status}`, JSON.stringify(body));
  else console.error(' ', err.message);
  console.error('\nCommon causes: wrong token, missing scope, or token from a different portal.');
  process.exit(1);
});
