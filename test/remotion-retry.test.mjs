import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCancelSignal } from '@remotion/renderer';
import { isMissingNavigationResponse, retryMissingNavigationResponse } from '../src/internal/remotion-retry.mjs';

// The very message @remotion/renderer's gotoPageOrThrow throws when a page loads without a recorded response
const noResponse = () => Error('Visited "http://localhost:54290/index.html" but got no response.');

function flaky(failures, error = noResponse) {
  const calls = [];
  return { calls, call: async options => { calls.push(options); if (calls.length <= failures) throw error(); return 'rendered'; } };
}

test('a render whose page got no navigation response runs again with the same options', async () => {
  const { calls, call } = flaky(2);
  const retried = [];
  const render = retryMissingNavigationResponse(call, { delayMs: 1, onRetry: (_, attempt) => retried.push(attempt) });
  const options = { frame: 3, output: 'still.png' };
  assert.equal(await render(options), 'rendered');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(seen => seen === options));
  assert.deepEqual(retried, [1, 2]);
});

test('it gives up after its attempts, and any other failure fails at once', async () => {
  const always = flaky(Infinity);
  await assert.rejects(retryMissingNavigationResponse(always.call, { attempts: 3, delayMs: 1 })({}), /got no response/);
  assert.equal(always.calls.length, 3);
  const other = flaky(1, () => Error('Visited "http://localhost:1/index.html" but the status code was 404'));
  await assert.rejects(retryMissingNavigationResponse(other.call, { delayMs: 1 })({}), /404/);
  assert.equal(other.calls.length, 1);
  assert.equal(isMissingNavigationResponse(Error('renderStill() got cancelled')), false);
});

test('a cancelled render is not run again', async () => {
  const { calls, call } = flaky(1);
  const { cancel, cancelSignal } = makeCancelSignal();
  cancel();
  await assert.rejects(retryMissingNavigationResponse(call, { delayMs: 1 })({ cancelSignal }), /got no response/);
  assert.equal(calls.length, 1);
});
