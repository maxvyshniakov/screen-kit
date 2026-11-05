import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { reviewRun } from '../src/review.mjs';
import { hash } from '../src/run.mjs';

test('review detects a replaced artifact instead of approving its old provenance', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-review-'));
  try {
    const original = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'red' } }).png().toBuffer();
    const file = join(cwd, 'image.png');
    await writeFile(file, original);
    const manifest = join(cwd, 'run.json');
    await writeFile(manifest, JSON.stringify({ version: 1, status: 'complete', recipes: { sample: {
      status: 'complete', file: 'image.png', width: 8, height: 6, frames: 1, sha256: hash(original),
    } } }));
    assert.equal((await reviewRun({ manifest })).ok, true);
    await sharp({ create: { width: 8, height: 6, channels: 3, background: 'blue' } }).png().toFile(file);
    const result = await reviewRun({ manifest });
    assert.equal(result.ok, false);
    assert.match(result.checks.find(check => !check.ok).message, /hash/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
