import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('the version is the same in package.json, the footer and the newest patch notes', () => {
  const [major, minor] = JSON.parse(read('../package.json')).version.split('.');
  const version = `v${major}.${minor}`;
  const footer = read('../public/index.html').match(/<a class="pill" href="changes\.html"[^>]*aria-label="Patch notes, (v[\d.]+)">(v[\d.]+)<\/a>/);
  assert.deepEqual(footer?.slice(1), [version, version], 'the footer button and its label');
  const newest = read('../public/changes.html').match(/<h2 id="(v[\d.]+)">(v[\d.]+) </);
  assert.deepEqual(newest?.slice(1), [version, version], 'the first entry in the patch notes');
});
