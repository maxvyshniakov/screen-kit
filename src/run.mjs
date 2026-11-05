import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
        const { captureTerminalRecipe } = recipe.source === 'terminal' ? await import('./terminal.mjs') : {};
        const { captureBrowserRecipe } = recipe.source === 'browser' ? await import('./browser.mjs') : {};
        const capture = captureTerminalRecipe ?? captureBrowserRecipe;
        const video = ['mp4', 'webm'].includes(recipe.format);
        const captureRecipe = recipe.source === 'terminal' && video ? { ...recipe, format: 'webp' } : recipe;
        const artifact = await capture({ name, recipe: captureRecipe, cwd, out, base: recipe.base,
          ...(recipe.scale ? { scale: recipe.scale } : {}) });
        if (video && resolve(artifact.file) !== join(out, `${name}.${recipe.format}`)) {
          const { renderVideo } = await import('./video.mjs');
          const output = join(out, `${name}.${recipe.format}`);
          const encoded = await renderVideo({ input: artifact.videoInput ?? artifact.file, output, fps: recipe.fps });
          Object.assign(artifact, encoded, { videoInput: artifact.videoInput ?? artifact.file });
        }
        if (video) {
          const { probeVideo } = await import('./video.mjs');
          Object.assign(artifact, await probeVideo(artifact.file), { requestedDuration: recipe.duration });
        }
        const file = resolve(out, artifact.file);
        if (![artifact.width, artifact.height].every(value => Number.isInteger(value) && value > 0))
          throw Error(`${name}: capture did not report valid dimensions`);
        const bytes = await readFile(file);
        const inputs = [];
        for (const path of new Set([artifact.take, artifact.videoInput].filter(Boolean))) {
          if (resolve(path) !== file) inputs.push({ file: relative(out, path), sha256: hash(await readFile(path)) });
        }
        report.recipes[name] = { ...report.recipes[name], ...artifact, file: relative(out, file), inputs,
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
