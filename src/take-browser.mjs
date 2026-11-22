import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { helpers, storyUrl } from './browser.mjs';
import { hash } from './run.mjs';
import {
  GESTURE_KINDS as TIMELINE_GESTURE_KINDS,
  validateEventTrack as checkEventTrackSchema,
} from './timeline.mjs';
import { probeVideo } from './video.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));
const roundTime = (seconds) => Math.max(0, Number(seconds.toFixed(4)));
const roundCoord = (px) => Number(px.toFixed(2));

export const CAPTURE_MODES = Object.freeze(['quality', 'headless']);
const BUTTONS = new Set(['left', 'middle', 'right']);
const WHEEL_PHASES = new Set([
  'began',
  'changed',
  'stationary',
  'ended',
  'cancelled',
  'mayBegin',
  'maybegin',
  'none',
]);
const GESTURE_KINDS = new Set(TIMELINE_GESTURE_KINDS);
const KEY_ACTIONS = new Set(['press', 'down', 'up']);
const MODIFIER_MAP = new Map([
  ['meta', 'Meta'], ['cmd', 'Meta'], ['command', 'Meta'], ['super', 'Meta'],
  ['control', 'Control'], ['ctrl', 'Control'],
  ['alt', 'Alt'], ['option', 'Alt'], ['opt', 'Alt'],
  ['shift', 'Shift'],
]);
const VALID_MODIFIERS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

export function validateCaptureMode(mode) {
  if (typeof mode !== 'string' || !CAPTURE_MODES.includes(mode)) {
    throw Error(`Invalid capture mode: ${JSON.stringify(mode)}; expected "quality" or "headless"`);
  }
  return mode;
}

/** Flash & Hogan (1985) minimum-jerk progress profile: s(u) = 10u^3 - 15u^4 + 6u^5. */
export function minimumJerk(u) {
  if (!Number.isFinite(u)) throw Error(`Invalid minimum-jerk parameter: ${u}`);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

function toPointTuple(point, label = 'point') {
  if (Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) {
    return [point[0], point[1]];
  }
  if (point && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    return [point.x, point.y];
  }
  throw Error(`Invalid ${label}: expected [x, y] or { x, y } with finite CSS coordinates`);
}

function defaultMoveDuration(distance) {
  if (distance < 0.5) return 0;
  return Math.min(0.75, Math.max(0.18, 0.18 + distance * 0.00045));
}

/** Sample a minimum-jerk pointer trajectory in CSS pixels with optional slight quadratic arc. */
export function minimumJerkTrajectory({
  from,
  to,
  duration,
  sampleRate = 60,
  startTime = 0,
  arc = 0.08,
  includeStart = true,
} = {}) {
  const [x0, y0] = toPointTuple(from, 'from');
  const [x1, y1] = toPointTuple(to, 'to');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 240) {
    throw Error(`Invalid trajectory sampleRate: ${sampleRate}`);
  }
  if (!Number.isFinite(startTime) || startTime < 0) {
    throw Error(`Invalid trajectory startTime: ${startTime}`);
  }
  if (!Number.isFinite(arc)) throw Error(`Invalid trajectory arc: ${arc}`);

  const dx = x1 - x0;
  const dy = y1 - y0;
  const distance = Math.hypot(dx, dy);
  const resolvedDuration = duration ?? defaultMoveDuration(distance);
  if (!Number.isFinite(resolvedDuration) || resolvedDuration < 0) {
    throw Error(`Invalid trajectory duration: ${resolvedDuration}`);
  }

  if (resolvedDuration === 0) {
    return [{ t: roundTime(startTime), x: roundCoord(x1), y: roundCoord(y1) }];
  }

  const steps = Math.max(1, Math.round(resolvedDuration * sampleRate));
  const cx = x0 + dx / 2 - dy * arc;
  const cy = y0 + dy / 2 + dx * arc;
  const samples = [];
  let prevT = roundTime(startTime);

  for (let i = includeStart ? 0 : 1; i <= steps; i++) {
    const u = i / steps;
    const s = minimumJerk(u);
    const q = 1 - s;
    const rawX = i === 0 ? x0 : i === steps ? x1 : q * q * x0 + 2 * q * s * cx + s * s * x1;
    const rawY = i === 0 ? y0 : i === steps ? y1 : q * q * y0 + 2 * q * s * cy + s * s * y1;
    const t = Math.max(prevT, roundTime(startTime + u * resolvedDuration));
    prevT = t;
    samples.push({ t, x: roundCoord(rawX), y: roundCoord(rawY) });
  }
  return samples;
}

/** Validate an Event Track v1 object against the unified schema and monotonicity invariants. */
export function validateEventTrack(track) {
  if (!track || typeof track !== 'object' || Array.isArray(track)) {
    throw Error('Event track must be an object');
  }
  if (track.version !== 1) {
    throw Error(`Unsupported event track version: ${track.version}; expected 1`);
  }
  validateCaptureMode(track.captureMode);

  const vp = track.viewport;
  if (
    !vp || typeof vp !== 'object' ||
    !Number.isInteger(vp.width) || vp.width <= 0 ||
    !Number.isInteger(vp.height) || vp.height <= 0 ||
    !Number.isFinite(vp.deviceScaleFactor) || vp.deviceScaleFactor <= 0
  ) {
    throw Error('Event track viewport requires positive integer width/height and positive deviceScaleFactor');
  }

  const vid = track.video;
  if (
    !vid || typeof vid !== 'object' ||
    typeof vid.file !== 'string' || !vid.file.trim() ||
    !Number.isInteger(vid.width) || vid.width <= 0 ||
    !Number.isInteger(vid.height) || vid.height <= 0 ||
    !Number.isFinite(vid.fps) || vid.fps <= 0 ||
    !Number.isFinite(vid.duration) || vid.duration <= 0 ||
    !Number.isInteger(vid.frames) || vid.frames <= 0
  ) {
    throw Error('Event track video requires file, positive integer width/height/frames, and positive fps/duration');
  }

  if (typeof track.startedAt !== 'string' || Number.isNaN(Date.parse(track.startedAt))) {
    throw Error('Event track startedAt must be a valid ISO timestamp');
  }

  const unified = checkEventTrackSchema(track);
  if (!unified.ok) {
    throw Error(unified.errors.join('; '));
  }

  for (let i = 0; i < track.events.length; i++) {
    const event = track.events[i];
    if ((event.type === 'pointerdown' || event.type === 'pointerup') && !BUTTONS.has(event.button)) {
      throw Error(`Event[${i}] ${event.type} requires finite x, y and valid button`);
    }
    if (event.type === 'key' && (!Array.isArray(event.modifiers) || event.modifiers.some((m) => !VALID_MODIFIERS.has(m)) || !KEY_ACTIONS.has(event.action))) {
      throw Error(`Event[${i}] key requires non-empty key, canonical modifiers array and valid action`);
    }
  }

  return track;
}

export function serializeEventTrack(track) {
  validateEventTrack(track);
  return JSON.stringify(track, null, 2) + '\n';
}

function candidateExecutablesInDir(baseDir, subdirPrefix, relativePaths) {
  if (!baseDir || !existsSync(baseDir)) return [];
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(subdirPrefix))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
  const found = [];
  for (const dir of entries) {
    for (const rel of relativePaths) {
      const candidate = join(baseDir, dir, rel);
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

/**
 * Resolve a local Chromium binary cleanly without relying on any sibling repo checkout.
 * Checks explicit overrides, Playwright's configured executable, Playwright browser caches,
 * agent-browser's downloaded Chrome for Testing cache, and standard system installations.
 */
export function resolveChromiumExecutable({
  playwrightChromium,
  executablePath,
  env = process.env,
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
} = {}) {
  const explicit = executablePath ?? env.SCREEN_KIT_CHROMIUM_PATH ?? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) {
    const resolved = resolve(explicit);
    if (!exists(resolved)) throw Error(`Configured Chromium executable does not exist: ${resolved}`);
    return resolved;
  }

  if (playwrightChromium && typeof playwrightChromium.executablePath === 'function') {
    try {
      const pwDefault = playwrightChromium.executablePath();
      if (pwDefault && exists(pwDefault)) return pwDefault;
    } catch {
      // Fall through to cache discovery.
    }
  }

  const macRelatives = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ];
  const linuxRelatives = [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome',
  ];
  const winRelatives = [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome.exe',
  ];
  const relatives = platform === 'darwin' ? macRelatives : platform === 'win32' ? winRelatives : linuxRelatives;

  const pwCacheDir = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? resolve(env.PLAYWRIGHT_BROWSERS_PATH)
    : platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'ms-playwright')
      : platform === 'win32'
        ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright')
        : join(home, '.cache', 'ms-playwright');

  const agentBrowserDir = join(env.AGENT_BROWSER_HOME ?? join(home, '.agent-browser'), 'browsers');

  for (const candidate of [
    ...candidateExecutablesInDir(pwCacheDir, 'chromium-', relatives),
    ...candidateExecutablesInDir(agentBrowserDir, 'chrome-', relatives),
  ]) {
    if (exists(candidate)) return candidate;
  }

  const systemPaths = platform === 'darwin'
    ? [
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : platform === 'linux'
      ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
      : [];

  for (const sysPath of systemPaths) {
    if (exists(sysPath)) return sysPath;
  }

  throw Error(
    'No local Chromium executable found. Run `npx playwright install chromium` or `agent-browser install`, ' +
    'or set SCREEN_KIT_CHROMIUM_PATH.'
  );
}

/** macOS JXA focus handback per docs/research/retina-spike.md so headful Retina capture stays behind the owner's windows. */
export function createMacFocusController({ platform = process.platform, runExec = exec } = {}) {
  if (platform !== 'darwin') {
    return {
      async captureFrontmost() { return null; },
      async restoreFrontmost() { return false; },
    };
  }
  return {
    async captureFrontmost() {
      try {
        const { stdout } = await runExec('osascript', [
          '-l', 'JavaScript',
          '-e', 'ObjC.import("AppKit"); const a = $.NSWorkspace.sharedWorkspace.frontmostApplication; a && a.bundleIdentifier ? a.bundleIdentifier.js : "";',
        ], { timeout: 5000 });
        const bundleId = stdout.trim();
        return bundleId || null;
      } catch {
        return null;
      }
    },
    async restoreFrontmost(bundleId) {
      if (!bundleId || bundleId === 'com.google.Chrome.for.testing') return false;
      try {
        await runExec('osascript', [
          '-l', 'JavaScript',
          '-e', 'function run(argv) { ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]); return a.count ? Boolean(a.objectAtIndex(0).activateWithOptions(0)) : false; }',
          bundleId,
        ], { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function normalizeViewport(viewport = [1440, 810], deviceScaleFactor = 1) {
  let width, height, dsf = deviceScaleFactor;
  if (Array.isArray(viewport)) {
    [width, height] = viewport;
  } else if (viewport && typeof viewport === 'object') {
    width = viewport.width;
    height = viewport.height;
    if (viewport.deviceScaleFactor !== undefined) dsf = viewport.deviceScaleFactor;
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 7680 || height > 4320) {
    throw Error(`Invalid browser viewport: ${JSON.stringify(viewport)}`);
  }
  if (!Number.isFinite(dsf) || dsf <= 0 || dsf > 4) {
    throw Error(`Invalid deviceScaleFactor: ${dsf}`);
  }
  return { width, height, deviceScaleFactor: dsf };
}

function parseKeySpec(rawKey, rawModifiers = []) {
  if (typeof rawKey !== 'string' || !rawKey.length) throw Error('Keyboard step requires a non-empty key string');
  const modifiers = [];
  const addMod = (token) => {
    const canonical = MODIFIER_MAP.get(String(token).toLowerCase());
    if (!canonical) throw Error(`Unsupported key modifier: ${token}`);
    if (!modifiers.includes(canonical)) modifiers.push(canonical);
  };
  for (const mod of rawModifiers) addMod(mod);

  if (rawKey.includes('+') && rawKey.length > 1) {
    const parts = rawKey.split('+');
    const mainKey = parts.pop();
    for (const part of parts) addMod(part);
    return { key: mainKey, modifiers };
  }
  return { key: rawKey, modifiers };
}

async function waitForPageReady(page, recipe) {
  const selector = recipe.ready ?? (recipe.story ? '#storybook-root' : 'body');
  const timeout = recipe.readyTimeout ?? 20000;
  const checkStoryChildren = Boolean(recipe.story && !recipe.ready);
  await page.evaluate(async ({ sel, limit, storyChildren }) => {
    const until = async (test, label) => {
      const deadline = Date.now() + limit;
      while (!test()) {
        if (Date.now() > deadline) throw Error(`Capture readiness timed out: ${label}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until(() => {
      const el = document.querySelector(sel);
      return storyChildren ? Boolean(el?.childElementCount) : Boolean(el);
    }, 'mounted content');
    await Promise.race([
      document.fonts.ready,
      new Promise((_, reject) => setTimeout(() => reject(Error('Fonts did not load')), limit)),
    ]);
    for (const image of document.images) image.loading = 'eager';
    await until(() => [...document.images].every((img) => img.complete), 'images');
    if ([...document.images].some((img) => !img.naturalWidth)) throw Error('An image failed to load');
    await Promise.all([...document.images].map((img) => img.decode()));
    await new Promise((r) => setTimeout(r, 100));
  }, { sel: selector, limit: timeout, storyChildren: checkStoryChildren });
}

async function resolveTargetPoint(page, target, fallbackPoint) {
  if (target === undefined || target === null) {
    if (fallbackPoint) return fallbackPoint;
    throw Error('Step requires a target selector or coordinates');
  }
  if (Array.isArray(target) || (typeof target === 'object' && Number.isFinite(target.x) && Number.isFinite(target.y))) {
    return toPointTuple(target, 'target');
  }
  if (typeof target === 'string') {
    const point = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return null;
      return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    }, target);
    if (!point) throw Error(`Target selector matched no visible element: ${target}`);
    return [roundCoord(point[0]), roundCoord(point[1])];
  }
  throw Error(`Unsupported target specification: ${JSON.stringify(target)}`);
}

async function runPrepAction(page, action) {
  if (typeof action === 'string') {
    await page.evaluate(`(async () => { ${helpers}\n${action}\n })()`);
    return;
  }
  if (Array.isArray(action)) {
    const [cmd, ...rest] = action;
    if (cmd === 'click' && rest[0]) {
      const [x, y] = await resolveTargetPoint(page, rest[0]);
      await page.mouse.click(x, y);
      return;
    }
    if (cmd === 'press' && rest[0]) {
      await page.keyboard.press(String(rest[0]));
      return;
    }
    throw Error(`Unsupported preparation command array: ${JSON.stringify(action)}`);
  }
  if (action && typeof action === 'object') {
    if (action.eval) {
      await page.evaluate(`(async () => { ${helpers}\n${action.eval}\n })()`);
      return;
    }
    if (action.click) {
      const [x, y] = await resolveTargetPoint(page, action.click);
      await page.mouse.click(x, y);
      return;
    }
    if (action.key) {
      const { key, modifiers } = parseKeySpec(action.key, action.modifiers);
      await page.keyboard.press([...modifiers, key].join('+'));
      return;
    }
    if (action.wait !== undefined) {
      await sleep(action.wait);
      return;
    }
    if (action.pause !== undefined) {
      await sleep(action.pause * 1000);
      return;
    }
  }
  throw Error(`Invalid preparation action: ${JSON.stringify(action)}`);
}

function orderRawScreencastFrames(rawFrames = []) {
  const withValidTs = rawFrames.filter((f) => Number.isFinite(f.cdpTimestamp));
  if (withValidTs.length === rawFrames.length && rawFrames.length > 0) {
    const sorted = [...rawFrames].sort((a, b) => a.cdpTimestamp - b.cdpTimestamp || a.index - b.index);
    const offset = Math.min(...sorted.map((f) => f.elapsed - f.cdpTimestamp));
    return sorted.map((f) => ({ ...f, t: Math.max(0, f.cdpTimestamp + offset) }));
  }
  return [...rawFrames]
    .sort((a, b) => a.elapsed - b.elapsed || a.index - b.index)
    .map((f) => ({ ...f, t: Math.max(0, f.elapsed) }));
}

/**
 * Compute honest raw screencast frame timing and inter-frame gap statistics
 * before temporary frame files are deleted or resampled to CFR.
 */
export function computeRawCaptureStats({
  rawFrames = [],
  elapsedDuration = 0,
  requestedFps = 60,
  truncated = false,
  durationExceeded = false,
} = {}) {
  const ordered = orderRawScreencastFrames(rawFrames);
  const safeElapsed = Math.max(0, Number.isFinite(elapsedDuration) ? elapsedDuration : 0);
  const count = ordered.length;
  const firstFrameAt = count > 0 ? roundTime(ordered[0].t) : null;
  const lastFrameAt = count > 0 ? roundTime(ordered.at(-1).t) : null;
  const rawFps = safeElapsed > 0 ? Number((count / safeElapsed).toFixed(2)) : 0;

  const twoFrameThresholdSec = requestedFps > 0 ? 2 / requestedFps : Infinity;
  let maxGapSec = count === 0 ? safeElapsed : 0;
  let gapsOver2Frames = count === 0 && safeElapsed > twoFrameThresholdSec + 1e-6 ? 1 : 0;

  for (let i = 1; i < count; i++) {
    const dt = Math.max(0, ordered[i].t - ordered[i - 1].t);
    if (dt > maxGapSec) maxGapSec = dt;
    if (dt > twoFrameThresholdSec + 1e-6) {
      gapsOver2Frames += 1;
    }
  }

  return {
    rawFrames: count,
    firstFrameAt,
    lastFrameAt,
    elapsedDuration: roundTime(safeElapsed),
    rawFps,
    maxGapMs: Number((maxGapSec * 1000).toFixed(3)),
    gapsOver2Frames,
    truncated: Boolean(truncated),
    ...(durationExceeded ? { durationExceeded: true } : {}),
  };
}

function escapeConcatPath(filePath) {
  return filePath.replaceAll("'", "'\\''");
}

export async function encodeScreencastFrames({
  initialFrameFile,
  rawFrames,
  framesDir,
  outputFile,
  format,
  fps,
  targetDuration,
  colorSpace = 'srgb',
  signal,
}) {
  if (!['srgb', 'p3'].includes(colorSpace)) {
    throw Error(`Unsupported browser take colorSpace: ${colorSpace}`);
  }

  const ordered = orderRawScreencastFrames(rawFrames);
  const rawStats = computeRawCaptureStats({
    rawFrames,
    elapsedDuration: targetDuration,
    requestedFps: fps,
  });

  const timeline = [];
  if (initialFrameFile && (!ordered.length || ordered[0].t > 0.02)) {
    timeline.push({ file: initialFrameFile, t: 0 });
  } else if (ordered.length) {
    ordered[0] = { ...ordered[0], t: 0 };
  }

  let truncated = false;
  for (const frame of ordered) {
    if (frame.t >= targetDuration && timeline.length > 0) {
      if (frame.t > targetDuration + 0.5 / fps) truncated = true;
      break;
    }
    if (timeline.length > 0 && frame.t - timeline.at(-1).t < 0.0005) {
      timeline[timeline.length - 1] = { file: frame.file, t: timeline.at(-1).t };
    } else {
      timeline.push(frame);
    }
  }

  if (!timeline.length) {
    throw Error('No screencast frames were captured');
  }

  const concatFile = join(framesDir, 'frames.concat.txt');
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < timeline.length; i++) {
    const current = timeline[i];
    const nextT = i + 1 < timeline.length ? timeline[i + 1].t : targetDuration;
    // Preserve sub-frame 120Hz ProMotion intervals rather than clamping up to 1/fps (which stretches time into slow-motion).
    const dur = Math.max(0.0005, nextT - current.t);
    lines.push(`file '${escapeConcatPath(current.file)}'`);
    lines.push(`duration ${dur.toFixed(6)}`);
  }
  lines.push(`file '${escapeConcatPath(timeline.at(-1).file)}'`);
  await writeFile(concatFile, lines.join('\n') + '\n');

  const temporary = join(framesDir, `encoded-${randomUUID()}.${format}`);
  const vfColor = colorSpace === 'p3'
    ? 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv'
    : 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
  const colorFlags = colorSpace === 'p3'
    ? ['-color_range', 'tv', '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709']
    : ['-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  const codec = format === 'mp4'
    ? [
        '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-profile:v', 'high',
        '-movflags', '+faststart',
      ]
    : [
        '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good',
        '-cpu-used', '2', '-row-mt', '1',
      ];

  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-t', targetDuration.toFixed(6),
    '-an',
    '-vf', `fps=${fps},pad=ceil(iw/2)*2:ceil(ih/2)*2,${vfColor}`,
    '-pix_fmt', 'yuv420p',
    ...codec,
    ...colorFlags,
    '-threads', '2',
    temporary,
  ], { signal, timeout: 300000, maxBuffer: 5e6 });

  const info = await probeVideo(temporary);
  if (!info.frames || !(info.duration > 0)) {
    throw Error('Video encoder produced an empty take');
  }
  await rename(temporary, outputFile);
  return { ...info, measuredFps: rawStats.rawFps, capturedFrames: rawFrames.length, truncated };
}

export async function createBrowserTakeCapture({
  cwd = process.cwd(),
  out,
  captureMode,
  scale,
  executablePath,
  playwright,
  focusController,
  encodeFrames = encodeScreencastFrames,
  signal,
} = {}) {
  if (!out) throw Error('Browser take capture needs an output directory');
  if (captureMode !== undefined) validateCaptureMode(captureMode);
  cwd = resolve(cwd);
  out = resolve(cwd, out);

  const focus = focusController ?? createMacFocusController();
  let activeBrowser = null;
  let activeContext = null;
  let activeCdp = null;

  async function cleanupActive() {
    const cdp = activeCdp;
    const context = activeContext;
    const browser = activeBrowser;
    activeCdp = null;
    activeContext = null;
    activeBrowser = null;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    }
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  async function capture(name, recipe = {}, base) {
    if (name !== undefined && !/^[\w][\w.-]*$/.test(name)) {
      throw Error(`Invalid recipe name: ${name}`);
    }
    if (recipe.frame || recipe.clip || (recipe.themes?.length ?? 1) > 1) {
      throw Error('Browser video takes require a single uncropped viewport');
    }

    const mode = captureMode !== undefined
      ? validateCaptureMode(captureMode)
      : 'captureMode' in recipe
        ? validateCaptureMode(recipe.captureMode)
        : 'headless';

    const format = recipe.format ?? recipe.output?.format ?? 'mp4';
    if (!['mp4', 'webm'].includes(format)) {
      throw Error(`Unsupported browser take video format: ${format}`);
    }

    const requestedFps = recipe.fps ?? 60;
    if (!Number.isInteger(requestedFps) || requestedFps < 1 || requestedFps > 120) {
      throw Error(`Invalid browser take fps: ${requestedFps}`);
    }
    if (recipe.duration !== undefined && (!Number.isFinite(recipe.duration) || recipe.duration <= 0 || recipe.duration > 600)) {
      throw Error(`Invalid browser take duration: ${recipe.duration}`);
    }

    const colorSpace = recipe.colorSpace ?? 'srgb';
    if (!['srgb', 'p3'].includes(colorSpace)) {
      throw Error(`Unsupported browser take colorSpace: ${colorSpace}`);
    }

    const defaultDsf = mode === 'quality' ? 2 : 1;
    const dsf = recipe.deviceScaleFactor ?? scale ?? recipe.scale ?? defaultDsf;
    const viewport = normalizeViewport(recipe.viewport ?? [1440, 810], dsf);
    const url = storyUrl(base ?? recipe.base, recipe, recipe.themes?.[0] ?? 'dark');

    await mkdir(out, { recursive: true });
    const framesDir = join(out, `.frames-${randomUUID()}`);
    await mkdir(framesDir, { recursive: true });

    const pw = playwright ?? await import('playwright-core');
    const chromium = pw.chromium;
    const resolvedExecutable = playwright ? executablePath : resolveChromiumExecutable({ playwrightChromium: chromium, executablePath });

    const launchArgs = [
      ...(mode === 'quality'
        ? [
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
          ]
        : []),
      ...(colorSpace === 'p3' ? ['--force-color-profile=display-p3-d65'] : []),
      ...(recipe.browserArgs ?? []),
    ];

    try {
      const previousFrontmost = mode === 'quality' ? await focus.captureFrontmost() : null;
      activeBrowser = await chromium.launch({
        headless: mode === 'headless',
        ...(resolvedExecutable ? { executablePath: resolvedExecutable } : {}),
        args: launchArgs,
      });

      activeContext = await activeBrowser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
      });
      const page = await activeContext.newPage();

      if (mode === 'quality' && previousFrontmost) {
        await focus.restoreFrontmost(previousFrontmost);
      }

      await page.goto(url, { waitUntil: 'load', timeout: recipe.readyTimeout ?? 30000 });
      if (mode === 'quality' && previousFrontmost) {
        await focus.restoreFrontmost(previousFrontmost);
        await sleep(150);
      }

      await waitForPageReady(page, recipe);
      for (const prep of recipe.prepare ?? []) await runPrepAction(page, prep);
      for (const setupAction of recipe.setup ?? []) await runPrepAction(page, setupAction);
      if ((recipe.prepare?.length ?? 0) + (recipe.setup?.length ?? 0) > 0) {
        await waitForPageReady(page, recipe);
      }

      const [initX, initY] = recipe.initialPointer
        ? toPointTuple(recipe.initialPointer, 'initialPointer')
        : [roundCoord(viewport.width / 2), roundCoord(viewport.height / 2)];
      let pointerX = initX;
      let pointerY = initY;
      await page.mouse.move(pointerX, pointerY);

      activeCdp = await activeContext.newCDPSession(page);
      const screencastFormat = recipe.screencastFormat ?? 'jpeg';
      if (!['jpeg', 'png'].includes(screencastFormat)) {
        throw Error(`Unsupported screencastFormat: ${screencastFormat}`);
      }
      const screencastQuality = recipe.screencastQuality ?? 94;
      const ext = screencastFormat === 'png' ? 'png' : 'jpg';

      const initialShot = await activeCdp.send('Page.captureScreenshot', {
        format: screencastFormat,
        ...(screencastFormat === 'jpeg' ? { quality: screencastQuality } : {}),
      });
      const initialFrameFile = join(framesDir, `init.${ext}`);
      await writeFile(initialFrameFile, Buffer.from(initialShot.data, 'base64'));

      const rawFrames = [];
      const pendingWrites = [];
      let nextFrameIndex = 1;
      let screencasting = true;
      let takeStartMs = performance.now();

      activeCdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        const elapsed = (performance.now() - takeStartMs) / 1000;
        activeCdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (!screencasting) return;
        const index = nextFrameIndex++;
        const file = join(framesDir, `f${String(index).padStart(6, '0')}.${ext}`);
        rawFrames.push({
          index,
          file,
          cdpTimestamp: metadata?.timestamp,
          elapsed,
        });
        pendingWrites.push(writeFile(file, Buffer.from(data, 'base64')));
      });

      await activeCdp.send('Page.startScreencast', {
        format: screencastFormat,
        ...(screencastFormat === 'jpeg' ? { quality: screencastQuality } : {}),
        maxWidth: Math.round(viewport.width * viewport.deviceScaleFactor),
        maxHeight: Math.round(viewport.height * viewport.deviceScaleFactor),
        everyNthFrame: 1,
        maxFramesInFlight: 3,
      });

      const startedAt = new Date().toISOString();
      takeStartMs = performance.now();

      const events = [];
      let lastT = 0;
      const nowT = () => {
        const raw = roundTime((performance.now() - takeStartMs) / 1000);
        lastT = Math.max(lastT, raw);
        return lastT;
      };
      const emit = (event) => {
        const t = event.t !== undefined ? Math.max(lastT, roundTime(event.t)) : nowT();
        lastT = t;
        events.push({ t, ...event, ...(event.t !== undefined ? { t } : {}) });
      };

      emit({ t: 0, type: 'pointermove', x: pointerX, y: pointerY });

      const sampleRate = Math.min(requestedFps, 60);
      const glideTo = async (toX, toY, duration, arc = 0.08) => {
        const distance = Math.hypot(toX - pointerX, toY - pointerY);
        const moveDur = duration ?? defaultMoveDuration(distance);
        if (moveDur <= 0 || distance < 0.5) {
          if (distance > 0) {
            pointerX = roundCoord(toX);
            pointerY = roundCoord(toY);
            await page.mouse.move(pointerX, pointerY);
            emit({ type: 'pointermove', x: pointerX, y: pointerY });
          }
          return;
        }
        const samples = minimumJerkTrajectory({
          from: [pointerX, pointerY],
          to: [toX, toY],
          duration: moveDur,
          sampleRate,
          startTime: 0,
          arc,
          includeStart: false,
        });
        const glideStartMs = performance.now();
        for (let i = 0; i < samples.length; i++) {
          const sample = samples[i];
          const dueMs = glideStartMs + sample.t * 1000;
          const remainingMs = dueMs - performance.now();
          if (remainingMs > 1) {
            await sleep(remainingMs);
          } else if (remainingMs < -20 && i < samples.length - 1) {
            continue;
          }
          pointerX = sample.x;
          pointerY = sample.y;
          await page.mouse.move(pointerX, pointerY);
          emit({ type: 'pointermove', x: pointerX, y: pointerY });
        }
      };

      const steps = recipe.steps ?? [];
      let previousPlannedAt = 0;

      for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        const rawStep = steps[stepIndex];
        if (rawStep && typeof rawStep === 'object' && !Array.isArray(rawStep) && rawStep.at !== undefined) {
          if (!Number.isFinite(rawStep.at) || rawStep.at < previousPlannedAt || (recipe.duration !== undefined && rawStep.at > recipe.duration)) {
            throw Error('Browser take step `at` times must be ordered and within duration');
          }
          previousPlannedAt = rawStep.at;
          await sleep(rawStep.at * 1000 - (performance.now() - takeStartMs));
        }

        const stepLabel = rawStep && typeof rawStep === 'object' && !Array.isArray(rawStep) ? rawStep.label : undefined;
        if (stepLabel !== undefined) {
          const normalizedLabel = String(stepLabel).trim() || `step-${stepIndex}`;
          emit({ type: 'step', index: stepIndex, label: normalizedLabel });
        }

        if (typeof rawStep === 'string') {
          await page.evaluate(`(async () => { ${helpers}\n${rawStep}\n })()`);
          continue;
        }
        if (Array.isArray(rawStep)) {
          const [cmd, arg] = rawStep;
          if (cmd === 'click') {
            const [tx, ty] = await resolveTargetPoint(page, arg);
            await glideTo(tx, ty);
            await page.mouse.down({ button: 'left' });
            emit({ type: 'pointerdown', x: pointerX, y: pointerY, button: 'left' });
            await sleep(70);
            await page.mouse.up({ button: 'left' });
            emit({ type: 'pointerup', x: pointerX, y: pointerY, button: 'left' });
            continue;
          }
          if (cmd === 'press') {
            const { key, modifiers } = parseKeySpec(String(arg));
            await page.keyboard.press([...modifiers, key].join('+'));
            emit({ type: 'key', key, modifiers, action: 'press' });
            continue;
          }
          throw Error(`Unsupported browser take command array: ${JSON.stringify(rawStep)}`);
        }
        if (!rawStep || typeof rawStep !== 'object') {
          throw Error(`Invalid browser take step at index ${stepIndex}`);
        }

        const kind = rawStep.type
          ?? (rawStep.click !== undefined ? 'click'
            : rawStep.drag !== undefined ? 'drag'
            : rawStep.hover !== undefined || rawStep.move !== undefined ? 'move'
            : rawStep.wheel !== undefined ? 'wheel'
            : rawStep.gesture !== undefined ? 'gesture'
            : rawStep.key !== undefined || rawStep.press !== undefined ? 'key'
            : rawStep.pause !== undefined || rawStep.wait !== undefined ? 'pause'
            : rawStep.eval !== undefined ? 'eval'
            : null);

        switch (kind) {
          case 'step': {
            if (stepLabel === undefined) {
              const resolvedIndex = rawStep.index ?? stepIndex;
              const normalizedLabel = String(rawStep.name ?? '').trim() || `step-${resolvedIndex}`;
              emit({ type: 'step', index: resolvedIndex, label: normalizedLabel });
            }
            break;
          }
          case 'move':
          case 'hover': {
            const targetSpec = rawStep.to ?? rawStep.target ?? rawStep.hover ?? rawStep.move
              ?? (Number.isFinite(rawStep.x) && Number.isFinite(rawStep.y) ? [rawStep.x, rawStep.y] : null);
            const [tx, ty] = await resolveTargetPoint(page, targetSpec);
            await glideTo(tx, ty, rawStep.duration, rawStep.arc ?? 0.08);
            break;
          }
          case 'click':
          case 'dblclick': {
            const targetSpec = rawStep.target ?? rawStep.click
              ?? (Number.isFinite(rawStep.x) && Number.isFinite(rawStep.y) ? [rawStep.x, rawStep.y] : null);
            const [tx, ty] = await resolveTargetPoint(page, targetSpec, [pointerX, pointerY]);
            const button = rawStep.button ?? 'left';
            if (!BUTTONS.has(button)) throw Error(`Invalid mouse button: ${button}`);
            const clickModifiers = [];
            for (const mod of rawStep.modifiers ?? []) {
              const canonical = MODIFIER_MAP.get(String(mod).toLowerCase());
              if (!canonical) throw Error(`Unsupported click modifier: ${mod}`);
              if (!clickModifiers.includes(canonical)) clickModifiers.push(canonical);
            }
            const clickCount = rawStep.clickCount ?? (kind === 'dblclick' ? 2 : 1);
            if (rawStep.move !== false) {
              await glideTo(tx, ty, rawStep.moveDuration, rawStep.arc ?? 0.08);
            } else {
              pointerX = roundCoord(tx);
              pointerY = roundCoord(ty);
              await page.mouse.move(pointerX, pointerY);
              emit({ type: 'pointermove', x: pointerX, y: pointerY });
            }
            for (const mod of clickModifiers) await page.keyboard.down(mod);
            try {
              for (let c = 1; c <= clickCount; c++) {
                await page.mouse.down({ button, clickCount: c });
                emit({ type: 'pointerdown', x: pointerX, y: pointerY, button });
                await sleep((rawStep.hold ?? 0.07) * 1000);
                await page.mouse.up({ button, clickCount: c });
                emit({ type: 'pointerup', x: pointerX, y: pointerY, button });
                if (c < clickCount) await sleep(50);
              }
            } finally {
              for (const mod of [...clickModifiers].reverse()) await page.keyboard.up(mod);
            }
            break;
          }
          case 'pointerdown':
          case 'pointerup': {
            const targetSpec = rawStep.target
              ?? (Number.isFinite(rawStep.x) && Number.isFinite(rawStep.y) ? [rawStep.x, rawStep.y] : null);
            if (targetSpec) {
              const [tx, ty] = await resolveTargetPoint(page, targetSpec);
              await glideTo(tx, ty, rawStep.moveDuration);
            }
            const button = rawStep.button ?? 'left';
            if (!BUTTONS.has(button)) throw Error(`Invalid mouse button: ${button}`);
            if (kind === 'pointerdown') await page.mouse.down({ button });
            else await page.mouse.up({ button });
            emit({ type: kind, x: pointerX, y: pointerY, button });
            break;
          }
          case 'drag': {
            const dragSpec = rawStep.drag && typeof rawStep.drag === 'object' ? rawStep.drag : rawStep;
            const [fromX, fromY] = await resolveTargetPoint(page, dragSpec.from);
            const [toX, toY] = await resolveTargetPoint(page, dragSpec.to);
            const button = dragSpec.button ?? 'left';
            if (!BUTTONS.has(button)) throw Error(`Invalid drag button: ${button}`);
            const dragDuration = dragSpec.duration ?? 0.6;
            if (!Number.isFinite(dragDuration) || dragDuration <= 0) {
              throw Error(`Invalid drag duration: ${dragDuration}`);
            }

            await glideTo(fromX, fromY, dragSpec.moveDuration, dragSpec.arc ?? 0.08);
            const dragStartT = nowT();
            emit({
              t: dragStartT,
              type: 'drag',
              from: [pointerX, pointerY],
              to: [roundCoord(toX), roundCoord(toY)],
              duration: roundTime(dragDuration),
            });
            await page.mouse.down({ button });
            emit({ type: 'pointerdown', x: pointerX, y: pointerY, button });
            await sleep(25);
            await glideTo(toX, toY, dragDuration, dragSpec.dragArc ?? 0.03);
            await sleep((dragSpec.releaseHold ?? 0.03) * 1000);
            await page.mouse.up({ button });
            emit({ type: 'pointerup', x: pointerX, y: pointerY, button });
            break;
          }
          case 'wheel': {
            const targetSpec = rawStep.target
              ?? (Number.isFinite(rawStep.x) && Number.isFinite(rawStep.y) ? [rawStep.x, rawStep.y] : null);
            if (targetSpec) {
              const [tx, ty] = await resolveTargetPoint(page, targetSpec);
              await glideTo(tx, ty, rawStep.moveDuration);
            }
            const totalDx = rawStep.deltaX ?? 0;
            const totalDy = rawStep.deltaY ?? 0;
            if (!Number.isFinite(totalDx) || !Number.isFinite(totalDy)) {
              throw Error('Wheel step requires finite deltaX/deltaY');
            }
            const wheelSteps = Math.max(1, Math.round(rawStep.steps ?? 1));
            const stepDelayMs = wheelSteps > 1 ? ((rawStep.duration ?? 0.2) * 1000) / wheelSteps : 0;
            for (let s = 0; s < wheelSteps; s++) {
              const dx = Number((totalDx / wheelSteps).toFixed(2));
              const dy = Number((totalDy / wheelSteps).toFixed(2));
              const rawPhase = rawStep.phase ?? (wheelSteps === 1 ? 'changed' : s === 0 ? 'began' : s === wheelSteps - 1 ? 'ended' : 'changed');
              if (!WHEEL_PHASES.has(rawPhase)) throw Error(`Invalid wheel phase: ${rawPhase}`);
              const phase = rawPhase === 'maybegin' ? 'mayBegin' : rawPhase;
              await page.mouse.wheel(dx, dy);
              emit({ type: 'wheel', x: pointerX, y: pointerY, deltaX: dx, deltaY: dy, phase });
              if (stepDelayMs > 0 && s + 1 < wheelSteps) await sleep(stepDelayMs);
            }
            break;
          }
          case 'gesture':
          case 'scrollGesture': {
            const gestureKind = rawStep.kind ?? 'scroll';
            if (!GESTURE_KINDS.has(gestureKind)) throw Error(`Unsupported gesture kind: ${gestureKind}`);
            const targetSpec = rawStep.target
              ?? (Number.isFinite(rawStep.x) && Number.isFinite(rawStep.y) ? [rawStep.x, rawStep.y] : null);
            if (targetSpec) {
              const [tx, ty] = await resolveTargetPoint(page, targetSpec);
              if (rawStep.move === true) await glideTo(tx, ty, rawStep.moveDuration);
              else {
                pointerX = roundCoord(tx);
                pointerY = roundCoord(ty);
                await page.mouse.move(pointerX, pointerY);
                emit({ type: 'pointermove', x: pointerX, y: pointerY });
              }
            }
            const gestureStartT = nowT();
            const beforeGestureMs = performance.now();
            let emittedDeltaX = 0;
            let emittedDeltaY = 0;

            if (gestureKind === 'pinch') {
              const scaleFactor = rawStep.scaleFactor ?? 1.25;
              if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
                throw Error(`Invalid pinch scaleFactor: ${scaleFactor}`);
              }
              const totalDy = rawStep.deltaY ?? roundCoord(-Math.log(scaleFactor) * 240);
              const totalDx = rawStep.deltaX ?? 0;
              if (!Number.isFinite(totalDx) || !Number.isFinite(totalDy)) {
                throw Error('Pinch gesture requires finite deltaX/deltaY or positive scaleFactor');
              }
              const pinchSteps = Math.max(1, Math.round(rawStep.steps ?? 8));
              const plannedDurSec = rawStep.duration ?? 0.28;
              const stepDelayMs = pinchSteps > 1 ? (plannedDurSec * 1000) / pinchSteps : 0;
              for (let s = 0; s < pinchSteps; s++) {
                const stepDx = Number((totalDx / pinchSteps).toFixed(2));
                const stepDy = Number((totalDy / pinchSteps).toFixed(2));
                await activeCdp.send('Input.dispatchMouseEvent', {
                  type: 'mouseWheel',
                  x: pointerX,
                  y: pointerY,
                  deltaX: stepDx,
                  deltaY: stepDy,
                  modifiers: 2,
                });
                if (stepDelayMs > 0 && s + 1 < pinchSteps) await sleep(stepDelayMs);
              }
              emittedDeltaX = totalDx;
              emittedDeltaY = totalDy;
            } else {
              const deltaX = rawStep.deltaX ?? rawStep.xDistance ?? 0;
              const deltaY = rawStep.deltaY ?? rawStep.yDistance ?? 0;
              if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
                throw Error('Scroll gesture requires finite deltaX/deltaY');
              }
              const distance = Math.hypot(deltaX, deltaY);
              const speed = rawStep.speed ?? (
                rawStep.duration && rawStep.duration > 0 && distance > 0
                  ? Math.max(50, Math.round(distance / rawStep.duration))
                  : 900
              );
              await activeCdp.send('Input.synthesizeScrollGesture', {
                x: pointerX,
                y: pointerY,
                xDistance: deltaX,
                yDistance: deltaY,
                gestureSourceType: rawStep.gestureSourceType ?? 'mouse',
                speed,
                preventFling: rawStep.preventFling ?? false,
                ...(rawStep.repeatCount !== undefined ? { repeatCount: rawStep.repeatCount } : {}),
                ...(rawStep.repeatDelayMs !== undefined ? { repeatDelayMs: rawStep.repeatDelayMs } : {}),
              });
              emittedDeltaX = deltaX;
              emittedDeltaY = deltaY;
            }

            const measuredGestureDur = roundTime((performance.now() - beforeGestureMs) / 1000);
            const gestureDuration = Math.max(
              0.05,
              rawStep.duration !== undefined ? roundTime(rawStep.duration) : measuredGestureDur,
            );
            emit({
              t: gestureStartT,
              type: 'gesture',
              kind: gestureKind,
              x: pointerX,
              y: pointerY,
              deltaX: emittedDeltaX,
              deltaY: emittedDeltaY,
              ...(gestureKind === 'pinch' && rawStep.scaleFactor !== undefined ? { scaleFactor: rawStep.scaleFactor } : {}),
              duration: gestureDuration,
            });
            // Keep timestamp cursor at or after actual completion of the blocking CDP gesture.
            nowT();
            if (rawStep.settle) await sleep(rawStep.settle * 1000);
            break;
          }
          case 'key': {
            const action = rawStep.action ?? 'press';
            if (!KEY_ACTIONS.has(action)) throw Error(`Invalid key action: ${action}`);
            const { key, modifiers } = parseKeySpec(rawStep.key ?? rawStep.press, rawStep.modifiers);
            const chord = [...modifiers, key].join('+');
            if (action === 'press') {
              await page.keyboard.press(chord);
            } else if (action === 'down') {
              for (const mod of modifiers) await page.keyboard.down(mod);
              await page.keyboard.down(key);
            } else {
              await page.keyboard.up(key);
              for (const mod of [...modifiers].reverse()) await page.keyboard.up(mod);
            }
            emit({ type: 'key', key, modifiers, action });
            break;
          }
          case 'pause': {
            const seconds = rawStep.duration ?? rawStep.pause ?? ((rawStep.wait ?? 0) / 1000);
            if (!Number.isFinite(seconds) || seconds < 0) throw Error(`Invalid pause duration: ${seconds}`);
            await sleep(seconds * 1000);
            break;
          }
          case 'eval': {
            await page.evaluate(`(async () => { ${helpers}\n${rawStep.eval}\n })()`);
            break;
          }
          default:
            throw Error(`Unknown browser take step: ${JSON.stringify(rawStep)}`);
        }
      }

      const stepsElapsed = Math.max(lastT, (performance.now() - takeStartMs) / 1000);
      const durationExceeded = recipe.duration !== undefined && stepsElapsed > recipe.duration + 1e-3;

      if (recipe.duration !== undefined) {
        await sleep(recipe.duration * 1000 - (performance.now() - takeStartMs));
      } else {
        await sleep((recipe.tail ?? 0.2) * 1000);
      }

      // Allow any in-flight compositor frame from the final action to arrive before stopping.
      await sleep(40);
      const actualElapsed = Math.max(1 / requestedFps, (performance.now() - takeStartMs) / 1000);
      const targetDuration = recipe.duration !== undefined
        ? (recipe.truncate === true ? recipe.duration : Math.max(recipe.duration, stepsElapsed))
        : actualElapsed;

      screencasting = false;
      await activeCdp.send('Page.stopScreencast').catch(() => {});
      await Promise.all(pendingWrites);
      await cleanupActive();

      const preEncodeCapture = computeRawCaptureStats({
        rawFrames,
        elapsedDuration: recipe.duration !== undefined && !durationExceeded ? recipe.duration : actualElapsed,
        requestedFps,
        truncated: recipe.truncate === true && durationExceeded,
        durationExceeded,
      });

      const videoFileName = `take.${format}`;
      const videoPath = join(out, videoFileName);
      const encoded = await encodeFrames({
        initialFrameFile,
        rawFrames,
        framesDir,
        outputFile: videoPath,
        format,
        fps: requestedFps,
        targetDuration,
        colorSpace,
        signal,
      });

      const rawCapture = {
        ...preEncodeCapture,
        truncated: Boolean(preEncodeCapture.truncated || encoded.truncated),
      };
      const encodedFps = Number(encoded.fps.toFixed(2));

      const eventTrackData = {
        version: 1,
        captureMode: mode,
        viewport,
        video: {
          file: basename(videoPath),
          width: encoded.width,
          height: encoded.height,
          fps: encodedFps,
          encodedFps,
          duration: Number(encoded.duration.toFixed(4)),
          frames: encoded.frames,
          capture: rawCapture,
        },
        startedAt,
        events,
      };
      const serializedTrack = serializeEventTrack(eventTrackData);
      const eventTrackPath = join(out, 'event-track.json');
      await writeFile(eventTrackPath, serializedTrack);

      const videoBytes = await readFile(videoPath);
      const videoSha256 = hash(videoBytes);
      const eventTrackSha256 = hash(serializedTrack);

      return {
        file: videoPath,
        take: videoPath,
        takeSha256: videoSha256,
        sha256: videoSha256,
        eventTrack: eventTrackPath,
        eventTrackSha256,
        eventTrackData,
        captureMode: mode,
        viewport,
        width: encoded.width,
        height: encoded.height,
        requestedFps,
        fps: encodedFps,
        encodedFps,
        rawFps: rawCapture.rawFps,
        measuredFps: rawCapture.rawFps,
        capturedFrames: rawCapture.rawFrames,
        rawCapture,
        frames: encoded.frames,
        duration: encoded.duration,
        ...(recipe.duration !== undefined ? { requestedDuration: recipe.duration } : {}),
        ...(durationExceeded ? { durationExceeded: true } : {}),
        ...(rawCapture.truncated ? { truncated: true } : {}),
        codec: encoded.codec,
        audio: encoded.audio,
        ...(encoded.colorSpace ? { colorSpace: encoded.colorSpace } : {}),
        ...(encoded.colorPrimaries ? { colorPrimaries: encoded.colorPrimaries } : {}),
        ...(encoded.colorTransfer ? { colorTransfer: encoded.colorTransfer } : {}),
        ...(encoded.colorRange ? { colorRange: encoded.colorRange } : {}),
        startedAt,
        source: { url, format, captureMode: mode, colorSpace, deviceScaleFactor: viewport.deviceScaleFactor, kind: 'browser-take' },
      };
    } finally {
      await cleanupActive();
      await rm(framesDir, { recursive: true, force: true });
    }
  }

  return { capture, close: cleanupActive };
}

export async function captureBrowserTake({ name, recipe, base, ...options } = {}) {
  const runner = await createBrowserTakeCapture(options);
  try {
    return await runner.capture(name, recipe, base);
  } finally {
    await runner.close();
  }
}
