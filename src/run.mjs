import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
export const hash = data => createHash('sha256').update(data).digest('hex');

export async function loadConfiguration(file, cwd = process.cwd()) {
  const path = resolve(cwd, file);
  const config = path.endsWith('.json') ? JSON.parse(await readFile(path, 'utf8')) : (await import(pathToFileURL(path).href)).default;
  if (!config || typeof config !== 'object') throw Error('configuration must export an object');
  return { config, cwd: resolve(dirname(path), config.cwd ?? '.'), path };
}

export function selectedRecipes(config, only) {
  if (!config?.recipes || typeof config.recipes !== 'object' || Array.isArray(config.recipes))
    throw Error('configuration needs a recipes object');
  const names = only ? (Array.isArray(only) ? only : only.split(',')) : Object.keys(config.recipes);
  if (!names.length) throw Error('no recipes selected');
  return names.map(name => {
    if (!/^[\w][\w.-]*$/.test(name)) throw Error(`invalid recipe name: ${name}`);
    if (!Object.hasOwn(config.recipes, name)) throw Error(`unknown recipe: ${name}`);
    const recipe = { ...config.defaults, ...config.recipes[name] };
    if (!recipe.format && recipe.output?.format) recipe.format = recipe.output.format;
    if (recipe.source === 'browser' && (recipe.captureMode !== undefined || recipe.presentation !== undefined) && !recipe.format) {
      recipe.format = 'mp4';
    }
    if (!['terminal', 'browser'].includes(recipe.source)) throw Error(`${name}: unsupported source ${recipe.source}`);
    return [name, recipe];
  });
}

export function sourceRevision(cwd) {
  try {
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { revision: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) };
  } catch { return { revision: null, dirty: null }; }
}

/** Capture through real source adapters; partial results and failures remain inspectable. */
export async function captureRun({ config, cwd = process.cwd(), out = join(cwd, 'out', 'screen-kit'), only } = {}) {
  const recipes = selectedRecipes(config, only);
  cwd = resolve(cwd);
  out = resolve(cwd, out);
  const report = { version: 1, status: 'running', date: new Date().toISOString(),
    tool: { name: 'screen-kit', version: VERSION, node: process.version },
    source: sourceRevision(cwd), recipes: {} };
  await mkdir(out, { recursive: true });
  const save = () => writeFile(join(out, 'run.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  try {
    for (const [name, recipe] of recipes) {
      const start = Date.now();
      report.recipes[name] = { status: 'running', recipeHash: hash(JSON.stringify(recipe)) };
      await save();
      try {
        const video = ['mp4', 'webm'].includes(recipe.format);
        const browserTake = recipe.source === 'browser' && (video || recipe.captureMode !== undefined) && recipe.driver !== 'agent-browser';
        let artifact;
        if (browserTake) {
          const { captureBrowserTake } = await import('./take-browser.mjs');
          const takeDir = join(out, 'takes', name);
          artifact = await captureBrowserTake({
            name,
            recipe,
            cwd,
            out: takeDir,
            base: recipe.base,
            ...(recipe.scale ? { scale: recipe.scale } : {}),
            ...(recipe.captureMode !== undefined ? { captureMode: recipe.captureMode } : {}),
          });
          delete artifact.eventTrackData;
          const exportPath = join(out, `${name}.${recipe.format}`);
          await copyFile(artifact.file, exportPath);
          artifact.take = artifact.file;
          artifact.file = exportPath;
        } else {
          const { captureTerminalRecipe } = recipe.source === 'terminal' ? await import('./terminal.mjs') : {};
          const { captureBrowserRecipe } = recipe.source === 'browser' ? await import('./browser.mjs') : {};
          const capture = captureTerminalRecipe ?? captureBrowserRecipe;
          const captureRecipe = recipe.source === 'terminal' && video ? { ...recipe, format: 'webp' } : recipe;
          artifact = await capture({ name, recipe: captureRecipe, cwd, out, base: recipe.base,
            ...(recipe.scale ? { scale: recipe.scale } : {}) });
          if (video && resolve(artifact.file) !== join(out, `${name}.${recipe.format}`)) {
            const { renderVideo } = await import('./video.mjs');
            const output = join(out, `${name}.${recipe.format}`);
            const encoded = await renderVideo({ input: artifact.videoInput ?? artifact.file, output, fps: recipe.fps });
            Object.assign(artifact, encoded, { videoInput: artifact.videoInput ?? artifact.file });
          }
        }
        if (video) {
          const { probeVideo } = await import('./video.mjs');
          const probed = await probeVideo(artifact.file);
          Object.assign(artifact, probed, {
            encodedFps: Number(probed.fps.toFixed(2)),
            ...(recipe.duration !== undefined ? { requestedDuration: recipe.duration } : {}),
            ...(artifact.requestedFps !== undefined || recipe.fps !== undefined ? { requestedFps: artifact.requestedFps ?? recipe.fps } : {}),
          });
        }
        const file = resolve(out, artifact.file);
        if (![artifact.width, artifact.height].every(value => Number.isInteger(value) && value > 0))
          throw Error(`${name}: capture did not report valid dimensions`);
        const bytes = await readFile(file);
        const inputs = [];
        for (const path of new Set([artifact.take, artifact.videoInput, artifact.eventTrack].filter(Boolean))) {
          const resolvedInput = resolve(out, path);
          if (resolvedInput !== file) inputs.push({ file: relative(out, resolvedInput), sha256: hash(await readFile(resolvedInput)) });
        }
        const normalizedRefs = {
          ...(artifact.take ? { take: relative(out, resolve(out, artifact.take)) } : {}),
          ...(artifact.eventTrack ? { eventTrack: relative(out, resolve(out, artifact.eventTrack)) } : {}),
        };
        report.recipes[name] = { ...report.recipes[name], ...artifact, ...normalizedRefs, file: relative(out, file), inputs,
          status: 'complete', bytes: bytes.length, sha256: hash(bytes), elapsedMs: Date.now() - start };
      } catch (error) {
        Object.assign(report.recipes[name], { status: 'failed', error: error.message, elapsedMs: Date.now() - start });
        throw error;
      } finally { await save(); }
    }
    report.status = 'complete';
    return report;
  } catch (error) {
    report.status = 'failed';
    throw error;
  } finally { await save(); }
}

/** Compare recipes and source revision without launching an application or altering artifacts. */
export async function statusRun({ config, cwd = process.cwd(), manifest, only } = {}) {
  const selected = selectedRecipes(config, only);
  const previous = manifest ? JSON.parse(await readFile(resolve(cwd, manifest), 'utf8')) : { recipes: {} };
  const source = sourceRevision(cwd);
  const recipes = {};
  for (const [name, recipe] of selected) {
    const captured = previous.recipes?.[name];
    recipes[name] = { captured: Boolean(captured),
      recipeChanged: Boolean(captured && captured.recipeHash !== hash(JSON.stringify(recipe))),
      sourceChanged: Boolean(captured && previous.source?.revision !== source.revision),
      sourceDirty: source.dirty };
  }
  return { source, recipes };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unified single-config pipeline: capture browser takes (or reuse existing valid takes when
 * `reuseTake` is true) -> compile `timeline.json` (with `recipe.presentation` and per-step camera
 * hints) -> run fast `renderTimelinePreview` (`previewOnly`) OR full `renderTimeline` + `reviewVideo`.
 */
export async function runPipeline({
  config: configInput,
  cwd: cwdInput = process.cwd(),
  only,
  out: outInput,
  previewOnly = false,
  reuseTake = false,
  profiles,
  colorSpace,
  narration,
  burnInCaptions,
  burnCaptions,
  ttsProvider,
  aligner,
  narrationOptions = {},
  captureOptions = {},
  renderOptions = {},
  reviewOptions = {},
} = {}) {
  let config = configInput;
  let cwd = resolve(cwdInput);
  if (typeof configInput === 'string') {
    const loaded = await loadConfiguration(configInput, cwd);
    config = loaded.config;
    cwd = loaded.cwd;
  }

  let narrationConfig = null;
  if (narration !== undefined && narration !== false && narration !== null && narration !== '') {
    if (typeof narration === 'string') {
      const langs = narration.split(',').map((s) => s.trim()).filter(Boolean);
      narrationConfig = {
        ...narrationOptions,
        language: langs[0] ?? 'en',
        ...(langs.length > 1 ? { languages: langs } : {}),
      };
    } else if (narration === true) {
      narrationConfig = { ...narrationOptions, language: narrationOptions.language ?? 'en' };
    } else if (typeof narration === 'object' && !Array.isArray(narration)) {
      narrationConfig = { ...narrationOptions, ...narration };
    } else {
      throw Error(`Invalid narration option: ${String(narration)}`);
    }
    if (ttsProvider !== undefined && narrationConfig.provider === undefined) {
      narrationConfig.provider = ttsProvider;
    }
    if (aligner !== undefined && narrationConfig.aligner === undefined) {
      narrationConfig.aligner = aligner;
    }
    const explicitBurnIn = burnInCaptions ?? burnCaptions;
    if (explicitBurnIn !== undefined && narrationConfig.burnInCaptions === undefined) {
      narrationConfig.burnInCaptions = Boolean(explicitBurnIn);
    }
  }

  const recipes = selectedRecipes(config, only);
  for (const [name, recipe] of recipes) {
    if (recipe.source !== 'browser') {
      throw Error(`${name}: runPipeline requires source "browser" (received "${recipe.source}")`);
    }
  }

  const out = resolve(cwd, outInput ?? join(cwd, 'out', 'screen-kit'));
  await mkdir(out, { recursive: true });

  const [{ captureBrowserTake, validateEventTrack }, { compileTimeline }, { renderTimeline, renderTimelinePreview }, { probeVideo }, { reviewVideo }, narrationMod] =
    await Promise.all([
      import('./take-browser.mjs'),
      import('./timeline.mjs'),
      import('./render-timeline.mjs'),
      import('./video.mjs'),
      import('./review-video.mjs'),
      narrationConfig ? import('./narration.mjs') : Promise.resolve(null),
    ]);

  const recipeResults = {};
  let allOk = true;

  for (const [name, recipe] of recipes) {
    const takeDir = join(out, 'takes', name);
    const recipeDir = recipes.length === 1 ? out : join(out, name);
    await mkdir(recipeDir, { recursive: true });

    let eventTrack = null;
    let eventTrackPath = join(takeDir, 'event-track.json');
    let videoPath = null;
    let reused = false;

    if (reuseTake && (await fileExists(eventTrackPath))) {
      const rawTrack = JSON.parse(await readFile(eventTrackPath, 'utf8'));
      eventTrack = validateEventTrack(rawTrack);
      videoPath = resolve(takeDir, eventTrack.video.file);
      if (!(await fileExists(videoPath))) {
        throw Error(`${name}: reusable take video missing at ${videoPath}`);
      }
      const probed = await probeVideo(videoPath);
      if (!probed.frames || !(probed.duration > 0)) {
        throw Error(`${name}: reusable take video is empty or invalid at ${videoPath}`);
      }
      reused = true;
    } else {
      const format = ['mp4', 'webm'].includes(recipe.format) ? recipe.format : 'mp4';
      const captureColorSpace = colorSpace ?? recipe.colorSpace ?? recipe.presentation?.colorSpace;
      const artifact = await captureBrowserTake({
        name,
        recipe: {
          ...recipe,
          format,
          ...(captureColorSpace ? { colorSpace: captureColorSpace } : {}),
        },
        cwd,
        out: takeDir,
        base: recipe.base,
        ...(recipe.scale ? { scale: recipe.scale } : {}),
        ...(recipe.captureMode !== undefined ? { captureMode: recipe.captureMode } : {}),
        ...captureOptions,
      });
      eventTrack = artifact.eventTrackData;
      eventTrackPath = artifact.eventTrack;
      videoPath = artifact.file;
    }

    const presentation =
      recipe.presentation && typeof recipe.presentation === 'object'
        ? recipe.presentation
        : recipe.timeline && typeof recipe.timeline === 'object'
          ? recipe.timeline
          : recipe;

    const timelinePath = join(recipeDir, 'timeline.json');
    const relVideo = relative(recipeDir, videoPath);
    const relEventTrack = relative(recipeDir, eventTrackPath);

    const effectiveColorSpace =
      colorSpace ?? presentation.colorSpace ?? recipe.colorSpace ?? eventTrack.video?.colorSpace;
    let activeTimeline = compileTimeline({
      take: {
        video: relVideo,
        eventTrack: relEventTrack,
        ...(effectiveColorSpace !== undefined ? { colorSpace: effectiveColorSpace } : {}),
      },
      eventTrack,
      recipe: presentation,
    });
    let activeEventTrackPath = eventTrackPath;
    let narrationSummary = null;

    if (narrationConfig && narrationMod) {
      const narrated = await narrationMod.narrateTimeline({
        ...narrationConfig,
        timeline: activeTimeline,
        eventTrack,
        recipe,
        outDir: recipeDir,
        cwd: recipeDir,
      });
      activeTimeline = narrated.timeline;
      if (narrated.eventTrackFile) {
        activeEventTrackPath = narrated.eventTrackFile;
      }
      narrationSummary = {
        provider: narrated.provider,
        aligner: narrated.aligner,
        language: narrated.language,
        languages: narrated.languages,
        paddedSeconds: narrated.paddedSeconds,
        totalDuration: narrated.totalDuration,
        ...(narrated.paddedVideoFile ? { paddedVideoFile: narrated.paddedVideoFile } : {}),
        ...(narrated.eventTrackFile ? { eventTrackFile: narrated.eventTrackFile } : {}),
        audioTracks: narrated.audioTracks.length,
        subtitles: Object.fromEntries(
          Object.entries(narrated.subtitles).map(([lang, sub]) => [
            lang,
            {
              cueCount: sub.cues.length,
              ...(sub.srtFile ? { srtFile: sub.srtFile } : {}),
              ...(sub.vttFile ? { vttFile: sub.vttFile } : {}),
            },
          ])
        ),
      };
    } else {
      await writeFile(timelinePath, JSON.stringify(activeTimeline, null, 2) + '\n');
    }

    const takeSummary = {
      reused,
      video: videoPath,
      eventTrack: eventTrackPath,
      captureMode: eventTrack.captureMode,
      width: eventTrack.video.width,
      height: eventTrack.video.height,
      fps: eventTrack.video.fps,
      duration: eventTrack.video.duration,
      frames: eventTrack.video.frames,
    };

    const timelineSummary = {
      file: timelinePath,
      steps: activeTimeline.steps,
      cameraKeyframes: activeTimeline.camera.keyframes.length,
      outputs: activeTimeline.outputs,
    };

    if (previewOnly) {
      const previewDir = join(recipeDir, 'preview');
      const preview = await renderTimelinePreview({
        timeline: timelinePath,
        outDir: previewDir,
        ...(colorSpace ? { colorSpace } : {}),
        ...renderOptions,
      });
      recipeResults[name] = {
        ok: true,
        take: takeSummary,
        timeline: timelineSummary,
        ...(narrationSummary ? { narration: narrationSummary } : {}),
        preview,
      };
    } else {
      const renderResult = await renderTimeline({
        timeline: timelinePath,
        outDir: recipeDir,
        ...(profiles ? { profiles } : {}),
        ...(colorSpace ? { colorSpace } : {}),
        ...renderOptions,
      });

      const videoOutputs = renderResult.outputs.filter(
        (item) => item.format === 'mp4' || item.format === 'webm'
      );
      const profileGroups = new Map();
      for (const item of videoOutputs) {
        const groupKey = item.id ?? 'default';
        if (!profileGroups.has(groupKey)) profileGroups.set(groupKey, []);
        profileGroups.get(groupKey).push(item);
      }

      const profileTargets = [];
      for (const [profileId, items] of profileGroups.entries()) {
        const chosen =
          items.find((item) => item.role === 'video' && item.format === 'mp4') ??
          items.find((item) => item.format === 'mp4') ??
          items[0];
        if (chosen) profileTargets.push({ profileId, videoOutput: chosen });
      }

      let reviewSummary = null;
      const profileReviews = {};
      let recipeOk = true;
      for (let pIdx = 0; pIdx < profileTargets.length; pIdx += 1) {
        const { profileId, videoOutput } = profileTargets[pIdx];
        const reviewDir =
          profileTargets.length === 1 || pIdx === 0
            ? join(recipeDir, 'review')
            : join(recipeDir, 'review', profileId);
        const fullReview = await reviewVideo({
          video: videoOutput.file,
          timeline: timelinePath,
          eventTrack: activeEventTrackPath,
          outDir: reviewDir,
          ...(videoOutput.id ? { outputId: videoOutput.id } : {}),
          ...reviewOptions,
        });
        if (!fullReview.ok) recipeOk = false;
        const summaryItem = {
          ok: fullReview.ok,
          ...(videoOutput.id ? { outputId: videoOutput.id } : {}),
          video: fullReview.video,
          report: fullReview.artifacts?.report ?? null,
          contactSheet: fullReview.artifacts?.contactSheet?.file ?? null,
          stills: (fullReview.artifacts?.stills ?? []).map((s) => s.file),
          checks: fullReview.checks,
          findings: fullReview.findings,
        };
        profileReviews[profileId] = summaryItem;
        if (pIdx === 0) {
          reviewSummary = summaryItem;
        }
      }
      if (profileTargets.length > 1 && reviewSummary) {
        reviewSummary = {
          ...reviewSummary,
          ok: recipeOk,
          profiles: profileReviews,
        };
      }

      if (!recipeOk) allOk = false;
      recipeResults[name] = {
        ok: recipeOk,
        take: takeSummary,
        timeline: timelineSummary,
        ...(narrationSummary ? { narration: narrationSummary } : {}),
        render: renderResult,
        review: reviewSummary,
      };
    }
  }

  const singleName = recipes.length === 1 ? recipes[0][0] : null;
  const singleResult = singleName ? recipeResults[singleName] : null;

  return {
    ok: allOk,
    mode: previewOnly ? 'preview' : 'full',
    outDir: out,
    ...(singleResult
      ? {
          recipe: singleName,
          take: singleResult.take,
          timeline: singleResult.timeline,
          ...(singleResult.narration ? { narration: singleResult.narration } : {}),
          ...(previewOnly
            ? { preview: singleResult.preview }
            : { render: singleResult.render, review: singleResult.review }),
        }
      : {}),
    recipes: recipeResults,
  };
}
