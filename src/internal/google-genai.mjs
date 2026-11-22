export const GOOGLE_GENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function toAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const message =
    typeof signal?.reason === 'string' && signal.reason.length > 0
      ? signal.reason
      : 'Google Generative AI request aborted';
  return new DOMException(message, 'AbortError');
}

/**
 * Resolve Google Generative AI API credentials from `apiKey ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY` (trimmed).
 * Throws cleanly before any network activity when missing or blank.
 */
export function resolveGoogleApiKey({
  apiKey,
  env = process.env,
  label = 'Google Generative AI',
  missingKeyMessage,
} = {}) {
  let candidate;
  if (apiKey !== undefined && apiKey !== null) {
    candidate = apiKey;
  } else {
    const geminiKey = env?.GEMINI_API_KEY;
    const googleKey = env?.GOOGLE_API_KEY;
    candidate = isNonEmptyString(geminiKey) ? geminiKey : (geminiKey ?? googleKey);
    if (!isNonEmptyString(candidate) && isNonEmptyString(googleKey)) {
      candidate = googleKey;
    }
  }

  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (!trimmed) {
    throw Error(
      missingKeyMessage ??
        `${label} requires API credentials: set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey explicitly.`
    );
  }
  return trimmed;
}

/**
 * Strip optional Markdown ` ```json ... ``` ` or ` ``` ... ``` ` fences around JSON text.
 */
export function stripJsonCodeFence(rawText = '') {
  const trimmed = String(rawText ?? '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function buildGoogleGenAiEndpoint(
  model,
  action = 'generateContent',
  { baseUrl = GOOGLE_GENAI_BASE_URL } = {}
) {
  if (!isNonEmptyString(model)) {
    throw Error('Google Generative AI request requires a non-empty model name');
  }
  const cleanAction = String(action).replace(/^:+/, '');
  return `${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model.trim())}:${cleanAction}`;
}

/**
 * Unified HTTP POST JSON adapter for Google Generative AI endpoints (`:generateContent`, `:predict`, etc.).
 * - Resolves and trims `apiKey ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY` with zero network calls if missing.
 * - Sends credentials exclusively via the `x-goog-api-key` header (never in URL query strings).
 * - Forwards `signal` (`AbortSignal`), truncates HTTP error bodies cleanly, and strips Markdown JSON fences.
 */
export async function postGoogleGenAiJson({
  model,
  action = 'generateContent',
  endpoint,
  body,
  apiKey,
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal,
  label = 'Google Generative AI',
  missingKeyMessage,
  maxErrorChars = 300,
} = {}) {
  const resolvedKey = resolveGoogleApiKey({
    apiKey,
    env,
    label,
    missingKeyMessage,
  });

  if (signal?.aborted) {
    throw toAbortError(signal);
  }

  if (typeof fetchImpl !== 'function') {
    throw Error(`fetch is not available for ${label}`);
  }

  const rawUrl = endpoint ?? buildGoogleGenAiEndpoint(model, action);
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.searchParams.has('key')) {
    parsedUrl.searchParams.delete('key');
  }
  const safeUrl = parsedUrl.toString();

  const response = await fetchImpl(safeUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': resolvedKey,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const rawError =
      typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    const snippet = String(rawError ?? '').slice(0, maxErrorChars);
    throw Error(`${label} API returned HTTP ${response.status}: ${snippet}`);
  }

  if (typeof response.text === 'function') {
    const rawBody = await response.text();
    return JSON.parse(stripJsonCodeFence(rawBody));
  }
  if (typeof response.json === 'function') {
    const data = await response.json();
    return typeof data === 'string' ? JSON.parse(stripJsonCodeFence(data)) : data;
  }
  throw Error(`${label} response did not provide a JSON body reader`);
}
