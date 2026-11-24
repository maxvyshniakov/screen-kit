import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { comparison, difference } from './images.mjs';
import { hash } from './run.mjs';
import { validateEventTrack } from './take-browser.mjs';
import { probeVideo } from './video.mjs';
import { reviewVideo } from './review-video.mjs';

export { reviewVideo };

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function inspectCast(bytes) {
  const [header, ...events] = bytes.toString('utf8').trim().split('\n').map(JSON.parse);
  if (header?.version !== 2 || ![header.width, header.height].every(n => Number.isInteger(n) && n > 0))
    throw Error('asciicast needs a version 2 header with positive integer dimensions');
  if (!events.length || !events.some(event => event?.[1] === 'o')) throw Error('asciicast has no output events');
  let previous = 0;
  for (const event of events) {
    if (!Array.isArray(event) || event.length !== 3 || !Number.isFinite(event[0]) || event[0] < previous
        || !['o', 'i', 'm', 'r'].includes(event[1]) || typeof event[2] !== 'string')
      throw Error('asciicast events must be ordered, nonnegative [time, type, string] records');
    previous = event[0];
  }
  return { width: header.width, height: header.height, frames: 0, duration: previous };
}

/** What a captured file actually holds: a take's terminal size and length, a video's probe, an image's pages. */
async function inspectArtifact(file, bytes) {
  const ext = extname(file).toLowerCase();
  if (ext === '.cast') return inspectCast(bytes);
  if (['.mp4', '.webm', '.mov'].includes(ext)) return probeVideo(file);
  const metadata = await sharp(bytes, { animated: true }).metadata();
  return {
    width: metadata.width,
    height: metadata.pageHeight ?? metadata.height,
    frames: metadata.pages ?? 1,
    duration: metadata.delay?.reduce((sum, delay) => sum + delay, 0) / 1000,
  };
}

/** Verify exported bytes against the capture manifest; no application is launched. */
export async function reviewRun({
  manifest,
  videoReview,
  outDir,
  baseline,
  updateBaselines = false,
  multimodal,
} = {}) {
  if (!manifest) throw Error('review requires a run.json manifest');
  if (updateBaselines && !baseline) throw Error('updateBaselines requires a baseline directory');
  manifest = resolve(manifest);
  const report = JSON.parse(await readFile(manifest, 'utf8'));
  const checks = [];
  const recipes = {};
  const videos = {};
  const baselinesUpdated = [];
  const check = (name, ok, message) => checks.push({ name, ok: Boolean(ok), message });

  check('run', report.version === 1 && report.status === 'complete', `run status: ${report.status}`);
  check('recipes', Object.keys(report.recipes ?? {}).length > 0, 'run contains captured recipes');

  for (const [name, artifact] of Object.entries(report.recipes ?? {})) {
    const startCheckIdx = checks.length;
    check(`${name}:capture`, artifact.status === 'complete', artifact.error ?? `capture status: ${artifact.status}`);
    if (artifact.status !== 'complete') {
      recipes[name] = { ok: false, status: artifact.status, ...(artifact.error ? { error: artifact.error } : {}) };
      continue;
    }

    let baselineInfo = null;
    try {
      const file = resolve(dirname(manifest), artifact.file);
      const bytes = await readFile(file);
      check(`${name}:hash`, hash(bytes) === artifact.sha256, 'artifact hash matches the capture manifest');
      for (const input of artifact.inputs ?? []) {
        const data = await readFile(resolve(dirname(manifest), input.file));
        check(`${name}:take`, hash(data) === input.sha256, 'source take hash matches the capture manifest');
      }
      // A multi-output take lists every render, the primary one first: each gets the primary's checks
      for (const output of artifact.outputs ?? []) {
        const path = resolve(dirname(manifest), output.file);
        const data = await readFile(path);
        check(`${name}:output`, hash(data) === output.sha256, `${output.file} hash matches the capture manifest`);
        const found = await inspectArtifact(path, data);
        check(`${name}:output`, found.width === output.width && found.height === output.height,
          `${output.file} dimensions ${found.width}×${found.height}; expected ${output.width}×${output.height}`);
        if (output.frames !== undefined)
          check(`${name}:output`, found.frames === output.frames, `${output.file} frames ${found.frames}; expected ${output.frames}`);
        if (output.duration > 0 && found.frames > 1)
          check(`${name}:output`, Math.abs(found.duration - output.duration) <= 0.1,
            `${output.file} duration ${found.duration}s; expected ${output.duration}s`);
      }
      if (artifact.eventTrack) {
        const trackBytes = await readFile(resolve(dirname(manifest), artifact.eventTrack));
        if (artifact.eventTrackSha256) {
          check(`${name}:eventTrackHash`, hash(trackBytes) === artifact.eventTrackSha256, 'event-track.json hash matches the capture manifest');
        }
        const track = validateEventTrack(JSON.parse(trackBytes.toString('utf8')));
        if (artifact.captureMode) {
          check(`${name}:captureMode`, track.captureMode === artifact.captureMode, `event-track captureMode ${track.captureMode}; expected ${artifact.captureMode}`);
        }
      }

      const ext = extname(file).toLowerCase();
      const cast = ext === '.cast';
      const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
      const actual = await inspectArtifact(file, bytes);

      check(`${name}:dimensions`, actual.width === artifact.width && actual.height === artifact.height,
        `dimensions ${actual.width}×${actual.height}; expected ${artifact.width}×${artifact.height}`);
      if (artifact.frames !== undefined)
        check(`${name}:frames`, actual.frames === artifact.frames, `frames ${actual.frames}; expected ${artifact.frames}`);
      if (artifact.duration > 0 && (cast || actual.frames > 1))
        check(`${name}:duration`, Math.abs(actual.duration - artifact.duration) <= 0.1,
          `duration ${actual.duration}s; expected ${artifact.duration}s`);
      for (const assertion of artifact.assertions ?? [])
        check(`${name}:assertion`, assertion.ok, assertion.message ?? assertion.expect ?? 'capture assertion');
      for (const checkpoint of artifact.checkpoints ?? [])
        check(`${name}:checkpoint`, checkpoint.passed, `expected screen content at ${checkpoint.at}s: ${JSON.stringify(checkpoint.expect)}`);

      const isStillImage = ['.png', '.webp'].includes(ext) && (actual.frames ?? 1) === 1;
      const verifiedSoFar = checks.slice(startCheckIdx).every((c) => c.ok);

      if (baseline && isStillImage) {
        const baseRoot = resolve(baseline);
        const relCandidate = join(baseRoot, artifact.file);
        const flatCandidate = join(baseRoot, basename(artifact.file));

        if (updateBaselines) {
          if (verifiedSoFar) {
            const targetBaseline = (await pathExists(relCandidate))
              ? relCandidate
              : (await pathExists(flatCandidate))
                ? flatCandidate
                : relCandidate;
            await mkdir(dirname(targetBaseline), { recursive: true });
            await copyFile(file, targetBaseline);
            baselinesUpdated.push(targetBaseline);
            baselineInfo = {
              baselineFile: targetBaseline,
              diffRatio: 0,
              changedPixels: 0,
              comparisonFile: null,
              baselineUpdated: true,
            };
            check(`${name}:baseline`, true, `baseline updated: ${targetBaseline}`);
          }
        } else {
          const baselineFile = (await pathExists(relCandidate))
            ? relCandidate
            : (await pathExists(flatCandidate))
              ? flatCandidate
              : null;

          if (!baselineFile) {
            let comparisonFile = null;
            if (outDir) {
              comparisonFile = join(resolve(outDir), 'comparisons', `${name}.png`);
              await comparison(null, file, comparisonFile);
            }
            baselineInfo = {
              baselineFile: null,
              diffRatio: null,
              changedPixels: null,
              comparisonFile,
            };
            check(`${name}:baseline`, false, `missing baseline image for ${artifact.file}`);
          } else {
            const rawDiff = await difference(baselineFile, file);
            const totalPixels = actual.width * actual.height;
            const changedPixels = rawDiff === null ? null : Math.round(rawDiff * totalPixels);
            const diffRatio = rawDiff === null ? null : Number(rawDiff.toFixed(6));
            const hasDiff = rawDiff === null || changedPixels > 0;
            let comparisonFile = null;
            if (hasDiff && outDir) {
              comparisonFile = join(resolve(outDir), 'comparisons', `${name}.png`);
              await comparison(baselineFile, file, comparisonFile);
            }
            baselineInfo = {
              baselineFile,
              diffRatio,
              changedPixels,
              comparisonFile,
            };
            if (rawDiff === null) {
              check(`${name}:baseline`, false, 'dimensions differ from baseline image');
            } else if (changedPixels > 0) {
              check(
                `${name}:baseline`,
                false,
                `visual diff against baseline: ${changedPixels} changed pixels (${(rawDiff * 100).toFixed(2)}%)`
              );
            } else {
              check(`${name}:baseline`, true, 'matches baseline image');
            }
          }
        }
      }

      if (isVideo && videoReview !== false) {
        const extraOpts = typeof videoReview === 'object' && videoReview !== null ? videoReview : {};
        const timelineRef = typeof artifact.timeline === 'string'
          ? resolve(dirname(manifest), artifact.timeline)
          : artifact.timeline;
        const eventTrackRef = typeof artifact.eventTrack === 'string'
          ? resolve(dirname(manifest), artifact.eventTrack)
          : artifact.eventTrack;
        const videoOutDir = outDir ? join(resolve(outDir), name) : undefined;
        let videoBaseline;
        if (baseline) {
          const baseRoot = resolve(baseline);
          const perRecipeStills = join(baseRoot, name, 'stills');
          const perRecipeDir = join(baseRoot, name);
          if (await pathExists(perRecipeStills)) videoBaseline = perRecipeStills;
          else if (await pathExists(perRecipeDir)) videoBaseline = perRecipeDir;
          else if (Object.keys(report.recipes ?? {}).length === 1) videoBaseline = baseRoot;
          else videoBaseline = perRecipeDir;
        }
        const cheapOnly = !timelineRef && !videoReview;
        const videoResult = await reviewVideo({
          ...(cheapOnly ? { freeze: { enabled: false }, black: { enabled: false } } : {}),
          ...extraOpts,
          video: file,
          timeline: extraOpts.timeline ?? timelineRef,
          eventTrack: extraOpts.eventTrack ?? eventTrackRef,
          outDir: extraOpts.outDir ?? videoOutDir,
          baseline: extraOpts.baseline ?? videoBaseline,
          multimodal: extraOpts.multimodal ?? multimodal,
        });
        videos[name] = videoResult;
        for (const videoCheck of videoResult.checks) {
          check(`${name}:video:${videoCheck.name}`, videoCheck.ok, videoCheck.message);
        }
      }

      const recipeOk = checks.slice(startCheckIdx).every((c) => c.ok);
      recipes[name] = {
        ok: recipeOk,
        status: artifact.status,
        file,
        width: actual.width,
        height: actual.height,
        ...baselineInfo,
      };
    } catch (error) {
      check(`${name}:file`, false, error.message);
      recipes[name] = {
        ok: false,
        status: artifact.status,
        error: error.message,
        ...baselineInfo,
      };
    }
  }

  return {
    version: 1,
    manifest,
    ok: checks.every(check => check.ok),
    checks,
    recipes,
    ...(updateBaselines ? { baselinesUpdated } : {}),
    ...(Object.keys(videos).length > 0 ? { videos } : {}),
  };
}
