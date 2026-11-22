import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, link, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { bundle } from '@remotion/bundler';
import {
  makeCancelSignal,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
} from '@remotion/renderer';
import { assertValidTimeline } from './timeline.mjs';
import { generateContactSheet } from './images.mjs';
import { probeVideo } from './video.mjs';
import { computeFrameScene, screenToRender } from './remotion/layout.mjs';
import { COMPOSITION_ID } from './remotion/Root.mjs';

export { computeFrameScene, screenToRender };

export const RENDER_PROFILES = ['web-loop', 'youtube-master'];
const POSTER_FORMATS = new Set(['png', 'webp']);
const SINGLE_FILE_EXTENSIONS = new Set(['mp4', 'webm', 'png', 'webp']);
const EXTERNAL_URL_RE = /^(?:https?:|data:|blob:)/i;

const REMOTION_ENTRY = fileURLToPath(new URL('./remotion/index.mjs', import.meta.url));

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const evenDimension = (value) => Math.max(2, Math.round(value / 2) * 2);

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
} = {}) {
  assertValidTimeline(timeline);

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
    if (ext === 'png' || ext === 'webp') {
      return {
        mode: 'file',
        outDir: dirname(file),
        targets: [
          {
            id: baseSpec.id ?? 'poster',
            role: 'poster',
            kind: 'still',
            format: ext,
            width: Math.max(1, Math.round(baseSpec.width ?? timeline.camera.outputWidth)),
            height: Math.max(1, Math.round(baseSpec.height ?? timeline.camera.outputHeight)),
            fps: targetFps,
            posterTime,
            file,
          },
        ],
      };
    }

    const width = evenDimension(baseSpec.width ?? timeline.camera.outputWidth);
    const height = evenDimension(baseSpec.height ?? timeline.camera.outputHeight);
    return {
      mode: 'file',
      outDir: dirname(file),
      targets: [
        {
          id: baseSpec.id ?? ext,
          role: 'video',
          kind: 'video',
          format: ext,
          codec: normalizeRemotionCodec(ext === baseSpec.format ? baseSpec.codec : undefined, ext),
          width,
          height,
          fps: targetFps,
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
    const targetFps = fps ?? spec.fps ?? timeline.take.fps;
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
          posterTime,
          file: join(targetDir, `youtube-master-poster.${posterFormat}`),
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
        posterTime,
        file: join(targetDir, `${spec.id}-poster.${posterFormat}`),
      });
    }
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

async function prepareStagedTimeline(timeline, baseDir, publicDir) {
  const staged = structuredClone(timeline);
  let counter = 0;
  const stagedMap = new Map();

  const stageRef = async (ref, label) => {
    if (EXTERNAL_URL_RE.test(ref)) return ref;
    const absPath = resolveLocalPath(ref, baseDir);
    if (stagedMap.has(absPath)) return stagedMap.get(absPath);
    try {
      const assetRel = await stageMediaFile(absPath, publicDir, counter++);
      stagedMap.set(absPath, assetRel);
      return assetRel;
    } catch (error) {
      throw Error(`${label} not found or unreadable (${absPath}): ${error.message}`);
    }
  };

  if (!EXTERNAL_URL_RE.test(timeline.take.video)) {
    const absVideo = resolveLocalPath(timeline.take.video, baseDir);
    const assetRel = await stageRef(timeline.take.video, 'timeline.take.video');
    try {
      const videoInfo = await probeVideo(absVideo);
      if (!videoInfo.frames || !(videoInfo.duration > 0)) {
        throw Error('take video has zero frames or non-positive duration');
      }
    } catch (error) {
      throw Error(`Invalid timeline.take.video (${absVideo}): ${error.message}`);
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
      try {
        const meta = await sharp(absBg).metadata();
        if (!meta.width || !meta.height) throw Error('empty image dimensions');
      } catch (error) {
        throw Error(`Invalid timeline.stage.background.src (${absBg}): ${error.message}`);
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
  });

  const scratchBase = scratchDir ? resolve(scratchDir) : tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const tempDir = await mkdtemp(join(scratchBase, 'screen-kit-remotion-'));
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
      throw Error('Timeline render aborted');
    }
    const remotionCancel = signal ? makeCancelSignal() : null;
    if (signal && remotionCancel) {
      signal.addEventListener('abort', () => remotionCancel.cancel(), { once: true });
    }

    const hasAudio = stagedTimeline.audio.tracks.length > 0;
    const stagedOutputs = [];

    for (const target of plan.targets) {
      if (signal?.aborted) {
        throw Error('Timeline render aborted');
      }
      const inputProps = {
        timeline: stagedTimeline,
        output: {
          id: target.id,
          width: target.width,
          height: target.height,
          fps: target.fps,
        },
      };

      const composition = await selectComposition({
        serveUrl,
        id: COMPOSITION_ID,
        inputProps,
        puppeteerInstance: browser,
        logLevel,
      });

      const tempFile = join(
        tempOutputsDir,
        `${target.id}-${target.role}-${randomUUID()}.${target.format}`
      );

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
          ...(remotionCancel ? { cancelSignal: remotionCancel.cancelSignal } : {}),
          overwrite: true,
          ...(concurrency !== undefined ? { concurrency } : {}),
          logLevel,
        });

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
