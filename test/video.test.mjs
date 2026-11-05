import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { renderVideo, probeVideo } from '../src/video.mjs';

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
