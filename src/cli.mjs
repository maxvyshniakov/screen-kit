#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRun, loadConfiguration, runPipeline, selectedRecipes, statusRun, VERSION } from './run.mjs';
import { reviewRun, reviewVideo } from './review.mjs';
import { compileTimeline } from './timeline.mjs';
import { renderVideo } from './video.mjs';
import { generateAsset } from './assets.mjs';
import { publishWebBundle, publishYouTube } from './publish.mjs';

const help = `screen-kit ${VERSION}

screen-kit capture --config screen-kit.config.mjs [--only name,name] [--out dir]
screen-kit status --config screen-kit.config.mjs [--manifest out/run.json]
screen-kit timeline --input event-track.json --out timeline.json [--config screen-kit.config.mjs] [--recipe name] [--video take.mp4] [--color-space srgb|p3]
screen-kit narrate --input timeline.json --out out/narrated --lang en [--provider gemini|kokoro] [--aligner auto|whisper|gemini|proportional] [--whisper-model path] [--voice Kore] [--style "..."] [--speed 1.1] [--burn-captions]
screen-kit audio-mix --input timeline.json --out out/audio [--music bed.wav] [--sfx] [--duck-mode envelope|sidechain] [--duck-db -10] [--video demo.mp4] [--out-video demo-mixed.mp4]
screen-kit preview --input timeline.json --out out/preview [--columns 3] [--width 1280]
screen-kit run --config demo.mjs --out out/demo [--only name] [--preview-only] [--reuse-take] [--profiles web-loop] [--color-space srgb|p3] [--verify-cursor] [--cursor-threshold 2] [--cursor-detection #ff00ff|json] [--baseline stills-dir] [--multimodal] [--narration en] [--burn-captions] [--tts-provider gemini|kokoro] [--aligner auto|whisper|gemini|proportional]
screen-kit review --manifest out/run.json [--out-dir review-out] [--baseline stills-dir] [--out review.json] [--verify-cursor]
screen-kit review --video demo.mp4 [--timeline timeline.json] [--event-track event-track.json] [--baseline stills-dir] [--out-dir review-out] [--out review.json] [--verify-cursor] [--cursor-threshold 2] [--cursor-detection #ff00ff|json] [--multimodal]
screen-kit render --input take.cast --out demo.webp [--fps 1] [--at 3]
screen-kit render --input take.gif --out demo.mp4 [--fps 30] [--color-space srgb|p3]
screen-kit render --input timeline.json --out out/demo [--profiles web-loop,youtube-master,shorts] [--poster-format png] [--color-space srgb|p3]
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

function parseBoolFlag(val, flagName) {
  if (val === undefined) return false;
  if (typeof val === 'boolean') return val;
  const normalized = String(val).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw Error(
    `Invalid boolean value for --${flagName}: "${val}" (expected true/1/yes or false/0/no)`
  );
}

function parseCursorThresholdFlag(raw) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw Error(`--cursor-threshold must be a positive finite number (received ${raw})`);
  }
  return value;
}

function rebaseLocalMediaRef(ref, fromDir, toDir) {
  if (typeof ref !== 'string' || ref.length === 0 || /^(?:https?:|data:|blob:)/i.test(ref)) {
    return ref;
  }
  const abs = ref.startsWith('file://') ? fileURLToPath(ref) : resolve(fromDir, ref);
  return relative(toDir, abs) || basename(abs);
}

const [command = 'help', ...args] = process.argv.slice(2);
const allowed = new Set([
  'config', 'cwd', 'only', 'recipe', 'out', 'manifest', 'input', 'take', 'fps', 'at',
  'profile', 'profiles', 'poster-format', 'columns', 'width', 'preview-only', 'reuse-take',
  'video', 'timeline', 'event-track', 'baseline', 'out-dir',
  'verify-cursor', 'cursor-threshold', 'cursor-detection', 'cursor-color', 'multimodal', 'provider',
  'kind', 'prompt', 'aspect-ratio', 'model', 'tts-model', 'whisper-model', 'cache-dir',
  'target', 'name', 'poster', 'formats', 'color-space',
  'title', 'description', 'privacy', 'captions', 'thumbnail', 'dry-run',
  'lang', 'language', 'narration', 'burn-captions', 'tts-provider', 'aligner', 'voice', 'style', 'style-prompt', 'speed',
  'music', 'sfx', 'duck-mode', 'duck-db', 'out-video', 'music-lufs', 'keep-stems',
]);
const booleanFlags = new Set([
  'multimodal', 'preview-only', 'reuse-take', 'dry-run', 'verify-cursor', 'sfx', 'keep-stems', 'burn-captions',
]);
try {
  if (['help', '--help', '-h'].includes(command)) { console.log(help); }
  else if (['--version', '-V'].includes(command)) console.log(VERSION);
  else {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (!args[i].startsWith('--')) throw Error(`unknown option: ${args[i]}`);
      const eqIdx = args[i].indexOf('=');
      if (eqIdx > 2) {
        const name = args[i].slice(2, eqIdx);
        if (!allowed.has(name)) throw Error(`unknown option: --${name}`);
        if (Object.hasOwn(flags, name)) throw Error(`duplicate option: --${name}`);
        flags[name] = args[i].slice(eqIdx + 1);
        continue;
      }
      const name = args[i].slice(2);
      if (!allowed.has(name)) throw Error(`unknown option: ${args[i]}`);
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
          ...(flags['color-space'] ? { colorSpace: flags['color-space'] } : {}),
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
      const cursorThresholdPx = parseCursorThresholdFlag(flags['cursor-threshold']);
      const cursorDetection = parseCursorDetectionFlag(flags['cursor-detection'], flags['cursor-color']);
      const verifyCursor = parseBoolFlag(flags['verify-cursor'], 'verify-cursor');
      const multimodalEnabled = parseBoolFlag(flags.multimodal, 'multimodal');
      const multimodalOpt = multimodalEnabled
        ? {
            enabled: true,
            provider: flags.provider ?? 'gemini',
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
          ...(flags['color-space'] ? { colorSpace: flags['color-space'] } : {}),
          ...(flags.fps ? { fps: Number(flags.fps) } : {}),
          ...(flags.at ? { posterTime: Number(flags.at) } : {}),
        });
      } else if(extname(flags.input)==='.cast') {
        const {renderTerminalTake}=await import('./terminal.mjs');
        const output=resolve(flags.out),extension=extname(output);
        result=await renderTerminalTake({cast:resolve(flags.input),out:dirname(output),name:basename(output,extension),
          recipe:{format:extension.slice(1),...(flags.fps?{fps:Number(flags.fps)}:{}),...(flags.at?{at:Number(flags.at)}:{})}});
      } else result=await renderVideo({ input: flags.input, output: flags.out,
        ...(flags.fps ? { fps: Number(flags.fps) } : {}),
        ...(flags['color-space'] ? { colorSpace: flags['color-space'] } : {}) });
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
        ...(flags['color-space'] ? { colorSpace: flags['color-space'] } : {}),
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

      const burnInCaptions = parseBoolFlag(flags['burn-captions'], 'burn-captions');
      const ttsModel =
        flags['tts-model'] ??
        (flags.model && !['whisper', 'gemini'].includes(flags.aligner) ? flags.model : undefined);
      const alignerModel =
        flags['whisper-model'] ??
        (['whisper', 'gemini'].includes(flags.aligner) ? flags.model : undefined);
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
        ...(ttsModel ? { ttsModel } : {}),
        ...(flags['whisper-model'] ? { whisperModel: flags['whisper-model'] } : {}),
        ...(flags.aligner === 'gemini' && flags.model ? { geminiModel: flags.model } : {}),
        ...(alignerModel ? { alignerOptions: { model: alignerModel } } : {}),
        ...(flags.voice ? { voice: flags.voice } : {}),
        ...((flags['style-prompt'] ?? flags.style) ? { stylePrompt: flags['style-prompt'] ?? flags.style } : {}),
        ...(speedVal !== undefined ? { speed: speedVal } : {}),
        ...(flags['burn-captions'] !== undefined ? { burnInCaptions } : {}),
      });
      const { timeline: _fullTimeline, ...summary } = narrated;
      console.log(JSON.stringify(summary, null, 2));
    } else if (command === 'audio-mix') {
      const timelineArg = flags.input ?? flags.timeline;
      const outArg = flags.out ?? flags['out-dir'];
      if (!timelineArg || !outArg) {
        throw Error('audio-mix requires --input timeline.json and --out');
      }
      const timelinePath = resolve(timelineArg);
      const resolvedOut = resolve(outArg);
      const audioExts = new Set(['.wav', '.mp3', '.m4a', '.aac', '.opus', '.ogg', '.flac']);
      const isAudioFileOut = audioExts.has(extname(resolvedOut).toLowerCase());
      const outDir = flags['out-dir']
        ? resolve(flags['out-dir'])
        : isAudioFileOut
          ? dirname(resolvedOut)
          : resolvedOut;
      const outFile = isAudioFileOut ? resolvedOut : undefined;

      let duckUnderSpeechDb;
      if (flags['duck-db'] !== undefined) {
        duckUnderSpeechDb = Number(flags['duck-db']);
        if (!Number.isFinite(duckUnderSpeechDb)) {
          throw Error(`--duck-db must be a finite number (received ${flags['duck-db']})`);
        }
      }
      let musicLufs;
      if (flags['music-lufs'] !== undefined) {
        musicLufs = Number(flags['music-lufs']);
        if (!Number.isFinite(musicLufs)) {
          throw Error(`--music-lufs must be a finite number (received ${flags['music-lufs']})`);
        }
      }

      const sfxEnabled = parseBoolFlag(flags.sfx, 'sfx');
      const keepStems = parseBoolFlag(flags['keep-stems'], 'keep-stems');
      const videoFile = flags.video ? resolve(flags.video) : undefined;
      const muxOutFile = flags['out-video']
        ? resolve(flags['out-video'])
        : videoFile && !isAudioFileOut
          ? join(outDir, `${basename(videoFile, extname(videoFile))}-mixed${extname(videoFile) || '.mp4'}`)
          : undefined;

      const { mixTimelineAudio } = await import('./audio-mix.mjs');
      const mixed = await mixTimelineAudio({
        timeline: timelinePath,
        ...(outFile ? { outFile } : {}),
        outDir,
        ...(flags.music ? { music: resolve(flags.music) } : {}),
        sfx: sfxEnabled,
        ...(flags['duck-mode'] ? { duckingMode: flags['duck-mode'] } : {}),
        ...(duckUnderSpeechDb !== undefined ? { duckUnderSpeechDb } : {}),
        ...(musicLufs !== undefined ? { musicLufs } : {}),
        ...(keepStems ? { keepStems: true } : {}),
        ...(videoFile ? { videoFile } : {}),
        ...(muxOutFile ? { muxOutFile } : {}),
      });

      let timelineOutFile = null;
      if (mixed.timeline && !isAudioFileOut) {
        timelineOutFile = join(outDir, 'timeline.json');
        const sourceBaseDir = dirname(timelinePath);
        const rebased = structuredClone(mixed.timeline);
        if (rebased.take?.video) {
          rebased.take.video = rebaseLocalMediaRef(rebased.take.video, sourceBaseDir, outDir);
        }
        if (rebased.take?.eventTrack) {
          rebased.take.eventTrack = rebaseLocalMediaRef(rebased.take.eventTrack, sourceBaseDir, outDir);
        }
        if (rebased.stage?.background?.type === 'image' && rebased.stage.background.src) {
          rebased.stage.background.src = rebaseLocalMediaRef(rebased.stage.background.src, sourceBaseDir, outDir);
        }
        if (Array.isArray(rebased.audio?.tracks)) {
          rebased.audio.tracks = rebased.audio.tracks.map((track) => ({
            ...track,
            src: rebaseLocalMediaRef(track.src, sourceBaseDir, outDir),
          }));
        }
        await mkdir(outDir, { recursive: true });
        await writeFile(timelineOutFile, JSON.stringify(rebased, null, 2) + '\n');
      }

      const { timeline: _mixedTimeline, ...mixSummary } = mixed;
      console.log(
        JSON.stringify(
          {
            ...mixSummary,
            ...(timelineOutFile ? { timelineFile: timelineOutFile } : {}),
          },
          null,
          2
        )
      );
      if (!mixed.ok) process.exitCode = 1;
    } else if (command === 'run') {
      const loaded = await loadConfiguration(flags.config ?? 'screen-kit.config.mjs');
      const profileArg = flags.profiles ?? flags.profile;
      const verifyCursor = parseBoolFlag(flags['verify-cursor'], 'verify-cursor');
      const cursorThresholdPx = parseCursorThresholdFlag(flags['cursor-threshold']);
      const cursorDetection = parseCursorDetectionFlag(flags['cursor-detection'], flags['cursor-color']);
      const multimodalEnabled = parseBoolFlag(flags.multimodal, 'multimodal');
      const speedVal = flags.speed !== undefined ? Number(flags.speed) : undefined;
      if (speedVal !== undefined && (!Number.isFinite(speedVal) || speedVal <= 0)) {
        throw Error(`--speed must be a positive finite number (received ${flags.speed})`);
      }
      const reviewOptions = {
        ...(verifyCursor ? { verifyCursor: true } : {}),
        ...(cursorThresholdPx !== undefined ? { cursorThresholdPx } : {}),
        ...(cursorDetection ? { cursorDetection } : {}),
        ...(flags.baseline ? { baseline: resolve(flags.baseline) } : {}),
        ...(multimodalEnabled ? { multimodal: { enabled: true, provider: 'gemini' } } : {}),
      };
      const burnInCaptions = parseBoolFlag(flags['burn-captions'], 'burn-captions');
      const ttsModel =
        flags['tts-model'] ??
        (flags.model && !['whisper', 'gemini'].includes(flags.aligner) ? flags.model : undefined);
      const alignerModel =
        flags['whisper-model'] ??
        (['whisper', 'gemini'].includes(flags.aligner) ? flags.model : undefined);
      const result = await runPipeline({
        config: loaded.config,
        cwd: flags.cwd ? resolve(flags.cwd) : loaded.cwd,
        ...(flags.only ? { only: flags.only } : {}),
        ...(flags.out ? { out: resolve(flags.out) } : {}),
        previewOnly: parseBoolFlag(flags['preview-only'], 'preview-only'),
        reuseTake: parseBoolFlag(flags['reuse-take'], 'reuse-take'),
        ...(profileArg ? { profiles: profileArg } : {}),
        ...(flags['color-space'] ? { colorSpace: flags['color-space'] } : {}),
        ...(Object.keys(reviewOptions).length > 0 ? { reviewOptions } : {}),
        ...(flags.narration !== undefined ? { narration: flags.narration } : {}),
        ...(flags['burn-captions'] !== undefined ? { burnInCaptions } : {}),
        ...((flags['tts-provider'] ?? flags.provider) ? { ttsProvider: flags['tts-provider'] ?? flags.provider } : {}),
        ...(flags.aligner ? { aligner: flags.aligner } : {}),
        narrationOptions: {
          ...(ttsModel ? { ttsModel } : {}),
          ...(flags.voice ? { voice: flags.voice } : {}),
          ...((flags['style-prompt'] ?? flags.style) ? { stylePrompt: flags['style-prompt'] ?? flags.style } : {}),
          ...(speedVal !== undefined ? { speed: speedVal } : {}),
          ...(flags['burn-captions'] !== undefined ? { burnInCaptions } : {}),
          ...(flags['whisper-model'] ? { whisperModel: flags['whisper-model'] } : {}),
          ...(alignerModel ? { alignerOptions: { model: alignerModel } } : {}),
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
        let result;
        try {
          result = await publishYouTube({
            video: videoArg,
            title: flags.title,
            ...(flags.description !== undefined ? { description: flags.description } : {}),
            ...(flags.privacy ? { privacy: flags.privacy } : {}),
            ...(captions ? { captions } : {}),
            ...(thumbnail ? { thumbnail } : {}),
            dryRun: parseBoolFlag(flags['dry-run'], 'dry-run'),
          });
        } catch (ytError) {
          if (flags.out && ytError?.cause?.videoId) {
            const outPath = resolve(flags.out);
            await mkdir(dirname(outPath), { recursive: true });
            const partial = ytError.partialReport ?? {
              ok: false,
              target: 'youtube',
              uploaded: true,
              partial: true,
              ...ytError.cause,
              error: ytError.message,
            };
            await writeFile(outPath, JSON.stringify(partial, null, 2) + '\n');
          }
          throw ytError;
        }
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
