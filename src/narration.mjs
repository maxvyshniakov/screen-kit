import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertValidTimeline } from './timeline.mjs';

const exec = promisify(execFile);

export const TTS_PROVIDERS = ['gemini', 'kokoro'];
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
export const DEFAULT_GEMINI_VOICE = 'Kore';
export const DEFAULT_KOKORO_VOICE = 'af_heart';
export const DEFAULT_STEP_LEAD_IN = 0.2;
export const DEFAULT_STEP_LEAD_OUT = 0.4;

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
  tone,
  pacing,
  instructions,
  sampleRate,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (!isNonEmptyString(text)) {
    throw Error('synthesizeWithGemini requires non-empty text');
  }

  const resolvedKey = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!isNonEmptyString(resolvedKey)) {
    throw Error(
      'Gemini TTS requires API credentials: set GEMINI_API_KEY (or GOOGLE_API_KEY), pass apiKey explicitly, or use provider="kokoro" for offline synthesis.'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw Error('fetch is not available for Gemini TTS');
  }

  const languageCode = language ? normalizeLanguageCode(language) : undefined;
  const promptText = buildGeminiTtsPrompt({ text, language: languageCode, style, tone, pacing, instructions });
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(resolvedKey.trim())}`;

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
    headers: { 'content-type': 'application/json' },
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
  timeoutMs = 120000,
}) {
  const langCode = resolveKokoroLangCode(language);
  const cliCommand = executable ?? 'kokoro-tts';

  // 1. Try local kokoro-tts CLI if present
  try {
    await exec(
      cliCommand,
      ['--text', text, '--voice', voice, '--lang', langCode, '--speed', String(speed), '--output', outputFile],
      { timeout: timeoutMs, maxBuffer: 10e6 }
    );
    return { runtime: cliCommand };
  } catch (cliError) {
    if (executable || cliError?.code !== 'ENOENT') {
      if (executable) {
        throw Error(
          `Kokoro CLI '${cliCommand}' failed: ${cliError.stderr?.trim() || cliError.message}`
        );
      }
    }
  }

  // 2. Fall back to local Python kokoro runtime
  try {
    await exec(
      python,
      ['-c', KOKORO_PYTHON_SCRIPT, text, outputFile, voice, langCode, String(speed)],
      { timeout: timeoutMs, maxBuffer: 10e6 }
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
  speed = 1.0,
  executable,
  python = 'python3',
  runner,
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
      : null;
  const end = isFiniteNumber(entry.end)
    ? entry.end
    : isFiniteNumber(entry.endMs)
      ? entry.endMs / 1000
      : null;
  if (start === null || end === null) return null;
  return { word: word.trim(), start, end: Math.max(start, end) };
}

/**
 * Align known script text to monotonic word-level timestamps.
 * Uses provided forced-alignment `wordTimings` (e.g. Whisper/MFA/provider alignment) when present,
 * falling back to deterministic proportional syllable/character weighting.
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

    const aligned = [];
    let cursorTime = startOffset;

    for (let i = 0; i < tokens.length; i += 1) {
      let rawStart;
      let rawEnd;
      if (normalizedExternal.length === tokens.length) {
        rawStart = startOffset + normalizedExternal[i].start;
        rawEnd = startOffset + normalizedExternal[i].end;
      } else {
        const mappedIndex = Math.min(
          normalizedExternal.length - 1,
          Math.floor((i * normalizedExternal.length) / tokens.length)
        );
        const mappedNext = Math.min(
          normalizedExternal.length - 1,
          Math.floor(((i + 1) * normalizedExternal.length) / tokens.length)
        );
        const seg = normalizedExternal[mappedIndex];
        const nextSeg = normalizedExternal[mappedNext];
        rawStart = startOffset + seg.start;
        rawEnd = startOffset + Math.max(seg.end, mappedNext > mappedIndex ? nextSeg.start : seg.end);
      }

      const clampedStart = Math.max(cursorTime, Math.min(rawStart, maxEnd));
      const clampedEnd = Math.max(clampedStart, Math.min(rawEnd, maxEnd));
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
        enabled: true,
        tracks: captionTracks,
      },
    };
    if (!Array.isArray(updatedTimeline.steps) || updatedTimeline.steps.length === 0) {
      updatedTimeline.steps = scheduledSteps.map(({ t, index, label }) => ({ t, index, label }));
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

  const loudnessMeasurements = [];
  const loudnessIssues = [];

  if (loudness.enabled !== false && audioTargets.length > 0) {
    for (const target of audioTargets) {
      const measurement = await measureLoudness(target.path, {
        silenceThresholdLufs: bounds.silenceThresholdLufs,
      });
      const entry = { label: target.label, ...measurement };
      loudnessMeasurements.push(entry);

      if (!measurement.hasAudio) {
        const msg = `${target.label}: no audio stream found`;
        loudnessIssues.push(msg);
        addFinding('error', 'audio-loudness', msg, { details: entry });
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
        ? `audio loudness within [${bounds.minLufs}, ${bounds.maxLufs}] LUFS across ${loudnessMeasurements.length} file(s) (${loudnessMeasurements.map((m) => `${m.integratedLufs} LUFS`).join(', ')})`
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
  } else if (timeline?.overlays?.captions?.enabled && Array.isArray(timeline.overlays.captions.tracks)) {
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
