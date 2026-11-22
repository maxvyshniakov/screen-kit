import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { probeVideo, renderVideo } from './video.mjs';
import { VERSION } from './run.mjs';

const exec = promisify(execFile);

export const WEB_BUNDLE_FORMATS = Object.freeze(['av1', 'vp9', 'h264']);
export const YOUTUBE_PRIVACY_VALUES = Object.freeze(['private', 'unlisted', 'public']);
export const YOUTUBE_MULTI_AUDIO_NOTE =
  'Additional audio-language tracks cannot be uploaded via the YouTube Data API v3; add extra audio-language tracks manually in YouTube Studio.';

const YOUTUBE_UPLOAD_VIDEOS_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status';
const YOUTUBE_UPLOAD_CAPTIONS_URL =
  'https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet';
const YOUTUBE_UPLOAD_THUMBNAIL_BASE =
  'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';

const YOUTUBE_MAX_TITLE_CHARS = 100;
const YOUTUBE_MAX_DESCRIPTION_CHARS = 5000;
const YOUTUBE_MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 2 MiB YouTube limit

const VIDEO_MIME_BY_EXT = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
});
const CAPTION_MIME_BY_EXT = Object.freeze({
  '.srt': { format: 'srt', mimeType: 'application/x-subrip' },
  '.vtt': { format: 'vtt', mimeType: 'text/vtt' },
});
const THUMBNAIL_MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const escapeHtmlAttr = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

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

async function readNonEmptyFile(filePath, label) {
  const resolved = resolve(filePath);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw Error(`${label} file not found: ${resolved} (${error.code ?? error.message})`);
  }
  if (!info.isFile()) {
    throw Error(`${label} path is not a regular file: ${resolved}`);
  }
  if (info.size <= 0) {
    throw Error(`${label} file is empty: ${resolved}`);
  }
  const buffer = await readFile(resolved);
  return {
    file: resolved,
    bytes: buffer.length,
    sha256: sha256(buffer),
    buffer,
  };
}

function sanitizeBundleName(rawName, inputPath) {
  const fallback = basename(inputPath, extname(inputPath)) || 'clip';
  const candidate = rawName === undefined || rawName === null ? fallback : String(rawName).trim();
  if (!candidate) {
    throw Error('publishWebBundle name must be a non-empty string');
  }
  if (/[\\/\0]/.test(candidate) || candidate === '.' || candidate === '..' || candidate.includes('..')) {
    throw Error(`publishWebBundle name must be a safe base filename without path separators: ${candidate}`);
  }
  return candidate;
}

function normalizeWebFormats(formats) {
  const rawList =
    formats === undefined || formats === null
      ? ['vp9', 'h264']
      : typeof formats === 'string'
        ? formats.split(',').map((item) => item.trim()).filter(Boolean)
        : Array.isArray(formats)
          ? formats.map((item) => String(item).trim()).filter(Boolean)
          : null;

  if (!rawList || rawList.length === 0) {
    throw Error('formats must be a non-empty array or comma-separated list of av1, vp9, h264');
  }

  const seen = new Set();
  const normalized = [];
  for (const item of rawList) {
    const lower = item.toLowerCase();
    let canonical;
    if (lower === 'vp9' || lower === 'webm') canonical = 'vp9';
    else if (lower === 'av1' || lower === 'av1-webm') canonical = 'av1';
    else if (lower === 'h264' || lower === 'mp4') canonical = 'h264';
    else {
      throw Error(`Unsupported web bundle format "${item}"; expected av1, vp9 (or webm), or h264 (or mp4)`);
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      normalized.push(canonical);
    }
  }

  // Order sources by progressive enhancement: AV1 -> VP9 -> H.264
  const priority = { av1: 0, vp9: 1, h264: 2 };
  normalized.sort((a, b) => priority[a] - priority[b]);
  return normalized;
}

async function encodeAv1Webm({ input, output, fps, colorSpace = 'srgb' }) {
  const resolvedInput = resolve(input);
  const resolvedOutput = resolve(output);
  if (resolvedInput === resolvedOutput) {
    throw Error('video input and output must differ');
  }
  await access(resolvedInput);
  await mkdir(dirname(resolvedOutput), { recursive: true });

  const vf =
    colorSpace === 'p3'
      ? 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv'
      : 'pad=ceil(iw/2)*2:ceil(ih/2)*2';
  const colorFlags =
    colorSpace === 'p3'
      ? ['-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv']
      : [];

  const temporary = join(dirname(resolvedOutput), `.${basename(resolvedOutput)}-${randomUUID()}.webm`);
  try {
    await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        resolvedInput,
        '-an',
        '-vf',
        vf,
        '-pix_fmt',
        'yuv420p',
        ...(fps ? ['-r', String(fps)] : []),
        '-c:v',
        'libsvtav1',
        '-crf',
        '32',
        '-preset',
        '6',
        ...colorFlags,
        '-threads',
        '2',
        temporary,
      ],
      { timeout: 300000, maxBuffer: 5e6 }
    );
    const info = await probeVideo(temporary);
    if (!info.frames || !(info.duration > 0)) {
      throw Error('AV1 encoder produced an empty video');
    }
    await rename(temporary, resolvedOutput);
    return { file: resolvedOutput, format: 'webm', ...info };
  } finally {
    await rm(temporary, { force: true });
  }
}

async function createWebpPoster({ input, poster, outputPath, posterTime = 0, duration = 0 }) {
  let sourceBuffer;
  let posterSource;
  if (poster) {
    const resolvedPoster = resolve(poster);
    await access(resolvedPoster);
    sourceBuffer = await sharp(resolvedPoster).keepIccProfile().webp({ quality: 88 }).toBuffer();
    posterSource = 'provided';
  } else {
    const seekTime =
      Number.isFinite(posterTime) && posterTime > 0
        ? Math.min(posterTime, Math.max(0, duration - 0.05))
        : 0;
    const { stdout } = await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...(seekTime > 0 ? ['-ss', String(seekTime)] : []),
        '-i',
        resolve(input),
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        '-',
      ],
      { encoding: 'buffer', maxBuffer: 50e6, timeout: 60000 }
    );
    if (!stdout || stdout.length === 0) {
      throw Error(`Failed to extract poster frame from ${input}`);
    }
    sourceBuffer = await sharp(stdout).keepIccProfile().webp({ quality: 88 }).toBuffer();
    posterSource = 'extracted';
  }

  await writeFileAtomic(outputPath, sourceBuffer);
  const meta = await sharp(sourceBuffer).metadata();
  return {
    format: 'webp',
    mimeType: 'image/webp',
    file: basename(outputPath),
    path: resolve(outputPath),
    bytes: sourceBuffer.length,
    sha256: sha256(sourceBuffer),
    width: meta.width ?? null,
    height: meta.height ?? null,
    source: posterSource,
  };
}

/**
 * Build a self-contained HTML `<video autoplay muted loop playsinline>` embed
 * snippet referencing the exported WebM/MP4 sources and WebP poster.
 */
export function buildWebEmbedHtml({ videos, poster, width, height } = {}) {
  if (!Array.isArray(videos) || videos.length === 0) {
    throw Error('buildWebEmbedHtml requires at least one video entry');
  }
  const attrs = ['autoplay', 'muted', 'loop', 'playsinline'];
  if (Number.isFinite(width) && width > 0) attrs.push(`width="${Math.round(width)}"`);
  if (Number.isFinite(height) && height > 0) attrs.push(`height="${Math.round(height)}"`);
  if (poster?.file) attrs.push(`poster="${escapeHtmlAttr(poster.file)}"`);

  const sources = videos
    .map(
      (entry) =>
        `  <source src="${escapeHtmlAttr(entry.file)}" type="${escapeHtmlAttr(entry.mimeType)}">`
    )
    .join('\n');

  return `<video ${attrs.join(' ')}>\n${sources}\n</video>\n`;
}

/**
 * Export a self-contained web clip bundle:
 * - VP9 (and/or AV1) WebM + H.264 MP4
 * - WebP poster (provided or extracted from the input video)
 * - `embed.html` (`<video autoplay muted loop playsinline poster="...">`)
 * - `bundle.json` provenance manifest (SHA-256 hashes, dimensions, bytes, codecs)
 *
 * Strictly opt-in; never invoked implicitly by `capture`, `render`, or `run`.
 */
export async function publishWebBundle({
  input,
  outDir,
  name,
  poster,
  formats,
  fps,
  colorSpace = 'srgb',
  posterTime = 0,
} = {}) {
  if (!isNonEmptyString(input)) {
    throw Error('publishWebBundle requires an input video path');
  }
  if (!isNonEmptyString(outDir)) {
    throw Error('publishWebBundle requires an outDir path');
  }
  if (!['srgb', 'p3'].includes(colorSpace)) {
    throw Error(`unsupported colorSpace: ${colorSpace}`);
  }
  if (fps !== undefined && !(typeof fps === 'number' && Number.isFinite(fps) && fps > 0 && fps <= 120)) {
    throw Error('fps must be a finite number between 0 and 120');
  }
  if (typeof posterTime !== 'number' || !Number.isFinite(posterTime) || posterTime < 0) {
    throw Error('posterTime must be a non-negative finite number');
  }

  const resolvedInput = resolve(input);
  const resolvedOutDir = resolve(outDir);
  const sourceFile = await readNonEmptyFile(resolvedInput, 'input video');
  const sourceProbe = await probeVideo(resolvedInput);
  const bundleName = sanitizeBundleName(name, resolvedInput);
  const selectedFormats = normalizeWebFormats(formats);

  await mkdir(resolvedOutDir, { recursive: true });

  const hasBothWebm = selectedFormats.includes('av1') && selectedFormats.includes('vp9');
  const videos = [];

  for (const spec of selectedFormats) {
    let fileName;
    let mimeType;
    let encoded;
    if (spec === 'av1') {
      fileName = hasBothWebm ? `${bundleName}.av1.webm` : `${bundleName}.webm`;
      mimeType = 'video/webm; codecs="av01.0.04M.08"';
      encoded = await encodeAv1Webm({
        input: resolvedInput,
        output: join(resolvedOutDir, fileName),
        fps,
        colorSpace,
      });
    } else if (spec === 'vp9') {
      fileName = hasBothWebm ? `${bundleName}.vp9.webm` : `${bundleName}.webm`;
      mimeType = 'video/webm; codecs="vp9"';
      encoded = await renderVideo({
        input: resolvedInput,
        output: join(resolvedOutDir, fileName),
        fps,
        colorSpace,
      });
    } else {
      fileName = `${bundleName}.mp4`;
      mimeType = 'video/mp4';
      encoded = await renderVideo({
        input: resolvedInput,
        output: join(resolvedOutDir, fileName),
        fps,
        colorSpace,
      });
    }

    const encodedBytes = await readFile(encoded.file);
    videos.push({
      id: spec,
      format: encoded.format,
      codec: encoded.codec,
      mimeType,
      file: fileName,
      path: encoded.file,
      bytes: encodedBytes.length,
      sha256: sha256(encodedBytes),
      width: encoded.width,
      height: encoded.height,
      duration: encoded.duration,
      frames: encoded.frames,
      fps: encoded.fps,
      colorPrimaries: encoded.colorPrimaries,
      colorTransfer: encoded.colorTransfer,
      colorSpace: encoded.colorSpace,
      colorRange: encoded.colorRange,
    });
  }

  const posterPath = join(resolvedOutDir, `${bundleName}.webp`);
  const posterEntry = await createWebpPoster({
    input: resolvedInput,
    poster,
    outputPath: posterPath,
    posterTime,
    duration: sourceProbe.duration,
  });

  const primaryVideo = videos[0];
  const embedHtml = buildWebEmbedHtml({
    videos,
    poster: posterEntry,
    width: primaryVideo.width,
    height: primaryVideo.height,
  });
  const embedBuffer = Buffer.from(embedHtml, 'utf8');
  const embedFile = join(resolvedOutDir, 'embed.html');
  await writeFileAtomic(embedFile, embedBuffer);

  const manifest = {
    schemaVersion: 1,
    target: 'web',
    name: bundleName,
    createdAt: new Date().toISOString(),
    tool: {
      name: '@maxvyshniakov/screen-kit',
      version: VERSION,
    },
    source: {
      file: basename(resolvedInput),
      sha256: sourceFile.sha256,
      bytes: sourceFile.bytes,
      width: sourceProbe.width,
      height: sourceProbe.height,
      duration: sourceProbe.duration,
      frames: sourceProbe.frames,
      fps: sourceProbe.fps,
      codec: sourceProbe.codec,
    },
    colorSpace,
    assets: {
      videos: videos.map(({ path: _absPath, ...rest }) => rest),
      poster: {
        format: posterEntry.format,
        mimeType: posterEntry.mimeType,
        file: posterEntry.file,
        bytes: posterEntry.bytes,
        sha256: posterEntry.sha256,
        width: posterEntry.width,
        height: posterEntry.height,
        source: posterEntry.source,
      },
      embed: {
        file: 'embed.html',
        bytes: embedBuffer.length,
        sha256: sha256(embedBuffer),
      },
    },
  };

  const manifestFile = join(resolvedOutDir, 'bundle.json');
  await writeFileAtomic(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  return {
    ok: true,
    target: 'web',
    name: bundleName,
    outDir: resolvedOutDir,
    manifestFile,
    embedFile,
    posterFile: posterEntry.path,
    videos,
    poster: posterEntry,
    embedHtml,
    manifest,
  };
}

function buildMultipartRelatedBody(metadataJson, mediaBuffer, mediaMimeType) {
  const boundary = `screen_kit_${randomUUID().replace(/-/g, '')}`;
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadataJson)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mediaMimeType}\r\n\r\n`,
    'utf8'
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    boundary,
    contentType: `multipart/related; boundary=${boundary}`,
    body: Buffer.concat([preamble, mediaBuffer, epilogue]),
  };
}

async function validateYouTubeCaptions(captions) {
  if (captions === undefined || captions === null) return [];
  if (!Array.isArray(captions)) {
    throw Error('captions must be an array of { file, language, name?, isDraft? } objects');
  }
  const validated = [];
  for (const [index, entry] of captions.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw Error(`captions[${index}] must be an object with file and language`);
    }
    if (!isNonEmptyString(entry.file)) {
      throw Error(`captions[${index}].file must be a non-empty file path`);
    }
    if (!isNonEmptyString(entry.language)) {
      throw Error(`captions[${index}].language must be a non-empty language code (e.g. "en", "uk")`);
    }
    const ext = extname(entry.file).toLowerCase();
    const spec = CAPTION_MIME_BY_EXT[ext];
    if (!spec) {
      throw Error(`captions[${index}].file must be .srt or .vtt (received "${ext || '(none)'}")`);
    }
    const loaded = await readNonEmptyFile(entry.file, `caption[${index}]`);
    validated.push({
      file: loaded.file,
      language: entry.language.trim(),
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      isDraft: Boolean(entry.isDraft),
      format: spec.format,
      mimeType: spec.mimeType,
      bytes: loaded.bytes,
      sha256: loaded.sha256,
      buffer: loaded.buffer,
    });
  }
  return validated;
}

async function validateYouTubeThumbnail(thumbnail) {
  if (thumbnail === undefined || thumbnail === null) return null;
  if (!isNonEmptyString(thumbnail)) {
    throw Error('thumbnail must be a non-empty image file path');
  }
  const ext = extname(thumbnail).toLowerCase();
  const mimeType = THUMBNAIL_MIME_BY_EXT[ext];
  if (!mimeType) {
    throw Error(`thumbnail must be .png, .jpg, .jpeg, or .webp (received "${ext || '(none)'}")`);
  }
  const loaded = await readNonEmptyFile(thumbnail, 'thumbnail');
  if (loaded.bytes > YOUTUBE_MAX_THUMBNAIL_BYTES) {
    throw Error(
      `thumbnail exceeds YouTube's 2 MiB limit (${loaded.bytes} bytes > ${YOUTUBE_MAX_THUMBNAIL_BYTES} bytes)`
    );
  }
  return {
    file: loaded.file,
    mimeType,
    bytes: loaded.bytes,
    sha256: loaded.sha256,
    buffer: loaded.buffer,
  };
}

/**
 * Strictly opt-in YouTube Data API v3 publisher.
 *
 * - Never triggered implicitly by `capture`, `render`, or `run`.
 * - Supports `dryRun: true` to validate video, metadata, captions, and thumbnail
 *   without requiring an OAuth token or making any network calls.
 * - Real upload requires an explicit OAuth 2.0 Bearer access token
 *   (`accessToken` or `YOUTUBE_ACCESS_TOKEN`).
 * - Note: Additional audio-language tracks are not supported by the YouTube
 *   Data API v3 and must be added manually in YouTube Studio.
 */
export async function publishYouTube({
  video,
  title,
  description = '',
  privacy = 'unlisted',
  captions = [],
  thumbnail,
  accessToken,
  fetchImpl = globalThis.fetch,
  dryRun = false,
  tags,
  categoryId,
  defaultLanguage,
  signal,
} = {}) {
  if (!isNonEmptyString(video)) {
    throw Error('publishYouTube requires a video file path');
  }
  if (!isNonEmptyString(title)) {
    throw Error('publishYouTube requires a non-empty title');
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle.length > YOUTUBE_MAX_TITLE_CHARS) {
    throw Error(
      `YouTube title exceeds ${YOUTUBE_MAX_TITLE_CHARS} characters (received ${trimmedTitle.length})`
    );
  }
  if (typeof description !== 'string') {
    throw Error('YouTube description must be a string');
  }
  if (description.length > YOUTUBE_MAX_DESCRIPTION_CHARS) {
    throw Error(
      `YouTube description exceeds ${YOUTUBE_MAX_DESCRIPTION_CHARS} characters (received ${description.length})`
    );
  }
  if (!YOUTUBE_PRIVACY_VALUES.includes(privacy)) {
    throw Error(
      `YouTube privacy must be one of ${YOUTUBE_PRIVACY_VALUES.join(', ')} (received ${String(privacy)})`
    );
  }
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t) => isNonEmptyString(t)))) {
    throw Error('YouTube tags must be an array of non-empty strings');
  }

  const videoExt = extname(video).toLowerCase();
  const videoMimeType = VIDEO_MIME_BY_EXT[videoExt];
  if (!videoMimeType) {
    throw Error(
      `Unsupported YouTube video extension "${videoExt || '(none)'}"; expected one of ${Object.keys(VIDEO_MIME_BY_EXT).join(', ')}`
    );
  }

  const loadedVideo = await readNonEmptyFile(video, 'video');
  const validatedCaptions = await validateYouTubeCaptions(captions);
  const validatedThumbnail = await validateYouTubeThumbnail(thumbnail);

  const snippet = {
    title: trimmedTitle,
    description,
    ...(tags ? { tags: tags.map((t) => t.trim()) } : {}),
    ...(isNonEmptyString(categoryId) ? { categoryId: categoryId.trim() } : {}),
    ...(isNonEmptyString(defaultLanguage) ? { defaultLanguage: defaultLanguage.trim() } : {}),
  };
  const status = { privacyStatus: privacy };

  if (dryRun) {
    return {
      ok: true,
      target: 'youtube',
      dryRun: true,
      uploaded: false,
      privacy,
      title: trimmedTitle,
      description,
      metadata: { snippet, status },
      video: {
        file: loadedVideo.file,
        mimeType: videoMimeType,
        bytes: loadedVideo.bytes,
        sha256: loadedVideo.sha256,
      },
      captions: validatedCaptions.map(({ buffer: _buf, ...rest }) => rest),
      thumbnail: validatedThumbnail
        ? {
            file: validatedThumbnail.file,
            mimeType: validatedThumbnail.mimeType,
            bytes: validatedThumbnail.bytes,
            sha256: validatedThumbnail.sha256,
          }
        : null,
      notes: [YOUTUBE_MULTI_AUDIO_NOTE],
    };
  }

  const resolvedToken =
    accessToken !== undefined ? accessToken : process.env.YOUTUBE_ACCESS_TOKEN;
  if (!isNonEmptyString(resolvedToken)) {
    throw Error(
      'YouTube upload is strictly opt-in and requires an OAuth access token: pass accessToken or set YOUTUBE_ACCESS_TOKEN (or use dryRun: true to validate locally).'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw Error('fetch is not available for YouTube upload');
  }

  const authHeader = `Bearer ${resolvedToken.trim()}`;

  // 1. Upload video via multipart/related request
  const videoMultipart = buildMultipartRelatedBody(
    { snippet, status },
    loadedVideo.buffer,
    videoMimeType
  );
  const videoResponse = await fetchImpl(YOUTUBE_UPLOAD_VIDEOS_URL, {
    method: 'POST',
    headers: {
      authorization: authHeader,
      'content-type': videoMultipart.contentType,
    },
    body: videoMultipart.body,
    ...(signal ? { signal } : {}),
  });

  if (!videoResponse.ok) {
    const errorText = await videoResponse.text().catch(() => '');
    throw Error(`YouTube video upload failed with HTTP ${videoResponse.status}: ${errorText.slice(0, 300)}`);
  }

  const videoPayload = await videoResponse.json();
  const videoId = videoPayload?.id;
  if (!isNonEmptyString(videoId)) {
    throw Error('YouTube video upload response did not include a video id');
  }

  // 2. Upload caption tracks (SRT/VTT)
  const uploadedCaptions = [];
  for (const track of validatedCaptions) {
    const captionMultipart = buildMultipartRelatedBody(
      {
        snippet: {
          videoId,
          language: track.language,
          name: track.name,
          isDraft: track.isDraft,
        },
      },
      track.buffer,
      track.mimeType
    );
    const captionResponse = await fetchImpl(YOUTUBE_UPLOAD_CAPTIONS_URL, {
      method: 'POST',
      headers: {
        authorization: authHeader,
        'content-type': captionMultipart.contentType,
      },
      body: captionMultipart.body,
      ...(signal ? { signal } : {}),
    });
    if (!captionResponse.ok) {
      const errorText = await captionResponse.text().catch(() => '');
      throw Error(
        `YouTube caption upload (${track.language}) failed with HTTP ${captionResponse.status}: ${errorText.slice(0, 300)}`
      );
    }
    const captionPayload = await captionResponse.json().catch(() => ({}));
    uploadedCaptions.push({
      id: captionPayload?.id ?? null,
      file: track.file,
      language: track.language,
      name: track.name,
      isDraft: track.isDraft,
      format: track.format,
      mimeType: track.mimeType,
      bytes: track.bytes,
      sha256: track.sha256,
    });
  }

  // 3. Upload custom thumbnail (if provided)
  let uploadedThumbnail = null;
  if (validatedThumbnail) {
    const thumbUrl = `${YOUTUBE_UPLOAD_THUMBNAIL_BASE}?videoId=${encodeURIComponent(videoId)}&uploadType=media`;
    const thumbResponse = await fetchImpl(thumbUrl, {
      method: 'POST',
      headers: {
        authorization: authHeader,
        'content-type': validatedThumbnail.mimeType,
      },
      body: validatedThumbnail.buffer,
      ...(signal ? { signal } : {}),
    });
    if (!thumbResponse.ok) {
      const errorText = await thumbResponse.text().catch(() => '');
      throw Error(
        `YouTube thumbnail upload failed with HTTP ${thumbResponse.status}: ${errorText.slice(0, 300)}`
      );
    }
    const thumbPayload = await thumbResponse.json().catch(() => ({}));
    uploadedThumbnail = {
      file: validatedThumbnail.file,
      mimeType: validatedThumbnail.mimeType,
      bytes: validatedThumbnail.bytes,
      sha256: validatedThumbnail.sha256,
      uploaded: true,
      items: thumbPayload?.items ?? null,
    };
  }

  return {
    ok: true,
    target: 'youtube',
    dryRun: false,
    uploaded: true,
    videoId,
    url: `https://youtu.be/${videoId}`,
    privacy,
    title: trimmedTitle,
    description,
    video: {
      file: loadedVideo.file,
      mimeType: videoMimeType,
      bytes: loadedVideo.bytes,
      sha256: loadedVideo.sha256,
    },
    captions: uploadedCaptions,
    thumbnail: uploadedThumbnail,
    notes: [YOUTUBE_MULTI_AUDIO_NOTE],
  };
}
