import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const SUPPORTED_COLOR_SPACES = Object.freeze(['srgb', 'p3']);

export const DEFAULT_LOUDNESS_BOUNDS = Object.freeze({
  minLufs: -30,
  maxLufs: -6,
  targetLufs: -14,
  maxTruePeakDbfs: -0.5,
  silenceThresholdLufs: -60,
});

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

const fraction = (value) => {
  const [a, b = 1] = String(value).split('/').map(Number);
  return b ? a / b : 0;
};

/**
 * Single source of truth for Display P3 & sRGB (BT.709) FFmpeg video filtergraphs and CICP flags.
 * - `srgb` explicitly sets BT.709 color primaries, transfer, YCbCr matrix, and TV range (`bt709` / `tv`).
 * - `p3` sets Display P3 primaries (`smpte432`), sRGB transfer (`iec61966-2-1`), BT.709 matrix (`bt709`), and TV range (`tv`).
 */
export function buildColorEncodeArgs(colorSpace = 'srgb', format = 'mp4') {
  if (!SUPPORTED_COLOR_SPACES.includes(colorSpace)) {
    throw Error(`unsupported colorSpace: ${colorSpace}`);
  }
  const normalizedFormat =
    format === undefined || format === null
      ? 'mp4'
      : String(format).replace(/^\./, '').toLowerCase();
  if (!['mp4', 'webm'].includes(normalizedFormat)) {
    throw Error(`unsupported video format: ${format}`);
  }

  const isP3 = colorSpace === 'p3';
  const colorPrimaries = isP3 ? 'smpte432' : 'bt709';
  const colorTransfer = isP3 ? 'iec61966-2-1' : 'bt709';
  const matrixColorSpace = 'bt709';
  const colorRange = 'tv';

  const vfColor =
    `scale=out_color_matrix=${matrixColorSpace}:out_range=${colorRange},` +
    `setparams=color_primaries=${colorPrimaries}:color_trc=${colorTransfer}:colorspace=${matrixColorSpace}:range=${colorRange}`;
  const vf = `pad=ceil(iw/2)*2:ceil(ih/2)*2,${vfColor}`;
  const colorFlags = [
    '-color_primaries',
    colorPrimaries,
    '-color_trc',
    colorTransfer,
    '-colorspace',
    matrixColorSpace,
    '-color_range',
    colorRange,
  ];

  return {
    targetColorSpace: colorSpace,
    format: normalizedFormat,
    colorPrimaries,
    colorTransfer,
    colorSpace: matrixColorSpace,
    colorRange,
    vfColor,
    vf,
    colorFlags,
  };
}

export async function probeVideo(file) {
  const { stdout } = await exec(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', resolve(file)],
    { maxBuffer: 5e6 }
  );
  const info = JSON.parse(stdout);
  const stream = (info.streams ?? []).find((s) => s.codec_type === 'video');
  if (!stream) throw Error(`${file}: no video stream`);
  return {
    width: stream.width,
    height: stream.height,
    frames: Number(stream.nb_read_frames ?? stream.nb_frames),
    duration: Number(info.format.duration ?? stream.duration),
    fps: fraction(stream.avg_frame_rate),
    codec: stream.codec_name,
    audio: (info.streams ?? []).some((s) => s.codec_type === 'audio'),
    colorPrimaries: stream.color_primaries ?? null,
    colorTransfer: stream.color_transfer ?? null,
    colorSpace: stream.color_space ?? null,
    colorRange: stream.color_range ?? null,
  };
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

export function isWavBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

/**
 * Parse RIFF WAVE header metadata (`fmt ` + `data` chunks). Returns `null` when not a valid WAV buffer.
 */
export function parseWavHeader(buffer) {
  if (!isWavBuffer(buffer)) return null;

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ' && bodyStart + 16 <= buffer.length) {
      audioFormat = buffer.readUInt16LE(bodyStart);
      channels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      byteRate = buffer.readUInt32LE(bodyStart + 8);
      blockAlign = buffer.readUInt16LE(bodyStart + 12);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataSize = Math.min(chunkSize, Math.max(0, buffer.length - bodyStart));
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || channels < 1 || sampleRate <= 0) return null;
  const effectiveByteRate = byteRate > 0 ? byteRate : sampleRate * channels * (bitsPerSample / 8);
  const duration = effectiveByteRate > 0 ? dataSize / effectiveByteRate : 0;

  return {
    audioFormat,
    channels,
    sampleRate,
    byteRate: effectiveByteRate,
    blockAlign,
    bitsPerSample,
    dataOffset,
    dataSize,
    duration: round(duration, 4),
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

/**
 * Decode a 16-bit PCM RIFF WAVE buffer into interleaved stereo Float32 samples in `[-1, 1]`.
 * Mono WAV buffers are duplicated identically across left and right channels.
 */
export function extractPcm16SamplesStereo(wavBuffer) {
  if (!isWavBuffer(wavBuffer)) {
    throw Error('Expected standard RIFF WAVE buffer');
  }
  const header = parseWavHeader(wavBuffer);
  if (!header || header.audioFormat !== 1 || header.bitsPerSample !== 16 || header.dataOffset < 0 || header.channels < 1) {
    throw Error(
      `Unsupported WAV PCM format (format=${header?.audioFormat ?? 0}, bits=${header?.bitsPerSample ?? 0}, channels=${header?.channels ?? 0})`
    );
  }

  const { channels, sampleRate, dataOffset, dataSize } = header;
  const frameStride = channels * 2;
  const frameCount = Math.floor(dataSize / frameStride);
  const stereo = new Float32Array(frameCount * 2);

  for (let i = 0; i < frameCount; i += 1) {
    const base = dataOffset + i * frameStride;
    const left = wavBuffer.readInt16LE(base) / 32768;
    const right = channels >= 2 ? wavBuffer.readInt16LE(base + 2) / 32768 : left;
    stereo[i * 2] = left;
    stereo[i * 2 + 1] = right;
  }

  return { sampleRate, channels, frameCount, stereo };
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
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      'ebur128=peak=true',
      '-f',
      'null',
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
