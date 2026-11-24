import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, extname, resolve, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { moveFileAtomic } from './internal/fs-paths.mjs';
import { buildColorEncodeArgs, probeVideo } from './internal/media.mjs';

const exec = promisify(execFile);

export { probeVideo };

const codecArgs = format => format === 'mp4'
  ? ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart']
  : ['-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good'];

/**
 * Encode frames drawn in memory (packed 8-bit RGB, `width` × `height`), streamed to FFmpeg with no
 * intermediate file. `frames` is an async iterable; each frame lasts 1/fps.
 */
export async function encodeRawVideo({ frames, width, height, output, fps, colorSpace = 'srgb', signal } = {}) {
  if (!frames || !output) throw Error('raw video encoding requires frames and an output path');
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) throw Error('raw video needs integer dimensions');
  if (!(Number.isFinite(fps) && fps > 0 && fps <= 120)) throw Error('fps must be between 0 and 120');
  output = resolve(output);
  const format = extname(output).slice(1);
  if (!['mp4', 'webm'].includes(format)) throw Error('video output must be .mp4 or .webm');
  const { vf, colorFlags } = buildColorEncodeArgs(colorSpace, format);
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.${basename(output)}-${randomUUID()}.${format}`);
  try {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0', '-an', '-vf', vf, '-pix_fmt', 'yuv420p',
      ...codecArgs(format), ...colorFlags, '-threads', '2', temporary], { stdio: ['pipe', 'ignore', 'pipe'], signal });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
    const exited = new Promise((success, failure) => {
      child.on('error', failure);
      child.on('close', code => code === 0 ? success() : failure(Error(`ffmpeg failed (${code}): ${errors}`)));
    });
    exited.catch(() => {});
    child.stdin.on('error', () => {});
    try {
      for await (const frame of frames) {
        if (frame.length !== width * height * 3) throw Error('raw video frame has the wrong size');
        if (child.exitCode !== null) break;
        if (!child.stdin.write(frame)) await new Promise(drained => {
          const done = () => { child.stdin.off('drain', done); child.off('close', done); drained(); };
          child.stdin.on('drain', done);
          child.on('close', done);
        });
      }
    } catch (error) {
      child.kill('SIGKILL');
      await exited.catch(() => {});
      throw error;
    } finally { child.stdin.end(); }
    await exited;
    const info = await probeVideo(temporary);
    if (!info.frames || !(info.duration > 0)) throw Error('encoder produced an empty video');
    await moveFileAtomic(temporary, output);
    return { file: output, format, ...info };
  } finally { await rm(temporary, { force: true }); }
}

/** Encode a real captured take or image sequence. Never records or drives an application. */
export async function renderVideo({ input, output, fps, colorSpace = 'srgb' } = {}) {
  if (!input || !output) throw Error('video rendering requires input and output paths');
  input = resolve(input);
  output = resolve(output);
  if (input === output) throw Error('video input and output must differ');
  const format = extname(output).slice(1);
  if (!['mp4', 'webm'].includes(format)) throw Error('video output must be .mp4 or .webm');
  const { vf, colorFlags } = buildColorEncodeArgs(colorSpace, format);
  if (fps !== undefined && !(Number.isFinite(fps) && fps > 0 && fps <= 120)) throw Error('fps must be between 0 and 120');
  const sequence = /%(?:0\d+)?d/.test(input);
  if (!sequence) await access(input);
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.${basename(output)}-${randomUUID()}.${format}`);
  const inputOptions = sequence ? ['-framerate', String(fps ?? 1)] : [];
  const codec = codecArgs(format);
  try {
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputOptions, '-i', input,
      '-an', '-vf', vf, '-pix_fmt', 'yuv420p',
      ...(fps && !sequence ? ['-r', String(fps)] : []), ...codec, ...colorFlags, '-threads', '2', temporary],
    { timeout: 300000, maxBuffer: 5e6 });
    const info = await probeVideo(temporary);
    if (!info.frames || !(info.duration > 0)) throw Error('encoder produced an empty video');
    await moveFileAtomic(temporary, output);
    return { file: output, format, ...info };
  } finally { await rm(temporary, { force: true }); }
}
