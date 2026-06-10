import assert from 'node:assert';
import {
  applyTransform, mapWixToHubspot, mapHubspotToWix,
  managedHubspotKeys, managedWixKeys, pick, valueHash,
} from '../sync/mapper.js';

// Offline unit tests for the deterministic sync core (no network / credentials).
// Run with: node src/scripts/test-mapper.js

let pass = 0;
const t = (name, fn) => { try { fn(); console.log(`✓ ${name}`); pass++; } catch (e) { console.log(`✗ ${name}: ${e.message}`); process.exitCode = 1; } };

const mappings = [
  { wixField: 'email', hubspotProperty: 'email', direction: 'bidirectional', transform: 'lowercase' },
  { wixField: 'firstName', hubspotProperty: 'firstname', direction: 'bidirectional', transform: 'trim' },
  { wixField: 'lastName', hubspotProperty: 'lastname', direction: 'wixToHubspot', transform: null },
  { wixField: 'company', hubspotProperty: 'company', direction: 'hubspotToWix', transform: null },
];

t('transforms', () => {
  assert.equal(applyTransform('  Hi ', 'trim'), 'Hi');
  assert.equal(applyTransform('  AB@X.com ', 'lowercase'), 'ab@x.com');
  assert.equal(applyTransform('ab', 'uppercase'), 'AB');
});

t('Wix → HubSpot respects direction + transforms', () => {
  const out = mapWixToHubspot({ email: 'A@B.COM', firstName: ' Ada ', lastName: 'Byron', company: 'X' }, mappings);
  assert.deepEqual(out, { email: 'a@b.com', firstname: 'Ada', lastname: 'Byron' }); // company is hubspotToWix only
});

t('HubSpot → Wix respects direction', () => {
  const out = mapHubspotToWix({ email: 'A@B.COM', firstname: 'Ada', lastname: 'Byron', company: 'X' }, mappings);
  assert.deepEqual(out, { email: 'a@b.com', firstName: 'Ada', company: 'X' }); // lastname is wixToHubspot only
});

t('managed key sets', () => {
  assert.deepEqual(managedHubspotKeys(mappings).sort(), ['company', 'email', 'firstname', 'lastname']);
  assert.deepEqual(managedWixKeys(mappings).sort(), ['company', 'email', 'firstName', 'lastName']);
});

t('valueHash is stable + order-independent (idempotency basis)', () => {
  assert.equal(valueHash({ a: '1', b: '2' }), valueHash({ b: '2', a: '1' }));
  assert.equal(valueHash({ a: 1 }), valueHash({ a: '1' }));            // type-normalised
  assert.equal(valueHash({ a: '1', c: '' }), valueHash({ a: '1' }));  // empty == absent
  assert.notEqual(valueHash({ a: '1' }), valueHash({ a: '2' }));
});

t('echo detection logic: same values hash-equal, changed values differ', () => {
  const written = mapWixToHubspot({ email: 'a@b.com', firstName: 'Ada', lastName: 'Byron' }, mappings);
  const echo = pick({ email: 'a@b.com', firstname: 'Ada', lastname: 'Byron' }, managedHubspotKeys(mappings));
  assert.equal(valueHash(written), valueHash(echo)); // → would be ignored as our own echo
  const genuine = pick({ email: 'a@b.com', firstname: 'Augusta', lastname: 'King' }, managedHubspotKeys(mappings));
  assert.notEqual(valueHash(written), valueHash(genuine)); // → genuine change, not ignored
});

console.log(`\n${pass} checks passed`);
