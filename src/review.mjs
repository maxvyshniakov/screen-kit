import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import sharp from 'sharp';
import { hash } from './run.mjs';
import { probeVideo } from './video.mjs';

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

/** Verify exported bytes against the capture manifest; no application is launched. */
export async function reviewRun({ manifest } = {}) {
  if (!manifest) throw Error('review requires a run.json manifest');
  manifest = resolve(manifest);
  const report = JSON.parse(await readFile(manifest, 'utf8'));
  const checks = [];
  const check = (name, ok, message) => checks.push({ name, ok: Boolean(ok), message });
  check('run', report.version === 1 && report.status === 'complete', `run status: ${report.status}`);
  check('recipes', Object.keys(report.recipes ?? {}).length > 0, 'run contains captured recipes');
  for (const [name, artifact] of Object.entries(report.recipes ?? {})) {
    check(`${name}:capture`, artifact.status === 'complete', artifact.error ?? `capture status: ${artifact.status}`);
    if (artifact.status !== 'complete') continue;
    try {
      const file = resolve(dirname(manifest), artifact.file);
      const bytes = await readFile(file);
      check(`${name}:hash`, hash(bytes) === artifact.sha256, 'artifact hash matches the capture manifest');
      for (const input of artifact.inputs ?? []) {
        const data = await readFile(resolve(dirname(manifest), input.file));
        check(`${name}:take`, hash(data) === input.sha256, 'source take hash matches the capture manifest');
      }
      let actual;
      const cast = extname(file) === '.cast';
      if (cast) actual = inspectCast(bytes);
      else if (['.mp4', '.webm', '.mov'].includes(extname(file))) actual = await probeVideo(file);
      else {
        const metadata = await sharp(bytes, { animated: true }).metadata();
        actual = { width: metadata.width, height: metadata.pageHeight ?? metadata.height,
          frames: metadata.pages ?? 1,
          duration: metadata.delay?.reduce((sum, delay) => sum + delay, 0) / 1000 };
      }
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
    } catch (error) { check(`${name}:file`, false, error.message); }
  }
  return { version: 1, manifest, ok: checks.every(check => check.ok), checks };
}
