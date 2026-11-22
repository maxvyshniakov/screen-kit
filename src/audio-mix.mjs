import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertValidTimeline } from './timeline.mjs';
import {
  DEFAULT_LOUDNESS_BOUNDS,
  encodePcm16Wav,
  measureLoudness,
  parsePcmMimeType,
  probeAudio,
} from './narration.mjs';

const exec = promisify(execFile);

export const DEFAULT_LYRIA_MODEL = 'lyria-3-clip-preview';
export const DEFAULT_MUSIC_LUFS = -18;
export const DEFAULT_SPEECH_MUSIC_LUFS = -26;
export const DEFAULT_DUCK_UNDER_SPEECH_DB = -10;
export const DEFAULT_DUCK_ATTACK_SEC = 0.18;
export const DEFAULT_DUCK_RELEASE_SEC = 0.45;
export const DEFAULT_MUSIC_FADE_IN_SEC = 0.4;
export const DEFAULT_MUSIC_FADE_OUT_SEC = 0.6;
export const DEFAULT_SFX_CLICK_VOLUME = 0.28;
export const DEFAULT_SFX_KEY_VOLUME = 0.22;
export const DEFAULT_MIX_SAMPLE_RATE = 48000;

const EPS = 1e-6;
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveLocalPath(ref, baseDir) {
  if (ref.startsWith('file://')) {
    return fileURLToPath(ref);
  }
  return resolve(baseDir, ref);
}

function isWavBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

function extractPcm16SamplesStereo(wavBuffer) {
  if (!isWavBuffer(wavBuffer)) {
    throw Error('Expected standard RIFF WAVE buffer');
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ' && bodyStart + 16 <= wavBuffer.length) {
      audioFormat = wavBuffer.readUInt16LE(bodyStart);
      channels = wavBuffer.readUInt16LE(bodyStart + 2);
      sampleRate = wavBuffer.readUInt32LE(bodyStart + 4);
      bitsPerSample = wavBuffer.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      dataStart = bodyStart;
      dataSize = Math.min(chunkSize, Math.max(0, wavBuffer.length - bodyStart));
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || dataStart < 0 || channels < 1) {
    throw Error(`Unsupported WAV PCM format (format=${audioFormat}, bits=${bitsPerSample}, channels=${channels})`);
  }

  const frameStride = channels * 2;
  const frameCount = Math.floor(dataSize / frameStride);
  const stereo = new Float32Array(frameCount * 2);

  for (let i = 0; i < frameCount; i += 1) {
    const base = dataStart + i * frameStride;
    const left = wavBuffer.readInt16LE(base) / 32768;
    const right = channels >= 2 ? wavBuffer.readInt16LE(base + 2) / 32768 : left;
    stereo[i * 2] = left;
    stereo[i * 2 + 1] = right;
  }

  return { sampleRate, frameCount, stereo };
}

async function decodeToPcm16StereoWav(inputFile, outputFile, sampleRate = DEFAULT_MIX_SAMPLE_RATE) {
  await exec(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputFile,
      '-vn',
      '-ar',
      String(sampleRate),
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      outputFile,
    ],
    { timeout: 60000, maxBuffer: 10e6 }
  );
}

/**
 * Synthesize clean, subtle procedural UI sound effects (`click`, `click-secondary`, `keystroke`)
 * as 16-bit stereo WAV files using FFmpeg's `aevalsrc` filter — zero external binary assets needed.
 */
export async function generateUiSfx({
  outDir,
  sampleRate = DEFAULT_MIX_SAMPLE_RATE,
  overwrite = false,
} = {}) {
  if (!isNonEmptyString(outDir)) {
    throw Error('generateUiSfx requires an outDir path');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw Error('sampleRate must be an integer between 8000 and 192000');
  }

  const targetDir = resolve(outDir);
  await mkdir(targetDir, { recursive: true });

  const specs = [
    {
      key: 'click',
      filename: 'sfx-click.wav',
      duration: 0.045,
      // Crisp micro-switch primary click with 1.5 ms anti-pop attack ramp
      expr: '(sin(2*PI*1850*t)*exp(-t*140)*0.45+sin(2*PI*720*t)*exp(-t*85)*0.35)*min(1,t/0.0015)',
    },
    {
      key: 'secondaryClick',
      filename: 'sfx-click-secondary.wav',
      duration: 0.05,
      // Slightly warmer lower-pitched secondary click
      expr: '(sin(2*PI*1420*t)*exp(-t*130)*0.40+sin(2*PI*560*t)*exp(-t*80)*0.35)*min(1,t/0.0015)',
    },
    {
      key: 'keystroke',
      filename: 'sfx-keystroke.wav',
      duration: 0.055,
      // Subtle tactile key thock transient
      expr: '(sin(2*PI*1150*t)*exp(-t*125)*0.30+sin(2*PI*420*t)*exp(-t*65)*0.38+sin(2*PI*2400*t)*exp(-t*220)*0.14)*min(1,t/0.0015)',
    },
  ];

  const files = {};
  const durations = {};

  for (const spec of specs) {
    const outPath = join(targetDir, spec.filename);
    let reusable = false;
    if (!overwrite && (await fileExists(outPath))) {
      const probed = await probeAudio(outPath).catch(() => null);
      if (probed?.hasAudio && probed.duration > 0 && probed.sampleRate === sampleRate && probed.channels === 2) {
        reusable = true;
        durations[spec.key] = probed.duration;
      }
    }

    if (!reusable) {
      await exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          `aevalsrc=exprs='${spec.expr}|${spec.expr}':s=${sampleRate}:d=${spec.duration}`,
          '-af',
          'aformat=sample_fmts=s16:channel_layouts=stereo',
          '-c:a',
          'pcm_s16le',
          outPath,
        ],
        { timeout: 30000, maxBuffer: 5e6 }
      );
      const probed = await probeAudio(outPath);
      if (!probed.hasAudio || !(probed.duration > 0)) {
        throw Error(`Failed to synthesize procedural UI SFX (${spec.key})`);
      }
      durations[spec.key] = probed.duration;
    }

    files[spec.key] = outPath;
  }

  return {
    outDir: targetDir,
    sampleRate,
    clickFile: files.click,
    secondaryClickFile: files.secondaryClick,
    keystrokeFile: files.keystroke,
    files,
    durations,
  };
}

/**
 * Collect UI SFX trigger events strictly from `timeline.overlays.ripples` and
 * `timeline.overlays.keystrokes` timestamps within `[0, duration)`.
 */
export function collectUiSfxEvents(
  timeline,
  {
    clicks = true,
    keystrokes = true,
    clickVolume = DEFAULT_SFX_CLICK_VOLUME,
    keystrokeVolume = DEFAULT_SFX_KEY_VOLUME,
    duration,
  } = {}
) {
  if (!isObject(timeline)) return [];
  const maxDuration = isFiniteNumber(duration)
    ? duration
    : isFiniteNumber(timeline.take?.duration)
      ? timeline.take.duration
      : Infinity;

  const events = [];

  if (clicks && Array.isArray(timeline.overlays?.ripples)) {
    for (const ripple of timeline.overlays.ripples) {
      if (!isObject(ripple) || !isFiniteNumber(ripple.t)) continue;
      if (ripple.t < -EPS || ripple.t >= maxDuration - EPS) continue;
      const t = round(Math.max(0, ripple.t), 4);
      const button = ripple.button ?? 'left';
      events.push({
        kind: 'click',
        variant: button === 'left' ? 'click' : 'secondaryClick',
        button,
        t,
        volume: clickVolume,
      });
    }
  }

  if (keystrokes && Array.isArray(timeline.overlays?.keystrokes)) {
    for (const ks of timeline.overlays.keystrokes) {
      if (!isObject(ks) || !isFiniteNumber(ks.t)) continue;
      if (ks.t < -EPS || ks.t >= maxDuration - EPS) continue;
      const t = round(Math.max(0, ks.t), 4);
      events.push({
        kind: 'keystroke',
        variant: 'keystroke',
        label: ks.label ?? '',
        t,
        volume: keystrokeVolume,
      });
    }
  }

  events.sort((a, b) => a.t - b.t || (a.kind === 'click' ? -1 : 1));
  return events;
}

async function renderSfxStemWav({
  events,
  sfxFiles,
  duration,
  sampleRate,
  masterVolume = 1,
  outputFile,
  scratchDir,
}) {
  const totalFrames = Math.max(1, Math.round(duration * sampleRate));
  const mix = new Float32Array(totalFrames * 2);

  const variantCache = new Map();
  const getVariantPcm = async (variant) => {
    if (variantCache.has(variant)) return variantCache.get(variant);
    const srcPath =
      variant === 'secondaryClick'
        ? (sfxFiles.secondaryClick ?? sfxFiles.click)
        : variant === 'keystroke'
          ? sfxFiles.keystroke
          : sfxFiles.click;
    const raw = await readFile(srcPath);
    let parsed = null;
    if (isWavBuffer(raw)) {
      try {
        const candidate = extractPcm16SamplesStereo(raw);
        if (candidate.sampleRate === sampleRate) parsed = candidate;
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      const normalizedFile = join(scratchDir, `norm-sfx-${variant}-${randomUUID().slice(0, 8)}.wav`);
      await decodeToPcm16StereoWav(srcPath, normalizedFile, sampleRate);
      parsed = extractPcm16SamplesStereo(await readFile(normalizedFile));
    }
    variantCache.set(variant, parsed);
    return parsed;
  };

  for (const ev of events) {
    const sampleData = await getVariantPcm(ev.variant);
    const startFrame = Math.max(0, Math.round(ev.t * sampleRate));
    if (startFrame >= totalFrames) continue;
    const gain = (isFiniteNumber(ev.volume) ? ev.volume : 1) * masterVolume;
    const copyFrames = Math.min(sampleData.frameCount, totalFrames - startFrame);
    for (let f = 0; f < copyFrames; f += 1) {
      const dstIdx = (startFrame + f) * 2;
      const srcIdx = f * 2;
      mix[dstIdx] += sampleData.stereo[srcIdx] * gain;
      mix[dstIdx + 1] += sampleData.stereo[srcIdx + 1] * gain;
    }
  }

  const pcmBytes = Buffer.alloc(totalFrames * 4);
  for (let i = 0; i < totalFrames * 2; i += 1) {
    const clamped = Math.max(-0.98, Math.min(0.98, mix[i]));
    pcmBytes.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const wavBuffer = encodePcm16Wav(pcmBytes, { sampleRate, channels: 2, bitsPerSample: 16 });
  await writeFile(outputFile, wavBuffer);
  return outputFile;
}

/**
 * Compute a deterministic SHA-256 cache key for a Lyria music generation request.
 */
export function computeMusicCacheKey({
  prompt,
  model = DEFAULT_LYRIA_MODEL,
  negativePrompt = '',
  seed = null,
  bpm = null,
  duration = null,
} = {}) {
  const canonical = JSON.stringify({
    provider: 'lyria',
    model: String(model ?? DEFAULT_LYRIA_MODEL).trim(),
    prompt: String(prompt ?? '').trim(),
    negativePrompt: String(negativePrompt ?? '').trim(),
    seed: seed ?? null,
    bpm: isFiniteNumber(bpm) ? bpm : null,
    duration: isFiniteNumber(duration) ? round(duration, 2) : null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function extractInlineAudioFromLyriaPayload(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline && typeof inline.data === 'string' && inline.data.length > 0) {
      return {
        data: inline.data,
        mimeType: inline.mimeType ?? inline.mime_type ?? 'audio/L16;codec=pcm;rate=48000;channels=2',
      };
    }
  }

  const outputAudio = payload?.output_audio ?? payload?.outputAudio ?? payload?.audio;
  if (typeof outputAudio === 'string' && outputAudio.length > 0) {
    return { data: outputAudio, mimeType: 'audio/wav' };
  }
  if (isObject(outputAudio) && typeof outputAudio.data === 'string' && outputAudio.data.length > 0) {
    return {
      data: outputAudio.data,
      mimeType: outputAudio.mimeType ?? outputAudio.mime_type ?? 'audio/wav',
    };
  }

  const pred = payload?.predictions?.[0];
  if (isObject(pred)) {
    const data = pred.bytesBase64Encoded ?? pred.audioContent ?? pred.audio?.data;
    if (typeof data === 'string' && data.length > 0) {
      return {
        data,
        mimeType: pred.mimeType ?? pred.mime_type ?? pred.audio?.mimeType ?? 'audio/wav',
      };
    }
  }

  return null;
}

/**
 * Opt-in cloud music bed generator using the Google Lyria / Gemini audio API.
 * - Sends `x-goog-api-key` header (never embeds API keys in URLs).
 * - Caches generated WAV beds by deterministic prompt/parameter SHA-256 hash.
 * - Never runs implicitly; rejects immediately without network calls if credentials are missing on cache miss.
 */
export async function generateMusicBed({
  prompt,
  outDir,
  cacheDir,
  outputFile,
  duration,
  model = DEFAULT_LYRIA_MODEL,
  negativePrompt,
  seed,
  bpm,
  apiKey,
  fetchImpl = globalThis.fetch,
  signal,
  force = false,
} = {}) {
  if (!isNonEmptyString(prompt)) {
    throw Error('generateMusicBed requires a non-empty prompt');
  }

  const cacheKey = computeMusicCacheKey({ prompt, model, negativePrompt, seed, bpm, duration });
  const resolvedCacheDir = cacheDir
    ? resolve(cacheDir)
    : outDir
      ? join(resolve(outDir), 'music-cache')
      : outputFile
        ? join(dirname(resolve(outputFile)), '.music-cache')
        : join(tmpdir(), 'screen-kit-lyria-cache');

  await mkdir(resolvedCacheDir, { recursive: true });
  const cachedFile = join(resolvedCacheDir, `lyria-${cacheKey.slice(0, 24)}.wav`);
  const finalOutFile = outputFile
    ? resolve(outputFile)
    : outDir
      ? join(resolve(outDir), `lyria-${cacheKey.slice(0, 12)}.wav`)
      : cachedFile;

  if (!force && (await fileExists(cachedFile))) {
    const probed = await probeAudio(cachedFile).catch(() => null);
    if (probed?.hasAudio && probed.duration > 0) {
      if (finalOutFile !== cachedFile) {
        await mkdir(dirname(finalOutFile), { recursive: true });
        await copyFile(cachedFile, finalOutFile);
      }
      const statBytes = (await readFile(finalOutFile)).length;
      return {
        provider: 'lyria',
        model,
        prompt: prompt.trim(),
        cacheKey,
        cached: true,
        cacheFile: cachedFile,
        file: finalOutFile,
        mimeType: 'audio/wav',
        sampleRate: probed.sampleRate,
        channels: probed.channels,
        duration: probed.duration,
        bytes: statBytes,
      };
    }
  }

  const resolvedKey = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!isNonEmptyString(resolvedKey)) {
    throw Error(
      'Lyria music generation requires API credentials: set GEMINI_API_KEY (or GOOGLE_API_KEY), pass apiKey explicitly, or provide a local music file.'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw Error('fetch is not available for Lyria music generation');
  }

  const directives = ['Instrumental background music bed for a product demo (no vocals).'];
  if (isFiniteNumber(bpm) && bpm > 0) directives.push(`Tempo: ${bpm} BPM.`);
  if (isFiniteNumber(duration) && duration > 0) directives.push(`Target length: ${round(duration, 1)}s.`);
  if (isNonEmptyString(negativePrompt)) directives.push(`Avoid: ${negativePrompt.trim()}.`);
  const fullPrompt = `${directives.join(' ')}\nPrompt: ${prompt.trim()}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const requestBody = {
    contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      ...(Number.isInteger(seed) ? { seed } : {}),
    },
  };

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': resolvedKey.trim(),
    },
    body: JSON.stringify(requestBody),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Error(`Lyria API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const extracted = extractInlineAudioFromLyriaPayload(payload);
  if (!extracted) {
    throw Error('Lyria API response did not contain audio data');
  }

  const rawBuffer = Buffer.from(extracted.data, 'base64');
  const tempWorkDir = await mkdtemp(join(tmpdir(), 'screen-kit-lyria-dec-'));

  try {
    if (isWavBuffer(rawBuffer)) {
      await writeFile(cachedFile, rawBuffer);
    } else if (/audio\/(?:l16|pcm|raw)|codec=pcm/i.test(extracted.mimeType)) {
      const pcmMeta = parsePcmMimeType(extracted.mimeType);
      const wavBuf = encodePcm16Wav(rawBuffer, {
        sampleRate: pcmMeta.sampleRate || 48000,
        channels: pcmMeta.channels || 2,
        bitsPerSample: pcmMeta.bitsPerSample || 16,
      });
      await writeFile(cachedFile, wavBuf);
    } else {
      const extMatch = extracted.mimeType.match(/audio\/([a-z0-9]+)/i);
      const ext = extMatch ? extMatch[1].replace('mpeg', 'mp3') : 'bin';
      const rawTmp = join(tempWorkDir, `raw.${ext}`);
      await writeFile(rawTmp, rawBuffer);
      await decodeToPcm16StereoWav(rawTmp, cachedFile, DEFAULT_MIX_SAMPLE_RATE);
    }
  } finally {
    await rm(tempWorkDir, { recursive: true, force: true });
  }

  const probed = await probeAudio(cachedFile);
  if (!probed.hasAudio || !(probed.duration > 0)) {
    await rm(cachedFile, { force: true }).catch(() => {});
    throw Error('Decoded Lyria audio did not contain a valid audio stream');
  }

  if (finalOutFile !== cachedFile) {
    await mkdir(dirname(finalOutFile), { recursive: true });
    await copyFile(cachedFile, finalOutFile);
  }
  const finalBytes = (await readFile(finalOutFile)).length;

  return {
    provider: 'lyria',
    model,
    prompt: prompt.trim(),
    cacheKey,
    cached: false,
    cacheFile: cachedFile,
    file: finalOutFile,
    mimeType: 'audio/wav',
    sampleRate: probed.sampleRate,
    channels: probed.channels,
    duration: probed.duration,
    bytes: finalBytes,
  };
}

/**
 * Loop or trim a local music file to match `duration`, calibrate base loudness to `targetLufs`
 * (default `-18 LUFS`), and apply smooth fade-in and fade-out curves.
 */
export async function prepareMusicBed({
  src,
  outputFile,
  duration,
  fadeIn = DEFAULT_MUSIC_FADE_IN_SEC,
  fadeOut = DEFAULT_MUSIC_FADE_OUT_SEC,
  targetLufs = DEFAULT_MUSIC_LUFS,
  volume,
  normalize = true,
  loop = true,
  sampleRate = DEFAULT_MIX_SAMPLE_RATE,
} = {}) {
  if (!isNonEmptyString(src)) {
    throw Error('prepareMusicBed requires a source audio file path');
  }
  if (!isNonEmptyString(outputFile)) {
    throw Error('prepareMusicBed requires an outputFile path');
  }
  if (!isFiniteNumber(duration) || duration <= 0) {
    throw Error('prepareMusicBed requires a positive finite duration');
  }

  const srcFile = resolve(src);
  const srcProbed = await probeAudio(srcFile);
  if (!srcProbed.hasAudio || !(srcProbed.duration > 0)) {
    throw Error(`Music source (${srcFile}) does not contain a valid audio stream`);
  }

  const destFile = resolve(outputFile);
  await mkdir(dirname(destFile), { recursive: true });

  const effFadeIn = Math.max(0, Math.min(isFiniteNumber(fadeIn) ? fadeIn : 0, duration * 0.45));
  const effFadeOut = Math.max(0, Math.min(isFiniteNumber(fadeOut) ? fadeOut : 0, duration * 0.45));

  const tempDir = await mkdtemp(join(tmpdir(), 'screen-kit-music-bed-'));
  try {
    const loopedRaw = join(tempDir, 'looped.wav');
    const loopArgs = loop ? ['-stream_loop', '-1'] : [];
    await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...loopArgs,
        '-i',
        srcFile,
        '-vn',
        '-af',
        `aresample=${sampleRate},aformat=sample_fmts=s16:channel_layouts=stereo,apad=whole_dur=${duration},atrim=0:${duration},asetpts=PTS-STARTPTS`,
        '-c:a',
        'pcm_s16le',
        loopedRaw,
      ],
      { timeout: 60000, maxBuffer: 10e6 }
    );

    let gainDb = 0;
    if (normalize && isFiniteNumber(targetLufs)) {
      const measured = await measureLoudness(loopedRaw);
      if (measured.integratedLufs !== null && Number.isFinite(measured.integratedLufs)) {
        gainDb = Math.max(-36, Math.min(24, targetLufs - measured.integratedLufs));
      }
    }
    if (isFiniteNumber(volume) && volume > 0) {
      gainDb += 20 * Math.log10(volume);
    }

    const filters = [];
    if (Math.abs(gainDb) > 0.01) {
      filters.push(`volume=${round(gainDb, 4)}dB`);
    }
    if (effFadeIn > EPS) {
      filters.push(`afade=t=in:st=0:d=${round(effFadeIn, 4)}:curve=tri`);
    }
    if (effFadeOut > EPS) {
      const fadeOutStart = Math.max(0, duration - effFadeOut);
      filters.push(`afade=t=out:st=${round(fadeOutStart, 4)}:d=${round(effFadeOut, 4)}:curve=tri`);
    }
    if (volume === 0) {
      filters.push('volume=0');
    }

    if (filters.length === 0) {
      await copyFile(loopedRaw, destFile);
    } else {
      await exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          loopedRaw,
          '-af',
          filters.join(','),
          '-c:a',
          'pcm_s16le',
          destFile,
        ],
        { timeout: 60000, maxBuffer: 10e6 }
      );
    }

    const finalProbe = await probeAudio(destFile);
    return {
      sourceFile: srcFile,
      sourceDuration: srcProbed.duration,
      looped: loop && srcProbed.duration + 0.02 < duration,
      trimmed: srcProbed.duration - 0.02 > duration,
      fadeIn: round(effFadeIn, 4),
      fadeOut: round(effFadeOut, 4),
      appliedGainDb: round(gainDb, 3),
      file: destFile,
      duration: finalProbe.duration,
      sampleRate: finalProbe.sampleRate,
      channels: finalProbe.channels,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function detectActiveSpeechSubWindows(audioFile, clipDuration) {
  const { stderr } = await exec(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      audioFile,
      '-af',
      'silencedetect=noise=-42dB:d=0.25',
      '-f',
      'null',
      '-',
    ],
    { timeout: 60000, maxBuffer: 10e6 }
  );

  const silences = [];
  let pendingStart = null;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.eE+-]+)/);
    if (startMatch) {
      pendingStart = Math.max(0, Number(startMatch[1]));
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([0-9.eE+-]+)/);
    if (endMatch) {
      const end = Math.min(clipDuration, Number(endMatch[1]));
      const start = pendingStart ?? 0;
      if (end > start + EPS) silences.push([start, end]);
      pendingStart = null;
    }
  }
  if (pendingStart !== null && clipDuration > pendingStart + EPS) {
    silences.push([pendingStart, clipDuration]);
  }

  if (silences.length === 0) {
    return clipDuration > EPS ? [[0, clipDuration]] : [];
  }

  const active = [];
  let cursor = 0;
  for (const [sStart, sEnd] of silences) {
    if (sStart > cursor + 0.04) {
      active.push([cursor, sStart]);
    }
    cursor = Math.max(cursor, sEnd);
  }
  if (clipDuration > cursor + 0.04) {
    active.push([cursor, clipDuration]);
  }
  return active;
}

/**
 * Resolve merged speech intervals `[{ start, end }]` from explicit `speechWindows`,
 * `narrationTracks`, or `timeline.audio.tracks` (`kind === 'narration'`).
 */
export async function resolveSpeechWindows({
  timeline,
  narrationTracks,
  speechWindows,
  baseDir = process.cwd(),
  totalDuration,
  mergeGap = 0.35,
} = {}) {
  const maxDur = isFiniteNumber(totalDuration)
    ? totalDuration
    : isFiniteNumber(timeline?.take?.duration)
      ? timeline.take.duration
      : Infinity;

  const raw = [];
  if (Array.isArray(speechWindows) && speechWindows.length > 0) {
    for (const win of speechWindows) {
      const s = Array.isArray(win) ? win[0] : win?.start;
      const e = Array.isArray(win) ? win[1] : win?.end;
      if (isFiniteNumber(s) && isFiniteNumber(e) && e > s + EPS) {
        const clampedStart = Math.max(0, s);
        const clampedEnd = Math.min(maxDur, e);
        if (clampedEnd > clampedStart + EPS) {
          raw.push([clampedStart, clampedEnd]);
        }
      }
    }
  } else {
    const tracks = Array.isArray(narrationTracks)
      ? narrationTracks
      : (timeline?.audio?.tracks ?? []).filter((t) => t?.kind === 'narration');

    for (const track of tracks) {
      if (!isObject(track)) continue;
      const start = isFiniteNumber(track.start) ? Math.max(0, track.start) : 0;
      let trackDuration = isFiniteNumber(track.duration) && track.duration > 0 ? track.duration : null;
      let absFile = null;

      if (isNonEmptyString(track.src) && !/^(?:https?:|data:|blob:)/i.test(track.src)) {
        absFile = resolveLocalPath(track.src, baseDir);
        if (trackDuration === null && (await fileExists(absFile))) {
          const probed = await probeAudio(absFile).catch(() => null);
          if (probed?.hasAudio && probed.duration > 0) trackDuration = probed.duration;
        }
      }

      if (!trackDuration || trackDuration <= EPS) continue;

      // If a single narration track spans most of the timeline, inspect internal silences so
      // silent pauses inside a single voiceover file still recover unducked music smoothly.
      if (
        absFile &&
        Number.isFinite(maxDur) &&
        tracks.length === 1 &&
        trackDuration >= maxDur * 0.75 &&
        (await fileExists(absFile))
      ) {
        const subWindows = await detectActiveSpeechSubWindows(absFile, trackDuration).catch(() => [
          [0, trackDuration],
        ]);
        for (const [subStart, subEnd] of subWindows) {
          const s = Math.max(0, start + subStart);
          const e = Math.min(maxDur, start + subEnd);
          if (e > s + EPS) raw.push([s, e]);
        }
      } else {
        const e = Math.min(maxDur, start + trackDuration);
        if (e > start + EPS) raw.push([start, e]);
      }
    }
  }

  if (raw.length === 0) return [];
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged = [raw[0]];
  for (let i = 1; i < raw.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = raw[i];
    if (curr[0] <= prev[1] + mergeGap) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }

  return merged.map(([start, end]) => ({
    start: round(start, 4),
    end: round(end, 4),
    duration: round(end - start, 4),
  }));
}

/**
 * Build a flat, non-nested FFmpeg `volume` expression (`eval=frame`) that smoothly ramps
 * music gain in dB by `duckDb` (e.g. `-10 dB`) across `speechWindows` with `attack` and `release`.
 */
export function buildDuckingVolumeExpression(
  speechWindows,
  {
    duckDb = DEFAULT_DUCK_UNDER_SPEECH_DB,
    attack = DEFAULT_DUCK_ATTACK_SEC,
    release = DEFAULT_DUCK_RELEASE_SEC,
  } = {}
) {
  if (!Array.isArray(speechWindows) || speechWindows.length === 0 || Math.abs(duckDb) < EPS) {
    return '1';
  }
  const effAttack = Math.max(0.01, isFiniteNumber(attack) ? attack : DEFAULT_DUCK_ATTACK_SEC);
  const effRelease = Math.max(0.01, isFiniteNumber(release) ? release : DEFAULT_DUCK_RELEASE_SEC);
  const negativeDuckDb = duckDb > 0 ? -duckDb : duckDb;

  // Merge windows whose attack/release skirts overlap so trapezoids remain strictly disjoint
  const sorted = speechWindows
    .map((w) => ({ start: Number(w.start), end: Number(w.end) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) return '1';

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start - effAttack <= prev.end + effRelease) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push(curr);
    }
  }

  const terms = merged.map((w) => {
    const sIn = round(w.start - effAttack, 4);
    const eOut = round(w.end + effRelease, 4);
    const a = round(effAttack, 4);
    const r = round(effRelease, 4);
    return `clip(min((t-(${sIn}))/${a},((${eOut})-t)/${r}),0,1)`;
  });

  const progressExpr = terms.length === 1 ? terms[0] : `min(1,${terms.join('+')})`;
  return `pow(10,(${round(negativeDuckDb, 4)}*(${progressExpr}))/20)`;
}

/**
 * Measure the RMS level in dBFS over a `[start, end]` slice of an audio or video file via FFmpeg `astats`.
 */
export async function measureSegmentRmsDb(mediaPath, start, end) {
  const file = resolve(mediaPath);
  if (!isFiniteNumber(start) || !isFiniteNumber(end) || end <= start + 0.02) {
    throw Error('measureSegmentRmsDb requires end > start + 0.02s');
  }
  const { stderr } = await exec(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-vn',
      '-af',
      `atrim=start=${round(start, 4)}:end=${round(end, 4)},asetpts=PTS-STARTPTS,astats=metadata=0:reset=0`,
      '-f',
      'null',
      '-',
    ],
    { timeout: 60000, maxBuffer: 10e6 }
  );

  const overallIdx = stderr.lastIndexOf('Overall');
  const tail = overallIdx >= 0 ? stderr.slice(overallIdx) : stderr;
  const match = tail.match(/RMS level dB:\s*([+-]?\d+(?:\.\d+)?|-inf)/i);
  if (!match) return -Infinity;
  if (match[1].toLowerCase() === '-inf') return -Infinity;
  const value = Number(match[1]);
  return Number.isFinite(value) ? round(value, 2) : -Infinity;
}

async function buildNarrationStemWav({
  tracks,
  baseDir,
  duration,
  sampleRate,
  narrationVolume = 1,
  outputFile,
  scratchDir,
}) {
  const totalFrames = Math.max(1, Math.round(duration * sampleRate));
  const mix = new Float32Array(totalFrames * 2);

  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    if (!isObject(track) || !isNonEmptyString(track.src)) continue;
    const srcFile = resolveLocalPath(track.src, baseDir);
    const decodedWav = join(scratchDir, `narr-decoded-${i}-${randomUUID().slice(0, 8)}.wav`);
    await decodeToPcm16StereoWav(srcFile, decodedWav, sampleRate);
    const sampleData = extractPcm16SamplesStereo(await readFile(decodedWav));

    const startSec = isFiniteNumber(track.start) ? Math.max(0, track.start) : 0;
    const startFrame = Math.round(startSec * sampleRate);
    if (startFrame >= totalFrames) continue;

    const trackVol = isFiniteNumber(track.volume) ? track.volume : 1;
    const gain = trackVol * narrationVolume;
    const copyFrames = Math.min(sampleData.frameCount, totalFrames - startFrame);

    for (let f = 0; f < copyFrames; f += 1) {
      const dstIdx = (startFrame + f) * 2;
      const srcIdx = f * 2;
      mix[dstIdx] += sampleData.stereo[srcIdx] * gain;
      mix[dstIdx + 1] += sampleData.stereo[srcIdx + 1] * gain;
    }
  }

  const pcmBytes = Buffer.alloc(totalFrames * 4);
  for (let i = 0; i < totalFrames * 2; i += 1) {
    const clamped = Math.max(-0.99, Math.min(0.99, mix[i]));
    pcmBytes.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const wavBuffer = encodePcm16Wav(pcmBytes, { sampleRate, channels: 2, bitsPerSample: 16 });
  await writeFile(outputFile, wavBuffer);
  return outputFile;
}

/**
 * Mux a mixed stereo audio file into a video file without re-encoding video frames (`-c:v copy -c:a aac`).
 */
export async function muxAudioIntoVideo({
  videoFile,
  audioFile,
  outFile,
  audioBitrate = '192k',
} = {}) {
  if (!isNonEmptyString(videoFile) || !isNonEmptyString(audioFile) || !isNonEmptyString(outFile)) {
    throw Error('muxAudioIntoVideo requires videoFile, audioFile, and outFile');
  }
  const resolvedVideo = resolve(videoFile);
  const resolvedAudio = resolve(audioFile);
  const resolvedOut = resolve(outFile);
  await mkdir(dirname(resolvedOut), { recursive: true });

  const ext = extname(resolvedOut).toLowerCase();
  const audioCodecArgs =
    ext === '.webm'
      ? ['-c:a', 'libopus', '-b:a', audioBitrate]
      : ['-c:a', 'aac', '-b:a', audioBitrate];

  await exec(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      resolvedVideo,
      '-i',
      resolvedAudio,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      ...audioCodecArgs,
      '-shortest',
      resolvedOut,
    ],
    { timeout: 120000, maxBuffer: 10e6 }
  );

  const audioInfo = await probeAudio(resolvedOut);
  return {
    file: resolvedOut,
    videoFile: resolvedVideo,
    audioFile: resolvedAudio,
    audio: audioInfo,
  };
}

function findSilentGapWindow(speechWindows, duration, attack, release, fadeIn, fadeOut) {
  const safeStart = Math.min(duration * 0.2, Math.max(0.05, fadeIn));
  const safeEnd = Math.max(safeStart + 0.1, duration - Math.min(duration * 0.2, Math.max(0.05, fadeOut)));
  if (speechWindows.length === 0) {
    return safeEnd - safeStart >= 0.12 ? { start: safeStart, end: safeEnd } : null;
  }

  const candidates = [];
  let cursor = safeStart;
  for (const win of speechWindows) {
    const gapEnd = Math.min(safeEnd, win.start - attack);
    if (gapEnd - cursor >= 0.12) {
      candidates.push({ start: cursor, end: gapEnd, len: gapEnd - cursor });
    }
    cursor = Math.max(cursor, win.end + release);
  }
  if (safeEnd - cursor >= 0.12) {
    candidates.push({ start: cursor, end: safeEnd, len: safeEnd - cursor });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.len - a.len);
  return { start: round(candidates[0].start, 4), end: round(candidates[0].end, 4) };
}

/**
 * Mix narration tracks, background music (local file or opt-in Google Lyria bed), and procedural
 * UI SFX (`overlays.ripples` + `overlays.keystrokes`) with automatic voice ducking and `ebur128`
 * loudness verification, attaching the resulting stereo track cleanly to `timeline.audio.tracks`
 * (and optionally muxing into MP4).
 */
export async function mixTimelineAudio({
  timeline: timelineInput,
  duration: durationOverride,
  music,
  sfx = false,
  narrationTracks: explicitNarrationTracks,
  speechWindows: explicitSpeechWindows,
  outFile,
  outDir,
  videoFile,
  muxOutFile,
  duckUnderSpeechDb = DEFAULT_DUCK_UNDER_SPEECH_DB,
  duckAttack = DEFAULT_DUCK_ATTACK_SEC,
  duckRelease = DEFAULT_DUCK_RELEASE_SEC,
  duckingMode = 'envelope',
  musicLufs = DEFAULT_MUSIC_LUFS,
  musicVolume,
  sfxVolume = 1,
  narrationVolume = 1,
  sampleRate = DEFAULT_MIX_SAMPLE_RATE,
  loudnessBounds = {},
  attachToTimeline = true,
  keepStems = false,
  baseDir,
} = {}) {
  if (!['envelope', 'sidechain'].includes(duckingMode)) {
    throw Error(`duckingMode must be "envelope" or "sidechain" (received ${String(duckingMode)})`);
  }

  let timeline = null;
  let timelineFile = null;
  if (typeof timelineInput === 'string') {
    timelineFile = resolve(timelineInput);
    timeline = JSON.parse(await readFile(timelineFile, 'utf8'));
  } else if (isObject(timelineInput)) {
    timeline = timelineInput;
  } else if (timelineInput !== undefined && timelineInput !== null) {
    throw Error('timeline must be an object or path to timeline.json');
  }

  const resolvedBaseDir = baseDir
    ? resolve(baseDir)
    : timelineFile
      ? dirname(timelineFile)
      : process.cwd();

  const duration = isFiniteNumber(durationOverride) && durationOverride > 0
    ? durationOverride
    : timeline?.take?.duration;
  if (!isFiniteNumber(duration) || duration <= 0) {
    throw Error('mixTimelineAudio requires timeline.take.duration or a positive duration option');
  }

  const resolvedOutDir = outDir ? resolve(outDir) : null;
  const resolvedOutFile = outFile
    ? resolve(outFile)
    : resolvedOutDir
      ? join(resolvedOutDir, 'audio-mix.wav')
      : null;

  if (!resolvedOutFile) {
    throw Error('mixTimelineAudio requires outFile or outDir');
  }
  await mkdir(dirname(resolvedOutFile), { recursive: true });
  if (resolvedOutDir) {
    await mkdir(resolvedOutDir, { recursive: true });
  }

  const narrationList = Array.isArray(explicitNarrationTracks)
    ? explicitNarrationTracks
    : (timeline?.audio?.tracks ?? []).filter((t) => t?.kind === 'narration');

  const scratchDir = await mkdtemp(join(tmpdir(), 'screen-kit-audio-mix-'));
  const stemsOutDir = (keepStems && resolvedOutDir) ? join(resolvedOutDir, 'stems') : scratchDir;
  if (stemsOutDir !== scratchDir) {
    await mkdir(stemsOutDir, { recursive: true });
  }

  try {
    // 1. Resolve speech windows & narration stem
    const speechWindows = await resolveSpeechWindows({
      timeline,
      narrationTracks: narrationList,
      speechWindows: explicitSpeechWindows,
      baseDir: resolvedBaseDir,
      totalDuration: duration,
    });

    let narrationStemFile = null;
    if (narrationList.length > 0) {
      narrationStemFile = join(stemsOutDir, 'narration-stem.wav');
      await buildNarrationStemWav({
        tracks: narrationList,
        baseDir: resolvedBaseDir,
        duration,
        sampleRate,
        narrationVolume,
        outputFile: narrationStemFile,
        scratchDir,
      });
    }

    // 2. Resolve UI SFX events & stem (strictly at overlays.ripples & overlays.keystrokes)
    const sfxConfig = sfx === true ? { enabled: true } : isObject(sfx) ? sfx : { enabled: false };
    const sfxEnabled = sfx === true || (isObject(sfx) && sfx.enabled !== false);
    let sfxEvents = [];
    let sfxAssets = null;
    let sfxStemFile = null;

    if (sfxEnabled && timeline) {
      sfxEvents = collectUiSfxEvents(timeline, {
        clicks: sfxConfig.clicks !== false,
        keystrokes: sfxConfig.keystrokes !== false,
        ...(isFiniteNumber(sfxConfig.clickVolume) ? { clickVolume: sfxConfig.clickVolume } : {}),
        ...(isFiniteNumber(sfxConfig.keystrokeVolume) ? { keystrokeVolume: sfxConfig.keystrokeVolume } : {}),
        duration,
      });

      if (sfxEvents.length > 0) {
        const sfxAssetDir = sfxConfig.outDir
          ? resolve(sfxConfig.outDir)
          : resolvedOutDir
            ? join(resolvedOutDir, 'sfx')
            : join(scratchDir, 'sfx');
        if (sfxConfig.clickFile && sfxConfig.keystrokeFile) {
          sfxAssets = {
            outDir: sfxAssetDir,
            sampleRate,
            clickFile: resolveLocalPath(sfxConfig.clickFile, resolvedBaseDir),
            secondaryClickFile: sfxConfig.secondaryClickFile
              ? resolveLocalPath(sfxConfig.secondaryClickFile, resolvedBaseDir)
              : resolveLocalPath(sfxConfig.clickFile, resolvedBaseDir),
            keystrokeFile: resolveLocalPath(sfxConfig.keystrokeFile, resolvedBaseDir),
            files: {
              click: resolveLocalPath(sfxConfig.clickFile, resolvedBaseDir),
              secondaryClick: sfxConfig.secondaryClickFile
                ? resolveLocalPath(sfxConfig.secondaryClickFile, resolvedBaseDir)
                : resolveLocalPath(sfxConfig.clickFile, resolvedBaseDir),
              keystroke: resolveLocalPath(sfxConfig.keystrokeFile, resolvedBaseDir),
            },
          };
        } else {
          sfxAssets = await generateUiSfx({ outDir: sfxAssetDir, sampleRate });
        }

        sfxStemFile = join(stemsOutDir, 'sfx-stem.wav');
        await renderSfxStemWav({
          events: sfxEvents,
          sfxFiles: sfxAssets.files,
          duration,
          sampleRate,
          masterVolume: isFiniteNumber(sfxConfig.volume) ? sfxConfig.volume * sfxVolume : sfxVolume,
          outputFile: sfxStemFile,
          scratchDir,
        });
      }
    }

    // 3. Resolve & duck background music bed (local file OR explicit opt-in Lyria generation)
    const musicConfig =
      typeof music === 'string'
        ? { enabled: true, src: music }
        : isObject(music) && music.enabled !== false
          ? music
          : null;

    let musicDetails = null;
    let duckedMusicStemFile = null;
    let duckingReport = {
      applied: false,
      mode: duckingMode,
      duckUnderSpeechDb,
      speechWindows,
      silentGapRmsDb: null,
      speechWindowRmsDb: null,
      attenuationDb: 0,
    };

    if (musicConfig) {
      let rawMusicSource = null;
      let generatedBedInfo = null;

      if (musicConfig.provider === 'lyria') {
        generatedBedInfo = await generateMusicBed({
          prompt: musicConfig.prompt,
          outDir: resolvedOutDir ?? scratchDir,
          cacheDir: musicConfig.cacheDir,
          duration,
          model: musicConfig.model ?? DEFAULT_LYRIA_MODEL,
          negativePrompt: musicConfig.negativePrompt,
          seed: musicConfig.seed,
          bpm: musicConfig.bpm,
          apiKey: musicConfig.apiKey,
          fetchImpl: musicConfig.fetchImpl,
          signal: musicConfig.signal,
          force: Boolean(musicConfig.force),
        });
        rawMusicSource = generatedBedInfo.file;
      } else if (isNonEmptyString(musicConfig.src)) {
        rawMusicSource = resolveLocalPath(musicConfig.src, resolvedBaseDir);
      } else if (isNonEmptyString(musicConfig.prompt)) {
        throw Error(
          'Cloud music generation is strictly opt-in: set music.provider = "lyria" explicitly to call the Lyria API.'
        );
      } else {
        throw Error('music configuration requires either `src` (local file) or `provider: "lyria"` with `prompt`');
      }

      const fadeIn = musicConfig.fadeIn ?? DEFAULT_MUSIC_FADE_IN_SEC;
      const fadeOut = musicConfig.fadeOut ?? DEFAULT_MUSIC_FADE_OUT_SEC;
      const preparedBedFile = join(scratchDir, 'music-prepared.wav');
      const prepared = await prepareMusicBed({
        src: rawMusicSource,
        outputFile: preparedBedFile,
        duration,
        fadeIn,
        fadeOut,
        targetLufs: musicConfig.targetLufs ?? musicLufs,
        volume: musicConfig.volume ?? musicVolume,
        normalize: musicConfig.normalize !== false,
        loop: musicConfig.loop !== false,
        sampleRate,
      });

      duckedMusicStemFile = join(stemsOutDir, 'music-ducked-stem.wav');
      const shouldDuck =
        musicConfig.duck !== false &&
        Math.abs(duckUnderSpeechDb) > EPS &&
        (speechWindows.length > 0 || (duckingMode === 'sidechain' && Boolean(narrationStemFile)));

      if (shouldDuck && duckingMode === 'sidechain' && narrationStemFile) {
        const attackMs = Math.max(1, Math.round(duckAttack * 1000));
        const releaseMs = Math.max(10, Math.round(duckRelease * 1000));
        await exec(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            preparedBedFile,
            '-i',
            narrationStemFile,
            '-filter_complex',
            `[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo[mbed];[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo[vsc];[mbed][vsc]sidechaincompress=threshold=0.015:ratio=12:attack=${attackMs}:release=${releaseMs}:level_sc=2.5:knee=4,aformat=sample_fmts=s16:channel_layouts=stereo[ducked]`,
            '-map',
            '[ducked]',
            '-c:a',
            'pcm_s16le',
            duckedMusicStemFile,
          ],
          { timeout: 60000, maxBuffer: 10e6 }
        );
      } else if (shouldDuck && speechWindows.length > 0) {
        const volExpr = buildDuckingVolumeExpression(speechWindows, {
          duckDb: duckUnderSpeechDb,
          attack: duckAttack,
          release: duckRelease,
        });
        await exec(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            preparedBedFile,
            '-af',
            `volume=volume='${volExpr}':eval=frame,aformat=sample_fmts=s16:channel_layouts=stereo`,
            '-c:a',
            'pcm_s16le',
            duckedMusicStemFile,
          ],
          { timeout: 60000, maxBuffer: 10e6 }
        );
      } else {
        await copyFile(preparedBedFile, duckedMusicStemFile);
      }

      if (shouldDuck && speechWindows.length > 0) {
        const primaryWin = speechWindows.reduce((best, w) => (w.duration > best.duration ? w : best), speechWindows[0]);
        const speechTrimStart = primaryWin.start + Math.min(0.05, primaryWin.duration * 0.15);
        const speechTrimEnd = primaryWin.end - Math.min(0.05, primaryWin.duration * 0.15);
        const speechRms =
          speechTrimEnd - speechTrimStart > 0.04
            ? await measureSegmentRmsDb(duckedMusicStemFile, speechTrimStart, speechTrimEnd)
            : null;

        const gapWin = findSilentGapWindow(
          speechWindows,
          duration,
          duckAttack,
          duckRelease,
          prepared.fadeIn,
          prepared.fadeOut
        );
        const gapRms = gapWin
          ? await measureSegmentRmsDb(duckedMusicStemFile, gapWin.start, gapWin.end)
          : null;

        duckingReport = {
          applied: true,
          mode: duckingMode,
          duckUnderSpeechDb,
          speechWindows,
          silentGapWindow: gapWin,
          silentGapRmsDb: gapRms,
          speechWindowRmsDb: speechRms,
          attenuationDb:
            Number.isFinite(gapRms) && Number.isFinite(speechRms)
              ? round(gapRms - speechRms, 2)
              : null,
        };
      }

      musicDetails = {
        provider: generatedBedInfo ? 'lyria' : 'local',
        ...(generatedBedInfo
          ? {
              model: generatedBedInfo.model,
              cacheKey: generatedBedInfo.cacheKey,
              cached: generatedBedInfo.cached,
              generatedFile: generatedBedInfo.file,
            }
          : {}),
        sourceFile: prepared.sourceFile,
        sourceDuration: prepared.sourceDuration,
        looped: prepared.looped,
        trimmed: prepared.trimmed,
        fadeIn: prepared.fadeIn,
        fadeOut: prepared.fadeOut,
        appliedGainDb: prepared.appliedGainDb,
        ...(keepStems && resolvedOutDir ? { stemFile: duckedMusicStemFile } : {}),
      };
    }

    // 4. Mix active stems cleanly via FFmpeg (`amix=normalize=0` + true-peak limiter)
    const activeStemFiles = [narrationStemFile, duckedMusicStemFile, sfxStemFile].filter(Boolean);
    const outExt = extname(resolvedOutFile).toLowerCase();
    const codecArgs =
      outExt === '.m4a' || outExt === '.aac' || outExt === '.mp4'
        ? ['-c:a', 'aac', '-b:a', '192k']
        : outExt === '.mp3'
          ? ['-c:a', 'libmp3lame', '-b:a', '192k']
          : outExt === '.opus' || outExt === '.ogg'
            ? ['-c:a', 'libopus', '-b:a', '160k']
            : ['-c:a', 'pcm_s16le'];

    if (activeStemFiles.length === 0) {
      await exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}:d=${duration}`,
          ...codecArgs,
          resolvedOutFile,
        ],
        { timeout: 60000, maxBuffer: 10e6 }
      );
    } else if (activeStemFiles.length === 1) {
      await exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          activeStemFiles[0],
          '-af',
          `aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,alimiter=limit=0.89125:level=false:attack=5:release=50,atrim=0:${duration},asetpts=PTS-STARTPTS`,
          ...codecArgs,
          resolvedOutFile,
        ],
        { timeout: 60000, maxBuffer: 10e6 }
      );
    } else {
      const inputArgs = [];
      const labels = [];
      activeStemFiles.forEach((stemPath, idx) => {
        inputArgs.push('-i', stemPath);
        labels.push(`[${idx}:a]`);
      });
      const filterGraph = `${labels.join('')}amix=inputs=${activeStemFiles.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.89125:level=false:attack=5:release=50,atrim=0:${duration},asetpts=PTS-STARTPTS[mixout]`;

      await exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          ...inputArgs,
          '-filter_complex',
          filterGraph,
          '-map',
          '[mixout]',
          ...codecArgs,
          resolvedOutFile,
        ],
        { timeout: 60000, maxBuffer: 10e6 }
      );
    }

    // 5. Verify output loudness with `measureLoudness` (`ebur128`)
    const bounds = { ...DEFAULT_LOUDNESS_BOUNDS, ...loudnessBounds };
    const loudness = await measureLoudness(resolvedOutFile, {
      silenceThresholdLufs: bounds.silenceThresholdLufs,
    });

    const hasContinuousProgram = narrationList.length > 0 || Boolean(musicDetails);
    const loudnessIssues = [];
    if (!loudness.hasAudio) {
      loudnessIssues.push('mixed output contains no audio stream');
    } else if (hasContinuousProgram) {
      if (loudness.isSilent) {
        loudnessIssues.push(`mixed audio is silent (I=${loudness.integratedLufs ?? '-inf'} LUFS)`);
      } else {
        if (loudness.integratedLufs < bounds.minLufs) {
          loudnessIssues.push(
            `integrated loudness ${loudness.integratedLufs} LUFS below minimum ${bounds.minLufs} LUFS`
          );
        }
        if (loudness.integratedLufs > bounds.maxLufs) {
          loudnessIssues.push(
            `integrated loudness ${loudness.integratedLufs} LUFS exceeds maximum ${bounds.maxLufs} LUFS`
          );
        }
      }
      if (loudness.truePeakDbfs !== null && loudness.truePeakDbfs > bounds.maxTruePeakDbfs) {
        loudnessIssues.push(
          `true peak ${loudness.truePeakDbfs} dBFS exceeds ceiling ${bounds.maxTruePeakDbfs} dBFS`
        );
      }
    } else if (sfxEvents.length > 0) {
      if (loudness.truePeakDbfs === null || loudness.truePeakDbfs <= -60) {
        loudnessIssues.push('SFX-only mix produced no measurable transient signal');
      } else if (loudness.truePeakDbfs > bounds.maxTruePeakDbfs) {
        loudnessIssues.push(
          `true peak ${loudness.truePeakDbfs} dBFS exceeds ceiling ${bounds.maxTruePeakDbfs} dBFS`
        );
      }
    }

    // 6. Attach mixed track cleanly onto cloned `timeline.audio.tracks`
    let updatedTimeline = null;
    if (timeline && attachToTimeline) {
      updatedTimeline = structuredClone(timeline);
      const trackSrc = timelineFile
        ? relative(dirname(timelineFile), resolvedOutFile) || resolvedOutFile
        : resolvedOutFile;
      // Use kind='music' when music or narration is mixed into a single master track so
      // `reviewNarration` verifies master ebur128 loudness without misclassifying full-timeline
      // duration as a single step's speech overflow; use kind='sfx' for SFX-only mixes.
      const trackKind = hasContinuousProgram ? 'music' : 'sfx';
      updatedTimeline.audio = {
        tracks: [
          {
            id: 'audio-mix',
            kind: trackKind,
            src: trackSrc,
            start: 0,
            volume: 1,
          },
        ],
      };
      assertValidTimeline(updatedTimeline);
    }

    // 7. Optional mux into MP4/WebM video
    let muxedVideo = null;
    if (videoFile && muxOutFile) {
      muxedVideo = await muxAudioIntoVideo({
        videoFile,
        audioFile: resolvedOutFile,
        outFile: muxOutFile,
      });
    }

    return {
      ok: loudnessIssues.length === 0,
      file: resolvedOutFile,
      duration: loudness.duration || round(duration, 4),
      sampleRate: loudness.sampleRate || sampleRate,
      channels: loudness.channels || 2,
      loudness,
      loudnessBounds: bounds,
      loudnessIssues,
      ducking: duckingReport,
      music: musicDetails,
      sfx: {
        enabled: sfxEnabled,
        count: sfxEvents.length,
        clicks: sfxEvents.filter((e) => e.kind === 'click').length,
        keystrokes: sfxEvents.filter((e) => e.kind === 'keystroke').length,
        events: sfxEvents,
        ...(sfxAssets ? { files: sfxAssets.files } : {}),
        ...(keepStems && resolvedOutDir && sfxStemFile ? { stemFile: sfxStemFile } : {}),
      },
      narration: {
        trackCount: narrationList.length,
        speechWindows,
        ...(keepStems && resolvedOutDir && narrationStemFile ? { stemFile: narrationStemFile } : {}),
      },
      ...(updatedTimeline ? { timeline: updatedTimeline } : {}),
      ...(muxedVideo ? { muxedVideo } : {}),
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
