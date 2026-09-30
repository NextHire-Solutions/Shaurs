import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAliasOverride } from './portal-aliases';

test("a client's other portals map to it", () => {
  const m = buildAliasOverride([
    { name: 'Properties & Estates Boston', campaign_aliases: ['Properties & Estates', 'Properties & Estates Florida'] },
    { name: 'SERHANT. PA', campaign_aliases: ['SERHANT. PA 15M+'] },
  ]);
  assert.equal(m.get('properties estates florida'), 'properties estates boston');
  assert.equal(m.get('serhant pa 15m'), 'serhant pa');
});

test("an alias that is another client's own name is ignored", () => {
  const m = buildAliasOverride([
    { name: 'Discover Phx Team', campaign_aliases: ['Discover Flag Team'] },
    { name: 'Discover Flag Team', campaign_aliases: [] },
  ]);
  assert.equal(m.has('discover flag team'), false);
});

test('an alias claimed by two clients is ignored', () => {
  const m = buildAliasOverride([
    { name: 'A Realty', campaign_aliases: ['Shared'] },
    { name: 'B Realty', campaign_aliases: ['Shared'] },
  ]);
  assert.equal(m.has('shared'), false);
});
