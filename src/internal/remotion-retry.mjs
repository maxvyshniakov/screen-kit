/**
 * Remotion 4 opens each render's page with its own copy of Puppeteer. Under heavy machine load that page can load
 * while its navigation response goes unrecorded, and Remotion then fails the whole call with `Visited "<url>" but got
 * no response.` (gotoPageOrThrow, @remotion/renderer 4.0.545). It retries the same navigation itself on ECONNRESET
 * and 5xx, but not on this. Every call wrapped here opens a fresh page and overwrites its output, so running it again
 * is safe. Drop this once Remotion retries a missing response itself.
 */
const NO_RESPONSE = /^Visited ".*" but got no response\.$/;

export const isMissingNavigationResponse = error => NO_RESPONSE.test(error?.message ?? '');

/** `call`, run again (up to `attempts` times in all, after `delayMs`) when Remotion reports no navigation response. */
export function retryMissingNavigationResponse(call, { attempts = 3, delayMs = 500, onRetry } = {}) {
  return async options => {
    // Remotion's cancelSignal takes a callback and calls it at once when already cancelled: a cancelled render is
    // never run again
    let cancelled = false;
    options?.cancelSignal?.(() => { cancelled = true; });
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(options);
      } catch (error) {
        if (attempt >= attempts || cancelled || !isMissingNavigationResponse(error)) throw error;
        onRetry?.(error, attempt);
        await new Promise(done => setTimeout(done, delayMs * attempt));
      }
    }
  };
}
