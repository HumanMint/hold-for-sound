import test from 'node:test';
import assert from 'node:assert/strict';
import { queue } from '../queue.js';

test('jobs run one at a time with a gap, and a full line turns callers away', async () => {
  const line = queue(30, 3);
  const started = [];
  const job = () => started.push(Date.now());
  const results = await Promise.allSettled([line(job), line(job), line(job), line(job)]);

  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[3].reason.status, 429);
  assert.equal(results[3].reason.retryAfter, 5);
  assert.ok(started[1] - started[0] >= 25 && started[2] - started[1] >= 25, `spaced out, got ${started}`);

  await new Promise((done) => setTimeout(done, 50));
  assert.equal(await line(() => 'ok'), 'ok'); // room again once the line drains
});

test('a failing job does not block the line', async () => {
  const line = queue(1);
  await assert.rejects(line(() => Promise.reject(new Error('upstream down'))), /upstream down/);
  assert.equal(await line(() => 'next'), 'next');
});
