import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { difference } from './images.mjs';
import {
  cameraViewportRect,
  projectViewportToScreen,
  sampleCamera,
  sampleCursor,
  validateTimeline,
} from './timeline.mjs';
import { reviewNarration } from './narration.mjs';

const exec = promisify(execFile);

export const DEFAULT_CURSOR_THRESHOLD_PX = 2;
export const DEFAULT_BASELINE_MAX_DIFF = 0.01;
export const DEFAULT_FREEZE_DURATION = 1.0;
export const DEFAULT_FREEZE_NOISE = 0.001;
export const DEFAULT_BLACK_DURATION = 0.2;
export const DEFAULT_BLACK_PIX_THRESHOLD = 0.1;
export const DEFAULT_BLACK_PIC_THRESHOLD = 0.98;
export const DEFAULT_GAP_FACTOR = 1.75;
export const DEFAULT_STILL_COUNT = 6;
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const EPS = 1e-6;
const DEFAULT_MULTIMODAL_PROMPT = [
  'Inspect this rendered product demo video contact sheet and timeline summary.',
  'Identify visual or semantic defects such as clipped text, overlapping overlays, awkward zoom timing, visual glitches, or unreadable UI.',
  'Return JSON with shape: { "ok": boolean, "summary": string, "findings": [{ "severity": "error"|"warning"|"info", "category": string, "timestamp"?: number, "message": string }] }.',
].join(' ');

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function parseFraction(value) {
  if (!value || value === '0/0') return 0;
  const [a, b = 1] = String(value).split('/').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : 0;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function slugify(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function padIndex(index) {
  return String(index).padStart(3, '0');
}

function parseColor(color) {
  if (typeof color === 'string') {
    const hex = color.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    throw Error(`Unsupported color string: ${color}`);
  }
  if (isObject(color) && [color.r, color.g, color.b].every(isFiniteNumber)) {
    return { r: color.r, g: color.g, b: color.b };
  }
  throw Error('color must be a hex string or { r, g, b } object');
}

async function loadJsonOrObject(input, label) {
  if (input === undefined || input === null) return null;
  if (typeof input === 'string') {
    const file = resolve(input);
    const raw = await readFile(file, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw Error(`Failed to parse ${label} JSON (${file}): ${error.message}`);
    }
  }
  if (isObject(input)) return input;
  throw Error(`${label} must be an object or path to a JSON file`);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe video stream metadata and file size using `ffprobe`.
 */
export async function probeVideoDetails(videoPath) {
  const file = resolve(videoPath);
  const infoStat = await stat(file);
  const { stdout } = await exec(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file],
    { maxBuffer: 10e6 }
  );
  const parsed = JSON.parse(stdout);
  const stream = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
  if (!stream) throw Error(`${file}: no video stream`);

  const avgFps = parseFraction(stream.avg_frame_rate);
  const rFps = parseFraction(stream.r_frame_rate);
  const frames = Number(stream.nb_read_frames ?? stream.nb_frames ?? 0);
  const duration = Number(parsed.format?.duration ?? stream.duration ?? 0);
  const derivedFps = !avgFps && duration > 0 && frames > 0 ? frames / duration : avgFps;
  const nominalFps = rFps > 0 && rFps <= 240 ? rFps : derivedFps;

  return {
    file,
    fileSizeBytes: infoStat.size,
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    frames: Number.isFinite(frames) ? frames : 0,
    duration: Number.isFinite(duration) ? duration : 0,
    fps: round(derivedFps, 4),
    nominalFps: round(nominalFps, 4),
    codec: stream.codec_name ?? '',
    pixFmt: stream.pix_fmt ?? '',
    audio: (parsed.streams ?? []).some((s) => s.codec_type === 'audio'),
    bitRate: Number(parsed.format?.bit_rate ?? stream.bit_rate ?? 0) || 0,
  };
}

/**
 * Inspect video packet presentation timestamps via `ffprobe` to detect capture gaps and frame drops.
 */
export async function probeFrameTimestamps(videoPath, options = {}) {
  const file = resolve(videoPath);
  const gapFactor = options.maxGapFactor ?? DEFAULT_GAP_FACTOR;
  const { stdout } = await exec(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,dts_time,duration_time',
      '-of', 'json',
      file,
    ],
    { maxBuffer: 25e6 }
  );
  const parsed = JSON.parse(stdout);
  const packets = Array.isArray(parsed.packets) ? parsed.packets : [];

  const timestamps = [];
  for (const packet of packets) {
    const raw = packet.pts_time ?? packet.dts_time;
    const value = Number(raw);
    if (Number.isFinite(value)) timestamps.push(value);
  }
  // Sort ascending because B-frame codecs emit packets in decode (DTS) order rather than PTS order.
  timestamps.sort((a, b) => a - b);

  const deltas = [];
  const positiveDeltas = [];
  let duplicateTimestamps = 0;
  for (let i = 0; i + 1 < timestamps.length; i += 1) {
    const delta = timestamps[i + 1] - timestamps[i];
    deltas.push(delta);
    if (delta > EPS) positiveDeltas.push(delta);
    else duplicateTimestamps += 1;
  }

  let medianDelta = 0;
  if (positiveDeltas.length > 0) {
    const sorted = [...positiveDeltas].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianDelta = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const fallbackInterval = options.nominalFps > 0 ? 1 / options.nominalFps : 0;
  const expectedInterval = medianDelta > 0 ? medianDelta : fallbackInterval;
  const thresholdSec = isFiniteNumber(options.maxGapMs)
    ? options.maxGapMs / 1000
    : expectedInterval > 0
      ? Math.max(expectedInterval * gapFactor, expectedInterval + 0.005)
      : Infinity;

  const gaps = [];
  let totalMissedFrames = 0;
  for (let i = 0; i < deltas.length; i += 1) {
    const delta = deltas[i];
    if (delta > thresholdSec + EPS) {
      const missedFrames = expectedInterval > 0 ? Math.max(1, Math.round(delta / expectedInterval) - 1) : 1;
      totalMissedFrames += missedFrames;
      gaps.push({
        index: i,
        fromTime: round(timestamps[i], 6),
        toTime: round(timestamps[i + 1], 6),
        deltaMs: round(delta * 1000, 3),
        expectedIntervalMs: round(expectedInterval * 1000, 3),
        missedFrames,
      });
    }
  }

  const minDelta = positiveDeltas.length > 0 ? Math.min(...positiveDeltas) : 0;
  const maxDelta = positiveDeltas.length > 0 ? Math.max(...positiveDeltas) : 0;

  return {
    packetCount: packets.length,
    ptsCount: timestamps.length,
    duplicateTimestamps,
    expectedIntervalMs: round(expectedInterval * 1000, 3),
    minDeltaMs: round(minDelta * 1000, 3),
    medianDeltaMs: round(medianDelta * 1000, 3),
    maxDeltaMs: round(maxDelta * 1000, 3),
    thresholdMs: Number.isFinite(thresholdSec) ? round(thresholdSec * 1000, 3) : null,
    totalMissedFrames,
    gaps,
  };
}

/**
 * Run FFmpeg `freezedetect` and `blackdetect` filters in a single decode pass.
 */
export async function detectFreezeAndBlackFrames(videoPath, options = {}) {
  const file = resolve(videoPath);
  const videoDuration = isFiniteNumber(options.duration) ? options.duration : 0;
  const freezeOpts = options.freeze ?? {};
  const blackOpts = options.black ?? {};
  const freezeEnabled = freezeOpts.enabled !== false;
  const blackEnabled = blackOpts.enabled !== false;

  const freezeNoise = freezeOpts.noise ?? DEFAULT_FREEZE_NOISE;
  const freezeDuration = freezeOpts.duration ?? DEFAULT_FREEZE_DURATION;
  const blackDuration = blackOpts.duration ?? DEFAULT_BLACK_DURATION;
  const blackPixTh = blackOpts.pixThreshold ?? DEFAULT_BLACK_PIX_THRESHOLD;
  const blackPicTh = blackOpts.picThreshold ?? DEFAULT_BLACK_PIC_THRESHOLD;

  const filters = [];
  if (freezeEnabled) filters.push(`freezedetect=n=${freezeNoise}:d=${freezeDuration}`);
  if (blackEnabled) filters.push(`blackdetect=d=${blackDuration}:pix_th=${blackPixTh}:pic_th=${blackPicTh}`);

  if (filters.length === 0) {
    return {
      freeze: { enabled: false, segments: [], totalFrozenSeconds: 0 },
      black: { enabled: false, segments: [], totalBlackSeconds: 0 },
    };
  }

  const { stderr } = await exec(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-vf', filters.join(','), '-f', 'null', '-'],
    { maxBuffer: 20e6, timeout: 180000 }
  );

  const freezeSegments = [];
  const blackSegments = [];
  let openFreezeStart = null;
  let pendingFreezeDuration = null;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/lavfi\.freezedetect\.freeze_start:\s*([0-9.eE+-]+)/);
    if (startMatch) {
      openFreezeStart = Number(startMatch[1]);
      pendingFreezeDuration = null;
      continue;
    }
    const durMatch = line.match(/lavfi\.freezedetect\.freeze_duration:\s*([0-9.eE+-]+)/);
    if (durMatch) {
      pendingFreezeDuration = Number(durMatch[1]);
      continue;
    }
    const endMatch = line.match(/lavfi\.freezedetect\.freeze_end:\s*([0-9.eE+-]+)/);
    if (endMatch) {
      const end = Number(endMatch[1]);
      const start = openFreezeStart ?? (pendingFreezeDuration !== null ? Math.max(0, end - pendingFreezeDuration) : end);
      const segDuration = pendingFreezeDuration ?? Math.max(0, end - start);
      freezeSegments.push({
        start: round(start, 4),
        end: round(end, 4),
        duration: round(segDuration, 4),
      });
      openFreezeStart = null;
      pendingFreezeDuration = null;
      continue;
    }

    const blackMatch = line.match(
      /black_start:\s*([0-9.eE+-]+)\s+black_end:\s*([0-9.eE+-]+)\s+black_duration:\s*([0-9.eE+-]+)/
    );
    if (blackMatch) {
      blackSegments.push({
        start: round(Number(blackMatch[1]), 4),
        end: round(Number(blackMatch[2]), 4),
        duration: round(Number(blackMatch[3]), 4),
      });
    }
  }

  // FFmpeg omits freeze_end when a freeze extends through EOF; close it at videoDuration.
  if (openFreezeStart !== null) {
    const end = Math.max(openFreezeStart, videoDuration);
    const segDuration = pendingFreezeDuration ?? Math.max(0, end - openFreezeStart);
    freezeSegments.push({
      start: round(openFreezeStart, 4),
      end: round(end, 4),
      duration: round(segDuration, 4),
      ongoingToEnd: true,
    });
  }

  const totalFrozenSeconds = round(freezeSegments.reduce((sum, seg) => sum + seg.duration, 0), 4);
  const totalBlackSeconds = round(blackSegments.reduce((sum, seg) => sum + seg.duration, 0), 4);

  return {
    freeze: {
      enabled: freezeEnabled,
      noise: freezeNoise,
      minDuration: freezeDuration,
      segments: freezeSegments,
      totalFrozenSeconds,
    },
    black: {
      enabled: blackEnabled,
      minDuration: blackDuration,
      pixThreshold: blackPixTh,
      picThreshold: blackPicTh,
      segments: blackSegments,
      totalBlackSeconds,
    },
  };
}

/**
 * Verify timeline validity and camera bounds inside the stage using `validateTimeline`.
 */
export function verifyCameraBounds(timeline) {
  const validation = validateTimeline(timeline);
  const cameraBoundsPattern = /visible camera rect|leaves stage|timeline\.camera|timeline\.stage .* must be larger/i;
  const cameraBoundsErrors = validation.errors.filter((err) => cameraBoundsPattern.test(err));
  const schemaErrors = validation.errors.filter((err) => !cameraBoundsPattern.test(err));

  let samplesChecked = 0;
  const keyframes = Array.isArray(timeline?.camera?.keyframes) ? timeline.camera.keyframes.length : 0;

  // Also check any step timestamps explicitly when camera and stage are structurally usable.
  const stage = timeline?.stage;
  const camera = timeline?.camera;
  const canSample =
    isObject(stage) &&
    stage.width > 0 &&
    stage.height > 0 &&
    isObject(camera) &&
    camera.outputWidth > 0 &&
    camera.outputHeight > 0 &&
    Array.isArray(camera.keyframes) &&
    camera.keyframes.length > 0 &&
    camera.keyframes.every(
      (kf) => isObject(kf) && isFiniteNumber(kf.t) && isFiniteNumber(kf.x) && isFiniteNumber(kf.y) && kf.zoom > 0
    );

  if (canSample) {
    samplesChecked += camera.keyframes.length;
    const stepTimes = Array.isArray(timeline.steps)
      ? timeline.steps.map((s) => s?.t).filter(isFiniteNumber)
      : [];
    for (const t of stepTimes) {
      samplesChecked += 1;
      try {
        const sample = sampleCamera(camera, t);
        const rect = cameraViewportRect(camera, sample);
        if (
          rect.left < -EPS ||
          rect.top < -EPS ||
          rect.right > stage.width + EPS ||
          rect.bottom > stage.height + EPS
        ) {
          const msg = `step sample (t=${round(t, 4)}): visible camera rect [${rect.left.toFixed(2)}..${rect.right.toFixed(2)}, ${rect.top.toFixed(2)}..${rect.bottom.toFixed(2)}] leaves stage [0..${stage.width}, 0..${stage.height}]`;
          if (!cameraBoundsErrors.includes(msg)) cameraBoundsErrors.push(msg);
        }
      } catch {
        // Invalid easing or malformed keyframe is already reported by validateTimeline.
      }
    }
  }

  return {
    ok: validation.ok && cameraBoundsErrors.length === 0,
    timelineValid: validation.ok,
    schemaErrors,
    cameraBoundsErrors,
    keyframes,
    samplesChecked,
  };
}

/**
 * Image-based marker/cursor locator for verification frames.
 * Supports high-contrast color marker detection (`color`) or diff against a clean cursorless frame (`cleanImage`).
 */
export async function locateCursorMarker(image, options = {}) {
  const {
    color,
    cleanImage,
    tolerance = 32,
    diffThreshold = 24,
    minPixels = 4,
    region = null,
    anchor = 'centroid',
  } = options;

  if (!color && !cleanImage) {
    throw Error('locateCursorMarker requires either `color` or `cleanImage`');
  }

  const target = await sharp(image)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = target.info;
  const startX = region ? Math.max(0, Math.floor(region.x)) : 0;
  const startY = region ? Math.max(0, Math.floor(region.y)) : 0;
  const endX = region ? Math.min(width, Math.ceil(region.x + region.width)) : width;
  const endY = region ? Math.min(height, Math.ceil(region.y + region.height)) : height;

  let cleanData = null;
  if (cleanImage) {
    const clean = await sharp(cleanImage)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (clean.info.width !== width || clean.info.height !== height) {
      throw Error(
        `cleanImage dimensions (${clean.info.width}x${clean.info.height}) do not match image (${width}x${height})`
      );
    }
    cleanData = clean.data;
  }

  const targetColor = color ? parseColor(color) : null;

  let pixelCount = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const idx = (y * width + x) * 4;
      const r = target.data[idx];
      const g = target.data[idx + 1];
      const b = target.data[idx + 2];

      let matched = false;
      if (targetColor) {
        matched =
          Math.abs(r - targetColor.r) <= tolerance &&
          Math.abs(g - targetColor.g) <= tolerance &&
          Math.abs(b - targetColor.b) <= tolerance;
      } else if (cleanData) {
        matched =
          Math.abs(r - cleanData[idx]) > diffThreshold ||
          Math.abs(g - cleanData[idx + 1]) > diffThreshold ||
          Math.abs(b - cleanData[idx + 2]) > diffThreshold;
      }

      if (matched) {
        pixelCount += 1;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (pixelCount < minPixels) {
    return { found: false, x: null, y: null, pixelCount, bounds: null };
  }

  const bounds = { minX, maxX, minY, maxY };
  let x;
  let y;
  if (anchor === 'top-left') {
    x = minX;
    y = minY;
  } else if (isObject(anchor) && isFiniteNumber(anchor.offsetX) && isFiniteNumber(anchor.offsetY)) {
    x = minX + anchor.offsetX;
    y = minY + anchor.offsetY;
  } else {
    x = sumX / pixelCount;
    y = sumY / pixelCount;
  }

  return {
    found: true,
    x: round(x, 3),
    y: round(y, 3),
    pixelCount,
    bounds,
  };
}

function buildCursorFromEventTrack(eventTrack) {
  if (!isObject(eventTrack) || !Array.isArray(eventTrack.events)) return null;
  const samples = [];
  let pressed = false;
  for (const event of eventTrack.events) {
    if (!isObject(event) || !isFiniteNumber(event.t)) continue;
    if (event.type === 'pointermove' || event.type === 'pointerdown' || event.type === 'pointerup') {
      if (event.type === 'pointerdown') pressed = true;
      if (event.type === 'pointerup') pressed = false;
      if (isFiniteNumber(event.x) && isFiniteNumber(event.y)) {
        samples.push({ t: event.t, x: event.x, y: event.y, pressed, visible: true });
      }
    } else if (event.type === 'wheel' || event.type === 'gesture') {
      if (isFiniteNumber(event.x) && isFiniteNumber(event.y)) {
        samples.push({ t: event.t, x: event.x, y: event.y, pressed, visible: true });
      }
    } else if (event.type === 'drag' && Array.isArray(event.from) && Array.isArray(event.to)) {
      samples.push({ t: event.t, x: event.from[0], y: event.from[1], pressed: true, visible: true });
      if (isFiniteNumber(event.duration)) {
        const endT = event.t + event.duration;
        const hasInteriorPointer = eventTrack.events.some(
          (other) =>
            isObject(other) &&
            (other.type === 'pointermove' || other.type === 'pointerup') &&
            isFiniteNumber(other.t) &&
            other.t > event.t &&
            other.t <= endT
        );
        if (!hasInteriorPointer) {
          samples.push({ t: endT, x: event.to[0], y: event.to[1], pressed: false, visible: true });
        }
      }
    }
  }
  samples.sort((a, b) => a.t - b.t);
  return samples.length > 0 ? { enabled: true, style: 'macos', samples } : null;
}

/**
 * Pure geometric/sample verifier for cursor accuracy (`<= thresholdPx`, default 2 px).
 * Projects expected viewport coordinates with `projectViewportToScreen` and compares them
 * against observed screen-space `cursorSamples` (or cross-checks `eventTrack` against timeline).
 */
export function verifyCursorAccuracy({
  timeline,
  eventTrack,
  cursorSamples,
  thresholdPx = DEFAULT_CURSOR_THRESHOLD_PX,
  outputWidth,
  outputHeight,
} = {}) {
  const cursor = timeline?.overlays?.cursor;
  if (!timeline || !cursor?.enabled) {
    return {
      ok: true,
      checked: false,
      mode: 'disabled',
      thresholdPx,
      samplesChecked: 0,
      maxErrorPx: 0,
      meanErrorPx: 0,
      violations: [],
      comparisons: [],
    };
  }

  const trackCursor = buildCursorFromEventTrack(eventTrack);
  const referenceCursor =
    Array.isArray(cursor.samples) && cursor.samples.length > 0 ? cursor : trackCursor;

  if (!referenceCursor || referenceCursor.samples.length === 0) {
    return {
      ok: true,
      checked: false,
      mode: 'no-samples',
      thresholdPx,
      samplesChecked: 0,
      maxErrorPx: 0,
      meanErrorPx: 0,
      violations: [],
      comparisons: [],
    };
  }

  const cameraWidth = timeline.camera?.outputWidth;
  const cameraHeight = timeline.camera?.outputHeight;
  const scaleX = outputWidth && cameraWidth ? outputWidth / cameraWidth : 1;
  const scaleY = outputHeight && cameraHeight ? outputHeight / cameraHeight : 1;

  const projectExpected = (sourceCursor, t) => {
    const vp = sampleCursor(sourceCursor, t);
    if (!vp) return null;
    const screen = projectViewportToScreen(vp.x, vp.y, timeline, t);
    return {
      x: round(screen.x * scaleX, 3),
      y: round(screen.y * scaleY, 3),
      visible: vp.visible,
      viewport: { x: vp.x, y: vp.y },
    };
  };

  const comparisons = [];
  const violations = [];
  let mode = 'observed-samples';

  if (Array.isArray(cursorSamples) && cursorSamples.length > 0) {
    mode = 'observed-samples';
    for (const sample of cursorSamples) {
      if (!isObject(sample) || !isFiniteNumber(sample.t)) continue;
      const expected = projectExpected(referenceCursor, sample.t);
      if (!expected || !expected.visible) continue;

      const observedMissing =
        sample.found === false || !isFiniteNumber(sample.x) || !isFiniteNumber(sample.y);
      if (observedMissing) {
        const entry = {
          t: round(sample.t, 4),
          expected: { x: expected.x, y: expected.y },
          actual: null,
          dx: null,
          dy: null,
          distancePx: null,
          ok: false,
          reason: 'cursor not detected at expected timestamp',
        };
        comparisons.push(entry);
        violations.push(entry);
        continue;
      }

      let actualX = sample.x;
      let actualY = sample.y;
      if (sample.space === 'viewport') {
        const projected = projectViewportToScreen(sample.x, sample.y, timeline, sample.t);
        actualX = projected.x * scaleX;
        actualY = projected.y * scaleY;
      }

      const dx = actualX - expected.x;
      const dy = actualY - expected.y;
      const distancePx = Math.hypot(dx, dy);
      const ok = distancePx <= thresholdPx + EPS;
      const entry = {
        t: round(sample.t, 4),
        expected: { x: expected.x, y: expected.y },
        actual: { x: round(actualX, 3), y: round(actualY, 3) },
        dx: round(dx, 3),
        dy: round(dy, 3),
        distancePx: round(distancePx, 3),
        ok,
      };
      comparisons.push(entry);
      if (!ok) violations.push(entry);
    }
  } else if (trackCursor && Array.isArray(cursor.samples) && cursor.samples.length > 0) {
    mode = 'event-track-alignment';
    for (const sample of trackCursor.samples) {
      const expected = projectExpected(trackCursor, sample.t);
      const actual = projectExpected(cursor, sample.t);
      if (!expected || !actual || !expected.visible) continue;
      const dx = actual.x - expected.x;
      const dy = actual.y - expected.y;
      const distancePx = Math.hypot(dx, dy);
      const ok = distancePx <= thresholdPx + EPS;
      const entry = {
        t: round(sample.t, 4),
        expected: { x: expected.x, y: expected.y },
        actual: { x: actual.x, y: actual.y },
        dx: round(dx, 3),
        dy: round(dy, 3),
        distancePx: round(distancePx, 3),
        ok,
      };
      comparisons.push(entry);
      if (!ok) violations.push(entry);
    }
  } else {
    mode = 'projection-self-check';
    for (const sample of referenceCursor.samples) {
      const expected = projectExpected(referenceCursor, sample.t);
      if (!expected || !expected.visible) continue;
      const finite = Number.isFinite(expected.x) && Number.isFinite(expected.y);
      const entry = {
        t: round(sample.t, 4),
        expected: { x: expected.x, y: expected.y },
        actual: { x: expected.x, y: expected.y },
        dx: 0,
        dy: 0,
        distancePx: 0,
        ok: finite,
      };
      comparisons.push(entry);
      if (!finite) violations.push(entry);
    }
  }

  const numericDistances = comparisons.map((c) => c.distancePx).filter(isFiniteNumber);
  const maxErrorPx = numericDistances.length > 0 ? round(Math.max(...numericDistances), 3) : 0;
  const meanErrorPx =
    numericDistances.length > 0
      ? round(numericDistances.reduce((sum, d) => sum + d, 0) / numericDistances.length, 3)
      : 0;

  return {
    ok: violations.length === 0,
    checked: comparisons.length > 0,
    mode,
    thresholdPx,
    samplesChecked: comparisons.length,
    maxErrorPx,
    meanErrorPx,
    violations,
    comparisons,
  };
}

/**
 * Determine timestamps and deterministic filenames for per-step still extraction.
 */
export function resolveStillTargets({
  timeline,
  eventTrack,
  duration,
  timestamps,
  stillCount = DEFAULT_STILL_COUNT,
} = {}) {
  const safeMaxTime = duration > 0 ? Math.max(0, duration - 0.04) : 0;
  const rawTargets = [];

  if (Array.isArray(timestamps) && timestamps.length > 0) {
    timestamps.forEach((entry, i) => {
      if (isFiniteNumber(entry)) {
        rawTargets.push({ index: i, t: entry, label: `frame-${i}` });
      } else if (isObject(entry) && isFiniteNumber(entry.t)) {
        rawTargets.push({
          index: Number.isInteger(entry.index) ? entry.index : i,
          t: entry.t,
          label: entry.label ?? `step-${i}`,
        });
      }
    });
  } else if (Array.isArray(timeline?.steps) && timeline.steps.length > 0) {
    timeline.steps.forEach((step, i) => {
      rawTargets.push({
        index: Number.isInteger(step.index) ? step.index : i,
        t: step.t,
        label: step.label ?? `step-${i}`,
      });
    });
  } else if (Array.isArray(eventTrack?.events)) {
    const stepEvents = eventTrack.events.filter((e) => e?.type === 'step' && isFiniteNumber(e.t));
    stepEvents.forEach((step, i) => {
      rawTargets.push({
        index: Number.isInteger(step.index) ? step.index : i,
        t: step.t,
        label: step.label ?? `step-${i}`,
      });
    });
  }

  if (rawTargets.length === 0) {
    const count = Math.max(1, Math.min(stillCount, Math.max(1, Math.ceil(duration * 4))));
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0 : (safeMaxTime * i) / (count - 1);
      rawTargets.push({ index: i, t, label: `sample-${i}` });
    }
  }

  const usedFilenames = new Set();
  return rawTargets.map((target, i) => {
    const clampedT = round(Math.max(0, Math.min(target.t, safeMaxTime)), 4);
    const slug = slugify(target.label);
    let filename = slug ? `step-${padIndex(i)}-${slug}.png` : `step-${padIndex(i)}.png`;
    if (usedFilenames.has(filename)) filename = `step-${padIndex(i)}.png`;
    usedFilenames.add(filename);
    return {
      index: target.index,
      t: clampedT,
      requestedT: round(target.t, 4),
      label: String(target.label ?? `step-${i}`),
      filename,
    };
  });
}

async function extractFramePng(videoFile, timestamp, outputFile) {
  await exec(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', String(Math.max(0, timestamp)),
      '-i', videoFile,
      '-frames:v', '1',
      outputFile,
    ],
    { timeout: 60000, maxBuffer: 5e6 }
  );
}

/**
 * Extract per-step PNG stills from `video` into `<outDir>/stills/`.
 */
export async function extractStills({ video, targets, outDir }) {
  const videoFile = resolve(video);
  const stillsDir = join(resolve(outDir), 'stills');
  await mkdir(stillsDir, { recursive: true });

  const stills = [];
  for (const target of targets) {
    const file = join(stillsDir, target.filename);
    await extractFramePng(videoFile, target.t, file);
    const meta = await sharp(file).metadata();
    stills.push({
      index: target.index,
      t: target.t,
      requestedT: target.requestedT,
      label: target.label,
      filename: target.filename,
      file,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    });
  }
  return stills;
}

/**
 * Compose extracted stills into a labeled PNG contact sheet via `sharp`.
 */
export async function generateContactSheet({
  stills,
  outputFile,
  columns,
  tileWidth = 480,
  padding = 16,
  headerHeight = 28,
} = {}) {
  if (!Array.isArray(stills) || stills.length === 0) return null;
  const outPath = resolve(outputFile);
  await mkdir(dirname(outPath), { recursive: true });

  const firstMeta = await sharp(stills[0].file).metadata();
  const aspect = firstMeta.width && firstMeta.height ? firstMeta.height / firstMeta.width : 9 / 16;
  const tileHeight = Math.max(60, Math.round(tileWidth * aspect));
  const cols = Math.max(1, Math.min(columns ?? 3, stills.length));
  const rows = Math.ceil(stills.length / cols);

  const cellWidth = tileWidth;
  const cellHeight = tileHeight + headerHeight;
  const sheetWidth = cols * cellWidth + (cols + 1) * padding;
  const sheetHeight = rows * cellHeight + (rows + 1) * padding;

  const composites = [];
  for (let i = 0; i < stills.length; i += 1) {
    const still = stills[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = padding + col * (cellWidth + padding);
    const top = padding + row * (cellHeight + padding);

    const caption = `#${still.index}  ${Number(still.t).toFixed(2)}s  ${still.label ?? ''}`.trim();
    const headerSvg = Buffer.from(
      `<svg width="${cellWidth}" height="${headerHeight}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#1e293b"/>` +
        `<text x="10" y="${Math.round(headerHeight * 0.68)}" fill="#e2e8f0" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">${escapeXml(caption.slice(0, 64))}</text>` +
        `</svg>`
    );

    const resizedTile = await sharp(still.file)
      .resize({ width: tileWidth, height: tileHeight, fit: 'contain', background: '#020617' })
      .png()
      .toBuffer();

    composites.push({ input: headerSvg, left, top });
    composites.push({ input: resizedTile, left, top: top + headerHeight });
  }

  await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: { r: 15, g: 23, b: 42, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outPath);

  return {
    file: outPath,
    width: sheetWidth,
    height: sheetHeight,
    columns: cols,
    rows,
    count: stills.length,
  };
}

async function writeDiffImage(baselineFile, stillFile, diffFile) {
  const [a, b] = await Promise.all(
    [baselineFile, stillFile].map((file) =>
      sharp(file).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    )
  );
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    const gap = 16;
    const height = Math.max(a.info.height, b.info.height);
    const width = a.info.width + b.info.width + gap;
    await sharp({
      create: { width, height, channels: 4, background: { r: 30, g: 41, b: 59, alpha: 1 } },
    })
      .composite([
        { input: baselineFile, left: 0, top: 0 },
        { input: stillFile, left: a.info.width + gap, top: 0 },
      ])
      .png()
      .toFile(diffFile);
    return;
  }

  const out = Buffer.alloc(a.data.length);
  for (let offset = 0; offset < a.data.length; offset += 4) {
    const changed =
      Math.abs(a.data[offset] - b.data[offset]) > 8 ||
      Math.abs(a.data[offset + 1] - b.data[offset + 1]) > 8 ||
      Math.abs(a.data[offset + 2] - b.data[offset + 2]) > 8 ||
      Math.abs(a.data[offset + 3] - b.data[offset + 3]) > 8;
    if (changed) {
      out[offset] = 239;
      out[offset + 1] = 68;
      out[offset + 2] = 68;
      out[offset + 3] = 255;
    } else {
      out[offset] = Math.round(b.data[offset] * 0.35);
      out[offset + 1] = Math.round(b.data[offset + 1] * 0.35);
      out[offset + 2] = Math.round(b.data[offset + 2] * 0.35);
      out[offset + 3] = 255;
    }
  }
  await sharp(out, {
    raw: { width: a.info.width, height: a.info.height, channels: 4 },
  })
    .png()
    .toFile(diffFile);
}

/**
 * Compare extracted per-step stills against an approved `baselineDir` and write visual diff PNGs.
 */
export async function diffStillsAgainstBaseline({
  stills,
  baselineDir,
  outDir,
  maxDiffRatio = DEFAULT_BASELINE_MAX_DIFF,
} = {}) {
  const baseDir = resolve(baselineDir);
  const diffsDir = join(resolve(outDir), 'diffs');
  await mkdir(diffsDir, { recursive: true });

  const diffs = [];
  let maxChangedRatio = 0;
  let mismatches = 0;

  for (let i = 0; i < stills.length; i += 1) {
    const still = stills[i];
    const directCandidate = join(baseDir, still.filename);
    const fallbackCandidate = join(baseDir, `step-${padIndex(i)}.png`);
    const baselineFile = (await fileExists(directCandidate))
      ? directCandidate
      : (await fileExists(fallbackCandidate))
        ? fallbackCandidate
        : null;

    if (!baselineFile) {
      mismatches += 1;
      diffs.push({
        index: still.index,
        t: still.t,
        label: still.label,
        filename: still.filename,
        stillFile: still.file,
        baselineFile: null,
        diffFile: null,
        changedRatio: null,
        ok: false,
        reason: `missing baseline still for ${still.filename}`,
      });
      continue;
    }

    const changedRatio = await difference(baselineFile, still.file);
    const diffFile = join(diffsDir, still.filename);
    await writeDiffImage(baselineFile, still.file, diffFile);

    if (changedRatio === null) {
      mismatches += 1;
      diffs.push({
        index: still.index,
        t: still.t,
        label: still.label,
        filename: still.filename,
        stillFile: still.file,
        baselineFile,
        diffFile,
        changedRatio: null,
        ok: false,
        reason: 'dimensions differ from baseline still',
      });
      continue;
    }

    if (changedRatio > maxChangedRatio) maxChangedRatio = changedRatio;
    const ok = changedRatio <= maxDiffRatio + EPS;
    if (!ok) mismatches += 1;
    diffs.push({
      index: still.index,
      t: still.t,
      label: still.label,
      filename: still.filename,
      stillFile: still.file,
      baselineFile,
      diffFile,
      changedRatio: round(changedRatio, 6),
      ok,
      ...(ok ? {} : { reason: `changed pixels ${(changedRatio * 100).toFixed(2)}% exceed threshold ${(maxDiffRatio * 100).toFixed(2)}%` }),
    });
  }

  return {
    ok: mismatches === 0,
    compared: stills.length,
    mismatches,
    maxChangedRatio: round(maxChangedRatio, 6),
    maxDiffRatio,
    diffs,
  };
}

function summarizeTimeline(timeline, metrics) {
  if (!timeline) {
    return {
      video: {
        width: metrics.width,
        height: metrics.height,
        fps: metrics.fps,
        duration: metrics.duration,
        frames: metrics.frames,
        codec: metrics.codec,
      },
    };
  }
  return {
    version: timeline.version,
    stage: timeline.stage ? { width: timeline.stage.width, height: timeline.stage.height } : null,
    window: timeline.window
      ? {
          frame: timeline.window.frame,
          title: timeline.window.title,
          width: timeline.window.width,
          height: timeline.window.height,
        }
      : null,
    camera: timeline.camera
      ? {
          outputWidth: timeline.camera.outputWidth,
          outputHeight: timeline.camera.outputHeight,
          keyframes: timeline.camera.keyframes,
        }
      : null,
    overlays: {
      cursorEnabled: Boolean(timeline.overlays?.cursor?.enabled),
      cursorSamples: timeline.overlays?.cursor?.samples?.length ?? 0,
      ripples: timeline.overlays?.ripples?.length ?? 0,
      gestures: timeline.overlays?.gestures?.length ?? 0,
      keystrokes: timeline.overlays?.keystrokes?.length ?? 0,
      captionsEnabled: Boolean(timeline.overlays?.captions?.enabled),
    },
    steps: timeline.steps ?? [],
    video: {
      width: metrics.width,
      height: metrics.height,
      fps: metrics.fps,
      duration: metrics.duration,
      frames: metrics.frames,
      codec: metrics.codec,
    },
  };
}

function normalizeMultimodalFinding(item) {
  if (!isObject(item) || typeof item.message !== 'string' || !item.message.trim()) {
    return null;
  }
  const rawSeverity = String(item.severity ?? 'warning').toLowerCase();
  const severity = ['error', 'warning', 'info'].includes(rawSeverity) ? rawSeverity : 'warning';
  const category =
    typeof item.category === 'string' && item.category.trim() ? item.category.trim() : 'semantic';
  const normalized = {
    source: 'multimodal',
    severity,
    category,
    message: item.message.trim(),
  };
  if (isFiniteNumber(item.timestamp)) normalized.timestamp = round(item.timestamp, 4);
  return normalized;
}

async function callGeminiMultimodalReview({ payload, multimodal }) {
  const apiKey = multimodal.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return {
      ran: false,
      skipped: true,
      reason: 'No Gemini API key configured (set GEMINI_API_KEY or GOOGLE_API_KEY, or provide multimodal.reviewFn)',
      findings: [],
    };
  }

  const model = multimodal.model ?? DEFAULT_GEMINI_MODEL;
  const fetchImpl = multimodal.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw Error('fetch is not available for Gemini multimodal review');
  }

  const parts = [
    {
      text: `${payload.prompt}\n\nTimeline and deterministic summary:\n${JSON.stringify(
        {
          timelineSummary: payload.timelineSummary,
          stills: payload.stills.map(({ index, t, label }) => ({ index, t, label })),
          deterministicOk: payload.deterministicReport.ok,
        },
        null,
        2
      )}`,
    },
  ];

  const imageFiles = [];
  if (payload.contactSheet) imageFiles.push(payload.contactSheet);
  else {
    const maxStills = multimodal.maxStills ?? 6;
    for (const still of payload.stills.slice(0, maxStills)) {
      imageFiles.push(still.file);
    }
  }

  for (const imagePath of imageFiles) {
    const bytes = await readFile(imagePath);
    parts.push({
      inline_data: {
        mime_type: 'image/png',
        data: bytes.toString('base64'),
      },
    });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Error(`Gemini API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? '')
    .join('\n')
    .trim();

  if (!text) {
    return { ran: true, skipped: false, ok: true, summary: 'No multimodal response text returned', findings: [] };
  }

  const parsed = JSON.parse(text);
  const rawFindings = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : [];
  return {
    ran: true,
    skipped: false,
    ok: typeof parsed?.ok === 'boolean' ? parsed.ok : undefined,
    summary: typeof parsed?.summary === 'string' ? parsed.summary : undefined,
    findings: rawFindings,
  };
}

/**
 * Run the optional multimodal review hook. Never executes unless `multimodal.enabled === true`.
 */
export async function runMultimodalReview({ payload, multimodal } = {}) {
  if (!multimodal || !multimodal.enabled) {
    return {
      enabled: false,
      ran: false,
      skipped: false,
      findings: [],
    };
  }

  const provider = multimodal.reviewFn ? (multimodal.provider ?? 'custom') : (multimodal.provider ?? 'gemini');
  let rawResult;

  if (typeof multimodal.reviewFn === 'function') {
    const output = await multimodal.reviewFn(payload);
    if (Array.isArray(output)) {
      rawResult = { ran: true, skipped: false, findings: output };
    } else if (isObject(output)) {
      rawResult = {
        ran: output.ran ?? true,
        skipped: Boolean(output.skipped),
        reason: output.reason,
        ok: typeof output.ok === 'boolean' ? output.ok : undefined,
        summary: typeof output.summary === 'string' ? output.summary : undefined,
        findings: Array.isArray(output.findings) ? output.findings : [],
      };
    } else {
      rawResult = { ran: true, skipped: false, findings: [] };
    }
  } else if (provider === 'gemini') {
    rawResult = await callGeminiMultimodalReview({ payload, multimodal });
  } else {
    throw Error(`Unsupported multimodal review provider: ${provider}`);
  }

  const findings = (rawResult.findings ?? []).map(normalizeMultimodalFinding).filter(Boolean);
  const hasErrorFinding = findings.some((f) => f.severity === 'error');
  const ok = rawResult.ok !== undefined ? rawResult.ok && !hasErrorFinding : !hasErrorFinding;

  return {
    enabled: true,
    provider,
    ran: Boolean(rawResult.ran),
    skipped: Boolean(rawResult.skipped),
    ...(rawResult.reason ? { reason: rawResult.reason } : {}),
    ...(rawResult.summary ? { summary: rawResult.summary } : {}),
    ok,
    findings,
  };
}

/**
 * Automatically review a rendered video using deterministic assertions, contact sheet & stills,
 * baseline pixel diffing, and an optional pluggable multimodal agent review hook.
 */
export async function reviewVideo({
  video,
  timeline: timelineInput,
  eventTrack: eventTrackInput,
  baseline,
  outDir,
  cursorThresholdPx = DEFAULT_CURSOR_THRESHOLD_PX,
  cursorSamples,
  cursorDetection,
  expected = {},
  outputId,
  gaps: gapOptions = {},
  freeze: freezeOptions = {},
  black: blackOptions = {},
  baselineMaxDiff = DEFAULT_BASELINE_MAX_DIFF,
  timestamps,
  stillCount = DEFAULT_STILL_COUNT,
  contactSheet: contactSheetOptions = {},
  narration: narrationOptions,
  multimodal,
} = {}) {
  if (!video) throw Error('reviewVideo requires a video path');
  const videoFile = resolve(video);
  const resolvedOutDir = outDir ? resolve(outDir) : null;
  const timeline = await loadJsonOrObject(timelineInput, 'timeline');
  const eventTrack = await loadJsonOrObject(eventTrackInput, 'eventTrack');

  const checks = [];
  const findings = [];
  const addCheck = (name, ok, message, extra = {}) => {
    checks.push({ name, ok: Boolean(ok), message, ...extra });
  };
  const addFinding = (severity, category, message, extra = {}) => {
    findings.push({ source: 'deterministic', severity, category, message, ...extra });
  };

  // 1. ffprobe metadata & file size validation
  const probe = await probeVideoDetails(videoFile);
  const profileExpected =
    outputId && Array.isArray(timeline?.outputs)
      ? timeline.outputs.find((o) => o.id === outputId) ?? {}
      : {};
  const mergedExpected = { ...profileExpected, ...expected };

  const minBytes = mergedExpected.minBytes ?? 1;
  const maxBytes = mergedExpected.maxBytes;
  const sizeOk = probe.fileSizeBytes >= minBytes && (maxBytes === undefined || probe.fileSizeBytes <= maxBytes);
  addCheck(
    'file-size',
    sizeOk,
    sizeOk
      ? `file size ${probe.fileSizeBytes} bytes`
      : `file size ${probe.fileSizeBytes} bytes outside [${minBytes}, ${maxBytes ?? '∞'}]`
  );
  if (!sizeOk) {
    addFinding('error', 'file-size', `Video file size ${probe.fileSizeBytes} bytes failed bounds check`);
  }

  const probeBasicOk =
    probe.width > 0 &&
    probe.height > 0 &&
    probe.frames > 0 &&
    probe.duration > 0 &&
    probe.fps > 0 &&
    Boolean(probe.codec);

  const probeFailures = [];
  if (!probeBasicOk) {
    probeFailures.push(
      `invalid video stream metadata (${probe.width}x${probe.height}, ${probe.frames} frames, ${probe.duration}s, ${probe.fps} fps, codec=${probe.codec || 'none'})`
    );
  }
  if (mergedExpected.width && probe.width !== mergedExpected.width) {
    probeFailures.push(`width ${probe.width} != expected ${mergedExpected.width}`);
  }
  if (mergedExpected.height && probe.height !== mergedExpected.height) {
    probeFailures.push(`height ${probe.height} != expected ${mergedExpected.height}`);
  }
  if (mergedExpected.codec && probe.codec !== mergedExpected.codec) {
    probeFailures.push(`codec ${probe.codec} != expected ${mergedExpected.codec}`);
  }
  if (isFiniteNumber(mergedExpected.fps)) {
    const fpsTol = mergedExpected.fpsTolerance ?? 0.5;
    if (Math.abs(probe.fps - mergedExpected.fps) > fpsTol) {
      probeFailures.push(`fps ${probe.fps} outside expected ${mergedExpected.fps} ± ${fpsTol}`);
    }
  }
  if (isFiniteNumber(mergedExpected.minFps) && probe.fps < mergedExpected.minFps) {
    probeFailures.push(`fps ${probe.fps} below minimum ${mergedExpected.minFps}`);
  }
  if (isFiniteNumber(mergedExpected.duration)) {
    const durTol = mergedExpected.durationTolerance ?? 0.25;
    if (Math.abs(probe.duration - mergedExpected.duration) > durTol) {
      probeFailures.push(`duration ${probe.duration}s outside expected ${mergedExpected.duration}s ± ${durTol}s`);
    }
  }
  if (isFiniteNumber(mergedExpected.minDuration) && probe.duration < mergedExpected.minDuration) {
    probeFailures.push(`duration ${probe.duration}s below minimum ${mergedExpected.minDuration}s`);
  }
  if (isFiniteNumber(mergedExpected.maxDuration) && probe.duration > mergedExpected.maxDuration) {
    probeFailures.push(`duration ${probe.duration}s exceeds maximum ${mergedExpected.maxDuration}s`);
  }

  const probeOk = probeFailures.length === 0;
  addCheck(
    'ffprobe',
    probeOk,
    probeOk
      ? `${probe.width}x${probe.height}, ${probe.fps} fps, ${probe.duration}s, ${probe.frames} frames, ${probe.codec}`
      : probeFailures.join('; ')
  );
  for (const reason of probeFailures) {
    addFinding('error', 'ffprobe', reason);
  }

  // 2. Capture gap / frame-drop detection via PTS deltas
  const frameTiming = await probeFrameTimestamps(videoFile, {
    ...gapOptions,
    nominalFps: probe.nominalFps || probe.fps,
  });
  const gapsEnabled = gapOptions.enabled !== false;
  const maxDroppedFrames = gapOptions.maxDroppedFrames ?? 0;
  const gapsOk = !gapsEnabled || frameTiming.totalMissedFrames <= maxDroppedFrames;
  addCheck(
    'capture-gaps',
    gapsOk,
    gapsOk
      ? `no capture gaps detected (${frameTiming.ptsCount} frames, max delta ${frameTiming.maxDeltaMs} ms)`
      : `detected ${frameTiming.gaps.length} capture gap(s) (~${frameTiming.totalMissedFrames} missed frame(s), max delta ${frameTiming.maxDeltaMs} ms > ${frameTiming.thresholdMs} ms)`,
    { skipped: !gapsEnabled }
  );
  if (!gapsOk) {
    for (const gap of frameTiming.gaps) {
      addFinding(
        'error',
        'capture-gap',
        `Capture gap of ${gap.deltaMs} ms (~${gap.missedFrames} missed frame(s)) between ${gap.fromTime}s and ${gap.toTime}s`,
        { timestamp: gap.fromTime, details: gap }
      );
    }
  }

  // 3. Freeze frame & black frame detection via FFmpeg filters
  const signalDetection = await detectFreezeAndBlackFrames(videoFile, {
    duration: probe.duration,
    freeze: freezeOptions,
    black: blackOptions,
  });

  const freezeOk = !signalDetection.freeze.enabled || signalDetection.freeze.segments.length === 0;
  addCheck(
    'freeze-frames',
    freezeOk,
    freezeOk
      ? `no frozen segments >= ${signalDetection.freeze.minDuration}s`
      : `detected ${signalDetection.freeze.segments.length} frozen segment(s) totaling ${signalDetection.freeze.totalFrozenSeconds}s`,
    { skipped: !signalDetection.freeze.enabled }
  );
  if (!freezeOk) {
    for (const seg of signalDetection.freeze.segments) {
      addFinding(
        'error',
        'freeze-frame',
        `Frozen frames detected from ${seg.start}s to ${seg.end}s (${seg.duration}s)`,
        { timestamp: seg.start, details: seg }
      );
    }
  }

  const blackOk = !signalDetection.black.enabled || signalDetection.black.segments.length === 0;
  addCheck(
    'black-frames',
    blackOk,
    blackOk
      ? `no black segments >= ${signalDetection.black.minDuration}s`
      : `detected ${signalDetection.black.segments.length} black segment(s) totaling ${signalDetection.black.totalBlackSeconds}s`,
    { skipped: !signalDetection.black.enabled }
  );
  if (!blackOk) {
    for (const seg of signalDetection.black.segments) {
      addFinding(
        'error',
        'black-frame',
        `Black frames detected from ${seg.start}s to ${seg.end}s (${seg.duration}s)`,
        { timestamp: seg.start, details: seg }
      );
    }
  }

  // 4. Camera bounds & timeline validation
  let cameraReport = {
    ok: true,
    checked: false,
    timelineValid: true,
    schemaErrors: [],
    cameraBoundsErrors: [],
    keyframes: 0,
    samplesChecked: 0,
  };
  if (timeline) {
    cameraReport = { ...verifyCameraBounds(timeline), checked: true };
    const boundsOk = cameraReport.cameraBoundsErrors.length === 0;
    addCheck(
      'camera-bounds',
      boundsOk,
      boundsOk
        ? `camera viewport stays inside stage across ${cameraReport.keyframes} keyframe(s)`
        : cameraReport.cameraBoundsErrors.join('; ')
    );
    for (const err of cameraReport.cameraBoundsErrors) {
      addFinding('error', 'camera-bounds', err);
    }
    if (cameraReport.schemaErrors.length > 0) {
      addCheck('timeline-schema', false, cameraReport.schemaErrors.join('; '));
      for (const err of cameraReport.schemaErrors) {
        addFinding('error', 'timeline-schema', err);
      }
    }
  } else {
    addCheck('camera-bounds', true, 'no timeline provided; skipped camera bounds check', { skipped: true });
  }

  // 5. Per-step stills extraction, contact sheet, and baseline diff
  const artifacts = {
    outDir: resolvedOutDir,
    report: null,
    stills: [],
    contactSheet: null,
    diffs: [],
  };

  let baselineReport = {
    checked: false,
    ok: true,
    compared: 0,
    mismatches: 0,
    maxChangedRatio: 0,
    maxDiffRatio: baselineMaxDiff,
    diffs: [],
  };

  if (resolvedOutDir) {
    await mkdir(resolvedOutDir, { recursive: true });
    const targets = resolveStillTargets({
      timeline,
      eventTrack,
      duration: probe.duration,
      timestamps,
      stillCount,
    });
    artifacts.stills = await extractStills({ video: videoFile, targets, outDir: resolvedOutDir });
    artifacts.contactSheet = await generateContactSheet({
      stills: artifacts.stills,
      outputFile: join(resolvedOutDir, 'contact-sheet.png'),
      ...contactSheetOptions,
    });

    if (baseline) {
      baselineReport = {
        ...(await diffStillsAgainstBaseline({
          stills: artifacts.stills,
          baselineDir: baseline,
          outDir: resolvedOutDir,
          maxDiffRatio: baselineMaxDiff,
        })),
        checked: true,
      };
      artifacts.diffs = baselineReport.diffs;
      addCheck(
        'baseline-diff',
        baselineReport.ok,
        baselineReport.ok
          ? `all ${baselineReport.compared} step still(s) within ${(baselineMaxDiff * 100).toFixed(2)}% of baseline (max ${(baselineReport.maxChangedRatio * 100).toFixed(2)}%)`
          : `${baselineReport.mismatches} of ${baselineReport.compared} step still(s) diverged from baseline (max ${(baselineReport.maxChangedRatio * 100).toFixed(2)}%)`
      );
      for (const diff of baselineReport.diffs) {
        if (!diff.ok) {
          addFinding('error', 'baseline-diff', `Step ${diff.index} (${diff.label}): ${diff.reason}`, {
            timestamp: diff.t,
            details: {
              filename: diff.filename,
              changedRatio: diff.changedRatio,
              diffFile: diff.diffFile,
            },
          });
        }
      }
    }
  }

  // 6. Cursor accuracy check (observed samples, image-based marker locator, or event-track cross-check)
  let resolvedCursorSamples = cursorSamples;
  if (!resolvedCursorSamples && cursorDetection && timeline?.overlays?.cursor?.enabled) {
    const sampleTimes = Array.isArray(cursorDetection.timestamps) && cursorDetection.timestamps.length > 0
      ? cursorDetection.timestamps
      : (timeline.overlays.cursor.samples ?? []).map((s) => s.t);

    const ephemeralDir = resolvedOutDir ? null : await mkdtemp(join(tmpdir(), 'screen-kit-cursor-'));
    const frameDir = resolvedOutDir ? join(resolvedOutDir, 'cursor-frames') : ephemeralDir;
    await mkdir(frameDir, { recursive: true });

    try {
      const detectedSamples = [];
      for (let i = 0; i < sampleTimes.length; i += 1) {
        const t = sampleTimes[i];
        const clampedT = Math.max(0, Math.min(t, Math.max(0, probe.duration - 0.04)));
        const framePath = join(frameDir, `cursor-${padIndex(i)}.png`);
        await extractFramePng(videoFile, clampedT, framePath);
        let locateOptions = cursorDetection;
        if (!cursorDetection.region && isFiniteNumber(cursorDetection.searchRadius) && cursorDetection.searchRadius > 0) {
          const vp = sampleCursor(timeline.overlays.cursor, t);
          if (vp) {
            const expectedPt = projectViewportToScreen(vp.x, vp.y, timeline, t);
            const scaleX = probe.width && timeline.camera?.outputWidth ? probe.width / timeline.camera.outputWidth : 1;
            const scaleY = probe.height && timeline.camera?.outputHeight ? probe.height / timeline.camera.outputHeight : 1;
            const r = cursorDetection.searchRadius;
            locateOptions = {
              ...cursorDetection,
              region: {
                x: expectedPt.x * scaleX - r,
                y: expectedPt.y * scaleY - r,
                width: r * 2,
                height: r * 2,
              },
            };
          }
        }
        const locatorResult =
          typeof cursorDetection.locateFn === 'function'
            ? await cursorDetection.locateFn(framePath, { t, index: i, timeline })
            : await locateCursorMarker(framePath, locateOptions);
        detectedSamples.push({
          t,
          x: locatorResult?.x ?? null,
          y: locatorResult?.y ?? null,
          found: Boolean(locatorResult?.found),
        });
      }
      resolvedCursorSamples = detectedSamples;
    } finally {
      if (ephemeralDir) await rm(ephemeralDir, { recursive: true, force: true });
    }
  }

  const cursorReport = verifyCursorAccuracy({
    timeline,
    eventTrack,
    cursorSamples: resolvedCursorSamples,
    thresholdPx: cursorThresholdPx,
    outputWidth: probe.width || undefined,
    outputHeight: probe.height || undefined,
  });

  if (cursorReport.checked) {
    addCheck(
      'cursor-accuracy',
      cursorReport.ok,
      cursorReport.ok
        ? `cursor within ${cursorReport.thresholdPx} px across ${cursorReport.samplesChecked} sample(s) (max error ${cursorReport.maxErrorPx} px, mode=${cursorReport.mode})`
        : `${cursorReport.violations.length} cursor sample(s) exceeded ${cursorReport.thresholdPx} px threshold (max error ${cursorReport.maxErrorPx} px)`,
      { details: { mode: cursorReport.mode, maxErrorPx: cursorReport.maxErrorPx } }
    );
    for (const violation of cursorReport.violations) {
      const msg = violation.reason
        ? `Cursor at t=${violation.t}s: ${violation.reason}`
        : `Cursor drift ${violation.distancePx} px > ${cursorReport.thresholdPx} px at t=${violation.t}s (expected ${violation.expected.x},${violation.expected.y}; actual ${violation.actual.x},${violation.actual.y})`;
      addFinding('error', 'cursor-accuracy', msg, {
        timestamp: violation.t,
        details: violation,
      });
    }
  } else {
    addCheck('cursor-accuracy', true, `cursor accuracy check skipped (${cursorReport.mode})`, { skipped: true });
  }

  // 6b. Optional narration & caption checks (only when captions/audio tracks are active or explicitly enabled)
  const hasTimelineCaptions = Boolean(timeline?.overlays?.captions?.enabled);
  const hasTimelineAudio = Array.isArray(timeline?.audio?.tracks) && timeline.audio.tracks.length > 0;
  const shouldReviewNarration =
    narrationOptions?.enabled !== false &&
    (Boolean(narrationOptions?.enabled) || hasTimelineCaptions || hasTimelineAudio);

  let narrationReport = null;
  if (shouldReviewNarration) {
    const narrationBaseDir =
      narrationOptions?.baseDir ??
      (typeof timelineInput === 'string' ? dirname(resolve(timelineInput)) : dirname(videoFile));
    const checkVideoAudio =
      narrationOptions?.checkVideoAudio ?? (probe.audio || hasTimelineAudio);
    narrationReport = await reviewNarration({
      ...(checkVideoAudio ? { video: videoFile } : {}),
      ...(narrationOptions?.audioFiles ? { audioFiles: narrationOptions.audioFiles } : {}),
      timeline,
      ...(narrationOptions?.cues ? { cues: narrationOptions.cues } : {}),
      ...(narrationOptions?.captionTracks ? { captionTracks: narrationOptions.captionTracks } : {}),
      ...(narrationOptions?.steps ? { steps: narrationOptions.steps } : {}),
      ...(narrationOptions?.segments ? { segments: narrationOptions.segments } : {}),
      totalDuration: probe.duration,
      baseDir: narrationBaseDir,
      loudness: narrationOptions?.loudness,
      captionRules: narrationOptions?.captionRules,
      stepFit: narrationOptions?.stepFit,
    });
    for (const check of narrationReport.checks) {
      checks.push(check);
    }
    for (const finding of narrationReport.findings) {
      findings.push(finding);
    }
  }

  const metrics = {
    fileSizeBytes: probe.fileSizeBytes,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    nominalFps: probe.nominalFps,
    duration: probe.duration,
    frames: probe.frames,
    codec: probe.codec,
    audio: probe.audio,
    frameTiming,
    freeze: signalDetection.freeze,
    black: signalDetection.black,
    camera: {
      checked: cameraReport.checked,
      keyframes: cameraReport.keyframes,
      samplesChecked: cameraReport.samplesChecked,
      violations: cameraReport.cameraBoundsErrors.length,
    },
    cursor: {
      checked: cursorReport.checked,
      mode: cursorReport.mode,
      thresholdPx: cursorReport.thresholdPx,
      samplesChecked: cursorReport.samplesChecked,
      maxErrorPx: cursorReport.maxErrorPx,
      meanErrorPx: cursorReport.meanErrorPx,
      violations: cursorReport.violations.length,
    },
    baseline: {
      checked: baselineReport.checked,
      compared: baselineReport.compared,
      maxChangedRatio: baselineReport.maxChangedRatio,
      maxDiffRatio: baselineReport.maxDiffRatio,
      mismatches: baselineReport.mismatches,
    },
    ...(narrationReport ? { narration: narrationReport.metrics } : {}),
  };

  // 7. Optional multimodal agent review hook (never runs implicitly when disabled or without credentials)
  const deterministicOk = checks.every((c) => c.ok);
  const multimodalPayload = {
    video: videoFile,
    contactSheet: artifacts.contactSheet?.file ?? null,
    stills: artifacts.stills.map(({ index, t, label, file }) => ({ index, t, label, file })),
    timelineSummary: summarizeTimeline(timeline, metrics),
    deterministicReport: {
      ok: deterministicOk,
      checks: [...checks],
      metrics,
      findings: [...findings],
    },
    prompt: multimodal?.prompt ?? DEFAULT_MULTIMODAL_PROMPT,
  };

  const multimodalResult = await runMultimodalReview({
    payload: multimodalPayload,
    multimodal,
  });

  if (multimodalResult.enabled) {
    if (multimodalResult.skipped) {
      addCheck('multimodal', true, multimodalResult.reason ?? 'multimodal review skipped', { skipped: true });
    } else {
      for (const finding of multimodalResult.findings) {
        findings.push(finding);
      }
      const errorCount = multimodalResult.findings.filter((f) => f.severity === 'error').length;
      addCheck(
        'multimodal',
        multimodalResult.ok,
        multimodalResult.ok
          ? multimodalResult.summary ?? `multimodal review passed (${multimodalResult.findings.length} finding(s))`
          : multimodalResult.summary ?? `multimodal review reported ${errorCount} error finding(s)`
      );
    }
  }

  const report = {
    version: 1,
    ok: checks.every((c) => c.ok),
    video: videoFile,
    checks,
    metrics,
    artifacts,
    findings,
    multimodal: {
      enabled: multimodalResult.enabled,
      ran: multimodalResult.ran,
      ...(multimodalResult.provider ? { provider: multimodalResult.provider } : {}),
      ...(multimodalResult.skipped ? { skipped: true } : {}),
      ...(multimodalResult.reason ? { reason: multimodalResult.reason } : {}),
      ...(multimodalResult.summary ? { summary: multimodalResult.summary } : {}),
    },
  };

  if (resolvedOutDir) {
    const reportPath = join(resolvedOutDir, 'review.json');
    report.artifacts.report = reportPath;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }

  return report;
}
