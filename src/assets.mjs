import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import sharp from 'sharp';

/**
 * Opt-in Imagen / Gemini Image API generator for NON-UI visual assets only
 * (stage wallpapers, YouTube thumbnails, and cover art).
 *
 * UI frames and product screenshots/recordings MUST ALWAYS come from real
 * browser or terminal engines — never synthesized by an image generator.
 */
export const ASSET_KINDS = Object.freeze(['thumbnail', 'wallpaper']);
export const DEFAULT_IMAGE_MODEL = 'imagen-3.0-generate-002';
export const DEFAULT_ASPECT_RATIO = '16:9';
export const ASSET_NON_UI_POLICY =
  'Non-UI visual assets only (stage wallpapers, YouTube thumbnails, covers). Never use to synthesize UI frames.';

const ASPECT_RATIO_RE = /^[1-9]\d*:[1-9]\d*$/;
const FORMAT_BY_EXT = Object.freeze({
  '.png': { format: 'png', ext: 'png', mimeType: 'image/png' },
  '.jpg': { format: 'jpeg', ext: 'jpg', mimeType: 'image/jpeg' },
  '.jpeg': { format: 'jpeg', ext: 'jpg', mimeType: 'image/jpeg' },
  '.webp': { format: 'webp', ext: 'webp', mimeType: 'image/webp' },
});
const FORMAT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
});

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function writeFileAtomic(targetPath, data) {
  const resolved = resolve(targetPath);
  await mkdir(dirname(resolved), { recursive: true });
  const tempPath = join(dirname(resolved), `.${basename(resolved)}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, data);
    await rename(tempPath, resolved);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function resolveOutputFormat(outPath) {
  const ext = extname(outPath).toLowerCase();
  const info = FORMAT_BY_EXT[ext];
  if (!info) {
    throw Error(
      `Unsupported asset output extension "${ext || '(none)'}"; expected .png, .jpg, .jpeg, or .webp`
    );
  }
  return info;
}

async function convertImageBuffer(buffer, sourceFormat, targetFormat) {
  if (sourceFormat && sourceFormat === targetFormat) {
    return buffer;
  }
  const pipeline = sharp(buffer);
  if (targetFormat === 'png') return pipeline.png().toBuffer();
  if (targetFormat === 'jpeg') return pipeline.jpeg({ quality: 90 }).toBuffer();
  if (targetFormat === 'webp') return pipeline.webp({ quality: 90 }).toBuffer();
  throw Error(`Unsupported target image format: ${targetFormat}`);
}

async function probeImageDimensions(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    return {
      width: Number.isFinite(meta.width) ? meta.width : null,
      height: Number.isFinite(meta.height) ? meta.height : null,
      detectedFormat: meta.format ?? null,
    };
  } catch {
    return { width: null, height: null, detectedFormat: null };
  }
}

/**
 * Deterministic SHA-256 cache key derived from `(kind, model, aspectRatio, prompt)`.
 */
export function computeAssetCacheKey({
  kind,
  model = DEFAULT_IMAGE_MODEL,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  prompt,
} = {}) {
  if (!ASSET_KINDS.includes(kind)) {
    throw Error(`asset kind must be one of ${ASSET_KINDS.join(', ')} (received ${String(kind)})`);
  }
  if (!isNonEmptyString(model)) {
    throw Error('asset model must be a non-empty string');
  }
  if (!isNonEmptyString(aspectRatio) || !ASPECT_RATIO_RE.test(aspectRatio.trim())) {
    throw Error(`aspectRatio must match W:H (e.g. 16:9); received ${String(aspectRatio)}`);
  }
  if (!isNonEmptyString(prompt)) {
    throw Error('asset prompt must be a non-empty string');
  }
  const canonical = JSON.stringify({
    kind,
    model: model.trim(),
    aspectRatio: aspectRatio.trim(),
    prompt: prompt.trim(),
  });
  return sha256(canonical);
}

function buildImageRequest({ model, prompt, aspectRatio, mimeType }) {
  const isImagen = /^imagen-/i.test(model);
  if (isImagen) {
    return {
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predict`,
      body: {
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio,
          outputOptions: { mimeType },
        },
      },
    };
  }
  return {
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio },
      },
    },
  };
}

function extractImageFromPayload(payload) {
  const prediction = payload?.predictions?.[0];
  if (prediction && isNonEmptyString(prediction.bytesBase64Encoded)) {
    return {
      base64: prediction.bytesBase64Encoded,
      mimeType: prediction.mimeType ?? 'image/png',
    };
  }

  const generated = payload?.generatedImages?.[0]?.image;
  if (generated && isNonEmptyString(generated.imageBytes)) {
    return {
      base64: generated.imageBytes,
      mimeType: generated.mimeType ?? 'image/png',
    };
  }

  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline && isNonEmptyString(inline.data)) {
      return {
        base64: inline.data,
        mimeType: inline.mimeType ?? inline.mime_type ?? 'image/png',
      };
    }
  }

  return null;
}

async function readCachedAsset(cacheDir, cacheKey) {
  const metaPath = join(cacheDir, `${cacheKey}.json`);
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object' || !isNonEmptyString(meta.file) || !isNonEmptyString(meta.sha256)) {
    return null;
  }
  const cacheFile = join(cacheDir, basename(meta.file));
  let buffer;
  try {
    buffer = await readFile(cacheFile);
  } catch {
    return null;
  }
  if (sha256(buffer) !== meta.sha256) {
    return null;
  }
  return {
    cacheFile,
    buffer,
    format: meta.format ?? FORMAT_BY_MIME[meta.mimeType] ?? null,
    mimeType: meta.mimeType ?? 'image/png',
  };
}

/**
 * Generate an opt-in non-UI asset (YouTube thumbnail or stage wallpaper) via
 * Google's Imagen or Gemini Image API, cached deterministically by the SHA-256
 * hash of `(kind, model, aspectRatio, prompt)`.
 *
 * Authentication is sent exclusively in the `x-goog-api-key` header and never
 * in the URL query string. Fails cleanly without making any network calls when
 * credentials are absent.
 */
export async function generateAsset({
  kind,
  prompt,
  out,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  apiKey,
  fetchImpl = globalThis.fetch,
  model = DEFAULT_IMAGE_MODEL,
  cacheDir,
  signal,
} = {}) {
  if (!isNonEmptyString(out)) {
    throw Error('generateAsset requires an output file path (--out)');
  }

  const trimmedModel = isNonEmptyString(model) ? model.trim() : '';
  const trimmedAspectRatio = isNonEmptyString(aspectRatio) ? aspectRatio.trim() : '';
  const trimmedPrompt = isNonEmptyString(prompt) ? prompt.trim() : '';

  const cacheKey = computeAssetCacheKey({
    kind,
    model: trimmedModel,
    aspectRatio: trimmedAspectRatio,
    prompt: trimmedPrompt,
  });

  const resolvedOut = resolve(out);
  const target = resolveOutputFormat(resolvedOut);
  const resolvedCacheDir = cacheDir
    ? resolve(cacheDir)
    : process.env.SCREEN_KIT_ASSET_CACHE_DIR
      ? resolve(process.env.SCREEN_KIT_ASSET_CACHE_DIR)
      : join(dirname(resolvedOut), '.screen-kit-asset-cache');

  // 1. Deterministic prompt-hash cache lookup
  const cached = await readCachedAsset(resolvedCacheDir, cacheKey);
  if (cached) {
    const outBuffer = await convertImageBuffer(cached.buffer, cached.format, target.format);
    await writeFileAtomic(resolvedOut, outBuffer);
    const dims = await probeImageDimensions(outBuffer);
    return {
      ok: true,
      kind,
      model: trimmedModel,
      aspectRatio: trimmedAspectRatio,
      prompt: trimmedPrompt,
      file: resolvedOut,
      format: target.format,
      mimeType: target.mimeType,
      bytes: outBuffer.length,
      width: dims.width,
      height: dims.height,
      sha256: sha256(outBuffer),
      cacheKey,
      cacheFile: cached.cacheFile,
      cached: true,
      nonUiOnly: true,
      policy: ASSET_NON_UI_POLICY,
    };
  }

  // 2. Strictly opt-in credentials check before any network call
  const resolvedKey =
    apiKey !== undefined ? apiKey : (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
  if (!isNonEmptyString(resolvedKey)) {
    throw Error(
      'Image asset generation is opt-in and requires API credentials: set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey explicitly.'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw Error('fetch is not available for image asset generation');
  }

  const { endpoint, body } = buildImageRequest({
    model: trimmedModel,
    prompt: trimmedPrompt,
    aspectRatio: trimmedAspectRatio,
    mimeType: target.mimeType,
  });

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': resolvedKey.trim(),
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw Error(`Image generation API returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const payload = await response.json();
  const extracted = extractImageFromPayload(payload);
  if (!extracted) {
    throw Error('Image generation API response did not contain image data');
  }

  const rawBuffer = Buffer.from(extracted.base64, 'base64');
  if (rawBuffer.length === 0) {
    throw Error('Image generation API returned an empty image payload');
  }

  const responseFormat =
    FORMAT_BY_MIME[String(extracted.mimeType).toLowerCase().split(';')[0].trim()] ?? null;
  const outBuffer = await convertImageBuffer(rawBuffer, responseFormat, target.format);

  // 3. Persist to deterministic cache and target path atomically
  await mkdir(resolvedCacheDir, { recursive: true });
  const cacheFileName = `${cacheKey}.${target.ext}`;
  const cacheFile = join(resolvedCacheDir, cacheFileName);
  const digest = sha256(outBuffer);

  await writeFileAtomic(cacheFile, outBuffer);
  await writeFileAtomic(
    join(resolvedCacheDir, `${cacheKey}.json`),
    JSON.stringify(
      {
        cacheKey,
        kind,
        model: trimmedModel,
        aspectRatio: trimmedAspectRatio,
        prompt: trimmedPrompt,
        file: cacheFileName,
        format: target.format,
        mimeType: target.mimeType,
        bytes: outBuffer.length,
        sha256: digest,
        nonUiOnly: true,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  );
  await writeFileAtomic(resolvedOut, outBuffer);

  const dims = await probeImageDimensions(outBuffer);
  return {
    ok: true,
    kind,
    model: trimmedModel,
    aspectRatio: trimmedAspectRatio,
    prompt: trimmedPrompt,
    file: resolvedOut,
    format: target.format,
    mimeType: target.mimeType,
    bytes: outBuffer.length,
    width: dims.width,
    height: dims.height,
    sha256: digest,
    cacheKey,
    cacheFile,
    cached: false,
    nonUiOnly: true,
    policy: ASSET_NON_UI_POLICY,
  };
}
