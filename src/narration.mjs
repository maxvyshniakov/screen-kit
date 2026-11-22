import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertValidTimeline,
  compileStepCameraKeyframes,
  compileTimeline,
  sampleCamera,
  sampleCursor,
  validateEventTrack,
} from './timeline.mjs';
import { probeVideo } from './video.mjs';

const exec = promisify(execFile);

export const TTS_PROVIDERS = ['gemini', 'kokoro'];
export const WORD_ALIGNERS = ['auto', 'whisper', 'gemini', 'proportional'];
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-pro-preview-tts';
export const DEFAULT_GEMINI_ALIGN_MODEL = 'gemini-2.5-flash';
export const DEFAULT_MLX_WHISPER_MODEL = 'mlx-community/whisper-tiny';
export const DEFAULT_GEMINI_VOICE = 'Kore';
export const DEFAULT_GEMINI_STYLE_PROMPT =
  'Speak in a brisk, natural, energetic product-demo tone with clear pacing.';
export const DEFAULT_KOKORO_VOICE = 'af_heart';
export const DEFAULT_SPEECH_SPEED = 1.1;
export const DEFAULT_STEP_LEAD_IN = 0.12;
export const DEFAULT_STEP_LEAD_OUT = 0.22;

export const NETFLIX_CAPTION_RULES = Object.freeze({
  maxLines: 2,
  maxCharsPerLine: 42,
  targetCps: 17,
  maxCps: 20,
  minDuration: 5 / 6, // 0.8333... s (20 frames at 24fps)
  maxDuration: 7.0,
  minGap: 2 / 30, // ~0.0667 s (2 frames at 30fps)
  tail: 0.5,
});

export const DEFAULT_LOUDNESS_BOUNDS = Object.freeze({
  minLufs: -30,
  maxLufs: -6,
  targetLufs: -14,
  maxTruePeakDbfs: -0.5,
  silenceThresholdLufs: -60,
});

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

const BCP47_DEFAULTS = {
  en: 'en-US',
  ru: 'ru-RU',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-BR',
  ja: 'ja-JP',
  zh: 'zh-CN',
  ko: 'ko-KR',
};

const KOKORO_LANG_CODES = {
  en: 'a',
  'en-us': 'a',
  'en-gb': 'b',
  es: 'e',
  fr: 'f',
  hi: 'h',
  it: 'i',
  ja: 'j',
  pt: 'p',
  zh: 'z',
};

function normalizeLanguageCode(language) {
  if (!isNonEmptyString(language)) return 'en-US';
  const trimmed = language.trim();
  const lower = trimmed.toLowerCase();
  return BCP47_DEFAULTS[lower] ?? trimmed;
}

function resolveKokoroLangCode(language) {
  if (!isNonEmptyString(language)) return 'a';
  const lower = language.trim().toLowerCase();
  if (KOKORO_LANG_CODES[lower]) return KOKORO_LANG_CODES[lower];
  const primary = lower.split(/[-_]/)[0];
  return KOKORO_LANG_CODES[primary] ?? 'a';
}

/**
 * Parse sample rate and channel count from a PCM MIME type such as
 * `audio/L16;codec=pcm;rate=24000;channels=1`.
 */
export function parsePcmMimeType(mimeType = '') {
  const text = String(mimeType);
  const rateMatch = text.match(/(?:^|;\s*)rate=(\d+)/i);
  const channelsMatch = text.match(/(?:^|;\s*)channels=(\d+)/i);
  const bitsMatch = text.match(/audio\/l(\d+)/i);
  return {
    sampleRate: rateMatch ? Number(rateMatch[1]) : 24000,
    channels: channelsMatch ? Number(channelsMatch[1]) : 1,
    bitsPerSample: bitsMatch ? Number(bitsMatch[1]) : 16,
  };
}

/**
 * Wrap raw little-endian signed 16-bit PCM bytes into a standard RIFF WAVE buffer.
 */
export function encodePcm16Wav(
  pcmBytes,
  { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}
) {
  const pcm = Buffer.isBuffer(pcmBytes) ? pcmBytes : Buffer.from(pcmBytes);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw Error('sampleRate must be a positive integer');
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw Error('channels must be a positive integer');
  }
  if (!Number.isInteger(bitsPerSample) || bitsPerSample <= 0 || bitsPerSample % 8 !== 0) {
    throw Error('bitsPerSample must be a positive multiple of 8');
  }

  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function parseWavHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let bitsPerSample = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ' && bodyStart + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      byteRate = buffer.readUInt32LE(bodyStart + 8);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, Math.max(0, buffer.length - bodyStart));
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  const duration = byteRate > 0 ? dataSize / byteRate : 0;
  return { channels, sampleRate, bitsPerSample, byteRate, dataSize, duration: round(duration, 4) };
}

/**
 * Probe audio stream metadata of an audio or video file using `ffprobe`.
 */
export async function probeAudio(mediaPath) {
  const file = resolve(mediaPath);
  const { stdout } = await exec(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { maxBuffer: 10e6 }
  );
  const parsed = JSON.parse(stdout);
  const stream = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!stream) {
    return {
      file,
      hasAudio: false,
      duration: 0,
      sampleRate: 0,
      channels: 0,
      codec: '',
      bitRate: 0,
    };
  }
  const duration = Number(stream.duration ?? parsed.format?.duration ?? 0);
  return {
    file,
    hasAudio: true,
    duration: Number.isFinite(duration) ? round(duration, 4) : 0,
    sampleRate: Number(stream.sample_rate ?? 0) || 0,
    channels: Number(stream.channels ?? 0) || 0,
    codec: stream.codec_name ?? '',
    bitRate: Number(stream.bit_rate ?? parsed.format?.bit_rate ?? 0) || 0,
  };
}

function buildGeminiTtsPrompt({ text, language, style, tone, pacing, instructions }) {
  const directives = [];
  if (isNonEmptyString(language)) directives.push(`language ${language.trim()}`);
  if (isNonEmptyString(style)) directives.push(`style: ${style.trim()}`);
  if (isNonEmptyString(tone)) directives.push(`tone: ${tone.trim()}`);
  if (isNonEmptyString(pacing)) directives.push(`pacing: ${pacing.trim()}`);
  if (isNonEmptyString(instructions)) directives.push(instructions.trim());
  if (directives.length === 0) return text.trim();
  return `Speak the following script verbatim (${directives.join('; ')}):\n\n${text.trim()}`;
}

/**
 * Build a safe pitch-preserving FFmpeg `atempo` filter chain for `speed`.
 * FFmpeg's `atempo` filter requires each stage in `[0.5, 2.0]`, so speeds outside
 * `[0.5, 2.0]` are chained across multiple stages and extreme values are clamped to `[0.1, 16]`.
 */
export function buildAtempoFilterChain(speed) {
  if (!isFiniteNumber(speed) || speed <= 0) {
    throw Error(`Speech speed must be a positive finite number (received ${String(speed)})`);
  }
  const clamped = Math.min(16, Math.max(0.1, speed));
  if (Math.abs(clamped - 1) <= 1e-6) return '';
  const stages = [];
  let remaining = clamped;
  while (remaining > 2.0 + 1e-6) {
    stages.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5 - 1e-6) {
    stages.push('atempo=0.5');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-6 || stages.length === 0) {
    const stageVal = Math.min(2.0, Math.max(0.5, remaining));
    stages.push(`atempo=${Number(stageVal.toFixed(6))}`);
  }
  return stages.join(',');
}

async function applyAtempoToWavBuffer(
  wavBuffer,
  { atempoFilter, sampleRate, channels, signal } = {}
) {
  const scratchDir = await mkdtemp(join(tmpdir(), 'screen-kit-atempo-'));
  const tempIn = join(scratchDir, 'in.wav');
  const tempOut = join(scratchDir, 'out.wav');
  try {
    await writeFile(tempIn, wavBuffer);
    await exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        tempIn,
        '-af',
        atempoFilter,
        ...(sampleRate ? ['-ar', String(sampleRate)] : []),
        ...(channels ? ['-ac', String(channels)] : []),
        '-c:a',
        'pcm_s16le',
        tempOut,
      ],
      { timeout: 60000, maxBuffer: 10e6, ...(signal ? { signal } : {}) }
    );
    return await readFile(tempOut);
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Primary cloud TTS provider: Gemini native TTS audio generation API.
 * Strictly opt-in; throws clearly if credentials (`GEMINI_API_KEY` / `GOOGLE_API_KEY` / `apiKey`) are missing.
 */
export async function synthesizeWithGemini({
  text,
  outputFile,
  apiKey,
  model = DEFAULT_GEMINI_TTS_MODEL,
  voice = DEFAULT_GEMINI_VOICE,
  language,
  style,
  stylePrompt,
  tone,
  pacing,
  instructions,
  speed = DEFAULT_SPEECH_SPEED,
  sampleRate,
  fetchImpl = globalThis.fetch,
  env = process.env,
  signal,
} = {}) {
  if (!isNonEmptyString(text)) {
    throw Error('synthesizeWithGemini requires non-empty text');
  }
  const atempoFilter = buildAtempoFilterChain(speed);
  const clampedSpeed = Math.min(16, Math.max(0.1, speed));

  const resolvedKey = apiKey ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  if (!isNonEmptyString(resolvedKey)) {
    throw Error(
      'Gemini TTS requires API credentials: set GEMINI_API_KEY (or GOOGLE_API_KEY), pass apiKey explicitly, or use provider="kokoro" for offline synthesis.'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw Error('fetch is not available for Gemini TTS');
  }

  const languageCode = language ? normalizeLanguageCode(language) : undefined;
  const effectiveStyle =
    stylePrompt !== undefined
      ? stylePrompt
      : style !== undefined
        ? style
        : DEFAULT_GEMINI_STYLE_PROMPT;
  const promptText = buildGeminiTtsPrompt({
    text,
    language: languageCode,
    style: effectiveStyle,
    tone,
    pacing,
    instructions,
  });
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const requestBody = {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
        ...(languageCode ? { languageCode } : {}),
      },
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
    throw Error(`Gemini TTS API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const audioPart = parts.find((part) => {
    const inline = part?.inlineData ?? part?.inline_data;
    return inline && typeof inline.data === 'string' && inline.data.length > 0;
  });

  if (!audioPart) {
    throw Error('Gemini TTS response did not contain inline audio data');
  }

  const inline = audioPart.inlineData ?? audioPart.inline_data;
  const rawMimeType = inline.mimeType ?? inline.mime_type ?? 'audio/L16;codec=pcm;rate=24000';
  const rawBuffer = Buffer.from(inline.data, 'base64');

  let finalBuffer = rawBuffer;
  let finalMimeType = rawMimeType;
  let resolvedSampleRate = sampleRate ?? 24000;
  let resolvedChannels = 1;
  let duration = 0;

  const wavMeta = parseWavHeader(rawBuffer);
  if (wavMeta) {
    finalMimeType = 'audio/wav';
    resolvedSampleRate = wavMeta.sampleRate;
    resolvedChannels = wavMeta.channels;
    duration = wavMeta.duration;
  } else if (/audio\/(?:l16|pcm|raw)|codec=pcm/i.test(rawMimeType)) {
    const pcmMeta = parsePcmMimeType(rawMimeType);
    resolvedSampleRate = sampleRate ?? pcmMeta.sampleRate;
    resolvedChannels = pcmMeta.channels;
    finalBuffer = encodePcm16Wav(rawBuffer, {
      sampleRate: resolvedSampleRate,
      channels: resolvedChannels,
      bitsPerSample: pcmMeta.bitsPerSample,
    });
    finalMimeType = 'audio/wav';
    const bytesPerSample = pcmMeta.bitsPerSample / 8;
    duration = round(rawBuffer.length / (resolvedSampleRate * resolvedChannels * bytesPerSample), 4);
  }

  if (atempoFilter) {
    finalBuffer = await applyAtempoToWavBuffer(finalBuffer, {
      atempoFilter,
      sampleRate: finalMimeType === 'audio/wav' ? resolvedSampleRate : undefined,
      channels: finalMimeType === 'audio/wav' ? resolvedChannels : undefined,
      signal,
    });
    finalMimeType = 'audio/wav';
    const spedWavMeta = parseWavHeader(finalBuffer);
    if (spedWavMeta) {
      resolvedSampleRate = spedWavMeta.sampleRate || resolvedSampleRate;
      resolvedChannels = spedWavMeta.channels || resolvedChannels;
      duration = spedWavMeta.duration;
    } else {
      duration = 0;
    }
  }

  let resolvedFile = null;
  if (outputFile) {
    resolvedFile = resolve(outputFile);
    await mkdir(dirname(resolvedFile), { recursive: true });
    await writeFile(resolvedFile, finalBuffer);
    if (duration <= 0) {
      const probed = await probeAudio(resolvedFile).catch(() => null);
      if (probed?.hasAudio) {
        duration = probed.duration;
        resolvedSampleRate = probed.sampleRate || resolvedSampleRate;
        resolvedChannels = probed.channels || resolvedChannels;
      }
    }
  }

  return {
    provider: 'gemini',
    model,
    voice,
    language: languageCode ?? 'en-US',
    speed: clampedSpeed,
    file: resolvedFile,
    mimeType: finalMimeType,
    sampleRate: resolvedSampleRate,
    channels: resolvedChannels,
    duration,
    bytes: finalBuffer.length,
    buffer: finalBuffer,
  };
}

const KOKORO_PYTHON_SCRIPT = [
  'import sys, wave, numpy as np',
  'from kokoro import KPipeline',
  'text, out_path, voice, lang_code, speed = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])',
  'pipeline = KPipeline(lang_code=lang_code)',
  'chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=speed)]',
  'if not chunks:',
  '    raise RuntimeError("Kokoro produced no audio samples")',
  'samples = np.concatenate([np.asarray(c, dtype=np.float32) for c in chunks])',
  'pcm = np.clip(samples, -1.0, 1.0)',
  'pcm16 = (pcm * 32767.0).astype(np.int16)',
  'with wave.open(out_path, "wb") as wf:',
  '    wf.setnchannels(1)',
  '    wf.setsampwidth(2)',
  '    wf.setframerate(24000)',
  '    wf.writeframes(pcm16.tobytes())',
].join('\n');

async function defaultKokoroRunner({
  text,
  outputFile,
  voice,
  language,
  speed,
  executable,
  python = 'python3',
  env = process.env,
  timeoutMs = 120000,
}) {
  const langCode = resolveKokoroLangCode(language);
  const explicitBin = executable ?? env.SCREEN_KIT_KOKORO_BIN;
  const cliCommand = explicitBin ?? 'kokoro-tts';

  // 1. Try local kokoro-tts CLI if present
  try {
    await exec(
      cliCommand,
      [`--text=${text}`, '--voice', voice, '--lang', langCode, '--speed', String(speed), '--output', outputFile],
      { timeout: timeoutMs, maxBuffer: 10e6, env }
    );
    return { runtime: cliCommand };
  } catch (cliError) {
    if (explicitBin) {
      throw Error(
        `Kokoro CLI '${cliCommand}' failed: ${cliError.stderr?.trim() || cliError.message}`
      );
    }
  }

  // 2. Fall back to local Python kokoro runtime
  try {
    await exec(
      python,
      ['-c', KOKORO_PYTHON_SCRIPT, text, outputFile, voice, langCode, String(speed)],
      { timeout: timeoutMs, maxBuffer: 10e6, env }
    );
    return { runtime: `${python}:kokoro` };
  } catch (pyError) {
    const detail = (pyError?.stderr || pyError?.message || '').trim();
    const missing =
      pyError?.code === 'ENOENT' || /No module named ['"]?kokoro/i.test(detail);
    if (missing) {
      throw Error(
        'Kokoro offline TTS runtime is not installed. Install it locally with `pip install kokoro numpy` (or install the `kokoro-tts` CLI), or use provider="gemini" with GEMINI_API_KEY.'
      );
    }
    throw Error(`Kokoro Python TTS failed: ${detail.slice(0, 400)}`);
  }
}

/**
 * Offline fallback TTS provider: local Kokoro CLI or Python runtime (with injectable `runner` for tests).
 */
export async function synthesizeWithKokoro({
  text,
  outputFile,
  voice = DEFAULT_KOKORO_VOICE,
  language = 'en-US',
  speed = DEFAULT_SPEECH_SPEED,
  executable,
  python = 'python3',
  runner,
  env = process.env,
  timeoutMs = 120000,
} = {}) {
  if (!isNonEmptyString(text)) {
    throw Error('synthesizeWithKokoro requires non-empty text');
  }
  if (!isNonEmptyString(outputFile)) {
    throw Error('synthesizeWithKokoro requires an outputFile path');
  }
  if (!isFiniteNumber(speed) || speed <= 0 || speed > 4) {
    throw Error('Kokoro speed must be a finite number in (0, 4]');
  }

  const resolvedFile = resolve(outputFile);
  await mkdir(dirname(resolvedFile), { recursive: true });

  const runResult =
    typeof runner === 'function'
      ? await runner({ text: text.trim(), outputFile: resolvedFile, voice, language, speed })
      : await defaultKokoroRunner({
          text: text.trim(),
          outputFile: resolvedFile,
          voice,
          language,
          speed,
          executable,
          python,
          env,
          timeoutMs,
        });

  if (runResult?.buffer && Buffer.isBuffer(runResult.buffer)) {
    await writeFile(resolvedFile, runResult.buffer);
  }

  await access(resolvedFile);
  const bytes = await readFile(resolvedFile);
  const wavMeta = parseWavHeader(bytes);
  let duration = wavMeta?.duration ?? 0;
  let sampleRate = wavMeta?.sampleRate ?? 24000;
  let channels = wavMeta?.channels ?? 1;

  if (duration <= 0) {
    const probed = await probeAudio(resolvedFile);
    if (!probed.hasAudio || !(probed.duration > 0)) {
      throw Error(`Kokoro output (${resolvedFile}) does not contain a valid audio stream`);
    }
    duration = probed.duration;
    sampleRate = probed.sampleRate || sampleRate;
    channels = probed.channels || channels;
  }

  return {
    provider: 'kokoro',
    voice,
    language: normalizeLanguageCode(language),
    speed,
    file: resolvedFile,
    mimeType: 'audio/wav',
    sampleRate,
    channels,
    duration,
    bytes: bytes.length,
    ...(Array.isArray(runResult?.wordTimings) ? { wordTimings: runResult.wordTimings } : {}),
  };
}

/**
 * Unified opt-in speech synthesis dispatcher across supported providers (`gemini` | `kokoro`).
 */
export async function synthesizeSpeech(options = {}) {
  const provider = options.provider ?? 'gemini';
  if (provider === 'gemini') {
    return synthesizeWithGemini(options);
  }
  if (provider === 'kokoro') {
    return synthesizeWithKokoro(options);
  }
  throw Error(`Unsupported TTS provider: ${String(provider)} (expected one of ${TTS_PROVIDERS.join(', ')})`);
}

/**
 * Compute step duration enforcing `max(actionDuration, leadIn + speechDuration + leadOut)`
 * per `docs/SPEC.md` (default lead-in `0.2 s`, lead-out `0.4 s`).
 * When `speechDuration` is 0 (silent step), returns `actionDuration`.
 */
export function computeStepDuration({
  actionDuration = 0,
  speechDuration = 0,
  leadIn = DEFAULT_STEP_LEAD_IN,
  leadOut = DEFAULT_STEP_LEAD_OUT,
} = {}) {
  if (!isFiniteNumber(actionDuration) || actionDuration < 0) {
    throw Error('actionDuration must be a non-negative finite number');
  }
  if (!isFiniteNumber(speechDuration) || speechDuration < 0) {
    throw Error('speechDuration must be a non-negative finite number');
  }
  if (!isFiniteNumber(leadIn) || leadIn < 0) {
    throw Error('leadIn must be a non-negative finite number');
  }
  if (!isFiniteNumber(leadOut) || leadOut < 0) {
    throw Error('leadOut must be a non-negative finite number');
  }

  const speechWindow = speechDuration > 0 ? leadIn + speechDuration + leadOut : 0;
  return round(Math.max(actionDuration, speechWindow), 4);
}

function estimateWordWeight(word) {
  const cleaned = word.toLowerCase().replace(/[^a-z\u0400-\u04ff0-9]/gi, '');
  const latinSyllables = (cleaned.match(/[aeiouy]+/gi) ?? []).length;
  const cyrillicSyllables = (cleaned.match(/[аеёиоуыэюя]+/gi) ?? []).length;
  const syllables = Math.max(1, latinSyllables + cyrillicSyllables);
  const charFactor = Math.max(1, cleaned.length) * 0.35;
  let pauseWeight = 0;
  if (/[.!?…]$/.test(word)) pauseWeight = 1.6;
  else if (/[,;:—–-]$/.test(word)) pauseWeight = 0.8;
  return syllables + charFactor + pauseWeight;
}

function normalizeRawWordTiming(entry) {
  if (!isObject(entry)) return null;
  const word = typeof entry.word === 'string'
    ? entry.word
    : typeof entry.text === 'string'
      ? entry.text
      : '';
  const start = isFiniteNumber(entry.start)
    ? entry.start
    : isFiniteNumber(entry.startMs)
      ? entry.startMs / 1000
      : isFiniteNumber(entry.start_ms)
        ? entry.start_ms / 1000
        : null;
  const end = isFiniteNumber(entry.end)
    ? entry.end
    : isFiniteNumber(entry.endMs)
      ? entry.endMs / 1000
      : isFiniteNumber(entry.end_ms)
        ? entry.end_ms / 1000
        : null;
  if (start === null || end === null) return null;
  return { word: word.trim(), start, end: Math.max(start, end) };
}

function cleanAlignToken(word) {
  return String(word ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function scoreAlignPair(scriptClean, recClean) {
  if (!scriptClean || !recClean) return 0;
  if (scriptClean === recClean) return 6;
  if (
    scriptClean.length >= 2 &&
    recClean.length >= 2 &&
    (scriptClean.startsWith(recClean) || recClean.startsWith(scriptClean))
  ) {
    return 3;
  }
  if (
    scriptClean.length >= 3 &&
    recClean.length >= 3 &&
    (scriptClean.includes(recClean) || recClean.includes(scriptClean))
  ) {
    return 2;
  }
  return -1;
}

function mapExternalTimingsToScript(tokens, normalizedExternal, startOffset, maxEnd) {
  const n = tokens.length;
  const m = normalizedExternal.length;
  const allWordsBlank = normalizedExternal.every((item) => !item.word);

  if (n === m && allWordsBlank) {
    return tokens.map((token, i) => ({
      token,
      rawStart: startOffset + normalizedExternal[i].start,
      rawEnd: startOffset + normalizedExternal[i].end,
    }));
  }

  const sClean = tokens.map(cleanAlignToken);
  const rClean = normalizedExternal.map((item) => cleanAlignToken(item.word));
  const gapPenalty = -1.5;

  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-Infinity));
  const back = Array.from({ length: n + 1 }, () => new Int32Array(m + 1).fill(0));
  // Op codes: 1 = (i-1, j-1), 2 = (i-1, j) script gap, 3 = (i, j-1) rec gap, 4 = (i-1, j-2) 1-to-2 compound, 5 = (i-2, j-1) 2-to-1 compound
  dp[0][0] = 0;
  for (let i = 1; i <= n; i += 1) {
    dp[i][0] = i * gapPenalty;
    back[i][0] = 2;
  }
  for (let j = 1; j <= m; j += 1) {
    dp[0][j] = j * gapPenalty;
    back[0][j] = 3;
  }

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      let best = dp[i - 1][j - 1] + scoreAlignPair(sClean[i - 1], rClean[j - 1]);
      let op = 1;

      const skipScript = dp[i - 1][j] + gapPenalty;
      if (skipScript > best) {
        best = skipScript;
        op = 2;
      }

      const skipRec = dp[i][j - 1] + gapPenalty;
      if (skipRec > best) {
        best = skipRec;
        op = 3;
      }

      if (
        j >= 2 &&
        sClean[i - 1] &&
        rClean[j - 2] &&
        rClean[j - 1] &&
        sClean[i - 1] === rClean[j - 2] + rClean[j - 1]
      ) {
        const compound12 = dp[i - 1][j - 2] + 8;
        if (compound12 >= best) {
          best = compound12;
          op = 4;
        }
      }

      if (
        i >= 2 &&
        rClean[j - 1] &&
        sClean[i - 2] &&
        sClean[i - 1] &&
        sClean[i - 2] + sClean[i - 1] === rClean[j - 1]
      ) {
        const compound21 = dp[i - 2][j - 1] + 8;
        if (compound21 >= best) {
          best = compound21;
          op = 5;
        }
      }

      dp[i][j] = best;
      back[i][j] = op;
    }
  }

  // Backtrack anchors: each anchor maps script range [sFrom..sTo] to recognized range [rFrom..rTo]
  const anchors = [];
  let ci = n;
  let cj = m;
  while (ci > 0 || cj > 0) {
    const op = back[ci][cj];
    if (op === 4) {
      anchors.push({ sFrom: ci - 1, sTo: ci - 1, rFrom: cj - 2, rTo: cj - 1 });
      ci -= 1;
      cj -= 2;
    } else if (op === 5) {
      anchors.push({ sFrom: ci - 2, sTo: ci - 1, rFrom: cj - 1, rTo: cj - 1 });
      ci -= 2;
      cj -= 1;
    } else if (op === 1) {
      const pairScore = scoreAlignPair(sClean[ci - 1], rClean[cj - 1]);
      if (pairScore > 0 || n === m) {
        anchors.push({ sFrom: ci - 1, sTo: ci - 1, rFrom: cj - 1, rTo: cj - 1 });
      }
      ci -= 1;
      cj -= 1;
    } else if (op === 2) {
      ci -= 1;
    } else {
      cj -= 1;
    }
  }
  anchors.reverse();

  const rawMapped = new Array(n).fill(null);

  const assignProportionalSpan = (sStart, sEnd, winStart, winEnd) => {
    const count = sEnd - sStart + 1;
    if (count <= 0) return;
    const span = Math.max(0, winEnd - winStart);
    const sliceWeights = [];
    let wTotal = 0;
    for (let k = sStart; k <= sEnd; k += 1) {
      const w = estimateWordWeight(tokens[k]);
      sliceWeights.push(w);
      wTotal += w;
    }
    let acc = 0;
    for (let idx = 0; idx < count; idx += 1) {
      const st = winStart + (wTotal > 0 ? (acc / wTotal) * span : 0);
      acc += sliceWeights[idx];
      const en = idx === count - 1 ? winEnd : winStart + (wTotal > 0 ? (acc / wTotal) * span : 0);
      rawMapped[sStart + idx] = {
        token: tokens[sStart + idx],
        rawStart: st,
        rawEnd: Math.max(st, en),
      };
    }
  };

  let prevS = -1;
  let prevR = -1;
  let prevTimeEnd = startOffset + Math.max(0, normalizedExternal[0].start);

  for (const anchor of anchors) {
    if (anchor.sFrom > prevS + 1) {
      const gapRStart = prevR + 1;
      const gapREnd = anchor.rFrom - 1;
      const winStart = gapRStart <= gapREnd
        ? startOffset + normalizedExternal[gapRStart].start
        : prevTimeEnd;
      const winEnd = gapRStart <= gapREnd
        ? startOffset + normalizedExternal[gapREnd].end
        : Math.max(winStart, startOffset + normalizedExternal[anchor.rFrom].start);
      assignProportionalSpan(prevS + 1, anchor.sFrom - 1, winStart, winEnd);
    }

    const anchorWinStart = startOffset + normalizedExternal[anchor.rFrom].start;
    const anchorWinEnd = startOffset + normalizedExternal[anchor.rTo].end;
    assignProportionalSpan(anchor.sFrom, anchor.sTo, anchorWinStart, anchorWinEnd);

    prevS = anchor.sTo;
    prevR = anchor.rTo;
    prevTimeEnd = anchorWinEnd;
  }

  if (prevS < n - 1) {
    const gapRStart = prevR + 1;
    const gapREnd = m - 1;
    const winStart = prevS === -1
      ? startOffset + normalizedExternal[0].start
      : gapRStart <= gapREnd
        ? startOffset + normalizedExternal[gapRStart].start
        : prevTimeEnd;
    const winEnd = gapRStart <= gapREnd
      ? startOffset + normalizedExternal[gapREnd].end
      : maxEnd;
    assignProportionalSpan(prevS + 1, n - 1, winStart, Math.max(winStart, winEnd));
  }

  return rawMapped;
}

/**
 * Align known script text to monotonic word-level timestamps.
 * Uses provided forced-alignment `wordTimings` (e.g. Whisper/Gemini/provider alignment) when present,
 * preserving exact script spelling/punctuation via sequence alignment, and falling back to
 * deterministic proportional syllable/character weighting.
 */
export function alignWords({
  text,
  duration,
  startOffset = 0,
  wordTimings,
} = {}) {
  if (typeof text !== 'string') {
    throw Error('alignWords requires text to be a string');
  }
  if (!isFiniteNumber(startOffset) || startOffset < 0) {
    throw Error('alignWords startOffset must be a non-negative finite number');
  }

  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const normalizedExternal = Array.isArray(wordTimings)
    ? wordTimings.map(normalizeRawWordTiming).filter(Boolean)
    : [];

  if (normalizedExternal.length > 0) {
    const inferredDuration = isFiniteNumber(duration) && duration > 0
      ? duration
      : Math.max(0.01, normalizedExternal[normalizedExternal.length - 1].end);
    const maxEnd = startOffset + inferredDuration;
    const mapped = mapExternalTimingsToScript(tokens, normalizedExternal, startOffset, maxEnd);

    const aligned = [];
    let cursorTime = startOffset;

    for (let i = 0; i < tokens.length; i += 1) {
      const entry = mapped[i];
      const clampedStart = Math.max(cursorTime, Math.min(entry.rawStart, maxEnd));
      const clampedEnd = Math.max(clampedStart, Math.min(entry.rawEnd, maxEnd));
      aligned.push({
        index: i,
        word: tokens[i],
        start: round(clampedStart, 4),
        end: round(clampedEnd, 4),
        method: 'forced',
      });
      cursorTime = clampedEnd;
    }

    return aligned;
  }

  if (!isFiniteNumber(duration) || duration <= 0) {
    throw Error('alignWords requires a positive duration when wordTimings are not provided');
  }

  const weights = tokens.map(estimateWordWeight);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const result = [];
  let accum = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const start = startOffset + (accum / totalWeight) * duration;
    accum += weights[i];
    const end = i === tokens.length - 1
      ? startOffset + duration
      : startOffset + (accum / totalWeight) * duration;
    result.push({
      index: i,
      word: tokens[i],
      start: round(start, 4),
      end: round(Math.max(start, end), 4),
      method: 'proportional',
    });
  }

  return result;
}

function inferWhisperKind(binaryPath) {
  const base = basename(String(binaryPath)).toLowerCase();
  if (base.includes('mlx_whisper') || base.includes('mlx-whisper')) return 'mlx-whisper';
  return 'whisper-cpp';
}

async function isExecutableFile(candidatePath) {
  try {
    await access(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a local Whisper forced-alignment CLI (`mlx_whisper` or `whisper-cli` / `whisper-cpp`).
 * Uses filesystem permission checks only (zero shell or network calls).
 */
export async function detectLocalWhisper({ executable, env = process.env } = {}) {
  if (executable === false || executable === null) return null;
  const envOverride = env?.SCREEN_KIT_WHISPER_BIN;
  if (executable === undefined && typeof envOverride === 'string') {
    const trimmedEnv = envOverride.trim();
    if (!trimmedEnv || trimmedEnv === 'none' || trimmedEnv === '0' || trimmedEnv === 'false') {
      return null;
    }
    executable = trimmedEnv;
  }

  const rawPath = typeof env?.PATH === 'string' ? env.PATH : '';
  const pathDirs = rawPath.split(delimiter).map((d) => d.trim()).filter(Boolean);
  if (env === process.env) {
    const extraDirs = [
      join(homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    for (const dir of extraDirs) {
      if (!pathDirs.includes(dir)) pathDirs.push(dir);
    }
  }

  if (isNonEmptyString(executable)) {
    const trimmed = executable.trim();
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      const resolved = resolve(trimmed);
      if (await isExecutableFile(resolved)) {
        return { kind: inferWhisperKind(resolved), executable: resolved };
      }
      throw Error(`Configured Whisper executable is not found or not executable: ${resolved}`);
    }
    for (const dir of pathDirs) {
      const candidate = join(dir, trimmed);
      if (await isExecutableFile(candidate)) {
        return { kind: inferWhisperKind(candidate), executable: candidate };
      }
    }
    throw Error(`Configured Whisper executable '${trimmed}' was not found in PATH`);
  }

  const candidates = ['mlx_whisper', 'whisper-cli', 'whisper-cpp'];
  for (const name of candidates) {
    for (const dir of pathDirs) {
      const candidate = join(dir, name);
      if (await isExecutableFile(candidate)) {
        return { kind: inferWhisperKind(candidate), executable: candidate };
      }
    }
  }
  return null;
}

function parseTimestampStringToSeconds(ts) {
  if (typeof ts !== 'string') return null;
  const m = ts.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function extractWhisperCppEntryTiming(entry) {
  if (!isObject(entry)) return null;
  if (isObject(entry.offsets) && isFiniteNumber(entry.offsets.from) && isFiniteNumber(entry.offsets.to)) {
    return {
      start: entry.offsets.from / 1000,
      end: Math.max(entry.offsets.from / 1000, entry.offsets.to / 1000),
    };
  }
  if (isObject(entry.timestamps)) {
    const fromSec = parseTimestampStringToSeconds(entry.timestamps.from);
    const toSec = parseTimestampStringToSeconds(entry.timestamps.to);
    if (fromSec !== null && toSec !== null) {
      return { start: fromSec, end: Math.max(fromSec, toSec) };
    }
  }
  if (isFiniteNumber(entry.t0) && isFiniteNumber(entry.t1)) {
    return { start: entry.t0 * 0.01, end: Math.max(entry.t0 * 0.01, entry.t1 * 0.01) };
  }
  return null;
}

/**
 * Parse word-level timestamps from `mlx_whisper`, `openai-whisper`, or `whisper.cpp` JSON output.
 */
export function parseWhisperWordTimings(input) {
  const payload = typeof input === 'string' ? JSON.parse(input) : input;
  if (Array.isArray(payload)) {
    return payload.map(normalizeRawWordTiming).filter((w) => w && w.word.length > 0);
  }
  if (!isObject(payload)) return [];

  if (Array.isArray(payload.words) && payload.words.length > 0) {
    return payload.words.map(normalizeRawWordTiming).filter((w) => w && w.word.length > 0);
  }

  // mlx_whisper / openai-whisper: segments[].words[]
  if (Array.isArray(payload.segments) && payload.segments.length > 0) {
    const words = [];
    for (const seg of payload.segments) {
      if (!isObject(seg)) continue;
      if (Array.isArray(seg.words) && seg.words.length > 0) {
        for (const rawW of seg.words) {
          const parsed = normalizeRawWordTiming(rawW);
          if (parsed && parsed.word.length > 0) words.push(parsed);
        }
      } else if (typeof seg.text === 'string' && isFiniteNumber(seg.start) && isFiniteNumber(seg.end)) {
        const segWords = seg.text.trim().split(/\s+/).filter(Boolean);
        const span = Math.max(0, seg.end - seg.start);
        segWords.forEach((tok, idx) => {
          const st = seg.start + (span * idx) / segWords.length;
          const en = seg.start + (span * (idx + 1)) / segWords.length;
          words.push({ word: tok, start: st, end: en });
        });
      }
    }
    return words;
  }

  // whisper.cpp (-ojf / -oj): transcription[] with optional subword tokens[]
  if (Array.isArray(payload.transcription) && payload.transcription.length > 0) {
    const words = [];
    for (const item of payload.transcription) {
      if (!isObject(item)) continue;
      if (Array.isArray(item.tokens) && item.tokens.length > 0) {
        for (const tok of item.tokens) {
          if (!isObject(tok) || typeof tok.text !== 'string') continue;
          const rawText = tok.text;
          if (/^\[_.*_\]$/.test(rawText.trim()) || rawText.length === 0) continue;
          const timing = extractWhisperCppEntryTiming(tok);
          if (!timing) continue;
          const startsNewWord = /^\s/.test(rawText) || words.length === 0;
          const trimmed = rawText.trim();
          if (!trimmed) continue;
          const isPurePunct = !/[\p{L}\p{N}]/u.test(trimmed);
          if (!startsNewWord || isPurePunct) {
            if (words.length > 0) {
              const prev = words[words.length - 1];
              prev.word += trimmed;
              prev.end = Math.max(prev.end, timing.end);
              continue;
            }
          }
          words.push({ word: trimmed, start: timing.start, end: timing.end });
        }
      } else if (typeof item.text === 'string' && item.text.trim().length > 0) {
        const timing = extractWhisperCppEntryTiming(item);
        if (!timing) continue;
        const tokensInSeg = item.text.trim().split(/\s+/).filter(Boolean);
        const span = Math.max(0, timing.end - timing.start);
        tokensInSeg.forEach((w, idx) => {
          words.push({
            word: w,
            start: timing.start + (span * idx) / tokensInSeg.length,
            end: timing.start + (span * (idx + 1)) / tokensInSeg.length,
          });
        });
      }
    }
    return words;
  }

  return [];
}

function normalizeWhisperLang(language) {
  if (!isNonEmptyString(language)) return 'en';
  return language.trim().toLowerCase().split(/[-_]/)[0] || 'en';
}

/**
 * Local forced word alignment via `mlx_whisper` or `whisper-cli` / `whisper.cpp`
 * (argument arrays only, never a shell) mapped onto exact script words.
 */
export async function alignWithWhisper({
  audioFile,
  text,
  duration,
  startOffset = 0,
  language = 'en',
  executable,
  model,
  runner,
  env = process.env,
  timeoutMs = 120000,
} = {}) {
  if (typeof text !== 'string') {
    throw Error('alignWithWhisper requires text to be a string');
  }
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { aligner: 'whisper', backend: 'whisper', duration: duration ?? 0, words: [] };
  }

  const resolvedAudio = isNonEmptyString(audioFile) ? resolve(audioFile) : null;
  let backend = 'custom-runner';
  let rawPayload = null;

  if (typeof runner === 'function') {
    const out = await runner({
      audioFile: resolvedAudio,
      text: text.trim(),
      language: normalizeWhisperLang(language),
      executable,
      model,
    });
    if (isObject(out) && isNonEmptyString(out.jsonFile)) {
      rawPayload = JSON.parse(await readFile(resolve(out.jsonFile), 'utf8'));
    } else {
      rawPayload = out;
    }
    if (isObject(out) && isNonEmptyString(out.backend)) backend = out.backend;
  } else {
    if (!resolvedAudio) {
      throw Error('alignWithWhisper requires an audioFile path');
    }
    await access(resolvedAudio);
    const detected = await detectLocalWhisper({ executable, env });
    if (!detected) {
      throw Error(
        'Local Whisper CLI not found. Install `mlx-whisper` (`pip install mlx-whisper`) or `whisper-cpp` (`brew install whisper-cpp`), or use aligner="gemini" or "proportional".'
      );
    }
    backend = detected.kind;
    const whisperLang = normalizeWhisperLang(language);
    const tempDir = await mkdtemp(join(tmpdir(), 'screen-kit-whisper-'));
    try {
      const outBase = join(tempDir, 'align');
      const outJson = `${outBase}.json`;
      if (detected.kind === 'mlx-whisper') {
        const args = [
          resolvedAudio,
          '--model',
          model ?? env.MLX_WHISPER_MODEL ?? DEFAULT_MLX_WHISPER_MODEL,
          '--output-dir',
          tempDir,
          '--output-name',
          'align',
          '--output-format',
          'json',
          '--word-timestamps',
          'True',
          '--verbose',
          'False',
          '--language',
          whisperLang,
          '--initial-prompt',
          text.trim(),
        ];
        await exec(detected.executable, args, { timeout: timeoutMs, maxBuffer: 20e6, env });
      } else {
        const resolvedModel = model ?? env.WHISPER_CPP_MODEL;
        const args = [
          ...(isNonEmptyString(resolvedModel) ? ['-m', resolve(resolvedModel)] : []),
          '-f',
          resolvedAudio,
          '-l',
          whisperLang,
          '-ojf',
          '-of',
          outBase,
          '--prompt',
          text.trim(),
        ];
        await exec(detected.executable, args, { timeout: timeoutMs, maxBuffer: 20e6, env });
      }
      rawPayload = JSON.parse(await readFile(outJson, 'utf8'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const rawTimings = parseWhisperWordTimings(rawPayload);
  let effectiveDuration = isFiniteNumber(duration) && duration > 0 ? duration : 0;
  if (!(effectiveDuration > 0) && resolvedAudio) {
    const probed = await probeAudio(resolvedAudio).catch(() => null);
    if (probed?.hasAudio && probed.duration > 0) effectiveDuration = probed.duration;
  }
  if (!(effectiveDuration > 0) && rawTimings.length > 0) {
    effectiveDuration = Math.max(0.05, rawTimings[rawTimings.length - 1].end);
  }
  if (!(effectiveDuration > 0)) effectiveDuration = 1.0;

  const words = rawTimings.length > 0
    ? alignWords({
        text,
        duration: effectiveDuration,
        startOffset,
        wordTimings: rawTimings,
      })
    : alignWords({
        text,
        duration: effectiveDuration,
        startOffset,
      });

  return {
    aligner: 'whisper',
    backend,
    duration: round(effectiveDuration, 4),
    words,
    rawWordCount: rawTimings.length,
  };
}

function inferAudioMimeType(filePath = '') {
  const ext = extname(String(filePath)).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg';
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') return 'audio/mp4';
  if (ext === '.flac') return 'audio/flac';
  return 'audio/wav';
}

function stripJsonCodeFence(rawText = '') {
  const trimmed = String(rawText).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Zero-install cloud word alignment using Gemini native audio understanding (`x-goog-api-key` header).
 * Makes zero network calls when credentials are absent.
 */
export async function alignWithGemini({
  audioFile,
  audioBuffer,
  mimeType,
  text,
  duration,
  startOffset = 0,
  language = 'en',
  apiKey,
  model = DEFAULT_GEMINI_ALIGN_MODEL,
  fetchImpl = globalThis.fetch,
  env = process.env,
  signal,
} = {}) {
  if (typeof text !== 'string') {
    throw Error('alignWithGemini requires text to be a string');
  }
  const resolvedKey = apiKey ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  if (!isNonEmptyString(resolvedKey)) {
    throw Error(
      'Gemini audio alignment requires API credentials: set GEMINI_API_KEY (or GOOGLE_API_KEY), pass apiKey explicitly, or use aligner="whisper" or "proportional".'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw Error('fetch is not available for Gemini audio alignment');
  }

  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { aligner: 'gemini', backend: model, duration: duration ?? 0, words: [] };
  }

  let bytes = null;
  let resolvedAudio = null;
  if (Buffer.isBuffer(audioBuffer)) {
    bytes = audioBuffer;
  } else if (isNonEmptyString(audioFile)) {
    resolvedAudio = resolve(audioFile);
    bytes = await readFile(resolvedAudio);
  } else {
    throw Error('alignWithGemini requires audioFile or audioBuffer');
  }

  let effectiveDuration = isFiniteNumber(duration) && duration > 0 ? duration : 0;
  if (!(effectiveDuration > 0)) {
    const wavMeta = parseWavHeader(bytes);
    if (wavMeta?.duration > 0) effectiveDuration = wavMeta.duration;
    else if (resolvedAudio) {
      const probed = await probeAudio(resolvedAudio).catch(() => null);
      if (probed?.hasAudio && probed.duration > 0) effectiveDuration = probed.duration;
    }
  }

  const resolvedMime = mimeType ?? inferAudioMimeType(resolvedAudio ?? 'audio.wav');
  const prompt = [
    `Align the attached spoken audio (${normalizeLanguageCode(language)}${effectiveDuration > 0 ? `, duration ${round(effectiveDuration, 3)}s` : ''}) to the exact script words below.`,
    `Return ONLY valid JSON of shape: { "words": [{ "word": string, "start": number, "end": number }] } where start and end are timestamps in seconds from the beginning of the audio clip.`,
    `Exact script (${tokens.length} words): ${JSON.stringify(tokens)}`,
  ].join('\n');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': resolvedKey.trim(),
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: resolvedMime,
                data: bytes.toString('base64'),
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
      },
    }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw Error(`Gemini audio alignment API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const rawText = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? '')
    .join('\n')
    .trim();

  if (!rawText) {
    throw Error('Gemini audio alignment returned an empty response');
  }

  const parsed = JSON.parse(stripJsonCodeFence(rawText));
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.words)
      ? parsed.words
      : Array.isArray(parsed?.segments)
        ? parsed.segments
        : [];
  let rawTimings = rawList.map(normalizeRawWordTiming).filter(Boolean);

  if (effectiveDuration > 0 && rawTimings.length > 0) {
    const maxRawEnd = Math.max(...rawTimings.map((t) => t.end));
    if (maxRawEnd > effectiveDuration * 2) {
      const rescaledMs = rawTimings.map((t) => ({
        ...t,
        start: t.start / 1000,
        end: t.end / 1000,
      }));
      const maxRescaledEnd = Math.max(...rescaledMs.map((t) => t.end));
      if (maxRescaledEnd > 0 && maxRescaledEnd <= effectiveDuration * 2) {
        rawTimings = rescaledMs;
      } else {
        rawTimings = [];
      }
    }
  }

  if (!(effectiveDuration > 0) && rawTimings.length > 0) {
    effectiveDuration = Math.max(0.05, rawTimings[rawTimings.length - 1].end);
  }
  if (!(effectiveDuration > 0)) effectiveDuration = 1.0;

  const words = rawTimings.length > 0
    ? alignWords({
        text,
        duration: effectiveDuration,
        startOffset,
        wordTimings: rawTimings,
      })
    : alignWords({
        text,
        duration: effectiveDuration,
        startOffset,
      });

  return {
    aligner: 'gemini',
    backend: model,
    duration: round(effectiveDuration, 4),
    words,
    rawWordCount: rawTimings.length,
  };
}

/**
 * Pluggable word-level audio alignment dispatcher (`auto` | `whisper` | `gemini` | `proportional`).
 * - `whisper`: local `mlx_whisper` or `whisper-cli`/`whisper.cpp` (argument arrays only)
 * - `gemini`: zero-install Gemini audio understanding (`x-goog-api-key` header)
 * - `proportional`: deterministic syllable/character fallback
 * - `auto`: tries local `whisper` -> `gemini` (when API key is set) -> `proportional` fallback
 */
export async function alignAudioWords({
  audioFile,
  audioBuffer,
  mimeType,
  text,
  duration,
  startOffset = 0,
  aligner = 'auto',
  provider,
  allowCloudAuto = true,
  language = 'en',
  apiKey,
  fetchImpl,
  runner,
  executable,
  model,
  geminiModel,
  env = process.env,
  timeoutMs = 120000,
  signal,
} = {}) {
  if (!WORD_ALIGNERS.includes(aligner)) {
    throw Error(`Unsupported word aligner: ${String(aligner)} (expected one of ${WORD_ALIGNERS.join(', ')})`);
  }
  if (typeof text !== 'string') {
    throw Error('alignAudioWords requires text to be a string');
  }

  const resolveEffectiveDuration = async () => {
    if (isFiniteNumber(duration) && duration > 0) return duration;
    if (Buffer.isBuffer(audioBuffer)) {
      const wav = parseWavHeader(audioBuffer);
      if (wav?.duration > 0) return wav.duration;
    }
    if (isNonEmptyString(audioFile)) {
      const probed = await probeAudio(resolve(audioFile)).catch(() => null);
      if (probed?.hasAudio && probed.duration > 0) return probed.duration;
    }
    return 0;
  };

  if (aligner === 'proportional') {
    const effectiveDuration = await resolveEffectiveDuration();
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const words = tokens.length > 0
      ? alignWords({ text, duration: effectiveDuration, startOffset })
      : [];
    return {
      aligner: 'proportional',
      backend: 'proportional',
      duration: round(effectiveDuration, 4),
      words,
    };
  }

  if (aligner === 'whisper') {
    return alignWithWhisper({
      audioFile,
      text,
      duration,
      startOffset,
      language,
      executable,
      model,
      runner,
      env,
      timeoutMs,
    });
  }

  if (aligner === 'gemini') {
    return alignWithGemini({
      audioFile,
      audioBuffer,
      mimeType,
      text,
      duration,
      startOffset,
      language,
      apiKey,
      ...(model ? { model } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      env,
      signal,
    });
  }

  // aligner === 'auto'
  const canTryWhisper =
    typeof runner === 'function' ||
    (isNonEmptyString(audioFile) && Boolean(await detectLocalWhisper({ executable, env }).catch(() => null)));

  if (canTryWhisper) {
    try {
      const whisperRes = await alignWithWhisper({
        audioFile,
        text,
        duration,
        startOffset,
        language,
        executable,
        model,
        runner,
        env,
        timeoutMs,
      });
      if (whisperRes.words.length === 0 || whisperRes.rawWordCount > 0) {
        return whisperRes;
      }
    } catch {
      // Fall through to Gemini / proportional in auto mode
    }
  }

  const canUseCloudInAuto = allowCloudAuto !== false && provider !== 'kokoro';
  const resolvedKey = canUseCloudInAuto ? (apiKey ?? env?.GEMINI_API_KEY ?? env?.GOOGLE_API_KEY) : null;
  if (
    canUseCloudInAuto &&
    isNonEmptyString(resolvedKey) &&
    (Buffer.isBuffer(audioBuffer) || isNonEmptyString(audioFile))
  ) {
    const autoGeminiModel =
      geminiModel ??
      (isNonEmptyString(model) && !model.includes('/') && !model.includes('\\') && !model.endsWith('.bin')
        ? model
        : undefined);
    try {
      const geminiRes = await alignWithGemini({
        audioFile,
        audioBuffer,
        mimeType,
        text,
        duration,
        startOffset,
        language,
        apiKey: resolvedKey,
        ...(autoGeminiModel ? { model: autoGeminiModel } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
        env,
        signal,
      });
      if (geminiRes.words.length === 0 || geminiRes.rawWordCount > 0) {
        return geminiRes;
      }
    } catch {
      // Fall through to deterministic proportional alignment in auto mode
    }
  }

  const effectiveDuration = await resolveEffectiveDuration();
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const words = tokens.length > 0
    ? alignWords({ text, duration: effectiveDuration, startOffset })
    : [];
  return {
    aligner: 'proportional',
    backend: 'proportional',
    duration: round(effectiveDuration, 4),
    words,
  };
}

const BREAK_BEFORE_WORDS = new Set([
  'and', 'or', 'but', 'with', 'for', 'to', 'from', 'in', 'on', 'at', 'by', 'into', 'then', 'while', 'when',
  'и', 'или', 'но', 'чтобы', 'для', 'с', 'на', 'в', 'к', 'от', 'при',
]);

function splitLongToken(token, maxCharsPerLine) {
  if (token.length <= maxCharsPerLine) return [token];
  const parts = [];
  for (let i = 0; i < token.length; i += maxCharsPerLine) {
    parts.push(token.slice(i, i + maxCharsPerLine));
  }
  return parts;
}

/**
 * Wrap an array of word strings into 1 or 2 balanced lines, each `<= maxCharsPerLine`.
 * Returns `null` if the words cannot fit within `maxLines` lines.
 */
function wrapWordsIntoLines(words, maxLines, maxCharsPerLine) {
  const joined = words.join(' ');
  if (joined.length <= maxCharsPerLine) {
    return [joined];
  }
  if (maxLines < 2 || words.length < 2) {
    return null;
  }

  let bestSplit = null;
  let bestScore = Infinity;

  for (let split = 1; split < words.length; split += 1) {
    const line1 = words.slice(0, split).join(' ');
    const line2 = words.slice(split).join(' ');
    if (line1.length > maxCharsPerLine || line2.length > maxCharsPerLine) continue;

    let score = Math.abs(line1.length - line2.length);
    const prevWord = words[split - 1];
    const nextWord = words[split].toLowerCase().replace(/[^a-z\u0400-\u04ff]/gi, '');
    if (/[.,;:!?—–-]$/.test(prevWord)) score -= 8;
    if (BREAK_BEFORE_WORDS.has(nextWord)) score -= 4;

    if (score < bestScore) {
      bestScore = score;
      bestSplit = [line1, line2];
    }
  }

  return bestSplit;
}

function expandOversizedWords(words, maxCharsPerLine) {
  const expanded = [];
  for (const item of words) {
    const pieces = splitLongToken(item.word, maxCharsPerLine);
    if (pieces.length === 1) {
      expanded.push(item);
      continue;
    }
    const span = Math.max(0, item.end - item.start);
    pieces.forEach((piece, idx) => {
      const start = item.start + (span * idx) / pieces.length;
      const end = item.start + (span * (idx + 1)) / pieces.length;
      expanded.push({
        ...item,
        word: piece,
        start: round(start, 4),
        end: round(end, 4),
      });
    });
  }
  return expanded;
}

/**
 * Format aligned words (or text + duration) into Netflix-compliant caption cues:
 * - max 2 lines per cue, max 42 chars/line
 * - ~17–20 CPS reading speed target
 * - min duration 0.833 s (5/6 s), max duration 7.0 s
 * - clean balanced line breaks, monotonic non-overlapping timestamps
 */
export function formatNetflixCues({
  words,
  text,
  duration,
  startOffset = 0,
  stepEnd,
  wordTimings,
  maxLines = NETFLIX_CAPTION_RULES.maxLines,
  maxCharsPerLine = NETFLIX_CAPTION_RULES.maxCharsPerLine,
  targetCps = NETFLIX_CAPTION_RULES.targetCps,
  maxCps = NETFLIX_CAPTION_RULES.maxCps,
  minDuration = NETFLIX_CAPTION_RULES.minDuration,
  maxDuration = NETFLIX_CAPTION_RULES.maxDuration,
  minGap = NETFLIX_CAPTION_RULES.minGap,
  tail = NETFLIX_CAPTION_RULES.tail,
} = {}) {
  const rawWords = Array.isArray(words) && words.length > 0
    ? words.map((w, idx) => ({
        index: w.index ?? idx,
        word: String(w.word ?? w.text ?? '').trim(),
        start: Number(w.start),
        end: Number(w.end),
      })).filter((w) => w.word.length > 0)
    : isNonEmptyString(text)
      ? alignWords({ text, duration, startOffset, wordTimings })
      : [];

  if (rawWords.length === 0) return [];

  const safeWords = expandOversizedWords(rawWords, maxCharsPerLine);
  const lastWordEnd = safeWords[safeWords.length - 1].end;
  const boundaryEnd = isFiniteNumber(stepEnd) ? Math.max(stepEnd, lastWordEnd) : lastWordEnd + tail;

  const groups = [];
  let current = [];

  for (let i = 0; i < safeWords.length; i += 1) {
    const word = safeWords[i];
    const candidate = [...current, word];
    const candidateTokens = candidate.map((w) => w.word);
    const wrapped = wrapWordsIntoLines(candidateTokens, maxLines, maxCharsPerLine);
    const spanDuration = candidate[candidate.length - 1].end - candidate[0].start;
    const charCount = candidateTokens.join(' ').length;

    const exceedsLayout = wrapped === null;
    const exceedsDuration = current.length > 0 && spanDuration > maxDuration;
    const exceedsCharsBudget =
      current.length > 0 && charCount > Math.floor(maxDuration * targetCps);

    if (exceedsLayout || exceedsDuration || exceedsCharsBudget) {
      groups.push(current);
      current = [word];
    } else {
      current = candidate;
      // Prefer closing a cue cleanly at sentence boundaries if already reasonably full
      const endsSentence = /[.!?…]$/.test(word.word);
      const remaining = safeWords.length - 1 - i;
      if (endsSentence && remaining > 0 && (charCount >= Math.floor(maxCharsPerLine * 0.7) || spanDuration >= 2.2)) {
        groups.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) groups.push(current);

  const cues = groups.map((group) => {
    const tokens = group.map((w) => w.word);
    const lines = wrapWordsIntoLines(tokens, maxLines, maxCharsPerLine) ?? [tokens.join(' ').slice(0, maxCharsPerLine)];
    const cueText = lines.join('\n');
    const start = group[0].start;
    const end = Math.min(group[group.length - 1].end, start + maxDuration);
    return { start, end, text: cueText, lines, words: group };
  });

  // Apply reading-speed / minimum duration / tail adjustments without overlapping or crossing boundaryEnd.
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const next = cues[i + 1];
    const charCount = cue.text.replace(/\n/g, ' ').length;
    const minForCps = maxCps > 0 ? charCount / maxCps : 0;
    const desiredMin = Math.min(maxDuration, Math.max(minDuration, minForCps));

    if (i > 0) {
      const prevEnd = cues[i - 1].end;
      if (cue.start < prevEnd) {
        cue.start = prevEnd;
      }
    }

    const hardCeiling = next
      ? Math.max(cue.end, next.start - minGap)
      : Math.min(boundaryEnd, cue.start + maxDuration);

    let targetEnd = cue.end;
    if (!next && tail > 0) {
      targetEnd = Math.min(boundaryEnd, cue.end + tail, cue.start + maxDuration);
    }
    if (targetEnd - cue.start < desiredMin) {
      targetEnd = Math.min(hardCeiling, cue.start + desiredMin);
    }
    if (targetEnd - cue.start > maxDuration) {
      targetEnd = cue.start + maxDuration;
    }

    cue.end = Math.max(cue.start, targetEnd);
  }

  // Second pass: guarantee monotonic non-overlap and finalize metrics
  const finalized = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    let start = round(cue.start, 4);
    let end = round(cue.end, 4);
    if (i > 0 && start < finalized[i - 1].end) {
      start = finalized[i - 1].end;
    }
    if (end < start) end = start;
    const cueDuration = round(end - start, 4);
    const charCount = cue.text.replace(/\n/g, ' ').length;
    const cps = cueDuration > 0 ? round(charCount / cueDuration, 2) : 0;
    finalized.push({
      start,
      end,
      duration: cueDuration,
      text: cue.text,
      lines: cue.lines,
      cps,
      words: cue.words,
    });
  }

  return finalized;
}

function formatSubtitleTimestamp(seconds, msSeparator) {
  if (!isFiniteNumber(seconds) || seconds < 0) {
    throw Error(`Subtitle timestamp must be a non-negative finite number (received ${String(seconds)})`);
  }
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);

  return (
    `${String(hr).padStart(2, '0')}:` +
    `${String(min).padStart(2, '0')}:` +
    `${String(sec).padStart(2, '0')}` +
    `${msSeparator}${String(ms).padStart(3, '0')}`
  );
}

/**
 * Format caption cues as SubRip (`.srt`) text.
 */
export function formatSrt(cues = []) {
  if (!Array.isArray(cues)) throw Error('formatSrt requires an array of cues');
  const blocks = cues.map((cue, index) => {
    const start = formatSubtitleTimestamp(cue.start, ',');
    const end = formatSubtitleTimestamp(cue.end, ',');
    return `${index + 1}\n${start} --> ${end}\n${cue.text}`;
  });
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
}

/**
 * Format caption cues as WebVTT (`.vtt`) text.
 */
export function formatVtt(cues = [], { header = 'WEBVTT' } = {}) {
  if (!Array.isArray(cues)) throw Error('formatVtt requires an array of cues');
  const blocks = cues.map((cue) => {
    const start = formatSubtitleTimestamp(cue.start, '.');
    const end = formatSubtitleTimestamp(cue.end, '.');
    return `${start} --> ${end}\n${cue.text}`;
  });
  return blocks.length > 0 ? `${header}\n\n${blocks.join('\n\n')}\n` : `${header}\n`;
}

function resolveStepTextForLanguage(step, lang, primaryLanguage) {
  const source = step.narration ?? step.say ?? step.text;
  if (typeof source === 'string') {
    return lang === primaryLanguage ? source.trim() : '';
  }
  if (isObject(source)) {
    const direct = source[lang];
    if (typeof direct === 'string') return direct.trim();
    const short = lang.split(/[-_]/)[0];
    if (typeof source[short] === 'string') return source[short].trim();
  }
  return '';
}

function resolveStepAudioForLanguage(step, lang, primaryLanguage) {
  const source = step.audioFile ?? step.audio;
  if (typeof source === 'string') {
    return lang === primaryLanguage ? source : null;
  }
  if (isObject(source)) {
    return source[lang] ?? source[lang.split(/[-_]/)[0]] ?? null;
  }
  return null;
}

function resolveStepWordTimings(step, lang, primaryLanguage) {
  const source = step.wordTimings;
  if (Array.isArray(source)) {
    return lang === primaryLanguage ? source : null;
  }
  if (isObject(source)) {
    return source[lang] ?? source[lang.split(/[-_]/)[0]] ?? null;
  }
  return null;
}

/**
 * Synthesize (or load) per-step narration audio, compute step durations via
 * `max(actionDuration, leadIn + speechDuration + leadOut)`, align words, format Netflix
 * SRT/VTT captions per language, and populate `timeline.audio.tracks` and
 * `timeline.overlays.captions.tracks` (validated by `assertValidTimeline`).
 */
export async function buildNarrationTracks({
  steps = [],
  language = 'en',
  languages,
  provider = 'gemini',
  providerOptions = {},
  outDir,
  leadIn = DEFAULT_STEP_LEAD_IN,
  leadOut = DEFAULT_STEP_LEAD_OUT,
  captionRules = {},
  timeline,
  writeSubtitles = true,
  burnInCaptions = true,
  volume = 1,
} = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw Error('buildNarrationTracks requires a non-empty steps array');
  }

  const targetLanguages = Array.isArray(languages) && languages.length > 0
    ? [...new Set(languages.map((l) => String(l).trim()).filter(Boolean))]
    : [String(language).trim()];
  const primaryLanguage = targetLanguages[0];
  const resolvedOutDir = outDir ? resolve(outDir) : null;
  if (resolvedOutDir) {
    await mkdir(resolvedOutDir, { recursive: true });
  }

  const perLanguageStepData = new Map();
  for (const lang of targetLanguages) {
    perLanguageStepData.set(lang, []);
  }

  // 1. Synthesize or inspect audio per step per language first so step timing covers speech
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    for (const lang of targetLanguages) {
      const text = resolveStepTextForLanguage(step, lang, primaryLanguage);
      const existingAudio = resolveStepAudioForLanguage(step, lang, primaryLanguage);
      const explicitTimings = resolveStepWordTimings(step, lang, primaryLanguage);

      if (!text && !existingAudio) {
        perLanguageStepData.get(lang).push({ text: '', audioFile: null, speechDuration: 0, wordTimings: null });
        continue;
      }

      if (existingAudio) {
        const audioPath = resolve(existingAudio);
        const probed = await probeAudio(audioPath);
        if (!probed.hasAudio || !(probed.duration > 0)) {
          throw Error(`Step ${i} (${lang}) audio file has no valid audio stream: ${audioPath}`);
        }
        perLanguageStepData.get(lang).push({
          text,
          audioFile: audioPath,
          speechDuration: probed.duration,
          wordTimings: explicitTimings,
        });
      } else {
        const langSlug = lang.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        const stepSlug = String(i).padStart(3, '0');
        const audioOutputFile = resolvedOutDir
          ? join(resolvedOutDir, 'audio', `${langSlug}-step-${stepSlug}.wav`)
          : undefined;

        const langProviderOpts = isObject(providerOptions[lang])
          ? { ...providerOptions, ...providerOptions[lang] }
          : providerOptions;

        const synth = await synthesizeSpeech({
          ...langProviderOpts,
          provider,
          text,
          language: lang,
          outputFile: audioOutputFile,
        });

        perLanguageStepData.get(lang).push({
          text,
          audioFile: synth.file,
          speechDuration: synth.duration,
          wordTimings: explicitTimings ?? synth.wordTimings ?? null,
        });
      }
    }
  }

  // 2. Schedule step windows using `computeStepDuration`
  const scheduledSteps = [];
  let cursor = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const actionDuration = isFiniteNumber(step.actionDuration)
      ? step.actionDuration
      : isFiniteNumber(step.duration)
        ? step.duration
        : 0;
    const maxSpeechDuration = Math.max(
      0,
      ...targetLanguages.map((lang) => perLanguageStepData.get(lang)[i].speechDuration)
    );
    const stepStart = isFiniteNumber(step.start)
      ? step.start
      : isFiniteNumber(step.t)
        ? step.t
        : cursor;
    const stepDuration = computeStepDuration({
      actionDuration,
      speechDuration: maxSpeechDuration,
      leadIn,
      leadOut,
    });
    const stepEnd = round(stepStart + stepDuration, 4);
    scheduledSteps.push({
      index: Number.isInteger(step.index) ? step.index : i,
      label: isNonEmptyString(step.label) ? step.label.trim() : `step-${i}`,
      t: round(stepStart, 4),
      start: round(stepStart, 4),
      end: stepEnd,
      actionDuration: round(actionDuration, 4),
      speechDuration: round(maxSpeechDuration, 4),
      duration: stepDuration,
    });
    cursor = Math.max(cursor, stepEnd);
  }

  // 3. Build audio tracks, word alignments, Netflix cues, and SRT/VTT files per language
  const audioTracks = [];
  const captionTracks = [];
  const subtitles = {};
  const segments = [];

  for (const lang of targetLanguages) {
    const langCues = [];
    const langSteps = perLanguageStepData.get(lang);

    for (let i = 0; i < steps.length; i += 1) {
      const sched = scheduledSteps[i];
      const info = langSteps[i];
      if (!info.text && !info.audioFile) continue;

      const speechStart = round(sched.start + leadIn, 4);
      const speechEnd = round(speechStart + info.speechDuration, 4);

      if (info.audioFile) {
        audioTracks.push({
          id: `narration-${lang}-${String(sched.index).padStart(3, '0')}`,
          kind: 'narration',
          src: info.audioFile,
          start: speechStart,
          volume,
          language: lang,
          stepIndex: sched.index,
          duration: info.speechDuration,
        });
      }

      segments.push({
        language: lang,
        stepIndex: sched.index,
        label: sched.label,
        start: speechStart,
        end: speechEnd,
        duration: info.speechDuration,
        src: info.audioFile,
      });

      if (info.text && info.speechDuration > 0) {
        const alignedWords = alignWords({
          text: info.text,
          duration: info.speechDuration,
          startOffset: speechStart,
          wordTimings: info.wordTimings,
        });
        const stepCues = formatNetflixCues({
          words: alignedWords,
          stepEnd: sched.end,
          ...captionRules,
        });
        for (const cue of stepCues) {
          langCues.push({ ...cue, stepIndex: sched.index });
        }
      }
    }

    const srt = formatSrt(langCues);
    const vtt = formatVtt(langCues);
    let srtFile = null;
    let vttFile = null;

    if (resolvedOutDir && writeSubtitles) {
      const langSlug = lang.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      srtFile = join(resolvedOutDir, `captions-${langSlug}.srt`);
      vttFile = join(resolvedOutDir, `captions-${langSlug}.vtt`);
      await writeFile(srtFile, srt, 'utf8');
      await writeFile(vttFile, vtt, 'utf8');
    }

    subtitles[lang] = {
      language: lang,
      cues: langCues,
      srt,
      vtt,
      ...(srtFile ? { srtFile } : {}),
      ...(vttFile ? { vttFile } : {}),
    };

    captionTracks.push({
      language: lang,
      cues: langCues.map(({ start, end, text }) => ({ start, end, text })),
    });
  }

  let updatedTimeline = null;
  if (timeline) {
    updatedTimeline = structuredClone(timeline);
    const primaryAudioTracks = audioTracks.filter((track) => track.language === primaryLanguage);
    const nonNarrationTracks = (updatedTimeline.audio?.tracks ?? []).filter(
      (track) => track.kind !== 'narration'
    );
    updatedTimeline.audio = {
      tracks: [...nonNarrationTracks, ...primaryAudioTracks],
    };
    updatedTimeline.overlays = {
      ...updatedTimeline.overlays,
      captions: {
        enabled: Boolean(burnInCaptions),
        tracks: captionTracks,
      },
    };
    if (!Array.isArray(updatedTimeline.steps) || updatedTimeline.steps.length === 0) {
      updatedTimeline.steps = scheduledSteps.map(({ t, index, label }) => ({ t, index, label }));
    }
    const maxAudioEnd = primaryAudioTracks.reduce(
      (maxEnd, track) => Math.max(maxEnd, round(track.start + (track.duration ?? 0), 4)),
      round(cursor, 4)
    );
    if (isObject(updatedTimeline.take) && isFiniteNumber(updatedTimeline.take.duration)) {
      if (maxAudioEnd > updatedTimeline.take.duration) {
        updatedTimeline.take.duration = maxAudioEnd;
        if (isFiniteNumber(updatedTimeline.take.fps) && updatedTimeline.take.fps > 0) {
          updatedTimeline.take.frames = Math.max(
            updatedTimeline.take.frames ?? 1,
            Math.round(maxAudioEnd * updatedTimeline.take.fps)
          );
        }
      }
    }
    assertValidTimeline(updatedTimeline);
  }

  return {
    provider,
    languages: targetLanguages,
    totalDuration: round(cursor, 4),
    steps: scheduledSteps,
    segments,
    audioTracks,
    captionTracks,
    subtitles,
    ...(updatedTimeline ? { timeline: updatedTimeline } : {}),
  };
}

const EXTERNAL_MEDIA_RE = /^(?:https?:|data:|blob:)/i;

async function fileExistsSafe(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveRefPath(ref, baseDir) {
  if (!isNonEmptyString(ref) || EXTERNAL_MEDIA_RE.test(ref)) return null;
  if (ref.startsWith('file://')) return fileURLToPath(ref);
  return resolve(baseDir, ref);
}

function rebaseMediaRef(ref, fromBaseDir, toBaseDir) {
  if (!isNonEmptyString(ref) || EXTERNAL_MEDIA_RE.test(ref)) return ref;
  const abs = resolveRefPath(ref, fromBaseDir);
  if (!abs) return ref;
  if (!toBaseDir) return abs;
  const rel = relative(toBaseDir, abs);
  return rel || basename(abs);
}

async function padTakeVideoWithHolds({
  sourceVideo,
  outputVideo,
  scheduledSteps,
  finalDuration,
  fps,
  colorSpace,
  signal,
}) {
  const srcInfo = await probeVideo(sourceVideo);
  const srcDuration = srcInfo.duration > 0 ? srcInfo.duration : 0.1;
  const targetFps = isFiniteNumber(fps) && fps > 0 ? fps : srcInfo.fps || 30;
  const minSlice = Math.max(0.02, 1.05 / targetFps);
  const format = extname(outputVideo).toLowerCase() === '.webm' ? 'webm' : 'mp4';
  const isP3 = colorSpace === 'p3' || srcInfo.colorPrimaries === 'smpte432';

  // Collect lead hold (cut < minSlice) and internal hold points (minSlice <= cut <= srcDuration - minSlice)
  const internalHolds = [];
  let leadHold = 0;
  let sumInternalPad = 0;
  for (let i = 0; i < scheduledSteps.length - 1; i += 1) {
    const step = scheduledSteps[i];
    if (!(step.padDuration > 1e-3)) continue;
    const cut = Math.max(0, Math.min(srcDuration, step.origEnd));
    if (cut < minSlice) {
      leadHold = round(leadHold + step.padDuration, 6);
      sumInternalPad += step.padDuration;
    } else if (cut <= srcDuration - minSlice) {
      const prev = internalHolds[internalHolds.length - 1];
      if (prev && Math.abs(cut - prev.cut) < minSlice) {
        prev.hold = round(prev.hold + step.padDuration, 6);
      } else {
        internalHolds.push({ cut: round(cut, 6), hold: round(step.padDuration, 6) });
      }
      sumInternalPad += step.padDuration;
    }
  }

  const tailHold = Math.max(0, finalDuration - (srcDuration + sumInternalPad)) + 2 / targetFps;
  await mkdir(dirname(outputVideo), { recursive: true });
  const tempOut = join(dirname(outputVideo), `.${basename(outputVideo)}-${randomUUID().slice(0, 8)}.${format}`);

  const colorTailFilter = isP3
    ? ',scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv'
    : '';
  const colorFlags = isP3
    ? ['-color_range', 'tv', '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709']
    : ['-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];

  const codecArgs = format === 'webm'
    ? ['-c:v', 'libvpx-vp9', '-crf', '22', '-b:v', '0', '-deadline', 'good', '-row-mt', '1', ...(isP3 ? colorFlags : [])]
    : [
        '-c:v', 'libx264',
        '-crf', '15',
        '-preset', 'fast',
        '-movflags', '+faststart',
        ...colorFlags,
      ];

  try {
    if (internalHolds.length === 0) {
      const tpadArgs = [
        ...(leadHold > 1e-4 ? [`start_mode=clone:start_duration=${leadHold.toFixed(6)}`] : []),
        `stop_mode=clone:stop_duration=${tailHold.toFixed(6)}`,
      ].join(':');
      const vf = [
        `tpad=${tpadArgs}`,
        `fps=${targetFps}`,
        `pad=ceil(iw/2)*2:ceil(ih/2)*2${colorTailFilter}`,
      ].join(',');
      await exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',
          '-i', sourceVideo,
          '-an',
          '-vf', vf,
          '-t', finalDuration.toFixed(6),
          '-pix_fmt', 'yuv420p',
          ...codecArgs,
          '-threads', '2',
          tempOut,
        ],
        { timeout: 300000, maxBuffer: 10e6, ...(signal ? { signal } : {}) }
      );
    } else {
      const slices = [];
      let prevCut = 0;
      for (const item of internalHolds) {
        slices.push({ start: prevCut, end: item.cut, hold: item.hold });
        prevCut = item.cut;
      }
      slices.push({ start: prevCut, end: srcDuration, hold: tailHold });

      const filterParts = [];
      const concatInputs = [];
      slices.forEach((slice, idx) => {
        const tpadParts = [];
        if (idx === 0 && leadHold > 1e-4) {
          tpadParts.push(`start_mode=clone:start_duration=${leadHold.toFixed(6)}`);
        }
        if (slice.hold > 1e-4) {
          tpadParts.push(`stop_mode=clone:stop_duration=${slice.hold.toFixed(6)}`);
        }
        const padChain = tpadParts.length > 0 ? `,tpad=${tpadParts.join(':')}` : '';
        filterParts.push(
          `[0:v]trim=start=${slice.start.toFixed(6)}:end=${slice.end.toFixed(6)},setpts=PTS-STARTPTS${padChain}[v${idx}]`
        );
        concatInputs.push(`[v${idx}]`);
      });
      filterParts.push(
        `${concatInputs.join('')}concat=n=${slices.length}:v=1:a=0,fps=${targetFps},pad=ceil(iw/2)*2:ceil(ih/2)*2${colorTailFilter},format=yuv420p[outv]`
      );

      await exec(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',
          '-i', sourceVideo,
          '-filter_complex', filterParts.join(';'),
          '-map', '[outv]',
          '-an',
          '-t', finalDuration.toFixed(6),
          ...codecArgs,
          '-threads', '2',
          tempOut,
        ],
        { timeout: 300000, maxBuffer: 10e6, ...(signal ? { signal } : {}) }
      );
    }

    const probed = await probeVideo(tempOut);
    if (!probed.frames || !(probed.duration > 0)) {
      throw Error('FFmpeg produced an empty padded take video');
    }
    await rename(tempOut, outputVideo);
    return probed;
  } finally {
    await rm(tempOut, { force: true }).catch(() => {});
  }
}

function buildPiecewiseTimeMapper(scheduledSteps) {
  return (t) => {
    if (!isFiniteNumber(t) || scheduledSteps.length === 0) return t;
    if (t < scheduledSteps[0].origStart - EPS) return round(t, 4);
    let idx = 0;
    for (let i = 0; i < scheduledSteps.length; i += 1) {
      if (scheduledSteps[i].origStart <= t + EPS) idx = i;
      else break;
    }
    return round(t + scheduledSteps[idx].shiftBefore, 4);
  };
}

function retimeCursorSamplesWithHolds(origCursor, scheduledSteps) {
  if (!isObject(origCursor) || !Array.isArray(origCursor.samples) || origCursor.samples.length === 0) {
    return origCursor?.samples ?? [];
  }
  const mapT = buildPiecewiseTimeMapper(scheduledSteps);
  const rawSamples = origCursor.samples;
  const holds = scheduledSteps.filter((s) => s.padDuration > 1e-4);
  if (holds.length === 0) {
    return rawSamples.map((s) => ({ ...s, t: mapT(s.t) }));
  }

  const out = [];
  const pushSample = (sample) => {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.t === sample.t &&
      prev.x === sample.x &&
      prev.y === sample.y &&
      prev.pressed === sample.pressed &&
      prev.visible === sample.visible
    ) {
      return;
    }
    out.push(sample);
  };

  let sampleIdx = 0;
  for (let i = 0; i < scheduledSteps.length; i += 1) {
    const step = scheduledSteps[i];
    const isLast = i === scheduledSteps.length - 1;
    const cutoff = step.origEnd;

    while (
      sampleIdx < rawSamples.length &&
      (isLast ? rawSamples[sampleIdx].t <= cutoff + EPS : rawSamples[sampleIdx].t < cutoff - EPS)
    ) {
      const s = rawSamples[sampleIdx++];
      pushSample({ ...s, t: round(s.t + step.shiftBefore, 4) });
    }

    if (step.padDuration > 1e-4) {
      const sampledAtBoundary = sampleCursor(
        { enabled: true, style: origCursor.style ?? 'macos', samples: rawSamples },
        cutoff
      );
      if (sampledAtBoundary) {
        const holdStartT = round(cutoff + step.shiftBefore, 4);
        const holdEndT = round(holdStartT + step.padDuration, 4);
        pushSample({
          t: holdStartT,
          x: sampledAtBoundary.x,
          y: sampledAtBoundary.y,
          pressed: false,
          visible: sampledAtBoundary.visible,
        });
        pushSample({
          t: holdEndT,
          x: sampledAtBoundary.x,
          y: sampledAtBoundary.y,
          pressed: false,
          visible: sampledAtBoundary.visible,
        });
      }
    }
  }

  const totalShift = scheduledSteps[scheduledSteps.length - 1]?.shiftAfter ?? 0;
  while (sampleIdx < rawSamples.length) {
    const s = rawSamples[sampleIdx++];
    pushSample({ ...s, t: round(s.t + totalShift, 4) });
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

function retimeCameraKeyframesWithHolds(origCamera, scheduledSteps) {
  if (!isObject(origCamera) || !Array.isArray(origCamera.keyframes) || origCamera.keyframes.length === 0) {
    return origCamera?.keyframes ?? [];
  }
  const holds = scheduledSteps.filter((s) => s.padDuration > 1e-4);
  if (holds.length === 0) {
    return origCamera.keyframes.map((kf) => ({ ...kf }));
  }

  const rawKfs = origCamera.keyframes;
  const out = [];
  const pushKf = (kf) => {
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs(prev.t - kf.t) < EPS &&
      Math.abs(prev.x - kf.x) < EPS &&
      Math.abs(prev.y - kf.y) < EPS &&
      Math.abs(prev.zoom - kf.zoom) < EPS &&
      prev.easing === kf.easing
    ) {
      return;
    }
    out.push(kf);
  };

  let kfIdx = 0;
  for (let i = 0; i < scheduledSteps.length; i += 1) {
    const step = scheduledSteps[i];
    const isLast = i === scheduledSteps.length - 1;
    const cutoff = step.origEnd;

    while (
      kfIdx < rawKfs.length &&
      (isLast ? rawKfs[kfIdx].t <= cutoff + EPS : rawKfs[kfIdx].t < cutoff - EPS)
    ) {
      const kf = rawKfs[kfIdx++];
      pushKf({ ...kf, t: round(kf.t + step.shiftBefore, 4) });
    }

    if (step.padDuration > 1e-4) {
      const pose = sampleCamera(origCamera, cutoff);
      const holdStartT = round(cutoff + step.shiftBefore, 4);
      const holdEndT = round(holdStartT + step.padDuration, 4);
      pushKf({
        t: holdStartT,
        x: pose.x,
        y: pose.y,
        zoom: pose.zoom,
        easing: out.length === 0 ? 'linear' : 'ease-in-out',
      });
      pushKf({
        t: holdEndT,
        x: pose.x,
        y: pose.y,
        zoom: pose.zoom,
        easing: 'linear',
      });
    }
  }

  const totalShift = scheduledSteps[scheduledSteps.length - 1]?.shiftAfter ?? 0;
  while (kfIdx < rawKfs.length) {
    const kf = rawKfs[kfIdx++];
    pushKf({ ...kf, t: round(kf.t + totalShift, 4) });
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

function retimeEventTrackWithHolds(eventTrack, scheduledSteps, origCursor, videoUpdate) {
  if (!isObject(eventTrack) || !Array.isArray(eventTrack.events)) return null;
  const cloned = structuredClone(eventTrack);
  const rawEvents = cloned.events;
  const outEvents = [];

  let evIdx = 0;
  for (let i = 0; i < scheduledSteps.length; i += 1) {
    const step = scheduledSteps[i];
    const isLast = i === scheduledSteps.length - 1;
    const cutoff = step.origEnd;

    while (
      evIdx < rawEvents.length &&
      (isLast ? rawEvents[evIdx].t <= cutoff + EPS : rawEvents[evIdx].t < cutoff - EPS)
    ) {
      const ev = rawEvents[evIdx++];
      outEvents.push({ ...ev, t: round(ev.t + step.shiftBefore, 4) });
    }

    if (step.padDuration > 1e-4 && origCursor?.samples?.length > 0) {
      const sampled = sampleCursor(
        { enabled: true, style: origCursor.style ?? 'macos', samples: origCursor.samples },
        cutoff
      );
      if (sampled) {
        const holdStartT = round(cutoff + step.shiftBefore, 4);
        const holdEndT = round(holdStartT + step.padDuration, 4);
        outEvents.push({ t: holdStartT, type: 'pointermove', x: sampled.x, y: sampled.y });
        outEvents.push({ t: holdEndT, type: 'pointermove', x: sampled.x, y: sampled.y });
      }
    }
  }

  const totalShift = scheduledSteps[scheduledSteps.length - 1]?.shiftAfter ?? 0;
  while (evIdx < rawEvents.length) {
    const ev = rawEvents[evIdx++];
    outEvents.push({ ...ev, t: round(ev.t + totalShift, 4) });
  }

  outEvents.sort((a, b) => a.t - b.t);
  cloned.events = outEvents;
  if (isObject(cloned.video) && isObject(videoUpdate)) {
    cloned.video = {
      ...cloned.video,
      ...videoUpdate,
    };
  }
  return cloned;
}

/**
 * End-to-end timeline narration pipeline:
 * 1. Loads `timeline.json` (and optional `event-track.json` / `recipe`)
 * 2. Synthesizes per-step WAVs via Gemini TTS (`x-goog-api-key`) or Kokoro offline fallback
 * 3. Computes step durations via `computeStepDuration` (`max(action, 0.2 + speech + 0.4)`) and pads
 *    take video + retimes timeline overlays/camera cleanly when speech exceeds action duration
 * 4. Aligns words (`whisper` / `gemini` / `proportional` / `auto`), formats Netflix SRT/VTT files,
 *    populates `timeline.audio.tracks` and `timeline.overlays.captions.tracks`, and writes `timeline.json`.
 */
export async function narrateTimeline({
  timeline: timelineInput,
  eventTrack: eventTrackInput,
  recipe: recipeInput,
  language = 'en',
  languages,
  provider = 'gemini',
  aligner = 'auto',
  outDir,
  out,
  cwd,
  stylePrompt,
  style,
  tone,
  pacing,
  instructions,
  voice,
  model,
  ttsModel,
  speed,
  apiKey,
  fetchImpl,
  ttsRunner,
  alignRunner,
  runner,
  whisperExecutable,
  whisperModel,
  geminiModel,
  providerOptions = {},
  alignerOptions = {},
  leadIn = DEFAULT_STEP_LEAD_IN,
  leadOut = DEFAULT_STEP_LEAD_OUT,
  captionRules = {},
  volume = 1,
  burnInCaptions,
  burnCaptions,
  padVideo = true,
  writeSubtitles = true,
  writeTimeline = true,
  env = process.env,
  signal,
} = {}) {
  if (!TTS_PROVIDERS.includes(provider)) {
    throw Error(`Unsupported TTS provider: ${String(provider)} (expected one of ${TTS_PROVIDERS.join(', ')})`);
  }
  if (!WORD_ALIGNERS.includes(aligner)) {
    throw Error(`Unsupported word aligner: ${String(aligner)} (expected one of ${WORD_ALIGNERS.join(', ')})`);
  }

  const workingCwd = cwd ? resolve(cwd) : process.cwd();
  let resolvedTimelineOut = null;
  let resolvedOutDir = null;

  if (isNonEmptyString(out) && extname(out).toLowerCase() === '.json') {
    resolvedTimelineOut = resolve(workingCwd, out);
    resolvedOutDir = isNonEmptyString(outDir) ? resolve(workingCwd, outDir) : dirname(resolvedTimelineOut);
  } else if (isNonEmptyString(outDir) || isNonEmptyString(out)) {
    resolvedOutDir = resolve(workingCwd, outDir ?? out);
    resolvedTimelineOut = join(resolvedOutDir, 'timeline.json');
  }

  if (resolvedOutDir) {
    await mkdir(resolvedOutDir, { recursive: true });
  }

  // Load eventTrack if explicitly provided
  let eventTrack = null;
  let eventTrackSourceDir = workingCwd;
  if (isNonEmptyString(eventTrackInput)) {
    const etPath = resolve(workingCwd, eventTrackInput);
    eventTrackSourceDir = dirname(etPath);
    eventTrack = JSON.parse(await readFile(etPath, 'utf8'));
  } else if (isObject(eventTrackInput)) {
    eventTrack = structuredClone(eventTrackInput);
  }

  // Load or compile base timeline
  let baseTimeline = null;
  let timelineSourceDir = workingCwd;
  if (isNonEmptyString(timelineInput)) {
    const tlPath = resolve(workingCwd, timelineInput);
    timelineSourceDir = dirname(tlPath);
    baseTimeline = JSON.parse(await readFile(tlPath, 'utf8'));
  } else if (isObject(timelineInput)) {
    baseTimeline = structuredClone(timelineInput);
  } else if (eventTrack) {
    baseTimeline = compileTimeline({
      eventTrack,
      recipe: isObject(recipeInput) ? recipeInput : {},
    });
    timelineSourceDir = eventTrackSourceDir;
  } else {
    throw Error('narrateTimeline requires a timeline (path or object) or eventTrack');
  }

  assertValidTimeline(baseTimeline);

  if (!eventTrack && isNonEmptyString(baseTimeline.take?.eventTrack)) {
    const candidateEtPath = resolveRefPath(baseTimeline.take.eventTrack, timelineSourceDir);
    if (candidateEtPath && (await fileExistsSafe(candidateEtPath))) {
      try {
        eventTrack = JSON.parse(await readFile(candidateEtPath, 'utf8'));
        eventTrackSourceDir = dirname(candidateEtPath);
      } catch {
        eventTrack = null;
      }
    }
  }

  const targetLanguages = Array.isArray(languages) && languages.length > 0
    ? [...new Set(languages.map((l) => String(l).trim()).filter(Boolean))]
    : String(language)
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);
  if (targetLanguages.length === 0) {
    throw Error('narrateTimeline requires at least one target language');
  }
  const primaryLanguage = targetLanguages[0];

  const origDuration = baseTimeline.take.duration;
  const recipeSteps = Array.isArray(recipeInput?.steps) ? recipeInput.steps : [];
  const eventStepsByIndex = new Map();
  if (Array.isArray(eventTrack?.events)) {
    for (const ev of eventTrack.events) {
      if (isObject(ev) && ev.type === 'step' && Number.isInteger(ev.index)) {
        eventStepsByIndex.set(ev.index, ev);
      }
    }
  }

  // Resolve ordered step descriptors with merged narration metadata
  const hasExplicitRecipe = recipeInput !== undefined && recipeInput !== null;
  let rawStepEntries = [];
  if (Array.isArray(baseTimeline.steps) && baseTimeline.steps.length > 0) {
    rawStepEntries = baseTimeline.steps.map((tlStep, idx) => {
      const stepIndex = Number.isInteger(tlStep.index) ? tlStep.index : idx;
      const evStep = eventStepsByIndex.get(stepIndex);
      const recStep = isObject(recipeSteps[stepIndex]) ? recipeSteps[stepIndex] : null;
      const recNarration = recStep?.narration ?? recStep?.say;
      const narration = hasExplicitRecipe
        ? (recNarration ?? tlStep.narration ?? evStep?.narration)
        : (tlStep.narration ?? evStep?.narration ?? recNarration);
      const label = hasExplicitRecipe
        ? (recStep?.label ?? tlStep.label ?? evStep?.label ?? `step-${stepIndex}`)
        : (tlStep.label ?? evStep?.label ?? recStep?.label ?? `step-${stepIndex}`);
      return {
        index: stepIndex,
        t: tlStep.t,
        label,
        narration,
        audioFile: hasExplicitRecipe ? (recStep?.audioFile ?? tlStep.audioFile) : (tlStep.audioFile ?? recStep?.audioFile),
        wordTimings: hasExplicitRecipe ? (recStep?.wordTimings ?? tlStep.wordTimings) : (tlStep.wordTimings ?? recStep?.wordTimings),
      };
    });
  } else if (eventStepsByIndex.size > 0) {
    rawStepEntries = [...eventStepsByIndex.values()]
      .sort((a, b) => a.t - b.t)
      .map((evStep, idx) => {
        const stepIndex = Number.isInteger(evStep.index) ? evStep.index : idx;
        const recStep = isObject(recipeSteps[stepIndex]) ? recipeSteps[stepIndex] : null;
        const recNarration = recStep?.narration ?? recStep?.say;
        return {
          index: stepIndex,
          t: evStep.t,
          label: hasExplicitRecipe
            ? (recStep?.label ?? evStep.label ?? `step-${stepIndex}`)
            : (evStep.label ?? recStep?.label ?? `step-${stepIndex}`),
          narration: hasExplicitRecipe ? (recNarration ?? evStep.narration) : (evStep.narration ?? recNarration),
          audioFile: recStep?.audioFile,
          wordTimings: recStep?.wordTimings,
        };
      });
  } else if (recipeSteps.length > 0) {
    rawStepEntries = recipeSteps
      .map((recStep, idx) => {
        if (!isObject(recStep)) return null;
        const fallbackT = isFiniteNumber(recStep.at)
          ? Math.min(origDuration, Math.max(0, recStep.at))
          : round((origDuration * idx) / recipeSteps.length, 4);
        return {
          index: idx,
          t: fallbackT,
          label: isNonEmptyString(recStep.label) ? recStep.label.trim() : `step-${idx}`,
          narration: recStep.narration ?? recStep.say,
          audioFile: recStep.audioFile,
          wordTimings: recStep.wordTimings,
        };
      })
      .filter(Boolean);
  }

  if (rawStepEntries.length === 0) {
    throw Error('narrateTimeline found no steps to narrate in timeline, eventTrack, or recipe');
  }

  rawStepEntries.sort((a, b) => a.t - b.t || a.index - b.index);

  let anyNarrationFound = false;
  for (const step of rawStepEntries) {
    for (const lang of targetLanguages) {
      if (
        resolveStepTextForLanguage(step, lang, primaryLanguage) ||
        resolveStepAudioForLanguage(step, lang, primaryLanguage)
      ) {
        anyNarrationFound = true;
        break;
      }
    }
    if (anyNarrationFound) break;
  }
  if (!anyNarrationFound) {
    throw Error(`No step narration found for language(s): ${targetLanguages.join(', ')}`);
  }

  const effectiveStyle =
    stylePrompt ??
    style ??
    recipeInput?.narrationStyle ??
    (isObject(recipeInput?.narration) ? recipeInput.narration.stylePrompt ?? recipeInput.narration.style : undefined);
  const effectiveVoice =
    voice ??
    recipeInput?.narrationVoice ??
    (isObject(recipeInput?.narration) ? recipeInput.narration.voice : undefined);
  const effectiveTtsModel =
    ttsModel ??
    model ??
    recipeInput?.narrationModel ??
    (isObject(recipeInput?.narration) ? recipeInput.narration.model : undefined);
  const effectiveSpeed =
    speed ??
    recipeInput?.narrationSpeed ??
    (isObject(recipeInput?.narration) ? recipeInput.narration.speed : undefined);
  const effectiveBurnInCaptions = Boolean(
    burnInCaptions ??
      burnCaptions ??
      recipeInput?.burnInCaptions ??
      (isObject(recipeInput?.narration) ? recipeInput.narration.burnInCaptions : false)
  );

  const effectiveTtsRunner =
    providerOptions.runner ?? ttsRunner ?? (provider === 'kokoro' ? runner : undefined);
  const effectiveAlignRunner =
    alignerOptions.runner ?? alignRunner ?? (aligner === 'whisper' ? runner : undefined);

  // 1. Synthesize or probe per-step audio for each requested language
  const perLanguageStepData = new Map();
  for (const lang of targetLanguages) {
    perLanguageStepData.set(lang, []);
  }

  const audioStagingBaseDir = resolvedOutDir ?? timelineSourceDir;

  for (let i = 0; i < rawStepEntries.length; i += 1) {
    const step = rawStepEntries[i];
    for (const lang of targetLanguages) {
      const text = resolveStepTextForLanguage(step, lang, primaryLanguage);
      const existingAudio = resolveStepAudioForLanguage(step, lang, primaryLanguage);
      const explicitTimings = resolveStepWordTimings(step, lang, primaryLanguage);

      if (!text && !existingAudio) {
        perLanguageStepData.get(lang).push({
          text: '',
          audioFile: null,
          speechDuration: 0,
          wordTimings: null,
        });
        continue;
      }

      if (existingAudio) {
        const audioPath = resolve(workingCwd, existingAudio);
        const probed = await probeAudio(audioPath);
        if (!probed.hasAudio || !(probed.duration > 0)) {
          throw Error(`Step ${step.index} (${lang}) audio file has no valid audio stream: ${audioPath}`);
        }
        perLanguageStepData.get(lang).push({
          text,
          audioFile: audioPath,
          speechDuration: probed.duration,
          wordTimings: explicitTimings,
        });
      } else {
        const langSlug = lang.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        const stepSlug = String(step.index).padStart(3, '0');
        const audioOutputFile = join(audioStagingBaseDir, 'audio', `${langSlug}-step-${stepSlug}.wav`);
        const langOpts = isObject(providerOptions[lang])
          ? { ...providerOptions, ...providerOptions[lang] }
          : providerOptions;

        const synth = await synthesizeSpeech({
          ...langOpts,
          provider,
          text,
          language: lang,
          outputFile: audioOutputFile,
          ...(effectiveTtsModel ? { model: effectiveTtsModel } : {}),
          ...(effectiveVoice ? { voice: effectiveVoice } : {}),
          ...(effectiveStyle !== undefined ? { style: effectiveStyle } : {}),
          ...(tone ? { tone } : {}),
          ...(pacing ? { pacing } : {}),
          ...(instructions ? { instructions } : {}),
          ...(effectiveSpeed !== undefined ? { speed: effectiveSpeed } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(effectiveTtsRunner ? { runner: effectiveTtsRunner } : {}),
          env,
          signal,
        });

        perLanguageStepData.get(lang).push({
          text,
          audioFile: synth.file,
          speechDuration: synth.duration,
          wordTimings: explicitTimings ?? synth.wordTimings ?? null,
        });
      }
    }
  }

  // 2. Compute step durations (`max(actionDuration, leadIn + speechDuration + leadOut)`) & cumulative shifts
  const minCueDuration = captionRules.minDuration ?? NETFLIX_CAPTION_RULES.minDuration;
  const maxCpsRule = captionRules.maxCps ?? NETFLIX_CAPTION_RULES.maxCps;
  const maxLinesRule = captionRules.maxLines ?? NETFLIX_CAPTION_RULES.maxLines;
  const maxCharsRule = captionRules.maxCharsPerLine ?? NETFLIX_CAPTION_RULES.maxCharsPerLine;
  const minGapRule = captionRules.minGap ?? NETFLIX_CAPTION_RULES.minGap;
  const scheduledSteps = [];
  let cumulativeShift = 0;

  for (let i = 0; i < rawStepEntries.length; i += 1) {
    const rawStep = rawStepEntries[i];
    const origStart = Math.max(0, Math.min(origDuration, rawStep.t));
    const origEnd = i + 1 < rawStepEntries.length
      ? Math.max(origStart, Math.min(origDuration, rawStepEntries[i + 1].t))
      : Math.max(origStart, origDuration);
    const actionDuration = round(Math.max(0, origEnd - origStart), 4);
    const maxSpeechDuration = Math.max(
      0,
      ...targetLanguages.map((lang) => perLanguageStepData.get(lang)[i].speechDuration)
    );
    let maxRequiredReadingSec = 0;
    for (const lang of targetLanguages) {
      const item = perLanguageStepData.get(lang)[i];
      if (item.text && item.speechDuration > 0) {
        const charLen = item.text.trim().replace(/\s+/g, ' ').length;
        const approxCueCapacity = Math.max(20, Math.floor(maxLinesRule * maxCharsRule * 0.7));
        const estCues = Math.max(1, Math.ceil(charLen / approxCueCapacity));
        const safeCps = Math.max(1, maxCpsRule - 0.5);
        const reqSec = Math.max(
          minCueDuration,
          charLen / safeCps + (estCues - 1) * (minGapRule + 0.05)
        );
        if (reqSec > maxRequiredReadingSec) maxRequiredReadingSec = reqSec;
      }
    }

    const baseStepDuration = computeStepDuration({
      actionDuration,
      speechDuration: maxSpeechDuration,
      leadIn,
      leadOut,
    });
    const minCaptionStepWindow = maxRequiredReadingSec > 0
      ? round(leadIn + maxRequiredReadingSec + 0.05, 4)
      : 0;
    const stepDuration = round(Math.max(baseStepDuration, minCaptionStepWindow), 4);
    const padDuration = round(Math.max(0, stepDuration - actionDuration), 4);
    const shiftBefore = round(cumulativeShift, 4);
    const shiftAfter = round(cumulativeShift + padDuration, 4);
    const newStart = round(origStart + shiftBefore, 4);
    const newEnd = round(newStart + stepDuration, 4);

    scheduledSteps.push({
      index: rawStep.index,
      label: rawStep.label,
      ...(rawStep.narration !== undefined ? { narration: structuredClone(rawStep.narration) } : {}),
      origStart: round(origStart, 4),
      origEnd: round(origEnd, 4),
      shiftBefore,
      shiftAfter,
      padDuration,
      t: newStart,
      start: newStart,
      end: newEnd,
      actionDuration,
      speechDuration: round(maxSpeechDuration, 4),
      duration: stepDuration,
    });

    cumulativeShift = shiftAfter;
  }

  const totalExtraPad = round(cumulativeShift, 4);
  let finalDuration = round(origDuration + totalExtraPad, 4);

  // 3. Word alignment + Netflix caption cue generation + SRT/VTT files
  const timelineTargetDir = resolvedTimelineOut ? dirname(resolvedTimelineOut) : resolvedOutDir;
  const rawAudioTracks = [];
  const captionTracks = [];
  const subtitles = {};
  const segments = [];
  const usedAligners = new Set();

  for (const lang of targetLanguages) {
    const langCues = [];
    const langSteps = perLanguageStepData.get(lang);

    for (let i = 0; i < scheduledSteps.length; i += 1) {
      const sched = scheduledSteps[i];
      const info = langSteps[i];
      if (!info.text && !info.audioFile) continue;

      const speechStart = round(sched.start + leadIn, 4);
      const speechEnd = round(speechStart + info.speechDuration, 4);

      if (info.audioFile) {
        const srcRef = timelineTargetDir
          ? rebaseMediaRef(info.audioFile, workingCwd, timelineTargetDir)
          : info.audioFile;
        rawAudioTracks.push({
          id: `narration-${lang}-${String(sched.index).padStart(3, '0')}`,
          kind: 'narration',
          src: srcRef,
          absSrc: info.audioFile,
          start: speechStart,
          volume,
          language: lang,
          stepIndex: sched.index,
          duration: info.speechDuration,
        });
      }

      segments.push({
        language: lang,
        stepIndex: sched.index,
        label: sched.label,
        start: speechStart,
        end: speechEnd,
        duration: info.speechDuration,
        src: info.audioFile,
      });

      if (info.text && info.speechDuration > 0) {
        let alignedWords;
        if (Array.isArray(info.wordTimings) && info.wordTimings.length > 0) {
          alignedWords = alignWords({
            text: info.text,
            duration: info.speechDuration,
            startOffset: speechStart,
            wordTimings: info.wordTimings,
          });
          usedAligners.add('explicit');
        } else {
          const alignment = await alignAudioWords({
            ...alignerOptions,
            audioFile: info.audioFile,
            text: info.text,
            duration: info.speechDuration,
            startOffset: speechStart,
            aligner,
            provider,
            allowCloudAuto: provider !== 'kokoro',
            language: lang,
            ...(apiKey ? { apiKey } : {}),
            ...(fetchImpl ? { fetchImpl } : {}),
            ...(effectiveAlignRunner ? { runner: effectiveAlignRunner } : {}),
            ...(whisperExecutable !== undefined ? { executable: whisperExecutable } : {}),
            ...(geminiModel ? { geminiModel } : {}),
            ...(aligner === 'gemini' && geminiModel
              ? { model: geminiModel }
              : whisperModel
                ? { model: whisperModel }
                : {}),
            env,
            signal,
          });
          alignedWords = alignment.words;
          usedAligners.add(alignment.aligner);
        }

        const stepCues = formatNetflixCues({
          words: alignedWords,
          stepEnd: sched.end,
          ...captionRules,
        });
        for (const cue of stepCues) {
          langCues.push({ ...cue, stepIndex: sched.index });
        }
      }
    }

    const srt = formatSrt(langCues);
    const vtt = formatVtt(langCues);
    let srtFile = null;
    let vttFile = null;

    if (resolvedOutDir && writeSubtitles) {
      const langSlug = lang.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      srtFile = join(resolvedOutDir, `captions-${langSlug}.srt`);
      vttFile = join(resolvedOutDir, `captions-${langSlug}.vtt`);
      await writeFile(srtFile, srt, 'utf8');
      await writeFile(vttFile, vtt, 'utf8');
    }

    subtitles[lang] = {
      language: lang,
      cues: langCues,
      srt,
      vtt,
      ...(srtFile ? { srtFile } : {}),
      ...(vttFile ? { vttFile } : {}),
    };

    captionTracks.push({
      language: lang,
      cues: langCues.map(({ start, end, text }) => ({ start, end, text })),
    });
  }

  // 4. Pad source take video if step speech windows extended timeline duration
  const updatedTimeline = structuredClone(baseTimeline);
  const absSourceVideo = resolveRefPath(baseTimeline.take.video, timelineSourceDir);
  const sourceVideoExists = absSourceVideo ? await fileExistsSafe(absSourceVideo) : false;

  let paddedVideoPath = null;
  let finalFrames = Math.max(1, Math.round(finalDuration * baseTimeline.take.fps));

  if (padVideo && totalExtraPad > 1e-3 && sourceVideoExists && resolvedOutDir) {
    const ext = extname(absSourceVideo).toLowerCase() === '.webm' ? '.webm' : '.mp4';
    paddedVideoPath = join(resolvedOutDir, `take-narrated${ext}`);
    const paddedInfo = await padTakeVideoWithHolds({
      sourceVideo: absSourceVideo,
      outputVideo: paddedVideoPath,
      scheduledSteps,
      finalDuration,
      fps: baseTimeline.take.fps,
      colorSpace: baseTimeline.take.colorSpace,
      signal,
    });
    finalDuration = round(paddedInfo.duration, 4);
    finalFrames = paddedInfo.frames;
    updatedTimeline.take.width = paddedInfo.width;
    updatedTimeline.take.height = paddedInfo.height;
    updatedTimeline.take.video = timelineTargetDir
      ? rebaseMediaRef(paddedVideoPath, workingCwd, timelineTargetDir)
      : paddedVideoPath;
  } else {
    updatedTimeline.take.video = timelineTargetDir
      ? rebaseMediaRef(baseTimeline.take.video, timelineSourceDir, timelineTargetDir)
      : baseTimeline.take.video;
  }

  updatedTimeline.take.duration = finalDuration;
  updatedTimeline.take.frames = finalFrames;

  if (updatedTimeline.stage?.background?.type === 'image') {
    updatedTimeline.stage.background.src = timelineTargetDir
      ? rebaseMediaRef(baseTimeline.stage.background.src, timelineSourceDir, timelineTargetDir)
      : updatedTimeline.stage.background.src;
  }

  // 5. Retime overlays, camera keyframes, steps, and optional eventTrack
  const mapTime = buildPiecewiseTimeMapper(scheduledSteps);
  if (totalExtraPad > 1e-4) {
    updatedTimeline.overlays.cursor.samples = retimeCursorSamplesWithHolds(
      baseTimeline.overlays.cursor,
      scheduledSteps
    );
    updatedTimeline.overlays.ripples = (baseTimeline.overlays.ripples ?? []).map((r) => ({
      ...r,
      t: mapTime(r.t),
    }));
    updatedTimeline.overlays.gestures = (baseTimeline.overlays.gestures ?? []).map((g) => ({
      ...g,
      t: mapTime(g.t),
    }));
    updatedTimeline.overlays.keystrokes = (baseTimeline.overlays.keystrokes ?? []).map((ks) => ({
      ...ks,
      t: mapTime(ks.t),
    }));
  }

  let retimedEventTrack = null;
  let retimedEventTrackPath = null;
  if (eventTrack) {
    retimedEventTrack = totalExtraPad > 1e-4
      ? retimeEventTrackWithHolds(eventTrack, scheduledSteps, baseTimeline.overlays.cursor, {
          ...(paddedVideoPath && resolvedOutDir
            ? { file: relative(resolvedOutDir, paddedVideoPath) || basename(paddedVideoPath) }
            : {}),
          duration: finalDuration,
          frames: finalFrames,
        })
      : structuredClone(eventTrack);

    // Ensure step events carry narration in retimed event track
    const narrByStepIdx = new Map(
      rawStepEntries
        .filter((s) => s.narration !== undefined)
        .map((s) => [s.index, s.narration])
    );
    for (const ev of retimedEventTrack.events ?? []) {
      if (ev?.type === 'step' && narrByStepIdx.has(ev.index)) {
        ev.narration = structuredClone(narrByStepIdx.get(ev.index));
      }
    }

    if (totalExtraPad > 1e-4 && resolvedOutDir && writeTimeline) {
      const checkEt = validateEventTrack(retimedEventTrack);
      if (checkEt.ok) {
        retimedEventTrackPath = join(resolvedOutDir, 'event-track.narrated.json');
        await writeFile(retimedEventTrackPath, `${JSON.stringify(retimedEventTrack, null, 2)}\n`, 'utf8');
        updatedTimeline.take.eventTrack = timelineTargetDir
          ? rebaseMediaRef(retimedEventTrackPath, workingCwd, timelineTargetDir)
          : retimedEventTrackPath;
      }
    }
  }

  if (!retimedEventTrackPath) {
    updatedTimeline.take.eventTrack = timelineTargetDir
      ? rebaseMediaRef(baseTimeline.take.eventTrack, timelineSourceDir, timelineTargetDir)
      : baseTimeline.take.eventTrack;
  }

  if (totalExtraPad > 1e-4) {
    const effectiveRecipeCamera = isObject(recipeInput?.presentation?.camera)
      ? { ...(isObject(recipeInput?.camera) ? recipeInput.camera : {}), ...recipeInput.presentation.camera }
      : isObject(recipeInput?.timeline?.camera)
        ? { ...(isObject(recipeInput?.camera) ? recipeInput.camera : {}), ...recipeInput.timeline.camera }
        : isObject(recipeInput?.camera)
          ? recipeInput.camera
          : null;
    const allowStepCameraRecompile =
      effectiveRecipeCamera?.keyframes === undefined &&
      effectiveRecipeCamera?.fromSteps !== false;
    const hasStepCameraHints =
      allowStepCameraRecompile &&
      Array.isArray(retimedEventTrack?.events) &&
      retimedEventTrack.events.some((ev) => ev?.type === 'step' && ev.camera !== undefined);
    const recompiledKfs = hasStepCameraHints
      ? compileStepCameraKeyframes({
          events: retimedEventTrack.events,
          viewportWidth: updatedTimeline.take.viewport.width,
          viewportHeight: updatedTimeline.take.viewport.height,
          stage: updatedTimeline.stage,
          window: updatedTimeline.window,
          outputWidth: updatedTimeline.camera.outputWidth,
          outputHeight: updatedTimeline.camera.outputHeight,
          cursor: updatedTimeline.overlays.cursor,
        })
      : null;

    updatedTimeline.camera.keyframes =
      recompiledKfs && recompiledKfs.length > 0
        ? recompiledKfs
        : retimeCameraKeyframesWithHolds(baseTimeline.camera, scheduledSteps);

    if (
      Array.isArray(baseTimeline.camera?.verticalKeyframes) &&
      baseTimeline.camera.verticalKeyframes.length > 0
    ) {
      updatedTimeline.camera.verticalKeyframes = retimeCameraKeyframesWithHolds(
        { keyframes: baseTimeline.camera.verticalKeyframes },
        scheduledSteps
      );
    }
  }

  updatedTimeline.steps = scheduledSteps.map((s) => ({
    t: s.t,
    index: s.index,
    label: s.label,
    duration: s.duration,
    end: s.end,
    ...(s.narration !== undefined ? { narration: structuredClone(s.narration) } : {}),
  }));

  const primaryAudioTracks = rawAudioTracks
    .filter((t) => t.language === primaryLanguage)
    .map(({ absSrc: _abs, ...track }) => track);
  const nonNarrationTracks = (baseTimeline.audio?.tracks ?? [])
    .filter((track) => track.kind !== 'narration')
    .map((track) => ({
      ...track,
      src: timelineTargetDir
        ? rebaseMediaRef(track.src, timelineSourceDir, timelineTargetDir)
        : track.src,
    }));

  updatedTimeline.audio = {
    tracks: [...nonNarrationTracks, ...primaryAudioTracks],
  };
  updatedTimeline.overlays = {
    ...updatedTimeline.overlays,
    captions: {
      enabled: effectiveBurnInCaptions,
      tracks: captionTracks,
    },
  };

  assertValidTimeline(updatedTimeline);

  if (resolvedTimelineOut && writeTimeline) {
    await mkdir(dirname(resolvedTimelineOut), { recursive: true });
    await writeFile(resolvedTimelineOut, `${JSON.stringify(updatedTimeline, null, 2)}\n`, 'utf8');
  }

  const resolvedAlignerList = [...usedAligners];
  const effectiveAligner = resolvedAlignerList.length === 1 ? resolvedAlignerList[0] : (resolvedAlignerList[0] ?? aligner);

  return {
    ok: true,
    provider,
    aligner: effectiveAligner,
    alignersUsed: resolvedAlignerList,
    language: primaryLanguage,
    languages: targetLanguages,
    ...(resolvedOutDir ? { outDir: resolvedOutDir } : {}),
    ...(resolvedTimelineOut && writeTimeline ? { timelineFile: resolvedTimelineOut } : {}),
    ...(retimedEventTrackPath ? { eventTrackFile: retimedEventTrackPath } : {}),
    ...(paddedVideoPath ? { paddedVideoFile: paddedVideoPath } : {}),
    paddedSeconds: totalExtraPad,
    totalDuration: finalDuration,
    steps: scheduledSteps,
    segments,
    audioTracks: updatedTimeline.audio.tracks,
    captionTracks,
    subtitles,
    timeline: updatedTimeline,
  };
}

/**
 * Measure integrated loudness (LUFS), loudness range (LU), and true peak (dBFS)
 * on an audio or video file using FFmpeg's `ebur128=peak=true` filter.
 */
export async function measureLoudness(
  mediaPath,
  { silenceThresholdLufs = DEFAULT_LOUDNESS_BOUNDS.silenceThresholdLufs } = {}
) {
  const file = resolve(mediaPath);
  const probed = await probeAudio(file);
  if (!probed.hasAudio) {
    return {
      file,
      hasAudio: false,
      duration: 0,
      sampleRate: 0,
      channels: 0,
      codec: '',
      integratedLufs: null,
      loudnessRangeLu: null,
      truePeakDbfs: null,
      isSilent: true,
    };
  }

  const { stderr } = await exec(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i', file,
      '-map', '0:a:0',
      '-af', 'ebur128=peak=true',
      '-f', 'null',
      '-',
    ],
    { maxBuffer: 20e6, timeout: 120000 }
  );

  const summaryIndex = stderr.lastIndexOf('Summary:');
  const summary = summaryIndex >= 0 ? stderr.slice(summaryIndex) : stderr;

  const iMatch = summary.match(/Integrated loudness:[\s\S]*?\bI:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*LUFS/i);
  const lraMatch = summary.match(/Loudness range:[\s\S]*?\bLRA:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*LU/i);
  const peakMatch = summary.match(/True peak:[\s\S]*?\bPeak:\s*([+-]?\d+(?:\.\d+)?|-inf)\s*dBFS/i);

  const parseMetric = (match) => {
    if (!match) return null;
    if (match[1].toLowerCase() === '-inf') return -Infinity;
    const value = Number(match[1]);
    return Number.isFinite(value) ? round(value, 2) : null;
  };

  const rawIntegrated = parseMetric(iMatch);
  const rawLra = parseMetric(lraMatch);
  const rawPeak = parseMetric(peakMatch);

  const integratedLufs = rawIntegrated === -Infinity ? null : rawIntegrated;
  const loudnessRangeLu = rawLra === -Infinity ? null : rawLra;
  const truePeakDbfs = rawPeak === -Infinity ? null : rawPeak;

  const isSilent =
    rawIntegrated === -Infinity ||
    rawPeak === -Infinity ||
    integratedLufs === null ||
    integratedLufs <= silenceThresholdLufs;

  return {
    file,
    hasAudio: true,
    duration: probed.duration,
    sampleRate: probed.sampleRate,
    channels: probed.channels,
    codec: probed.codec,
    integratedLufs,
    loudnessRangeLu,
    truePeakDbfs,
    isSilent,
  };
}

/**
 * Validate caption cues against Netflix subtitle rules:
 * - <= maxLines (2) lines per cue
 * - <= maxCharsPerLine (42) characters per line
 * - duration within [minDuration (0.833 s), maxDuration (7.0 s)]
 * - reading speed <= maxCps (20 CPS)
 * - monotonic, non-overlapping timestamps
 */
export function validateCaptionCues(cues = [], options = {}) {
  const {
    language,
    maxLines = NETFLIX_CAPTION_RULES.maxLines,
    maxCharsPerLine = NETFLIX_CAPTION_RULES.maxCharsPerLine,
    maxCps = NETFLIX_CAPTION_RULES.maxCps,
    minDuration = NETFLIX_CAPTION_RULES.minDuration,
    maxDuration = NETFLIX_CAPTION_RULES.maxDuration,
    durationTolerance = 0.005,
  } = options;

  if (!Array.isArray(cues)) {
    return {
      ok: false,
      ...(language ? { language } : {}),
      cueCount: 0,
      maxLinesObserved: 0,
      maxLineLengthObserved: 0,
      maxCpsObserved: 0,
      minDurationObserved: null,
      maxDurationObserved: null,
      violations: [{ cueIndex: -1, rule: 'schema', message: 'cues must be an array' }],
    };
  }

  const violations = [];
  let maxLinesObserved = 0;
  let maxLineLengthObserved = 0;
  let maxCpsObserved = 0;
  let minDurationObserved = Infinity;
  let maxDurationObserved = 0;

  let prevStart = -Infinity;
  let prevEnd = -Infinity;

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (!isObject(cue)) {
      violations.push({ cueIndex: i, rule: 'schema', message: `cue[${i}] must be an object` });
      continue;
    }

    const startOk = isFiniteNumber(cue.start) && cue.start >= 0;
    const endOk = isFiniteNumber(cue.end) && cue.end >= 0;
    if (!startOk || !endOk) {
      violations.push({
        cueIndex: i,
        rule: 'timestamps',
        message: `cue[${i}] must have non-negative finite start and end`,
      });
      continue;
    }

    if (cue.end <= cue.start) {
      violations.push({
        cueIndex: i,
        rule: 'timestamps',
        timestamp: cue.start,
        message: `cue[${i}] end (${cue.end}s) must be greater than start (${cue.start}s)`,
      });
    }

    if (i > 0) {
      if (cue.start < prevStart - EPS) {
        violations.push({
          cueIndex: i,
          rule: 'monotonic',
          timestamp: cue.start,
          message: `cue[${i}] start (${cue.start}s) precedes previous cue start (${prevStart}s)`,
        });
      }
      if (cue.start < prevEnd - EPS) {
        violations.push({
          cueIndex: i,
          rule: 'overlap',
          timestamp: cue.start,
          message: `cue[${i}] overlaps previous cue (${cue.start}s < ${prevEnd}s)`,
        });
      }
    }
    prevStart = cue.start;
    prevEnd = cue.end;

    const cueDuration = cue.end - cue.start;
    if (cueDuration < minDurationObserved) minDurationObserved = cueDuration;
    if (cueDuration > maxDurationObserved) maxDurationObserved = cueDuration;

    if (cueDuration < minDuration - durationTolerance) {
      violations.push({
        cueIndex: i,
        rule: 'min-duration',
        timestamp: cue.start,
        message: `cue[${i}] duration ${round(cueDuration, 3)}s is below minimum ${round(minDuration, 3)}s`,
      });
    }
    if (cueDuration > maxDuration + durationTolerance) {
      violations.push({
        cueIndex: i,
        rule: 'max-duration',
        timestamp: cue.start,
        message: `cue[${i}] duration ${round(cueDuration, 3)}s exceeds maximum ${round(maxDuration, 3)}s`,
      });
    }

    if (typeof cue.text !== 'string' || cue.text.trim().length === 0) {
      violations.push({
        cueIndex: i,
        rule: 'text',
        timestamp: cue.start,
        message: `cue[${i}] text must be a non-empty string`,
      });
      continue;
    }

    const lines = cue.text.split(/\r?\n/);
    if (lines.length > maxLinesObserved) maxLinesObserved = lines.length;
    if (lines.length > maxLines) {
      violations.push({
        cueIndex: i,
        rule: 'max-lines',
        timestamp: cue.start,
        message: `cue[${i}] has ${lines.length} lines (max ${maxLines})`,
      });
    }

    for (let l = 0; l < lines.length; l += 1) {
      const len = lines[l].length;
      if (len > maxLineLengthObserved) maxLineLengthObserved = len;
      if (len > maxCharsPerLine) {
        violations.push({
          cueIndex: i,
          rule: 'max-line-length',
          timestamp: cue.start,
          message: `cue[${i}] line ${l + 1} length ${len} exceeds max ${maxCharsPerLine} characters`,
        });
      }
    }

    const charCount = lines.join(' ').length;
    const cps = cueDuration > 0 ? charCount / cueDuration : Infinity;
    if (Number.isFinite(cps) && cps > maxCpsObserved) maxCpsObserved = cps;
    if (cps > maxCps + 0.05) {
      violations.push({
        cueIndex: i,
        rule: 'max-cps',
        timestamp: cue.start,
        message: `cue[${i}] reading speed ${round(cps, 2)} CPS exceeds max ${maxCps} CPS`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    ...(language ? { language } : {}),
    cueCount: cues.length,
    maxLinesObserved,
    maxLineLengthObserved,
    maxCpsObserved: round(maxCpsObserved, 2),
    minDurationObserved: Number.isFinite(minDurationObserved) ? round(minDurationObserved, 4) : null,
    maxDurationObserved: cues.length > 0 ? round(maxDurationObserved, 4) : null,
    violations,
  };
}

function normalizeStepWindows(steps = [], totalDuration) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const sorted = [...steps]
    .filter((s) => isObject(s) && isFiniteNumber(s.start ?? s.t))
    .sort((a, b) => (a.start ?? a.t) - (b.start ?? b.t));

  return sorted.map((step, i) => {
    const start = step.start ?? step.t;
    const nextStart = sorted[i + 1] ? (sorted[i + 1].start ?? sorted[i + 1].t) : null;
    const end = isFiniteNumber(step.end)
      ? step.end
      : isFiniteNumber(step.duration)
        ? start + step.duration
        : nextStart !== null
          ? nextStart
          : isFiniteNumber(totalDuration)
            ? totalDuration
            : start;
    return {
      index: Number.isInteger(step.index) ? step.index : i,
      label: step.label ?? `step-${i}`,
      start: round(start, 4),
      end: round(Math.max(start, end), 4),
      duration: round(Math.max(0, end - start), 4),
    };
  });
}

/**
 * Verify that every speech segment fits inside its assigned (or enclosing) step window.
 */
export function verifyStepSpeechFit({
  steps = [],
  segments = [],
  totalDuration,
  tolerance = 0.05,
} = {}) {
  const windows = normalizeStepWindows(steps, totalDuration);
  if (windows.length === 0 || !Array.isArray(segments) || segments.length === 0) {
    return {
      ok: true,
      checked: false,
      stepsCount: windows.length,
      segmentsChecked: 0,
      violations: [],
    };
  }

  const byIndex = new Map(windows.map((w) => [w.index, w]));
  const violations = [];
  let segmentsChecked = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (!isObject(seg) || !isFiniteNumber(seg.start)) continue;
    const end = isFiniteNumber(seg.end)
      ? seg.end
      : isFiniteNumber(seg.duration)
        ? seg.start + seg.duration
        : null;
    if (end === null) continue;

    segmentsChecked += 1;

    let stepWindow = null;
    if (Number.isInteger(seg.stepIndex) && byIndex.has(seg.stepIndex)) {
      stepWindow = byIndex.get(seg.stepIndex);
    } else {
      // Find step window whose start is <= seg.start (closest preceding step)
      for (let w = windows.length - 1; w >= 0; w -= 1) {
        if (windows[w].start <= seg.start + tolerance) {
          stepWindow = windows[w];
          break;
        }
      }
      if (!stepWindow) stepWindow = windows[0];
    }

    if (seg.start < stepWindow.start - tolerance) {
      violations.push({
        segmentIndex: i,
        stepIndex: stepWindow.index,
        label: stepWindow.label,
        timestamp: seg.start,
        reason: 'starts-before-step',
        message: `Speech segment ${i} starts at ${round(seg.start, 3)}s before step ${stepWindow.index} (${stepWindow.label}) starts at ${stepWindow.start}s`,
      });
    }
    if (end > stepWindow.end + tolerance) {
      violations.push({
        segmentIndex: i,
        stepIndex: stepWindow.index,
        label: stepWindow.label,
        timestamp: end,
        reason: 'overflows-step',
        message: `Speech segment ${i} ends at ${round(end, 3)}s after step ${stepWindow.index} (${stepWindow.label}) ends at ${stepWindow.end}s (overflow ${round(end - stepWindow.end, 3)}s)`,
      });
    }
    if (isFiniteNumber(totalDuration) && end > totalDuration + tolerance) {
      violations.push({
        segmentIndex: i,
        stepIndex: stepWindow.index,
        label: stepWindow.label,
        timestamp: end,
        reason: 'overflows-video',
        message: `Speech segment ${i} ends at ${round(end, 3)}s past video duration ${round(totalDuration, 3)}s`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    checked: segmentsChecked > 0,
    stepsCount: windows.length,
    segmentsChecked,
    violations,
  };
}

/**
 * Run narration & caption review assertions:
 * 1. Audio loudness (`ebur128`) checking for silence, overly quiet audio, or clipping.
 * 2. Netflix caption rule validation across all caption tracks/cues.
 * 3. Step window fit verification for every speech segment.
 */
export async function reviewNarration({
  video,
  audioFiles,
  timeline,
  cues,
  captionTracks,
  steps,
  segments,
  totalDuration,
  baseDir,
  loudness = {},
  captionRules = {},
  stepFit = {},
} = {}) {
  const checks = [];
  const findings = [];
  const addCheck = (name, ok, message, extra = {}) => {
    checks.push({ name, ok: Boolean(ok), message, ...extra });
  };
  const addFinding = (severity, category, message, extra = {}) => {
    findings.push({ source: 'deterministic', severity, category, message, ...extra });
  };

  const bounds = { ...DEFAULT_LOUDNESS_BOUNDS, ...loudness };
  const resolvedBaseDir = baseDir ? resolve(baseDir) : process.cwd();
  const effectiveTotalDuration = isFiniteNumber(totalDuration)
    ? totalDuration
    : isFiniteNumber(timeline?.take?.duration)
      ? timeline.take.duration
      : undefined;

  // 1. Audio loudness measurement
  const audioTargets = [];
  if (Array.isArray(audioFiles) && audioFiles.length > 0) {
    for (const file of audioFiles) {
      audioTargets.push({ label: file, path: resolve(resolvedBaseDir, file) });
    }
  }
  if (video) {
    audioTargets.push({ label: video, path: resolve(resolvedBaseDir, video), isVideo: true });
  } else if (audioTargets.length === 0 && Array.isArray(timeline?.audio?.tracks) && timeline.audio.tracks.length > 0) {
    for (const track of timeline.audio.tracks) {
      if (track?.src && !/^(?:https?:|data:|blob:)/i.test(track.src)) {
        audioTargets.push({
          label: track.id ?? track.src,
          path: resolve(resolvedBaseDir, track.src),
          track,
        });
      }
    }
  }

  const timelineTracks = Array.isArray(timeline?.audio?.tracks) ? timeline.audio.tracks : [];
  const isSfxOnlyTimeline =
    timelineTracks.length > 0 &&
    timelineTracks.every((t) => t?.kind === 'sfx') &&
    !timelineTracks.some((t) => t?.kind === 'narration' || t?.kind === 'music');

  const loudnessMeasurements = [];
  const loudnessIssues = [];

  if (loudness.enabled !== false && audioTargets.length > 0) {
    const hasExplicitAudioFiles = Array.isArray(audioFiles) && audioFiles.length > 0;
    let allTargetsTransientSfx = true;
    for (const target of audioTargets) {
      const measurement = await measureLoudness(target.path, {
        silenceThresholdLufs: bounds.silenceThresholdLufs,
      });
      const isSfxTarget =
        target.track?.kind === 'sfx' || (isSfxOnlyTimeline && !hasExplicitAudioFiles);
      if (!isSfxTarget) allTargetsTransientSfx = false;
      const entry = { label: target.label, mode: isSfxTarget ? 'sfx-transient' : 'program-lufs', ...measurement };
      loudnessMeasurements.push(entry);

      if (!measurement.hasAudio) {
        const msg = `${target.label}: no audio stream found`;
        loudnessIssues.push(msg);
        addFinding('error', 'audio-loudness', msg, { details: entry });
        continue;
      }

      if (isSfxTarget) {
        if (measurement.truePeakDbfs === null || !Number.isFinite(measurement.truePeakDbfs) || measurement.truePeakDbfs <= -60) {
          const msg = `${target.label}: SFX audio has no measurable transient signal (true peak ${measurement.truePeakDbfs ?? '-inf'} dBFS <= -60 dBFS)`;
          loudnessIssues.push(msg);
          addFinding('error', 'audio-loudness', msg, { details: entry });
        } else if (measurement.truePeakDbfs > bounds.maxTruePeakDbfs) {
          const msg = `${target.label}: true peak ${measurement.truePeakDbfs} dBFS exceeds ceiling ${bounds.maxTruePeakDbfs} dBFS (clipping risk)`;
          loudnessIssues.push(msg);
          addFinding('error', 'audio-loudness', msg, { details: entry });
        }
        continue;
      }

      if (measurement.isSilent) {
        const msg = `${target.label}: audio is silent (I=${measurement.integratedLufs ?? '-inf'} LUFS <= ${bounds.silenceThresholdLufs} LUFS)`;
        loudnessIssues.push(msg);
        addFinding('error', 'audio-loudness', msg, { details: entry });
        continue;
      }
      if (measurement.integratedLufs < bounds.minLufs) {
        const msg = `${target.label}: integrated loudness ${measurement.integratedLufs} LUFS is too quiet (min ${bounds.minLufs} LUFS)`;
        loudnessIssues.push(msg);
        addFinding('error', 'audio-loudness', msg, { details: entry });
      }
      if (measurement.integratedLufs > bounds.maxLufs) {
        const msg = `${target.label}: integrated loudness ${measurement.integratedLufs} LUFS is too loud (max ${bounds.maxLufs} LUFS)`;
        loudnessIssues.push(msg);
        addFinding('error', 'audio-loudness', msg, { details: entry });
      }
      if (measurement.truePeakDbfs !== null && measurement.truePeakDbfs > bounds.maxTruePeakDbfs) {
        const msg = `${target.label}: true peak ${measurement.truePeakDbfs} dBFS exceeds ceiling ${bounds.maxTruePeakDbfs} dBFS (clipping risk)`;
        loudnessIssues.push(msg);
        addFinding('error', 'audio-loudness', msg, { details: entry });
      }
    }

    const loudnessOk = loudnessIssues.length === 0;
    addCheck(
      'audio-loudness',
      loudnessOk,
      loudnessOk
        ? allTargetsTransientSfx
          ? `SFX transient peak within (-60, ${bounds.maxTruePeakDbfs}] dBFS across ${loudnessMeasurements.length} file(s) (${loudnessMeasurements.map((m) => `${m.truePeakDbfs} dBFS`).join(', ')})`
          : `audio loudness within [${bounds.minLufs}, ${bounds.maxLufs}] LUFS across ${loudnessMeasurements.length} file(s) (${loudnessMeasurements.map((m) => (m.mode === 'sfx-transient' ? `${m.truePeakDbfs} dBFS peak` : `${m.integratedLufs} LUFS`)).join(', ')})`
        : loudnessIssues.join('; ')
    );
  } else {
    addCheck('audio-loudness', true, 'no audio targets provided; skipped loudness check', { skipped: true });
  }

  // 2. Caption rules validation
  const tracksToValidate = [];
  if (Array.isArray(captionTracks) && captionTracks.length > 0) {
    for (const track of captionTracks) {
      tracksToValidate.push({ language: track.language ?? 'default', cues: track.cues ?? [] });
    }
  } else if (Array.isArray(cues)) {
    tracksToValidate.push({ language: 'default', cues });
  } else if (
    Array.isArray(timeline?.overlays?.captions?.tracks) &&
    timeline.overlays.captions.tracks.length > 0
  ) {
    for (const track of timeline.overlays.captions.tracks) {
      tracksToValidate.push({ language: track.language ?? 'default', cues: track.cues ?? [] });
    }
  }

  const captionReports = [];
  const allCaptionViolations = [];
  if (captionRules.enabled !== false && tracksToValidate.length > 0) {
    for (const track of tracksToValidate) {
      const report = validateCaptionCues(track.cues, {
        ...captionRules,
        language: track.language,
      });
      captionReports.push(report);
      for (const violation of report.violations) {
        const enriched = { ...violation, language: track.language };
        allCaptionViolations.push(enriched);
        addFinding('error', 'caption-rules', `[${track.language}] ${violation.message}`, {
          ...(isFiniteNumber(violation.timestamp) ? { timestamp: violation.timestamp } : {}),
          details: enriched,
        });
      }
    }

    const totalCues = captionReports.reduce((sum, r) => sum + r.cueCount, 0);
    const captionsOk = allCaptionViolations.length === 0;
    addCheck(
      'caption-rules',
      captionsOk,
      captionsOk
        ? `all ${totalCues} caption cue(s) across ${captionReports.length} track(s) follow Netflix rules`
        : `${allCaptionViolations.length} Netflix caption rule violation(s) across ${captionReports.length} track(s)`
    );
  } else {
    addCheck('caption-rules', true, 'no caption tracks provided; skipped caption check', { skipped: true });
  }

  // 3. Step speech-fit verification
  const effectiveSteps = Array.isArray(steps) && steps.length > 0
    ? steps
    : Array.isArray(timeline?.steps)
      ? timeline.steps
      : [];

  let effectiveSegments = Array.isArray(segments) && segments.length > 0 ? segments : [];
  if (effectiveSegments.length === 0 && Array.isArray(timeline?.audio?.tracks) && timeline.audio.tracks.length > 0) {
    const derived = [];
    for (const track of timeline.audio.tracks) {
      if (track.kind !== 'narration') continue;
      let segDuration = isFiniteNumber(track.duration) ? track.duration : null;
      if (segDuration === null && track.src && !/^(?:https?:|data:|blob:)/i.test(track.src)) {
        const trackPath = resolve(resolvedBaseDir, track.src);
        const probed = await probeAudio(trackPath).catch(() => null);
        if (probed?.hasAudio && probed.duration > 0) segDuration = probed.duration;
      }
      if (segDuration !== null) {
        derived.push({
          stepIndex: track.stepIndex,
          start: track.start,
          end: round(track.start + segDuration, 4),
          duration: segDuration,
        });
      }
    }
    effectiveSegments = derived;
  }
  if (effectiveSegments.length === 0 && tracksToValidate.length > 0) {
    effectiveSegments = tracksToValidate[0].cues.map((cue) => ({
      stepIndex: cue.stepIndex,
      start: cue.start,
      end: cue.end,
      duration: round(cue.end - cue.start, 4),
    }));
  }

  const stepFitReport = stepFit.enabled !== false
    ? verifyStepSpeechFit({
        steps: effectiveSteps,
        segments: effectiveSegments,
        totalDuration: effectiveTotalDuration,
        tolerance: stepFit.tolerance ?? 0.05,
      })
    : { ok: true, checked: false, stepsCount: effectiveSteps.length, segmentsChecked: 0, violations: [] };

  if (stepFitReport.checked) {
    addCheck(
      'step-speech-fit',
      stepFitReport.ok,
      stepFitReport.ok
        ? `all ${stepFitReport.segmentsChecked} speech segment(s) fit within their step windows`
        : `${stepFitReport.violations.length} speech segment(s) overflow their step window`
    );
    for (const violation of stepFitReport.violations) {
      addFinding('error', 'step-speech-fit', violation.message, {
        ...(isFiniteNumber(violation.timestamp) ? { timestamp: violation.timestamp } : {}),
        details: violation,
      });
    }
  } else {
    addCheck('step-speech-fit', true, 'no steps or speech segments provided; skipped step-fit check', { skipped: true });
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    metrics: {
      loudness: {
        checked: loudnessMeasurements.length > 0,
        bounds,
        measurements: loudnessMeasurements,
      },
      captions: {
        checked: captionReports.length > 0,
        tracks: captionReports,
        violations: allCaptionViolations.length,
      },
      stepFit: stepFitReport,
    },
    findings,
  };
}
