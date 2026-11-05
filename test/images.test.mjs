import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import { difference, comparison, reportPage, stack } from '../src/images.mjs';

test('difference detects changed pixels and incompatible sizes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = join(dir, 'a.png'), b = join(dir, 'b.png'), c = join(dir, 'c.png');
  await sharp({ create: { width: 2, height: 1, channels: 3, background: '#000' } }).png().toFile(a);
  await sharp(Buffer.from([0, 0, 0, 255, 255, 255]), { raw: { width: 2, height: 1, channels: 3 } }).png().toFile(b);
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toFile(c);
  assert.equal(await difference(a, a), 0);
  assert.equal(await difference(a, b), .5);
  assert.equal(await difference(a, c), null);
});

test('stack and comparison preserve all bands and produce a review picture', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-stack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const red = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 10, height: 20, channels: 3, background: 'blue' } }).png().toBuffer();
  const result = join(dir, 'stack.png');
  await stack([red, blue], result);
  const { width, height } = await sharp(result).metadata();
  assert.deepEqual([width, height], [20, 30]);
  const { data } = await sharp(result).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], [255, 0, 0]);
  const lower = (15 * width + 10) * 3;
  assert.deepEqual([...data.subarray(lower, lower + 3)], [0, 0, 255]);
  const review = join(dir, 'review.jpg');
  await comparison(null, result, review);
  assert.equal((await sharp(review).metadata()).height, 900);
  assert.ok((await readFile(review)).length > 0);
});

test('review report escapes recipe names and file names', () => {
  const html = reportPage({ date: '<today>', books: {}, shots: {
    '<script>alert(1)</script>': { width: 20, height: 30, before: null, changed: null },
  } });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('src="compare/<'));
});

test('stack retains saturated Display P3 pixels rather than clipping them through sRGB', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-p3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tagged = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
    .withIccProfile('p3').png().toBuffer();
  const { icc } = await sharp(tagged).metadata();
  // Encode a P3-primary red directly: converting an sRGB red to P3 would not
  // exercise gamut clipping, because that colour is inside both gamuts.
  const chunk = (name, data) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  const p3 = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('iCCP', Buffer.concat([Buffer.from('P3\0\0'), deflateSync(icc)])),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
  const file = join(dir, 'wide.png');
  await stack([p3, p3], file);
  const raw = await sharp(file).keepIccProfile().removeAlpha().raw().toBuffer();
  assert.deepEqual([...raw.subarray(0, 3)], [255, 0, 0]);
  assert.ok((await sharp(file).metadata()).icc.equals(icc));
});
