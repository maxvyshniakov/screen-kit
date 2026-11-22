#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, basename, extname } from 'node:path';
import { captureRun, loadConfiguration, runPipeline, selectedRecipes, statusRun, VERSION } from './run.mjs';
import { reviewRun, reviewVideo } from './review.mjs';
import { compileTimeline } from './timeline.mjs';
import { renderVideo } from './video.mjs';
import { generateAsset } from './assets.mjs';
import { publishWebBundle, publishYouTube } from './publish.mjs';

const help = `screen-kit ${VERSION}

screen-kit capture --config screen-kit.config.mjs [--only name,name] [--out dir]
screen-kit status --config screen-kit.config.mjs [--manifest out/run.json]
screen-kit timeline --input event-track.json --out timeline.json [--config screen-kit.config.mjs] [--recipe name] [--video take.mp4]
screen-kit narrate --input timeline.json --out out/narrated --lang en [--provider gemini|kokoro] [--aligner auto|whisper|gemini|proportional] [--voice Kore] [--style "..."]
screen-kit preview --input timeline.json --out out/preview [--columns 3] [--width 1280]
screen-kit run --config demo.mjs --out out/demo [--only name] [--preview-only] [--reuse-take] [--profiles web-loop] [--verify-cursor] [--narration en] [--tts-provider gemini|kokoro] [--aligner auto|whisper|gemini|proportional]
screen-kit review --manifest out/run.json [--out-dir review-out] [--baseline stills-dir] [--out review.json] [--verify-cursor]
screen-kit review --video demo.mp4 [--timeline timeline.json] [--event-track event-track.json] [--baseline stills-dir] [--out-dir review-out] [--out review.json] [--verify-cursor] [--cursor-threshold 2] [--cursor-detection #ff00ff|json] [--multimodal]
screen-kit render --input take.cast --out demo.webp [--fps 1] [--at 3]
screen-kit render --input take.gif --out demo.mp4 [--fps 30]
screen-kit render --input timeline.json --out out/demo [--profiles web-loop,youtube-master,shorts] [--poster-format png]
screen-kit publish --target web --input demo.mp4 --out out/web [--name demo] [--poster poster.png] [--formats vp9,h264] [--fps 30] [--color-space srgb|p3]
screen-kit publish --target youtube --input demo.mp4 --title "..." [--description "..."] [--privacy unlisted|private|public] [--captions en:subs.srt] [--thumbnail thumb.png] [--dry-run] [--out report.json]
screen-kit asset --kind thumbnail|wallpaper --prompt "..." --out out/thumb.png [--aspect-ratio 16:9] [--model imagen-3.0-generate-002] [--cache-dir dir]

Recipes live in the consumer repository. Browser and terminal capture use real input.
Capture writes run.json, original takes and exported files; timeline compiles event-track.json into
timeline.json; preview renders key step frames into a contact sheet; run executes the unified
capture -> timeline -> preview/render -> review pipeline; review verifies hashes, dimensions, frame
counts, duration, capture checkpoints and rendered video quality; render exports silent MP4/WebM or
renders timeline.json headlessly via Remotion 4; publish exports opt-in web clip bundles or uploads
to YouTube when explicitly authorized (extra audio-language tracks are added in YouTube Studio);
asset generates opt-in non-UI assets only (stage wallpapers, YouTube thumbnails, covers) via
Imagen / Gemini Image API and never synthesizes UI frames.
`;

function parseCaptionsFlag(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw Error(`Invalid --captions JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw Error('--captions JSON must be an array');
    }
    return parsed.map((entry) => ({
      ...entry,
      ...(typeof entry?.file === 'string' ? { file: resolve(entry.file) } : {}),
    }));
  }
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const sep = item.indexOf(':');
      if (sep <= 0 || sep === item.length - 1) {
        throw Error(`Invalid --captions entry "${item}"; expected <lang>:<file> (e.g. en:subs.srt)`);
      }
      return {
        language: item.slice(0, sep).trim(),
        file: resolve(item.slice(sep + 1).trim()),
      };
    });
}

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
  'profile', 'profiles', 'poster-format', 'columns', 'width', 'preview-only', 'reuse-take',
  'video', 'timeline', 'event-track', 'baseline', 'out-dir',
  'verify-cursor', 'cursor-threshold', 'cursor-detection', 'cursor-color', 'multimodal', 'provider',
  'kind', 'prompt', 'aspect-ratio', 'model', 'cache-dir',
  'target', 'name', 'poster', 'formats', 'color-space',
  'title', 'description', 'privacy', 'captions', 'thumbnail', 'dry-run',
  'lang', 'language', 'narration', 'tts-provider', 'aligner', 'voice', 'style', 'style-prompt', 'speed',
]);
const booleanFlags = new Set(['multimodal', 'preview-only', 'reuse-take', 'dry-run', 'verify-cursor']);
const toBoolFlag = (val) => val === true || val === 'true' || val === '1';
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
          timelineRecipe = rawRecipe.presentation && typeof rawRecipe.presentation === 'object'
            ? rawRecipe.presentation
            : rawRecipe.timeline && typeof rawRecipe.timeline === 'object'
              ? rawRecipe.timeline
              : rawRecipe;
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
      const verifyCursor = toBoolFlag(flags['verify-cursor']);
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
            ...(verifyCursor ? { verifyCursor: true } : {}),
            ...(cursorThresholdPx !== undefined ? { cursorThresholdPx } : {}),
            ...(cursorDetection ? { cursorDetection } : {}),
            ...(multimodalOpt ? { multimodal: multimodalOpt } : {}),
          })
        : await reviewRun({
            manifest: flags.manifest,
            ...(flags['out-dir'] ? { outDir: flags['out-dir'] } : {}),
            ...(flags.baseline ? { baseline: flags.baseline } : {}),
            ...(multimodalOpt ? { multimodal: multimodalOpt } : {}),
            ...(verifyCursor || cursorThresholdPx !== undefined || cursorDetection
              ? {
                  videoReview: {
                    ...(verifyCursor ? { verifyCursor: true } : {}),
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
    } else if (command === 'preview') {
      const timelineArg = flags.input ?? flags.timeline;
      const outArg = flags.out ?? flags['out-dir'];
      if (!timelineArg || !outArg) throw Error('preview requires --input (or --timeline) and --out');
      const { renderTimelinePreview } = await import('./render-timeline.mjs');
      const columns = flags.columns !== undefined ? Number(flags.columns) : undefined;
      const width = flags.width !== undefined ? Number(flags.width) : undefined;
      const result = await renderTimelinePreview({
        timeline: resolve(timelineArg),
        outDir: resolve(outArg),
        ...(columns !== undefined ? { columns } : {}),
        ...(width !== undefined ? { width } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'narrate') {
      const timelineArg = flags.input ?? flags.timeline;
      const outArg = flags.out ?? flags['out-dir'];
      if (!timelineArg && !flags['event-track'] && !flags.config) {
        throw Error('narrate requires --input timeline.json (or --event-track / --config) and --out');
      }
      if (!outArg) throw Error('narrate requires --out');

      let recipeObj;
      let resolvedCwd = flags.cwd ? resolve(flags.cwd) : process.cwd();
      if (flags.config) {
        const loaded = await loadConfiguration(flags.config);
        if (!flags.cwd) resolvedCwd = loaded.cwd;
        if (loaded.config?.recipes && typeof loaded.config.recipes === 'object') {
          const recipeName = flags.recipe ?? flags.only;
          const entries = recipeName
            ? selectedRecipes(loaded.config, recipeName)
            : Object.entries(loaded.config.recipes);
          if (entries.length !== 1) {
            throw Error('narrate --config has multiple recipes; pass --recipe <name>');
          }
          recipeObj = entries[0][1];
        } else {
          recipeObj = loaded.config;
        }
      }

      const langRaw = flags.lang ?? flags.language ?? 'en';
      const langs = String(langRaw).split(',').map((s) => s.trim()).filter(Boolean);
      const speedVal = flags.speed !== undefined ? Number(flags.speed) : undefined;
      if (speedVal !== undefined && (!Number.isFinite(speedVal) || speedVal <= 0)) {
        throw Error(`--speed must be a positive finite number (received ${flags.speed})`);
      }

      const { narrateTimeline } = await import('./narration.mjs');
      const narrated = await narrateTimeline({
        ...(timelineArg ? { timeline: resolve(timelineArg) } : {}),
        ...(flags['event-track'] ? { eventTrack: resolve(flags['event-track']) } : {}),
        ...(recipeObj ? { recipe: recipeObj } : {}),
        cwd: resolvedCwd,
        out: resolve(outArg),
        language: langs[0] ?? 'en',
        ...(langs.length > 1 ? { languages: langs } : {}),
        provider: flags['tts-provider'] ?? flags.provider ?? 'gemini',
        aligner: flags.aligner ?? 'auto',
        ...(flags.voice ? { voice: flags.voice } : {}),
        ...((flags['style-prompt'] ?? flags.style) ? { stylePrompt: flags['style-prompt'] ?? flags.style } : {}),
        ...(speedVal !== undefined ? { speed: speedVal } : {}),
      });
      const { timeline: _fullTimeline, ...summary } = narrated;
      console.log(JSON.stringify(summary, null, 2));
    } else if (command === 'run') {
      const loaded = await loadConfiguration(flags.config ?? 'screen-kit.config.mjs');
      const profileArg = flags.profiles ?? flags.profile;
      const verifyCursor = toBoolFlag(flags['verify-cursor']);
      const speedVal = flags.speed !== undefined ? Number(flags.speed) : undefined;
      if (speedVal !== undefined && (!Number.isFinite(speedVal) || speedVal <= 0)) {
        throw Error(`--speed must be a positive finite number (received ${flags.speed})`);
      }
      const result = await runPipeline({
        config: loaded.config,
        cwd: flags.cwd ? resolve(flags.cwd) : loaded.cwd,
        ...(flags.only ? { only: flags.only } : {}),
        ...(flags.out ? { out: resolve(flags.out) } : {}),
        previewOnly: toBoolFlag(flags['preview-only']),
        reuseTake: toBoolFlag(flags['reuse-take']),
        ...(profileArg ? { profiles: profileArg } : {}),
        ...(verifyCursor ? { reviewOptions: { verifyCursor: true } } : {}),
        ...(flags.narration !== undefined ? { narration: flags.narration } : {}),
        ...((flags['tts-provider'] ?? flags.provider) ? { ttsProvider: flags['tts-provider'] ?? flags.provider } : {}),
        ...(flags.aligner ? { aligner: flags.aligner } : {}),
        narrationOptions: {
          ...(flags.voice ? { voice: flags.voice } : {}),
          ...((flags['style-prompt'] ?? flags.style) ? { stylePrompt: flags['style-prompt'] ?? flags.style } : {}),
          ...(speedVal !== undefined ? { speed: speedVal } : {}),
        },
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'asset') {
      if (!flags.kind || !flags.prompt || !flags.out) {
        throw Error('asset requires --kind, --prompt, and --out');
      }
      const result = await generateAsset({
        kind: flags.kind,
        prompt: flags.prompt,
        out: flags.out,
        ...(flags['aspect-ratio'] ? { aspectRatio: flags['aspect-ratio'] } : {}),
        ...(flags.model ? { model: flags.model } : {}),
        ...(flags['cache-dir'] ? { cacheDir: flags['cache-dir'] } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'publish') {
      if (!flags.target) throw Error('publish requires --target web|youtube');
      if (flags.target === 'web') {
        const inputArg = flags.input ?? flags.video;
        const outArg = flags.out ?? flags['out-dir'];
        if (!inputArg || !outArg) throw Error('publish --target web requires --input and --out');
        const result = await publishWebBundle({
          input: inputArg,
          outDir: outArg,
          ...(flags.name ? { name: flags.name } : {}),
          ...(flags.poster ? { poster: flags.poster } : {}),
          ...(flags.formats ? { formats: flags.formats } : {}),
          ...(flags.fps ? { fps: Number(flags.fps) } : {}),
          ...(flags['color-space'] ? { colorSpace: flags['color-space'] } : {}),
          ...(flags.at ? { posterTime: Number(flags.at) } : {}),
        });
        console.log(JSON.stringify(result, null, 2));
      } else if (flags.target === 'youtube') {
        const videoArg = flags.input ?? flags.video;
        if (!videoArg) throw Error('publish --target youtube requires --input (or --video)');
        if (!flags.title) throw Error('publish --target youtube requires --title');
        const captions = flags.captions ? parseCaptionsFlag(flags.captions) : undefined;
        const thumbnail = flags.thumbnail ?? flags.poster;
        const result = await publishYouTube({
          video: videoArg,
          title: flags.title,
          ...(flags.description !== undefined ? { description: flags.description } : {}),
          ...(flags.privacy ? { privacy: flags.privacy } : {}),
          ...(captions ? { captions } : {}),
          ...(thumbnail ? { thumbnail } : {}),
          dryRun: toBoolFlag(flags['dry-run']),
        });
        const text = JSON.stringify(result, null, 2) + '\n';
        if (flags.out) {
          const outPath = resolve(flags.out);
          await mkdir(dirname(outPath), { recursive: true });
          await writeFile(outPath, text);
        }
        console.log(text.trimEnd());
      } else {
        throw Error(`unknown publish target: ${flags.target} (expected web or youtube)`);
      }
    } else throw Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`screen-kit: ${error.message}`);
  process.exitCode = 1;
}
