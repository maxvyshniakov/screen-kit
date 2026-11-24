import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { encodeRawVideo, renderVideo, probeVideo } from '../src/video.mjs';

test('a real image sequence exports a silent two-second MP4 and WebM', async () => {
  const out = await mkdtemp(join(tmpdir(), 'screen-kit-video-'));
  try {
    for (const [index, background] of ['red', 'blue'].entries())
      await sharp({ create: { width: 80, height: 60, channels: 3, background } }).png().toFile(join(out, `${index}.png`));
    for (const format of ['mp4', 'webm']) {
      const result = await renderVideo({ input: join(out, '%d.png'), output: join(out, `demo.${format}`), fps: 1 });
      assert.equal(result.width, 80);
      assert.equal(result.height, 60);
      assert.equal(result.frames, 2);
      assert.equal(result.duration, 2);
      const info = await probeVideo(result.file);
      assert.equal(info.audio, false);
      const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', result.file, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
      assert.equal(pixels.length, 6);
      assert.ok(pixels[0] > 230 && pixels[2] < 20, 'first frame stays red');
      assert.ok(pixels[3] < 20 && pixels[5] > 230, 'second frame stays blue');
    }
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('Display P3 video preserves CICP metadata and P3 vs sRGB red separation in MP4 and WebM', async () => {
  const out = await mkdtemp(join(tmpdir(), 'screen-kit-video-p3-'));
  const width = 128;
  const height = 64;
  const p3Red = [255, 0, 0];
  const srgbRed = [234, 51, 35];
  const rawFrame = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 3;
      const rgb = x < width / 2 ? p3Red : srgbRed;
      rawFrame[off] = rgb[0];
      rawFrame[off + 1] = rgb[1];
      rawFrame[off + 2] = rgb[2];
    }
  }
  try {
    for (const index of [0, 1]) {
      await sharp(rawFrame, { raw: { width, height, channels: 3 } })
        .png()
        .toFile(join(out, `${index}.png`));
    }
    for (const format of ['mp4', 'webm']) {
      const result = await renderVideo({
        input: join(out, '%d.png'),
        output: join(out, `p3.${format}`),
        fps: 2,
        colorSpace: 'p3',
      });
      const info = await probeVideo(result.file);
      for (const meta of [result, info]) {
        assert.equal(meta.colorPrimaries, 'smpte432', `${format} colorPrimaries`);
        assert.equal(meta.colorTransfer, 'iec61966-2-1', `${format} colorTransfer`);
        assert.equal(meta.colorSpace, 'bt709', `${format} colorSpace`);
        assert.equal(meta.colorRange, 'tv', `${format} colorRange`);
      }

      const decoded = execFileSync('ffmpeg', [
        '-v', 'error', '-i', result.file,
        '-vf', 'scale=in_color_matrix=bt709', '-vframes', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ]);
      assert.equal(decoded.length, width * height * 3);
      const pick = (x, y) => {
        const off = (Math.floor(y) * width + Math.floor(x)) * 3;
        return [decoded[off], decoded[off + 1], decoded[off + 2]];
      };
      const left = pick(width * 0.25, height * 0.5);
      const right = pick(width * 0.75, height * 0.5);
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(left[c] - p3Red[c]) <= 3, `${format} p3Red channel ${c}: got ${left}, expected ${p3Red}`);
        assert.ok(Math.abs(right[c] - srgbRed[c]) <= 3, `${format} srgbRed channel ${c}: got ${right}, expected ${srgbRed}`);
      }
      const dist = Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
      assert.ok(dist >= 55, `${format} P3 vs sRGB red separation (${dist.toFixed(1)}) must remain distinct`);
    }
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('renderVideo rejects unknown colorSpace values', async () => {
  await assert.rejects(
    renderVideo({ input: '/tmp/in.png', output: '/tmp/out.mp4', colorSpace: 'rec2020' }),
    /unsupported colorSpace/,
  );
});

test('an encoder killed while the next frame is drawn fails the encoding instead of hanging it', async () => {
  // Killed by a signal, FFmpeg leaves exitCode null; its close may come before the next frame's write
  const out = await mkdtemp(join(tmpdir(), 'screen-kit-video-'));
  const path = process.env.PATH;
  try {
    await writeFile(join(out, 'ffmpeg'), '#!/bin/sh\nkill -9 $$\n');
    await chmod(join(out, 'ffmpeg'), 0o755);
    process.env.PATH = `${out}:${path}`;
    const width = 320, height = 240;
    async function* frames() {
      for (let k = 0; k < 3; k++) {
        yield Buffer.alloc(width * height * 3, k * 80);
        await new Promise(done => setTimeout(done, 300)); // drawing the next frame
      }
    }
    const hung = new Promise((_, fail) => setTimeout(() => fail(Error('encoding hung')), 5000).unref());
    await assert.rejects(Promise.race([encodeRawVideo({ frames: frames(), width, height, output: join(out, 'clip.mp4'), fps: 4 }), hung]), /ffmpeg failed/);
    assert.deepEqual((await readdir(out)).sort(), ['ffmpeg'], 'no hidden file is left behind');
  } finally {
    process.env.PATH = path;
    await rm(out, { recursive: true, force: true });
  }
});
