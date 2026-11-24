import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingNavigationResponse, runRemotion } from '../src/internal/remotion-retry.mjs';

// The very message @remotion/renderer's gotoPageOrThrow throws when a page loads without a recorded response
const noResponse = () => Error('Visited "http://localhost:54290/index.html" but got no response.');

/** A pooled browser whose calls open a tab each; a failed attempt leaves its tab open, as Remotion 4.0.545 does. */
function fakeBrowser() {
  const open = new Set([{ name: 'blank' }]);
  return {
    open,
    pages: async () => [...open],
    newPage: () => { const page = { close: async () => { open.delete(page); } }; open.add(page); return page; },
  };
}

function flaky(failures, error = noResponse) {
  const calls = [];
  return { calls, call: async options => {
    calls.push(options);
    const page = options.puppeteerInstance?.newPage();
    if (calls.length <= failures) throw error();
    await page?.close();
    return 'rendered';
  } };
}

test('a render whose page got no response runs again on a fresh port, its failed tabs closed', async () => {
  const browser = fakeBrowser();
  const { calls, call } = flaky(2);
  let port = 4000;
  const retried = [];
  const result = await runRemotion(call, { frame: 3, port: 4000, puppeteerInstance: browser },
    { delayMs: 1, freshPort: async () => ++port, onRetry: (_, attempt) => retried.push(attempt) });
  assert.equal(result, 'rendered');
  assert.deepEqual(calls.map(options => [options.frame, options.port]), [[3, 4000], [3, 4001], [3, 4002]]);
  assert.deepEqual(retried, [1, 2]);
  assert.deepEqual([...browser.open].map(page => page.name), ['blank'], 'only the tab that was open before is left');
});

test('it gives up after its attempts, and any other failure fails at once', async () => {
  const always = flaky(Infinity);
  await assert.rejects(runRemotion(always.call, {}, { attempts: 3, delayMs: 1 }), /got no response/);
  assert.equal(always.calls.length, 3);
  const other = flaky(1, () => Error('Visited "http://localhost:1/index.html" but the status code was 404'));
  await assert.rejects(runRemotion(other.call, {}, { delayMs: 1 }), /404/);
  assert.equal(other.calls.length, 1);
  assert.equal(isMissingNavigationResponse(Error('renderStill() got cancelled')), false);
});

test('an abort during the pause before a retry runs nothing more', async () => {
  const { calls, call } = flaky(1);
  const controller = new AbortController();
  const pending = runRemotion(call, {}, { delayMs: 10_000, signal: controller.signal,
    onRetry: () => setTimeout(() => controller.abort(Error('Timeline render aborted')), 20) });
  const started = Date.now();
  await assert.rejects(pending, /Timeline render aborted/);
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 2000, 'the pause ends with the abort');
});

test('an aborted session starts no call, even one Remotion cannot cancel (selectComposition)', async () => {
  const { calls, call } = flaky(0);
  const controller = new AbortController();
  controller.abort(Error('Timeline render aborted'));
  await assert.rejects(runRemotion(call, {}, { signal: controller.signal }), /Timeline render aborted/);
  assert.equal(calls.length, 0);
});
