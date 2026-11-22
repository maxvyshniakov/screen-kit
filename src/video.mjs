import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, extname, resolve, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { moveFileAtomic } from './internal/fs-paths.mjs';
import { buildColorEncodeArgs, probeVideo } from './internal/media.mjs';

const exec = promisify(execFile);

export { probeVideo };

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
  const codec = format === 'mp4'
    ? ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart']
    : ['-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good'];
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
