import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Remotion 4 opens each render's page with its own copy of Puppeteer. Under heavy machine load that page can load
 * while its navigation response goes unrecorded, and Remotion then fails the whole call with `Visited "<url>" but got
 * no response.` (gotoPageOrThrow, @remotion/renderer 4.0.545). It retries the same navigation itself on ECONNRESET
 * and 5xx, but not on this. Drop this once Remotion retries a missing response itself.
 */
const NO_RESPONSE = /^Visited ".*" but got no response\.$/;

export const isMissingNavigationResponse = error => NO_RESPONSE.test(error?.message ?? '');

/**
 * Run a Remotion call (`selectComposition`, `renderStill`, `renderMedia`) and run it again, `attempts` times in
 * all, when Remotion reports no navigation response. Before a retry it closes the tabs the failed attempt opened in
 * `options.puppeteerInstance` (Remotion closes a page only once its navigation succeeded) and takes a fresh port
 * from `freshPort` (Remotion tears its server down without waiting, so the old port may still be bound). Nothing
 * runs after `signal` aborts: `throwIfAborted` is called before every attempt and after every pause.
 */
export async function runRemotion(call, options, { attempts = 3, delayMs = 500, signal, throwIfAborted = () => signal?.throwIfAborted(), freshPort, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    throwIfAborted();
    const browser = options.puppeteerInstance;
    const before = browser ? new Set(await browser.pages()) : null;
    try {
      return await call(options);
    } catch (error) {
      if (attempt >= attempts || !isMissingNavigationResponse(error)) throw error;
      if (before) for (const page of await browser.pages()) if (!before.has(page)) await page.close().catch(() => {});
      onRetry?.(error, attempt);
      await sleep(delayMs * attempt, undefined, { signal }).catch(() => {});
      throwIfAborted();
      if (freshPort && options.port !== undefined) options = { ...options, port: await freshPort() };
    }
  }
}
