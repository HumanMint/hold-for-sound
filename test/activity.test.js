import test from 'node:test';
import assert from 'node:assert/strict';
import { activity } from '../activity.js';
test('activity contains only bounded, expiring aggregates and coarse locations', () => {
 let now=0; const a=activity(()=>now,2);
 a.visit({'x-hfs-country':'US','x-hfs-city':'Los Angeles','x-hfs-lat':'34.0522','x-hfs-lon':'-118.2437','cf-connecting-ip':'192.0.2.3'},true);
 a.search('found',{lat:34.0522,lon:-118.2437,name:'Private address'});
 const r=a.report();assert.equal(r.regions[0].lat,34.1);assert.equal(r.searches[0].lat,34.05);
 assert.doesNotMatch(JSON.stringify(r),/192\.0\.2\.3|Private address/);
 a.search('unmatched');a.search('unavailable');assert.equal(a.report().searches.length,2);
 now=24*3600_000;assert.deepEqual(a.report().regions,[]);assert.deepEqual(a.report().searches,[]);
});

test('a region name is letters, spaces and .\'- only, or nothing', () => {
  const a = activity(() => 0);
  const city = (name) => (a.visit({ 'x-hfs-country': 'US', 'x-hfs-city': name }, true), a.report().regions.at(-1).city);
  assert.equal(city("St. John's"), "St. John's");
  assert.equal(city(Buffer.from('Zürich').toString('latin1')), 'Zürich'); // UTF-8 bytes, as Node reads a header
  for (const bad of ['<img src=x>', Buffer.from('Los Angeles\u202e').toString('latin1'), 'a'.repeat(81), 'Main St 12', 'x\ny']) assert.equal(city(bad), '', bad);
});
