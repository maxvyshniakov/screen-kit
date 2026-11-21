#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, basename, extname } from 'node:path';
import { captureRun, loadConfiguration, selectedRecipes, statusRun, VERSION } from './run.mjs';
import { reviewRun, reviewVideo } from './review.mjs';
import { compileTimeline } from './timeline.mjs';
import { renderVideo } from './video.mjs';

const help = `screen-kit ${VERSION}

screen-kit capture --config screen-kit.config.mjs [--only name,name] [--out dir]
screen-kit status --config screen-kit.config.mjs [--manifest out/run.json]
screen-kit timeline --input event-track.json --out timeline.json [--config screen-kit.config.mjs] [--recipe name] [--video take.mp4]
screen-kit review --manifest out/run.json [--out-dir review-out] [--baseline stills-dir] [--out review.json]
screen-kit review --video demo.mp4 [--timeline timeline.json] [--event-track event-track.json] [--baseline stills-dir] [--out-dir review-out] [--out review.json] [--cursor-threshold 2] [--cursor-detection #ff00ff|json] [--multimodal]
screen-kit render --input take.cast --out demo.webp [--fps 1] [--at 3]
screen-kit render --input take.gif --out demo.mp4 [--fps 30]
screen-kit render --input timeline.json --out out/demo [--profiles web-loop,youtube-master] [--poster-format png]

Recipes live in the consumer repository. Browser and terminal capture use real input.
Capture writes run.json, original takes and exported files; timeline compiles event-track.json into
timeline.json; review verifies hashes, dimensions, frame counts, duration, capture checkpoints and
rendered video quality; render exports silent MP4/WebM or renders timeline.json headlessly via Remotion 4.
`;

function parseCursorDetectionFlag(rawDetection, rawColor) {
  let options = null;
  if (rawDetection !== undefined) {
    const trimmed = String(rawDetection).trim();
    if (trimmed.startsWith('{')) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw Error(`Invalid --cursor-detection JSON: ${error.message}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw Error('--cursor-detection JSON must be an object');
      }
      options = { ...parsed };
      if (typeof options.cleanImage === 'string') {
        options.cleanImage = resolve(options.cleanImage);
      }
    } else if (/^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) {
      options = { color: trimmed };
    } else if (/\.(?:png|jpe?g|webp)$/i.test(trimmed)) {
      options = { cleanImage: resolve(trimmed) };
    } else {
      throw Error('Invalid --cursor-detection value: expected hex color (#rrggbb), JSON object, or clean reference image path');
    }
  }
  if (rawColor !== undefined) {
    options = { ...(options ?? {}), color: String(rawColor).trim() };
  }
  return options;
}

const [command = 'help', ...args] = process.argv.slice(2);
const allowed = new Set([
  'config', 'cwd', 'only', 'recipe', 'out', 'manifest', 'input', 'take', 'fps', 'at',
  'profile', 'profiles', 'poster-format',
  'video', 'timeline', 'event-track', 'baseline', 'out-dir',
  'cursor-threshold', 'cursor-detection', 'cursor-color', 'multimodal', 'provider',
]);
const booleanFlags = new Set(['multimodal']);
try {
  if (['help', '--help', '-h'].includes(command)) { console.log(help); }
  else if (['--version', '-V'].includes(command)) console.log(VERSION);
  else {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (!args[i].startsWith('--') || !allowed.has(args[i].slice(2))) throw Error(`unknown option: ${args[i]}`);
      const name = args[i].slice(2);
      if (Object.hasOwn(flags, name)) throw Error(`duplicate option: --${name}`);
      if (booleanFlags.has(name) && (!args[i + 1] || args[i + 1].startsWith('--'))) {
        flags[name] = true;
      } else {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`--${name} requires a value`);
        flags[name] = args[++i];
      }
    }
    if (command === 'capture' || command === 'status') {
      const loaded = await loadConfiguration(flags.config ?? 'screen-kit.config.mjs');
      const options = { config: loaded.config, cwd: flags.cwd ? resolve(flags.cwd) : loaded.cwd,
        only: flags.only, ...(flags.out ? { out: flags.out } : {}), manifest: flags.manifest };
      console.log(JSON.stringify(await (command === 'capture' ? captureRun(options) : statusRun(options)), null, 2));
    } else if (command === 'timeline') {
      const trackArg = flags['event-track'] ?? flags.input ?? flags.take;
      if (!trackArg || !flags.out) throw Error('timeline requires --input (or --take) and --out');
      const eventTrackPath = resolve(trackArg);
      const outPath = resolve(flags.out);
      const outBaseDir = dirname(outPath);
      const eventTrack = JSON.parse(await readFile(eventTrackPath, 'utf8'));

      let timelineRecipe = {};
      if (flags.config) {
        const loaded = await loadConfiguration(flags.config);
        if (loaded.config?.recipes && typeof loaded.config.recipes === 'object') {
          const recipeName = flags.recipe ?? flags.only;
          const entries = recipeName
            ? selectedRecipes(loaded.config, recipeName)
            : Object.entries(loaded.config.recipes);
          if (entries.length !== 1) {
            throw Error('timeline --config has multiple recipes; pass --recipe <name>');
          }
          const rawRecipe = entries[0][1] ?? {};
          timelineRecipe = rawRecipe.timeline && typeof rawRecipe.timeline === 'object' ? rawRecipe.timeline : rawRecipe;
        } else {
          timelineRecipe = loaded.config;
        }
      }

      const externalUrlRe = /^(?:https?:|data:|blob:)/i;
      let relVideo = eventTrack.video?.file;
      if (flags.video) {
        const absVid = resolve(flags.video);
        relVideo = relative(outBaseDir, absVid) || basename(absVid);
      } else if (typeof relVideo === 'string' && relVideo.length > 0 && !externalUrlRe.test(relVideo)) {
        const absVid = resolve(dirname(eventTrackPath), relVideo);
        relVideo = relative(outBaseDir, absVid) || basename(absVid);
      }
      const relEventTrack = relative(outBaseDir, eventTrackPath) || basename(eventTrackPath);

      const compiled = compileTimeline({
        take: {
          ...(relVideo ? { video: relVideo } : {}),
          eventTrack: relEventTrack,
        },
        eventTrack,
        recipe: timelineRecipe,
      });
      await mkdir(outBaseDir, { recursive: true });
      await writeFile(outPath, JSON.stringify(compiled, null, 2) + '\n');
      console.log(JSON.stringify({
        ok: true,
        file: outPath,
        version: compiled.version,
        take: compiled.take,
        outputs: compiled.outputs,
        steps: compiled.steps,
      }, null, 2));
    } else if (command === 'review') {
      let cursorThresholdPx;
      if (flags['cursor-threshold'] !== undefined) {
        cursorThresholdPx = Number(flags['cursor-threshold']);
        if (!Number.isFinite(cursorThresholdPx) || cursorThresholdPx <= 0) {
          throw Error(`--cursor-threshold must be a positive finite number (received ${flags['cursor-threshold']})`);
        }
      }
      const cursorDetection = parseCursorDetectionFlag(flags['cursor-detection'], flags['cursor-color']);
      const multimodalOpt = flags.multimodal
        ? {
            enabled: true,
            provider: flags.provider ?? (flags.multimodal === true ? 'gemini' : flags.multimodal),
          }
        : undefined;

      const result = flags.video
        ? await reviewVideo({
            video: flags.video,
            timeline: flags.timeline,
            eventTrack: flags['event-track'],
            baseline: flags.baseline,
            outDir: flags['out-dir'],
            ...(cursorThresholdPx !== undefined ? { cursorThresholdPx } : {}),
            ...(cursorDetection ? { cursorDetection } : {}),
            ...(multimodalOpt ? { multimodal: multimodalOpt } : {}),
          })
        : await reviewRun({
            manifest: flags.manifest,
            ...(flags['out-dir'] ? { outDir: flags['out-dir'] } : {}),
            ...(flags.baseline ? { baseline: flags.baseline } : {}),
            ...(multimodalOpt ? { multimodal: multimodalOpt } : {}),
            ...(cursorThresholdPx !== undefined || cursorDetection
              ? {
                  videoReview: {
                    ...(cursorThresholdPx !== undefined ? { cursorThresholdPx } : {}),
                    ...(cursorDetection ? { cursorDetection } : {}),
                  },
                }
              : {}),
          });
      const text = JSON.stringify(result, null, 2) + '\n';
      if (flags.out) await writeFile(resolve(flags.out), text);
      console.log(text.trimEnd());
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'render') {
      if (!flags.input || !flags.out) throw Error('render requires --input and --out');
      let result;
      if (extname(flags.input) === '.json') {
        const { renderTimeline } = await import('./render-timeline.mjs');
        const profileArg = flags.profiles ?? flags.profile;
        result = await renderTimeline({
          timeline: resolve(flags.input),
          out: resolve(flags.out),
          ...(profileArg ? { profiles: profileArg } : {}),
          ...(flags['poster-format'] ? { posterFormat: flags['poster-format'] } : {}),
          ...(flags.fps ? { fps: Number(flags.fps) } : {}),
          ...(flags.at ? { posterTime: Number(flags.at) } : {}),
        });
      } else if(extname(flags.input)==='.cast') {
        const {renderTerminalTake}=await import('./terminal.mjs');
        const output=resolve(flags.out),extension=extname(output);
        result=await renderTerminalTake({cast:resolve(flags.input),out:dirname(output),name:basename(output,extension),
          recipe:{format:extension.slice(1),...(flags.fps?{fps:Number(flags.fps)}:{}),...(flags.at?{at:Number(flags.at)}:{})}});
      } else result=await renderVideo({ input: flags.input, output: flags.out,
        ...(flags.fps ? { fps: Number(flags.fps) } : {}) });
      console.log(JSON.stringify(result, null, 2));
    } else throw Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`screen-kit: ${error.message}`);
  process.exitCode = 1;
}
