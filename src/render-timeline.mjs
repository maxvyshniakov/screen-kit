import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { access, copyFile, link, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { bundle } from '@remotion/bundler';
import {
  makeCancelSignal,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
} from '@remotion/renderer';
import { COLOR_SPACES, SAFE_OUTPUT_ID_RE, assertValidTimeline } from './timeline.mjs';
import { generateContactSheet } from './images.mjs';
import { probeVideo } from './video.mjs';
import { computeFrameScene, projectViewportToRender, screenToRender } from './remotion/layout.mjs';
import { COMPOSITION_ID } from './remotion/Root.mjs';

const exec = promisify(execFile);

export { computeFrameScene, projectViewportToRender, screenToRender };

export const RENDER_PROFILES = ['web-loop', 'youtube-master', 'shorts'];
const POSTER_FORMATS = new Set(['png', 'webp']);
const SINGLE_FILE_EXTENSIONS = new Set(['mp4', 'webm', 'png', 'webp']);
const EXTERNAL_URL_RE = /^(?:https?:|data:|blob:)/i;

const REMOTION_ENTRY = fileURLToPath(new URL('./remotion/index.mjs', import.meta.url));

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const evenDimension = (value) => Math.max(2, Math.round(value / 2) * 2);

function assertSafeOutputId(id, label = 'output.id') {
  if (
    typeof id !== 'string' ||
    !SAFE_OUTPUT_ID_RE.test(id) ||
    id.includes('..') ||
    /[/\\\0]/.test(id)
  ) {
    throw Error(
      `Invalid ${label} "${String(id)}": must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ without ".." or path separators`
    );
  }
  return id;
}

function assertSafeStillFilename(filename, label = 'filename') {
  if (typeof filename !== 'string' || filename.trim().length === 0) {
    throw Error(`${label} must be a non-empty string`);
  }
  if (
    /[/\\\0]/.test(filename) ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('..')
  ) {
    throw Error(`${label} must not contain "..", path separators, or null bytes: ${filename}`);
  }
  return filename;
}

function assertPathInsideDir(filePath, baseDir, label = 'output path') {
  const resolvedBase = resolve(baseDir);
  const resolvedFile = resolve(filePath);
  const rel = relative(resolvedBase, resolvedFile);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('..') || isAbsolute(rel)) {
    throw Error(`${label} escapes base directory (${resolvedBase}): ${filePath}`);
  }
  return resolvedFile;
}

function normalizeRemotionCodec(codec, format) {
  if (format === 'webm') {
    if (!codec || codec === 'vp9') return 'vp9';
    if (codec === 'vp8') return 'vp8';
    if (codec === 'av1') return 'av1';
    throw Error(`Unsupported WebM codec for Remotion renderer: ${codec}`);
  }
  if (format === 'mp4') {
    if (!codec || codec === 'h264' || codec === 'libx264') return 'h264';
    if (codec === 'h265' || codec === 'hevc') return 'h265';
    throw Error(`Unsupported MP4 codec for Remotion renderer: ${codec}`);
  }
  throw Error(`Unsupported video container format: ${format}`);
}

function buildPresetSpec(profileId, timeline, fpsOverride) {
  if (profileId === 'web-loop') {
    return {
      id: 'web-loop',
      format: 'webm',
      codec: 'vp9',
      width: Math.round(timeline.camera.outputWidth),
      height: Math.round(timeline.camera.outputHeight),
      fps: fpsOverride ?? timeline.take.fps,
      loop: true,
      poster: true,
    };
  }
  if (profileId === 'youtube-master') {
    return {
      id: 'youtube-master',
      format: 'mp4',
      codec: 'h264',
      width: 2560,
      height: 1440,
      fps: fpsOverride ?? Math.max(timeline.take.fps, 60),
      loop: false,
      poster: false,
    };
  }
  if (profileId === 'shorts') {
    return {
      id: 'shorts',
      format: 'mp4',
      codec: 'h264',
      width: 1080,
      height: 1920,
      fps: fpsOverride ?? Math.max(timeline.take.fps, 60),
      loop: false,
      poster: false,
    };
  }
  throw Error(`Unknown output profile: ${profileId}`);
}

function normalizeProfilesInput(profiles) {
  if (profiles === undefined || profiles === null) return null;
  const list = typeof profiles === 'string'
    ? profiles.split(',').map((item) => item.trim()).filter(Boolean)
    : Array.isArray(profiles)
      ? profiles
      : null;
  if (!list || list.length === 0) {
    throw Error('profiles must be a non-empty array or comma-separated string');
  }
  return list;
}

/**
 * Deterministically resolve all concrete render artifacts (video files + posters)
 * for a validated `timeline` and destination (`outDir` or `out`).
 */
export function resolveRenderTargets({
  timeline,
  outDir,
  out,
  profiles,
  posterFormat = 'png',
  posterTime = 0,
  fps,
  colorSpace,
} = {}) {
  assertValidTimeline(timeline);

  if (colorSpace !== undefined && !COLOR_SPACES.includes(colorSpace)) {
    throw Error(`colorSpace must be one of ${COLOR_SPACES.join(', ')} (received ${String(colorSpace)})`);
  }
  if (!POSTER_FORMATS.has(posterFormat)) {
    throw Error(`posterFormat must be png or webp (received ${String(posterFormat)})`);
  }
  if (typeof posterTime !== 'number' || !Number.isFinite(posterTime) || posterTime < 0) {
    throw Error('posterTime must be a non-negative finite number');
  }
  if (fps !== undefined && (!(typeof fps === 'number' && Number.isFinite(fps)) || fps <= 0 || fps > 240)) {
    throw Error('fps must be between 0 and 240');
  }

  if (!outDir && !out) {
    throw Error('renderTimeline requires outDir or out');
  }

  const requestedProfiles = normalizeProfilesInput(profiles);
  const ext = !outDir && out ? extname(out).toLowerCase().slice(1) : '';
  const isSingleFile = Boolean(!outDir && out && SINGLE_FILE_EXTENSIONS.has(ext));

  const resolveTargetColorSpace = (specColorSpace) => {
    const resolved = colorSpace ?? specColorSpace ?? timeline.take.colorSpace ?? 'srgb';
    if (!COLOR_SPACES.includes(resolved)) {
      throw Error(`colorSpace must be one of ${COLOR_SPACES.join(', ')} (received ${String(resolved)})`);
    }
    return resolved;
  };

  if (isSingleFile) {
    const file = resolve(out);
    let baseSpec = null;
    if (requestedProfiles) {
      if (requestedProfiles.length > 1) {
        throw Error('Single-file --out cannot be combined with multiple profiles; pass a directory instead');
      }
      const selected = requestedProfiles[0];
      if (typeof selected === 'string') {
        const fromTimeline = timeline.outputs.find((entry) => entry.id === selected);
        baseSpec = fromTimeline ? { ...fromTimeline } : buildPresetSpec(selected, timeline, fps);
      } else if (selected && typeof selected === 'object') {
        baseSpec = { ...selected };
      }
    } else {
      baseSpec =
        timeline.outputs.find((entry) => entry.format === ext) ??
        timeline.outputs[0] ?? {
          id: 'single',
          width: Math.round(timeline.camera.outputWidth),
          height: Math.round(timeline.camera.outputHeight),
          fps: timeline.take.fps,
        };
    }

    const targetFps = fps ?? baseSpec.fps ?? timeline.take.fps;
    const targetColorSpace = resolveTargetColorSpace(baseSpec.colorSpace);
    const singleOutDir = dirname(file);
    assertPathInsideDir(file, singleOutDir, 'output file');
    if (ext === 'png' || ext === 'webp') {
      const stillId = assertSafeOutputId(baseSpec.id ?? 'poster', 'output.id');
      return {
        mode: 'file',
        outDir: singleOutDir,
        targets: [
          {
            id: stillId,
            role: 'poster',
            kind: 'still',
            format: ext,
            width: Math.max(1, Math.round(baseSpec.width ?? timeline.camera.outputWidth)),
            height: Math.max(1, Math.round(baseSpec.height ?? timeline.camera.outputHeight)),
            fps: targetFps,
            colorSpace: targetColorSpace,
            posterTime,
            file,
          },
        ],
      };
    }

    const videoId = assertSafeOutputId(baseSpec.id ?? ext, 'output.id');
    const width = evenDimension(baseSpec.width ?? timeline.camera.outputWidth);
    const height = evenDimension(baseSpec.height ?? timeline.camera.outputHeight);
    return {
      mode: 'file',
      outDir: singleOutDir,
      targets: [
        {
          id: videoId,
          role: 'video',
          kind: 'video',
          format: ext,
          codec: normalizeRemotionCodec(ext === baseSpec.format ? baseSpec.codec : undefined, ext),
          width,
          height,
          fps: targetFps,
          colorSpace: targetColorSpace,
          loop: Boolean(baseSpec.loop),
          file,
        },
      ],
    };
  }

  const targetDir = resolve(outDir ?? out);
  const specs = requestedProfiles
    ? requestedProfiles.map((entry) => {
        if (typeof entry === 'string') {
          const fromTimeline = timeline.outputs.find((item) => item.id === entry);
          return fromTimeline ? { ...fromTimeline } : buildPresetSpec(entry, timeline, fps);
        }
        if (!entry || typeof entry !== 'object') {
          throw Error('Each profile must be a profile name or output spec object');
        }
        return { ...entry };
      })
    : timeline.outputs.map((entry) => ({ ...entry }));

  const targets = [];
  for (const spec of specs) {
    assertSafeOutputId(spec.id, 'output.id');
    const targetFps = fps ?? spec.fps ?? timeline.take.fps;
    const targetColorSpace = resolveTargetColorSpace(spec.colorSpace);
    if (spec.id === 'web-loop') {
      const width = evenDimension(spec.width ?? timeline.camera.outputWidth);
      const height = evenDimension(spec.height ?? timeline.camera.outputHeight);
      const webmCodec = spec.format === 'webm' ? normalizeRemotionCodec(spec.codec, 'webm') : 'vp9';
      targets.push({
        id: 'web-loop',
        role: 'video',
        kind: 'video',
        format: 'webm',
        codec: webmCodec,
        width,
        height,
        fps: targetFps,
        colorSpace: targetColorSpace,
        loop: spec.loop ?? true,
        file: join(targetDir, 'web-loop.webm'),
      });
      targets.push({
        id: 'web-loop',
        role: 'fallback-video',
        kind: 'video',
        format: 'mp4',
        codec: 'h264',
        width,
        height,
        fps: targetFps,
        colorSpace: targetColorSpace,
        loop: spec.loop ?? true,
        file: join(targetDir, 'web-loop.mp4'),
      });
      if (spec.poster !== false) {
        targets.push({
          id: 'web-loop',
          role: 'poster',
          kind: 'still',
          format: posterFormat,
          width,
          height,
          fps: targetFps,
          colorSpace: targetColorSpace,
          posterTime,
          file: join(targetDir, `web-loop-poster.${posterFormat}`),
        });
      }
      continue;
    }

    if (spec.id === 'youtube-master') {
      const width = evenDimension(spec.width ?? 2560);
      const height = evenDimension(spec.height ?? 1440);
      const masterFps = fps ?? spec.fps ?? Math.max(timeline.take.fps, 60);
      targets.push({
        id: 'youtube-master',
        role: 'video',
        kind: 'video',
        format: 'mp4',
        codec: normalizeRemotionCodec(spec.codec, 'mp4'),
        width,
        height,
        fps: masterFps,
        colorSpace: targetColorSpace,
        loop: false,
        file: join(targetDir, 'youtube-master.mp4'),
      });
      if (spec.poster === true) {
        targets.push({
          id: 'youtube-master',
          role: 'poster',
          kind: 'still',
          format: posterFormat,
          width,
          height,
          fps: masterFps,
          colorSpace: targetColorSpace,
          posterTime,
          file: join(targetDir, `youtube-master-poster.${posterFormat}`),
        });
      }
      continue;
    }

    if (spec.id === 'shorts') {
      const width = evenDimension(spec.width ?? 1080);
      const height = evenDimension(spec.height ?? 1920);
      const shortsFps = fps ?? spec.fps ?? Math.max(timeline.take.fps, 60);
      targets.push({
        id: 'shorts',
        role: 'video',
        kind: 'video',
        format: 'mp4',
        codec: normalizeRemotionCodec(spec.codec, 'mp4'),
        width,
        height,
        fps: shortsFps,
        colorSpace: targetColorSpace,
        loop: Boolean(spec.loop),
        file: join(targetDir, 'shorts.mp4'),
      });
      if (spec.poster === true) {
        targets.push({
          id: 'shorts',
          role: 'poster',
          kind: 'still',
          format: posterFormat,
          width,
          height,
          fps: shortsFps,
          colorSpace: targetColorSpace,
          posterTime,
          file: join(targetDir, `shorts-poster.${posterFormat}`),
        });
      }
      continue;
    }

    if (spec.format === 'png' || spec.format === 'webp') {
      targets.push({
        id: spec.id,
        role: 'poster',
        kind: 'still',
        format: spec.format,
        width: Math.max(1, Math.round(spec.width ?? timeline.camera.outputWidth)),
        height: Math.max(1, Math.round(spec.height ?? timeline.camera.outputHeight)),
        fps: targetFps,
        colorSpace: targetColorSpace,
        posterTime,
        file: join(targetDir, `${spec.id}.${spec.format}`),
      });
      continue;
    }

    const width = evenDimension(spec.width ?? timeline.camera.outputWidth);
    const height = evenDimension(spec.height ?? timeline.camera.outputHeight);
    targets.push({
      id: spec.id,
      role: 'video',
      kind: 'video',
      format: spec.format,
      codec: normalizeRemotionCodec(spec.codec, spec.format),
      width,
      height,
      fps: targetFps,
      colorSpace: targetColorSpace,
      loop: Boolean(spec.loop),
      file: join(targetDir, `${spec.id}.${spec.format}`),
    });
    if (spec.poster) {
      targets.push({
        id: spec.id,
        role: 'poster',
        kind: 'still',
        format: posterFormat,
        width,
        height,
        fps: targetFps,
        colorSpace: targetColorSpace,
        posterTime,
        file: join(targetDir, `${spec.id}-poster.${posterFormat}`),
      });
    }
  }

  for (const target of targets) {
    assertPathInsideDir(target.file, targetDir, 'render target file');
  }

  return { mode: 'directory', outDir: targetDir, targets };
}

function resolveLocalPath(ref, baseDir) {
  if (ref.startsWith('file://')) {
    return fileURLToPath(ref);
  }
  return resolve(baseDir, ref);
}

async function stageMediaFile(sourcePath, publicDir, index) {
  await access(sourcePath);
  const safeBase = basename(sourcePath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const relativeAsset = `media/${index}-${safeBase}`;
  const destination = join(publicDir, relativeAsset);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await link(sourcePath, destination);
  } catch {
    await copyFile(sourcePath, destination);
  }
  return relativeAsset;
}

async function prepareStagedTimeline(timeline, baseDir, publicDir, sharedState = null) {
  const staged = structuredClone(timeline);
  const stagedMap = sharedState?.stagedMap ?? new Map();
  const validatedVideos = sharedState?.validatedVideos ?? new Set();
  const validatedImages = sharedState?.validatedImages ?? new Set();
  const nextIndex = () => (sharedState ? sharedState.counter++ : counter++);
  let counter = 0;

  const stageRef = async (ref, label) => {
    if (EXTERNAL_URL_RE.test(ref)) return ref;
    const absPath = resolveLocalPath(ref, baseDir);
    if (stagedMap.has(absPath)) return stagedMap.get(absPath);
    try {
      const assetRel = await stageMediaFile(absPath, publicDir, nextIndex());
      stagedMap.set(absPath, assetRel);
      return assetRel;
    } catch (error) {
      throw Error(`${label} not found or unreadable (${absPath}): ${error.message}`);
    }
  };

  if (!EXTERNAL_URL_RE.test(timeline.take.video)) {
    const absVideo = resolveLocalPath(timeline.take.video, baseDir);
    const assetRel = await stageRef(timeline.take.video, 'timeline.take.video');
    if (!validatedVideos.has(absVideo)) {
      try {
        const videoInfo = await probeVideo(absVideo);
        if (!videoInfo.frames || !(videoInfo.duration > 0)) {
          throw Error('take video has zero frames or non-positive duration');
        }
        validatedVideos.add(absVideo);
      } catch (error) {
        throw Error(`Invalid timeline.take.video (${absVideo}): ${error.message}`);
      }
    }
    staged.take.video = assetRel;
  } else {
    staged.take.video = timeline.take.video;
  }

  if (timeline.stage.background.type === 'image') {
    const bgSrc = timeline.stage.background.src;
    staged.stage.background.src = await stageRef(bgSrc, 'timeline.stage.background.src');
    if (!EXTERNAL_URL_RE.test(bgSrc)) {
      const absBg = resolveLocalPath(bgSrc, baseDir);
      if (!validatedImages.has(absBg)) {
        try {
          const meta = await sharp(absBg).metadata();
          if (!meta.width || !meta.height) throw Error('empty image dimensions');
          validatedImages.add(absBg);
        } catch (error) {
          throw Error(`Invalid timeline.stage.background.src (${absBg}): ${error.message}`);
        }
      }
    }
  }

  for (let i = 0; i < staged.audio.tracks.length; i += 1) {
    staged.audio.tracks[i].src = await stageRef(
      timeline.audio.tracks[i].src,
      `timeline.audio.tracks[${i}].src`
    );
  }

  return staged;
}

export async function moveFileAtomic(source, destination, fsOps = {}) {
  const mkdirFn = fsOps.mkdir ?? mkdir;
  const renameFn = fsOps.rename ?? rename;
  const copyFileFn = fsOps.copyFile ?? copyFile;
  const rmFn = fsOps.rm ?? rm;

  await mkdirFn(dirname(destination), { recursive: true });
  try {
    await renameFn(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    const tempDest = `${destination}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await copyFileFn(source, tempDest);
      await renameFn(tempDest, destination);
      await rmFn(source, { force: true });
    } catch (copyError) {
      await rmFn(tempDest, { force: true }).catch(() => {});
      throw copyError;
    }
  }
}

async function loadTimelineInput(timelineInput, cwd) {
  if (typeof timelineInput === 'string') {
    const filePath = resolve(cwd ?? process.cwd(), timelineInput);
    const raw = await readFile(filePath, 'utf8');
    return {
      timeline: JSON.parse(raw),
      timelineFile: filePath,
      baseDir: dirname(filePath),
    };
  }
  if (timelineInput && typeof timelineInput === 'object' && !Array.isArray(timelineInput)) {
    return {
      timeline: timelineInput,
      timelineFile: null,
      baseDir: resolve(cwd ?? process.cwd()),
    };
  }
  throw Error('renderTimeline requires a timeline object or path to timeline.json');
}

function findLocalFullChromiumExecutable(env = process.env) {
  const explicit = env.SCREEN_KIT_CHROMIUM_PATH ?? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && existsSync(resolve(explicit))) {
    return resolve(explicit);
  }
  const home = homedir();
  const relCandidates =
    process.platform === 'darwin'
      ? [
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'linux'
        ? ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome']
        : ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'];

  const cacheRoots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    join(home, 'Library', 'Caches', 'ms-playwright'),
    join(home, '.cache', 'ms-playwright'),
    join(home, '.agent-browser', 'browsers'),
  ].filter(Boolean);

  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    let subdirs = [];
    try {
      subdirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (d.name.startsWith('chromium-') || d.name.startsWith('chrome-')))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      subdirs = [];
    }
    for (const dir of subdirs) {
      for (const rel of relCandidates) {
        const candidate = join(root, dir, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  const systemCandidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'linux'
        ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
        : [];
  for (const sysPath of systemCandidates) {
    if (existsSync(sysPath)) return sysPath;
  }
  return null;
}

function buildDisplayP3FfmpegOverride() {
  return ({ args }) => {
    const out = [...args];
    const setOpt = (names, val) => {
      for (let i = 0; i < out.length; i += 1) {
        if (names.includes(out[i]) && i + 1 < out.length) {
          out[i + 1] = val;
          return true;
        }
      }
      return false;
    };
    const isStreamCopy = out.some(
      (arg, idx) => (arg === '-c:v' || arg === '-vcodec' || arg === '-codec:v') && out[idx + 1] === 'copy'
    );
    if (!isStreamCopy) {
      setOpt(['-vf', '-filter:v'], 'scale=out_color_matrix=bt709:out_range=tv');
    }
    if (!setOpt(['-color_primaries', '-color_primaries:v'], 'smpte432')) {
      out.splice(out.length - 1, 0, '-color_primaries:v', 'smpte432');
    }
    if (!setOpt(['-color_trc', '-color_trc:v'], 'iec61966-2-1')) {
      out.splice(out.length - 1, 0, '-color_trc:v', 'iec61966-2-1');
    }
    if (!setOpt(['-colorspace', '-colorspace:v'], 'bt709')) {
      out.splice(out.length - 1, 0, '-colorspace:v', 'bt709');
    }
    if (!setOpt(['-color_range', '-color_range:v'], 'tv')) {
      out.splice(out.length - 1, 0, '-color_range:v', 'tv');
    }
    return out;
  };
}

async function tagMp4DisplayP3Cicp(filePath, codec, signal) {
  const taggedTemp = `${filePath}.${randomUUID().slice(0, 8)}.p3.mp4`;
  const bsfArgs =
    codec === 'h265'
      ? [
          '-bsf:v',
          'hevc_metadata=colour_primaries=12:transfer_characteristics=13:matrix_coefficients=1:video_full_range_flag=0',
        ]
      : [
          '-bsf:v',
          'h264_metadata=colour_primaries=12:transfer_characteristics=13:matrix_coefficients=1:video_full_range_flag=0',
        ];
  try {
    await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        filePath,
        '-map',
        '0',
        '-c',
        'copy',
        ...bsfArgs,
        '-color_primaries',
        'smpte432',
        '-color_trc',
        'iec61966-2-1',
        '-colorspace',
        'bt709',
        '-color_range',
        'tv',
        '-movflags',
        '+faststart',
        taggedTemp,
      ],
      { timeout: 60000, maxBuffer: 10e6, ...(signal ? { signal } : {}) }
    );
    await rename(taggedTemp, filePath);
  } finally {
    await rm(taggedTemp, { force: true }).catch(() => {});
  }
}

/**
 * Headlessly render a validated `timeline.json` (or timeline object) and its referenced take media
 * via Remotion 4 into `web-loop`, `youtube-master`, or explicit output targets.
 * Cleans up all temporary bundle, staged media, browser, and intermediate render files in `finally`.
 */
export async function renderTimeline({
  timeline: timelineInput,
  outDir,
  out,
  profiles,
  posterFormat = 'png',
  posterTime = 0,
  fps,
  colorSpace,
  cwd,
  concurrency,
  browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE ?? null,
  logLevel = 'error',
  signal,
  scratchDir,
} = {}) {
  const { timeline, timelineFile, baseDir } = await loadTimelineInput(timelineInput, cwd);
  const plan = resolveRenderTargets({
    timeline,
    outDir,
    out,
    profiles,
    posterFormat,
    posterTime,
    fps,
    colorSpace,
  });

  const scratchBase = scratchDir ? resolve(scratchDir) : tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const tempDir = await mkdtemp(join(scratchBase, 'screen-kit-remotion-'));
  const publicDir = join(tempDir, 'public');
  const bundleOutDir = join(tempDir, 'bundle');
  const tempOutputsDir = join(tempDir, 'outputs');

  const browsers = new Map();
  const getBrowserForColorSpace = async (targetColorSpace) => {
    const key = targetColorSpace === 'p3' ? 'p3' : 'srgb';
    if (browsers.has(key)) return browsers.get(key);
    if (key === 'p3') {
      const p3Executable = browserExecutable ?? findLocalFullChromiumExecutable();
      const p3ChromiumOptions = {
        flags: {
          'force-color-profile': 'display-p3-d65',
        },
      };
      const instance = await openBrowser('chrome', {
        ...(p3Executable ? { browserExecutable: p3Executable, chromeMode: 'chrome-for-testing' } : {}),
        chromiumOptions: p3ChromiumOptions,
        logLevel,
      });
      browsers.set(key, instance);
      return instance;
    }
    const instance = await openBrowser('chrome', {
      ...(browserExecutable ? { browserExecutable } : {}),
      logLevel,
    });
    browsers.set(key, instance);
    return instance;
  };

  try {
    await mkdir(publicDir, { recursive: true });
    await mkdir(tempOutputsDir, { recursive: true });

    const stagedTimeline = await prepareStagedTimeline(timeline, baseDir, publicDir);

    const serveUrl = await bundle({
      entryPoint: REMOTION_ENTRY,
      outDir: bundleOutDir,
      publicDir,
      symlinkPublicDir: true,
      enableCaching: false,
      rspack: true,
    });

    if (signal?.aborted) {
      throw Error('Timeline render aborted');
    }
    const remotionCancel = signal ? makeCancelSignal() : null;
    if (signal && remotionCancel) {
      signal.addEventListener('abort', () => remotionCancel.cancel(), { once: true });
    }

    const hasAudio = stagedTimeline.audio.tracks.length > 0;
    const stagedOutputs = [];
    const p3FfmpegOverride = buildDisplayP3FfmpegOverride();

    for (const target of plan.targets) {
      if (signal?.aborted) {
        throw Error('Timeline render aborted');
      }
      const isP3 = target.colorSpace === 'p3';
      const browser = await getBrowserForColorSpace(target.colorSpace);
      const p3ChromiumOptions = isP3
        ? { flags: { 'force-color-profile': 'display-p3-d65' } }
        : undefined;

      const inputProps = {
        timeline: stagedTimeline,
        output: {
          id: target.id,
          width: target.width,
          height: target.height,
          fps: target.fps,
          colorSpace: target.colorSpace,
        },
      };

      const composition = await selectComposition({
        serveUrl,
        id: COMPOSITION_ID,
        inputProps,
        puppeteerInstance: browser,
        ...(p3ChromiumOptions ? { chromiumOptions: p3ChromiumOptions } : {}),
        logLevel,
      });

      const tempFile = assertPathInsideDir(
        join(tempOutputsDir, `${target.id}-${target.role}-${randomUUID()}.${target.format}`),
        tempOutputsDir,
        'temp render output'
      );
      assertPathInsideDir(target.file, plan.outDir, 'render output file');

      if (target.kind === 'still') {
        const maxFrame = Math.max(0, composition.durationInFrames - 1);
        const frame = Math.min(maxFrame, Math.max(0, Math.round((target.posterTime ?? 0) * composition.fps)));
        await renderStill({
          serveUrl,
          composition,
          inputProps,
          frame,
          imageFormat: target.format,
          output: tempFile,
          puppeteerInstance: browser,
          ...(p3ChromiumOptions ? { chromiumOptions: p3ChromiumOptions } : {}),
          ...(remotionCancel ? { cancelSignal: remotionCancel.cancelSignal } : {}),
          overwrite: true,
          logLevel,
        });

        const meta = await sharp(tempFile).metadata();
        if (!meta.width || !meta.height) {
          throw Error(`Poster render produced invalid image for ${target.id}`);
        }
        const bytes = await readFile(tempFile);
        stagedOutputs.push({
          tempFile,
          destination: target.file,
          record: {
            id: target.id,
            role: target.role,
            format: target.format,
            file: target.file,
            width: meta.width,
            height: meta.height,
            frame,
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        });
      } else {
        const crf = target.codec === 'vp9' ? 20 : 15;
        await renderMedia({
          serveUrl,
          composition,
          inputProps,
          codec: target.codec,
          imageFormat: 'png',
          crf,
          pixelFormat: 'yuv420p',
          colorSpace: 'bt709',
          muted: !hasAudio,
          outputLocation: tempFile,
          puppeteerInstance: browser,
          ...(isP3
            ? {
                disableSharedMemoryCapture: true,
                chromiumOptions: p3ChromiumOptions,
                ffmpegOverride: p3FfmpegOverride,
              }
            : {}),
          ...(remotionCancel ? { cancelSignal: remotionCancel.cancelSignal } : {}),
          overwrite: true,
          ...(concurrency !== undefined ? { concurrency } : {}),
          logLevel,
        });

        if (isP3 && target.format === 'mp4') {
          await tagMp4DisplayP3Cicp(tempFile, target.codec, signal);
        }

        const info = await probeVideo(tempFile);
        if (!info.frames || !(info.duration > 0)) {
          throw Error(`Remotion produced an empty video for ${target.id} (${target.format})`);
        }
        const bytes = await readFile(tempFile);
        stagedOutputs.push({
          tempFile,
          destination: target.file,
          record: {
            id: target.id,
            role: target.role,
            format: target.format,
            file: target.file,
            codec: info.codec,
            width: info.width,
            height: info.height,
            frames: info.frames,
            duration: info.duration,
            fps: info.fps,
            audio: info.audio,
            colorSpace: info.colorSpace,
            colorPrimaries: info.colorPrimaries,
            colorTransfer: info.colorTransfer,
            colorRange: info.colorRange,
            loop: target.loop,
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        });
      }
    }

    if (signal?.aborted) {
      throw Error('Timeline render aborted');
    }

    const renderedOutputs = [];
    for (const item of stagedOutputs) {
      await moveFileAtomic(item.tempFile, item.destination);
      renderedOutputs.push(item.record);
    }

    return {
      renderer: 'remotion-4',
      ...(timelineFile ? { timelineFile } : {}),
      mode: plan.mode,
      outDir: plan.outDir,
      outputs: renderedOutputs,
    };
  } finally {
    for (const instance of browsers.values()) {
      await instance.close({ silent: true }).catch(() => {});
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Render an explicit batch of frame-indexed PNG stills across one or more timeline variants
 * in ONE shared Remotion bundle + headless browser session.
 */
export async function renderTimelineStills({
  timeline: timelineInput,
  variants,
  requests,
  outDir,
  width,
  height,
  fps,
  cwd,
  baseDir: explicitBaseDir,
  browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE ?? null,
  logLevel = 'error',
  signal,
  scratchDir,
} = {}) {
  if (!outDir) {
    throw Error('renderTimelineStills requires outDir');
  }
  if (!Array.isArray(requests) || requests.length === 0) {
    throw Error('renderTimelineStills requires a non-empty requests array');
  }

  const loaded = await loadTimelineInput(timelineInput, cwd);
  const baseTimeline = loaded.timeline;
  const baseDir = explicitBaseDir ? resolve(explicitBaseDir) : loaded.baseDir;
  assertValidTimeline(baseTimeline);

  const variantEntries = variants && typeof variants === 'object' && !Array.isArray(variants)
    ? Object.entries(variants)
    : [['default', baseTimeline]];
  for (const [variantId, variantTimeline] of variantEntries) {
    assertSafeOutputId(variantId, 'variant id');
    assertValidTimeline(variantTimeline);
  }

  const renderWidth = evenDimension(width ?? baseTimeline.camera.outputWidth);
  const renderHeight = evenDimension(height ?? baseTimeline.camera.outputHeight);
  const renderFps = Math.max(1, Math.round(fps ?? baseTimeline.take.fps ?? 30));
  const targetOutDir = resolve(cwd ?? process.cwd(), outDir);

  for (let i = 0; i < requests.length; i += 1) {
    const req = requests[i];
    if (!req || typeof req !== 'object') {
      throw Error(`requests[${i}] must be an object`);
    }
    const reqVariantId = req.variant ?? 'default';
    assertSafeOutputId(reqVariantId, `requests[${i}].variant`);
    const candidateFilename = req.filename ?? `${reqVariantId}-${String(i).padStart(3, '0')}.png`;
    assertSafeStillFilename(candidateFilename, `requests[${i}].filename`);
    assertPathInsideDir(join(targetOutDir, candidateFilename), targetOutDir, `requests[${i}] output file`);
  }

  const scratchBase = scratchDir ? resolve(scratchDir) : tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const tempDir = await mkdtemp(join(scratchBase, 'screen-kit-stills-'));
  const publicDir = join(tempDir, 'public');
  const bundleOutDir = join(tempDir, 'bundle');
  const tempOutputsDir = join(tempDir, 'outputs');

  let browser = null;
  try {
    await mkdir(publicDir, { recursive: true });
    await mkdir(tempOutputsDir, { recursive: true });

    const sharedStaging = {
      counter: 0,
      stagedMap: new Map(),
      validatedVideos: new Set(),
      validatedImages: new Set(),
    };
    const stagedVariants = new Map();
    for (const [variantId, variantTimeline] of variantEntries) {
      const staged = await prepareStagedTimeline(variantTimeline, baseDir, publicDir, sharedStaging);
      stagedVariants.set(variantId, staged);
    }

    const serveUrl = await bundle({
      entryPoint: REMOTION_ENTRY,
      outDir: bundleOutDir,
      publicDir,
      symlinkPublicDir: true,
      enableCaching: false,
      rspack: true,
    });

    browser = await openBrowser('chrome', {
      ...(browserExecutable ? { browserExecutable } : {}),
      logLevel,
    });

    if (signal?.aborted) {
      throw Error('Timeline still render aborted');
    }
    const remotionCancel = signal ? makeCancelSignal() : null;
    if (signal && remotionCancel) {
      signal.addEventListener('abort', () => remotionCancel.cancel(), { once: true });
    }

    const compositionCache = new Map();
    const getVariantContext = async (variantId) => {
      if (compositionCache.has(variantId)) return compositionCache.get(variantId);
      const stagedTimeline = stagedVariants.get(variantId);
      if (!stagedTimeline) {
        throw Error(`Unknown timeline variant in renderTimelineStills: ${variantId}`);
      }
      const inputProps = {
        timeline: stagedTimeline,
        output: {
          id: `still-${variantId}`,
          width: renderWidth,
          height: renderHeight,
          fps: renderFps,
        },
      };
      const composition = await selectComposition({
        serveUrl,
        id: COMPOSITION_ID,
        inputProps,
        puppeteerInstance: browser,
        logLevel,
      });
      const ctx = { inputProps, composition };
      compositionCache.set(variantId, ctx);
      return ctx;
    };

    const stagedStills = [];
    for (let i = 0; i < requests.length; i += 1) {
      if (signal?.aborted) {
        throw Error('Timeline still render aborted');
      }
      const req = requests[i];
      const variantId = req.variant ?? 'default';
      const { inputProps, composition } = await getVariantContext(variantId);
      const maxFrame = Math.max(0, composition.durationInFrames - 1);
      const requestedFrame = Number.isInteger(req.frame)
        ? req.frame
        : Math.floor(Math.max(0, Number(req.t ?? 0)) * composition.fps + 1e-9);
      const frame = Math.min(maxFrame, Math.max(0, requestedFrame));
      const filename = assertSafeStillFilename(
        req.filename ?? `${variantId}-${String(i).padStart(3, '0')}.png`,
        `requests[${i}].filename`
      );
      const tempStillFile = assertPathInsideDir(
        join(tempOutputsDir, `${String(i).padStart(3, '0')}-${filename}`),
        tempOutputsDir,
        `requests[${i}] temp still file`
      );

      await renderStill({
        serveUrl,
        composition,
        inputProps,
        frame,
        imageFormat: 'png',
        output: tempStillFile,
        puppeteerInstance: browser,
        ...(remotionCancel ? { cancelSignal: remotionCancel.cancelSignal } : {}),
        overwrite: true,
        logLevel,
      });

      const meta = await sharp(tempStillFile).metadata();
      if (!meta.width || !meta.height) {
        throw Error(`Still render produced invalid image for ${filename}`);
      }
      const bytes = await readFile(tempStillFile);
      const destination = assertPathInsideDir(
        join(targetOutDir, filename),
        targetOutDir,
        `requests[${i}] still output file`
      );
      stagedStills.push({
        tempFile: tempStillFile,
        destination,
        record: {
          key: req.key ?? `${variantId}:${frame}`,
          variant: variantId,
          frame,
          t: frame / composition.fps,
          filename,
          file: destination,
          width: meta.width,
          height: meta.height,
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      });
    }

    if (signal?.aborted) {
      throw Error('Timeline still render aborted');
    }

    const stills = [];
    for (const item of stagedStills) {
      await moveFileAtomic(item.tempFile, item.destination);
      stills.push(item.record);
    }

    return {
      renderer: 'remotion-4',
      ...(loaded.timelineFile ? { timelineFile: loaded.timelineFile } : {}),
      outDir: targetOutDir,
      width: renderWidth,
      height: renderHeight,
      fps: renderFps,
      stills,
    };
  } finally {
    if (browser) {
      await browser.close({ silent: true }).catch(() => {});
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

function slugifyPreviewLabel(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Deterministically resolve key step preview timestamps and still filenames (capped at `maxFrames`).
 */
export function resolvePreviewTargets({
  timeline,
  eventTrack,
  timestamps,
  maxFrames = 12,
} = {}) {
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 120) {
    throw Error('maxFrames must be an integer between 1 and 120');
  }
  const duration = timeline?.take?.duration ?? 0;
  const fps = timeline?.take?.fps ?? 30;
  const safeMaxTime = duration > 0 ? Math.max(0, duration - Math.min(0.04, 0.5 / Math.max(1, fps))) : 0;

  let rawTargets = [];
  if (Array.isArray(timestamps) && timestamps.length > 0) {
    timestamps.forEach((entry, i) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        rawTargets.push({ index: i, t: entry, label: `frame-${i}` });
      } else if (entry && typeof entry === 'object' && typeof entry.t === 'number' && Number.isFinite(entry.t)) {
        rawTargets.push({
          index: Number.isInteger(entry.index) ? entry.index : i,
          t: entry.t,
          label: entry.label ?? `step-${i}`,
        });
      } else {
        throw Error(`Invalid preview timestamp at index ${i}`);
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
    const stepEvents = eventTrack.events.filter(
      (e) => e && typeof e === 'object' && e.type === 'step' && typeof e.t === 'number' && Number.isFinite(e.t)
    );
    stepEvents.forEach((step, i) => {
      rawTargets.push({
        index: Number.isInteger(step.index) ? step.index : i,
        t: step.t,
        label: step.label ?? `step-${i}`,
      });
    });
  }

  if (rawTargets.length === 0) {
    const singleFrame = (timeline?.take?.frames ?? 0) === 1 || safeMaxTime <= 0;
    const count = singleFrame
      ? 1
      : Math.max(2, Math.min(maxFrames, Math.min(6, Math.ceil(duration * 3))));
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0 : (safeMaxTime * i) / (count - 1);
      rawTargets.push({ index: i, t, label: `sample-${i}` });
    }
  }

  if (rawTargets.length > maxFrames) {
    const pickedIndices = [];
    for (let i = 0; i < maxFrames; i += 1) {
      const idx = maxFrames === 1 ? 0 : Math.round((i * (rawTargets.length - 1)) / (maxFrames - 1));
      if (!pickedIndices.includes(idx)) pickedIndices.push(idx);
    }
    rawTargets = pickedIndices.map((idx) => rawTargets[idx]);
  }

  const usedFilenames = new Set();
  return rawTargets.map((target, i) => {
    const clampedT = Math.round(Math.max(0, Math.min(target.t, safeMaxTime)) * 1e4) / 1e4;
    const pad = String(i).padStart(3, '0');
    const slug = slugifyPreviewLabel(target.label);
    let filename = slug ? `step-${pad}-${slug}.png` : `step-${pad}.png`;
    if (usedFilenames.has(filename)) filename = `step-${pad}.png`;
    usedFilenames.add(filename);
    return {
      index: target.index,
      t: clampedT,
      requestedT: Math.round(target.t * 1e4) / 1e4,
      label: String(target.label ?? `step-${i}`),
      filename,
    };
  });
}

/**
 * Fast Remotion still-based preview: renders only key step frames in ONE shared bundle/browser
 * session and stitches them into `<outDir>/contact-sheet.png` + `<outDir>/stills/*.png`.
 */
export async function renderTimelinePreview({
  timeline: timelineInput,
  outDir,
  out,
  timestamps,
  maxFrames = 12,
  width,
  columns = 3,
  cwd,
  browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE ?? null,
  logLevel = 'error',
  signal,
  scratchDir,
} = {}) {
  const destArg = outDir ?? out;
  if (!destArg) {
    throw Error('renderTimelinePreview requires outDir or out');
  }
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) {
    throw Error('columns must be an integer between 1 and 12');
  }
  if (width !== undefined && (!(typeof width === 'number' && Number.isFinite(width)) || width < 2 || width > 7680)) {
    throw Error('width must be a finite number between 2 and 7680');
  }

  const { timeline, timelineFile, baseDir } = await loadTimelineInput(timelineInput, cwd);
  assertValidTimeline(timeline);

  let eventTrack = null;
  if (
    (!Array.isArray(timeline.steps) || timeline.steps.length === 0) &&
    !timestamps &&
    typeof timeline.take?.eventTrack === 'string' &&
    timeline.take.eventTrack.length > 0 &&
    !EXTERNAL_URL_RE.test(timeline.take.eventTrack)
  ) {
    try {
      const trackPath = resolveLocalPath(timeline.take.eventTrack, baseDir);
      eventTrack = JSON.parse(await readFile(trackPath, 'utf8'));
    } catch {
      // Optional fallback when timeline.steps is empty.
    }
  }

  const targets = resolvePreviewTargets({
    timeline,
    eventTrack,
    timestamps,
    maxFrames,
  });

  const aspect = timeline.camera.outputHeight / timeline.camera.outputWidth;
  const previewWidth = evenDimension(width ?? Math.min(1280, timeline.camera.outputWidth));
  const previewHeight = evenDimension(previewWidth * aspect);
  const previewFps = timeline.take.fps;
  const targetOutDir = resolve(cwd ?? process.cwd(), destArg);

  const scratchBase = scratchDir ? resolve(scratchDir) : tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const tempDir = await mkdtemp(join(scratchBase, 'screen-kit-preview-'));
  const publicDir = join(tempDir, 'public');
  const bundleOutDir = join(tempDir, 'bundle');
  const tempOutputsDir = join(tempDir, 'outputs');

  let browser = null;
  try {
    await mkdir(publicDir, { recursive: true });
    await mkdir(tempOutputsDir, { recursive: true });

    const stagedTimeline = await prepareStagedTimeline(timeline, baseDir, publicDir);

    const serveUrl = await bundle({
      entryPoint: REMOTION_ENTRY,
      outDir: bundleOutDir,
      publicDir,
      symlinkPublicDir: true,
      enableCaching: false,
      rspack: true,
    });

    browser = await openBrowser('chrome', {
      ...(browserExecutable ? { browserExecutable } : {}),
      logLevel,
    });

    if (signal?.aborted) {
      throw Error('Timeline preview aborted');
    }
    const remotionCancel = signal ? makeCancelSignal() : null;
    if (signal && remotionCancel) {
      signal.addEventListener('abort', () => remotionCancel.cancel(), { once: true });
    }

    const inputProps = {
      timeline: stagedTimeline,
      output: {
        id: 'preview',
        width: previewWidth,
        height: previewHeight,
        fps: previewFps,
      },
    };

    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
      puppeteerInstance: browser,
      logLevel,
    });

    const maxFrame = Math.max(0, composition.durationInFrames - 1);
    const stagedStills = [];

    for (const target of targets) {
      if (signal?.aborted) {
        throw Error('Timeline preview aborted');
      }
      const frame = Math.min(maxFrame, Math.max(0, Math.round(target.t * composition.fps)));
      const tempStillFile = join(tempOutputsDir, target.filename);
      await renderStill({
        serveUrl,
        composition,
        inputProps,
        frame,
        imageFormat: 'png',
        output: tempStillFile,
        puppeteerInstance: browser,
        ...(remotionCancel ? { cancelSignal: remotionCancel.cancelSignal } : {}),
        overwrite: true,
        logLevel,
      });

      const meta = await sharp(tempStillFile).metadata();
      if (!meta.width || !meta.height) {
        throw Error(`Preview render produced invalid image for ${target.filename}`);
      }
      const bytes = await readFile(tempStillFile);
      const destination = join(targetOutDir, 'stills', target.filename);
      stagedStills.push({
        tempFile: tempStillFile,
        destination,
        record: {
          index: target.index,
          t: target.t,
          requestedT: target.requestedT,
          frame,
          label: target.label,
          filename: target.filename,
          file: destination,
          width: meta.width,
          height: meta.height,
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      });
    }

    const tempContactSheet = join(tempOutputsDir, 'contact-sheet.png');
    const rawSheet = await generateContactSheet({
      stills: stagedStills.map((item) => ({
        index: item.record.index,
        t: item.record.t,
        label: item.record.label,
        file: item.tempFile,
      })),
      outputFile: tempContactSheet,
      columns,
    });
    const sheetBytes = await readFile(tempContactSheet);
    const finalSheetPath = join(targetOutDir, 'contact-sheet.png');

    if (signal?.aborted) {
      throw Error('Timeline preview aborted');
    }

    const stills = [];
    for (const item of stagedStills) {
      await moveFileAtomic(item.tempFile, item.destination);
      stills.push(item.record);
    }
    await moveFileAtomic(tempContactSheet, finalSheetPath);

    return {
      renderer: 'remotion-4',
      ...(timelineFile ? { timelineFile } : {}),
      outDir: targetOutDir,
      width: previewWidth,
      height: previewHeight,
      fps: previewFps,
      contactSheet: {
        ...rawSheet,
        file: finalSheetPath,
        bytes: sheetBytes.length,
        sha256: sha256(sheetBytes),
      },
      stills,
    };
  } finally {
    if (browser) {
      await browser.close({ silent: true }).catch(() => {});
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
