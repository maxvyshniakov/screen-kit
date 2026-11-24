import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.2.0';
export const hash = data => createHash('sha256').update(data).digest('hex');

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

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

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isUrlReachable(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    return res.status < 500;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function terminateProcessGroup(child, graceMs = 1500) {
  const pid = child?.pid;
  if (!pid) return;

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already exited.
    }
  }

  const termDeadline = Date.now() + graceMs;
  while (Date.now() < termDeadline && isProcessGroupAlive(pid)) {
    await sleep(25);
  }

  if (isProcessGroupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && isProcessGroupAlive(pid)) {
      await sleep(20);
    }
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
}

function validateServerConfig(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    throw Error('config.server must be an object');
  }
  if (typeof server.url !== 'string' || !server.url.trim()) {
    throw Error('config.server.url must be a non-empty URL string');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(server.url);
  } catch {
    throw Error(`Invalid config.server.url: ${server.url}`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw Error(`Unsupported config.server.url protocol: ${parsedUrl.protocol}`);
  }

  if (Array.isArray(server.command)) {
    if (!server.command.length || server.command.some((part) => typeof part !== 'string' || !part.length)) {
      throw Error('config.server.command array must contain non-empty string arguments');
    }
  } else if (typeof server.command === 'string') {
    if (!server.command.trim()) {
      throw Error('config.server.command string must be non-empty');
    }
  } else {
    throw Error('config.server.command must be a string or string[]');
  }

  const readyTimeout = server.readyTimeout ?? 30000;
  if (!Number.isFinite(readyTimeout) || readyTimeout <= 0) {
    throw Error(`Invalid config.server.readyTimeout: ${server.readyTimeout}`);
  }
  return { readyTimeout };
}

/**
 * Ensure `server.url` is reachable for the duration of `fn()`.
 * Reuses an already-running server without touching it; otherwise spawns `server.command`
 * in a detached process group and guarantees `SIGTERM` -> `SIGKILL` teardown in `finally`.
 */
export async function withManagedServer(server, defaultCwd, fn) {
  if (!server) return fn(null);
  const { readyTimeout } = validateServerConfig(server);

  if (await isUrlReachable(server.url)) {
    return fn({ url: server.url, reused: true, pid: null });
  }

  const serverCwd = resolve(defaultCwd, server.cwd ?? '.');
  const mergedEnv = { ...process.env, ...(server.env ?? {}) };

  const child = Array.isArray(server.command)
    ? spawn(server.command[0], server.command.slice(1), {
        cwd: serverCwd,
        env: mergedEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(server.command, {
        cwd: serverCwd,
        env: mergedEnv,
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  let logTail = '';
  const appendChunk = (chunk) => {
    logTail = (logTail + chunk.toString('utf8')).slice(-8192);
  };
  child.stdout?.on('data', appendChunk);
  child.stderr?.on('data', appendChunk);

  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let spawnError = null;

  child.once('error', (err) => {
    spawnError = err;
  });
  child.once('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  const onProcessExit = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // Ignore on process exit.
        }
      }
    }
  };
  process.once('exit', onProcessExit);

  try {
    const deadline = Date.now() + readyTimeout;
    while (true) {
      if (spawnError) {
        throw Error(`Managed server failed to start: ${spawnError.message}`);
      }
      if (await isUrlReachable(server.url, Math.min(1500, Math.max(250, deadline - Date.now())))) {
        break;
      }
      if (exited) {
        const detail = logTail.trim();
        throw Error(
          `Managed server exited prematurely (code ${exitCode}, signal ${exitSignal}) before ${server.url} became ready` +
            (detail ? `: ${detail}` : '')
        );
      }
      if (Date.now() >= deadline) {
        const detail = logTail.trim();
        throw Error(
          `Managed server at ${server.url} did not become ready within ${readyTimeout}ms` +
            (detail ? `: ${detail}` : '')
        );
      }
      await sleep(100);
    }

    return await fn({ url: server.url, reused: false, pid: child.pid });
  } finally {
    process.off('exit', onProcessExit);
    await terminateProcessGroup(child);
  }
}

async function readExistingManifest(manifestPath) {
  if (!(await fileExists(manifestPath))) return null;
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function isRecipeUnchanged({
  name,
  recipe,
  previous,
  manifestDir,
  outDir,
  currentSource,
  expectedMode,
}) {
  const prevEntry = previous?.recipes?.[name];
  if (!prevEntry || prevEntry.status !== 'complete') return false;
  if (expectedMode && prevEntry.mode && prevEntry.mode !== expectedMode) return false;
  if (!prevEntry.file || typeof prevEntry.file !== 'string') return false;

  if (prevEntry.recipeHash !== hash(JSON.stringify(recipe))) return false;

  const prevRev = previous?.source?.revision ?? null;
  const currRev = currentSource?.revision ?? null;
  if (prevRev !== currRev) return false;
  if (currentSource?.dirty === true || previous?.source?.dirty === true) return false;

  const manifestArtifactPath = resolve(manifestDir, prevEntry.file);
  const outArtifactPath = resolve(outDir, prevEntry.file);
  if (!(await fileExists(manifestArtifactPath))) return false;

  const bytes = await readFile(manifestArtifactPath);
  if (prevEntry.sha256 && hash(bytes) !== prevEntry.sha256) return false;
  for (const output of prevEntry.outputs ?? []) {
    const path = resolve(manifestDir, output.file);
    if (!(await fileExists(path)) || hash(await readFile(path)) !== output.sha256) return false;
  }

  if (outArtifactPath !== manifestArtifactPath && !(await fileExists(outArtifactPath))) {
    await mkdir(dirname(outArtifactPath), { recursive: true });
    await copyFile(manifestArtifactPath, outArtifactPath);
    for (const input of [...(prevEntry.inputs ?? []), ...(prevEntry.outputs ?? [])]) {
      const srcInput = resolve(manifestDir, input.file);
      const dstInput = resolve(outDir, input.file);
      if (await fileExists(srcInput)) {
        await mkdir(dirname(dstInput), { recursive: true });
        await copyFile(srcInput, dstInput);
      }
    }
  }

  return true;
}

/** Capture through real source adapters; partial results and failures remain inspectable. */
export async function captureRun({
  config,
  cwd = process.cwd(),
  out = join(cwd, 'out', 'screen-kit'),
  only,
  changedOnly = false,
  manifest,
} = {}) {
  const recipes = selectedRecipes(config, only);
  if (config?.server) validateServerConfig(config.server);
  cwd = resolve(cwd);
  out = resolve(cwd, out);
  const manifestPath = resolve(cwd, manifest ?? join(out, 'run.json'));
  const manifestDir = dirname(manifestPath);
  const previous = changedOnly ? await readExistingManifest(manifestPath) : null;

  const source = sourceRevision(cwd);
  const report = {
    version: 1,
    status: 'running',
    date: new Date().toISOString(),
    tool: { name: 'screen-kit', version: VERSION, node: process.version },
    source,
    recipes: {},
  };

  const skippedNames = new Set();
  if (changedOnly && previous) {
    for (const [name, recipe] of recipes) {
      const unchanged = await isRecipeUnchanged({
        name,
        recipe,
        previous,
        manifestDir,
        outDir: out,
        currentSource: source,
      });
      if (unchanged) {
        const { skipped: _prevSkipped, ...cleanPrev } = previous.recipes[name];
        report.recipes[name] = cleanPrev;
        skippedNames.add(name);
      }
    }
  }

  await mkdir(out, { recursive: true });
  const save = () => writeFile(join(out, 'run.json'), JSON.stringify(report, null, 2) + '\n');
  await save();

  const needsCapture = recipes.some(([name]) => !skippedNames.has(name));

  try {
    await withManagedServer(needsCapture ? config.server : null, cwd, async () => {
      for (const [name, recipe] of recipes) {
        if (skippedNames.has(name)) continue;

        const start = Date.now();
        report.recipes[name] = { status: 'running', recipeHash: hash(JSON.stringify(recipe)) };
        await save();
        try {
          const video = ['mp4', 'webm'].includes(recipe.format ?? recipe.outputs?.[0]?.format);
          const browserTake = recipe.source === 'browser' && (video || recipe.captureMode !== undefined) && recipe.driver !== 'agent-browser';
          const effectiveBase = recipe.base ?? config.server?.url;
          let artifact;
          if (browserTake) {
            const { captureBrowserTake } = await import('./take-browser.mjs');
            const takeDir = join(out, 'takes', name);
            artifact = await captureBrowserTake({
              name,
              recipe,
              cwd,
              out: takeDir,
              base: effectiveBase,
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
            artifact = await capture({
              name,
              recipe, // a terminal take encodes its video itself, straight from the replayed cells
              cwd,
              out,
              base: effectiveBase,
              ...(recipe.scale ? { scale: recipe.scale } : {}),
            });
            if (video && recipe.source !== 'terminal' && resolve(artifact.file) !== join(out, `${name}.${recipe.format}`)) {
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
          // Every render of a multi-output take, hashed like the primary one (which it lists first)
          const outputs = artifact.outputs && await Promise.all(artifact.outputs.map(async output => {
            const data = await readFile(resolve(out, output.file));
            return { file: relative(out, resolve(out, output.file)), bytes: data.length, sha256: hash(data),
              width: output.width, height: output.height, frames: output.frames, duration: output.duration };
          }));
          report.recipes[name] = {
            ...report.recipes[name],
            ...artifact,
            ...normalizedRefs,
            ...(outputs ? { outputs } : {}),
            file: relative(out, file),
            inputs,
            status: 'complete',
            bytes: bytes.length,
            sha256: hash(bytes),
            elapsedMs: Date.now() - start,
          };
        } catch (error) {
          Object.assign(report.recipes[name], { status: 'failed', error: error.message, elapsedMs: Date.now() - start });
          throw error;
        } finally {
          await save();
        }
      }
    });
    report.status = 'complete';
    if (!changedOnly) return report;

    const summaryRecipes = {};
    for (const [name] of recipes) {
      summaryRecipes[name] = {
        ...report.recipes[name],
        skipped: skippedNames.has(name),
      };
    }
    return {
      ...report,
      recipes: summaryRecipes,
    };
  } catch (error) {
    report.status = 'failed';
    throw error;
  } finally {
    await save();
  }
}

/** Compare recipes and source revision without launching an application or altering artifacts. */
export async function statusRun({ config, cwd = process.cwd(), manifest, only } = {}) {
  const selected = selectedRecipes(config, only);
  const previous = manifest ? JSON.parse(await readFile(resolve(cwd, manifest), 'utf8')) : { recipes: {} };
  const source = sourceRevision(cwd);
  const recipes = {};
  for (const [name, recipe] of selected) {
    const captured = previous.recipes?.[name];
    recipes[name] = {
      captured: Boolean(captured),
      recipeChanged: Boolean(captured && captured.recipeHash !== hash(JSON.stringify(recipe))),
      sourceChanged: Boolean(captured && previous.source?.revision !== source.revision),
      sourceDirty: source.dirty,
    };
  }
  return { source, recipes };
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
  manifest,
  changedOnly = false,
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
  if (config?.server) validateServerConfig(config.server);
  for (const [name, recipe] of recipes) {
    if (recipe.source !== 'browser') {
      throw Error(`${name}: runPipeline requires source "browser" (received "${recipe.source}")`);
    }
  }

  const out = resolve(cwd, outInput ?? join(cwd, 'out', 'screen-kit'));
  const mode = previewOnly ? 'preview' : 'full';
  const manifestPath = resolve(cwd, manifest ?? join(out, 'run.json'));
  const manifestDir = dirname(manifestPath);
  const previous = changedOnly ? await readExistingManifest(manifestPath) : null;
  const source = sourceRevision(cwd);

  const skippedEntries = new Map();
  if (changedOnly && previous) {
    for (const [name, recipe] of recipes) {
      const unchanged = await isRecipeUnchanged({
        name,
        recipe,
        previous,
        manifestDir,
        outDir: out,
        currentSource: source,
        expectedMode: mode,
      });
      if (unchanged) {
        const { skipped: _prevSkipped, ...cleanPrev } = previous.recipes[name];
        skippedEntries.set(name, cleanPrev);
      }
    }
  }

  await mkdir(out, { recursive: true });
  const runManifest = {
    version: 1,
    status: 'running',
    date: new Date().toISOString(),
    tool: { name: 'screen-kit', version: VERSION, node: process.version },
    source,
    recipes: Object.fromEntries(skippedEntries.entries()),
  };
  const saveManifest = () => writeFile(join(out, 'run.json'), JSON.stringify(runManifest, null, 2) + '\n');

  const recipeResults = {};
  let allOk = true;
  const needsExecution = recipes.some(([name]) => !skippedEntries.has(name));

  for (const [name, preserved] of skippedEntries.entries()) {
    recipeResults[name] = {
      ok: true,
      skipped: true,
      file: resolve(out, preserved.file),
      manifestEntry: preserved,
    };
  }

  if (needsExecution) {
    const [
      { captureBrowserTake, validateEventTrack },
      { compileTimeline },
      { renderTimeline, renderTimelinePreview },
      { probeVideo },
      { reviewVideo },
      narrationMod,
    ] = await Promise.all([
      import('./take-browser.mjs'),
      import('./timeline.mjs'),
      import('./render-timeline.mjs'),
      import('./video.mjs'),
      import('./review-video.mjs'),
      narrationConfig ? import('./narration.mjs') : Promise.resolve(null),
    ]);

    const needsCaptureServer = recipes.some(([name]) => !skippedEntries.has(name)) && !reuseTake;

    await withManagedServer(needsCaptureServer ? config.server : null, cwd, async () => {
      for (const [name, recipe] of recipes) {
        if (skippedEntries.has(name)) continue;

        const startMs = Date.now();
        const recipeHash = hash(JSON.stringify(recipe));
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
            base: recipe.base ?? config.server?.url,
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
          const primaryArtifact = preview.contactSheet?.file ?? preview.stills?.[0]?.file ?? videoPath;
          const primaryBytes = await readFile(primaryArtifact);
          runManifest.recipes[name] = {
            status: 'complete',
            mode: 'preview',
            recipeHash,
            file: relative(out, primaryArtifact),
            take: relative(out, videoPath),
            eventTrack: relative(out, activeEventTrackPath),
            timeline: relative(out, timelinePath),
            width: preview.contactSheet?.width ?? eventTrack.video.width,
            height: preview.contactSheet?.height ?? eventTrack.video.height,
            bytes: primaryBytes.length,
            sha256: hash(primaryBytes),
            elapsedMs: Date.now() - startMs,
          };
          recipeResults[name] = {
            ok: true,
            ...(changedOnly ? { skipped: false } : {}),
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

          const primaryOutput = profileTargets[0]?.videoOutput ?? renderResult.outputs[0];
          if (primaryOutput?.file && (await fileExists(primaryOutput.file))) {
            const primaryBytes = await readFile(primaryOutput.file);
            runManifest.recipes[name] = {
              status: recipeOk ? 'complete' : 'failed',
              mode: 'full',
              recipeHash,
              file: relative(out, primaryOutput.file),
              take: relative(out, videoPath),
              eventTrack: relative(out, activeEventTrackPath),
              timeline: relative(out, timelinePath),
              width: primaryOutput.width ?? eventTrack.video.width,
              height: primaryOutput.height ?? eventTrack.video.height,
              ...(primaryOutput.frames !== undefined ? { frames: primaryOutput.frames } : {}),
              ...(primaryOutput.duration !== undefined ? { duration: primaryOutput.duration } : {}),
              bytes: primaryBytes.length,
              sha256: hash(primaryBytes),
              elapsedMs: Date.now() - startMs,
            };
          }

          if (!recipeOk) allOk = false;
          recipeResults[name] = {
            ok: recipeOk,
            ...(changedOnly ? { skipped: false } : {}),
            take: takeSummary,
            timeline: timelineSummary,
            ...(narrationSummary ? { narration: narrationSummary } : {}),
            render: renderResult,
            review: reviewSummary,
          };
        }
      }
    });
  }

  runManifest.status = allOk ? 'complete' : 'failed';
  await saveManifest();

  const singleName = recipes.length === 1 ? recipes[0][0] : null;
  const singleResult = singleName ? recipeResults[singleName] : null;

  return {
    ok: allOk,
    mode,
    outDir: out,
    ...(singleResult
      ? singleResult.skipped
        ? {
            recipe: singleName,
            skipped: true,
            file: singleResult.file,
            manifestEntry: singleResult.manifestEntry,
          }
        : {
            recipe: singleName,
            ...(changedOnly ? { skipped: false } : {}),
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
