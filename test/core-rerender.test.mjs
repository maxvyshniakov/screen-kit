import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTerminalTake } from '../src/terminal.mjs';

test('an existing take can be rendered again without launching its application or changing the take', async () => {
  const out = await mkdtemp(join(tmpdir(), 'screen-kit-rerender-'));
  try {
    const cast = join(out, 'original.cast');
    const source = [JSON.stringify({ version: 2, width: 20, height: 4 }),
      JSON.stringify([0, 'o', '\x1b[2J\x1b[Halpha']),
      JSON.stringify([1, 'o', '\x1b[Hbeta ']), JSON.stringify([2, 'm', 'end'])].join('\n') + '\n';
    await writeFile(cast, source);
    const image = await renderTerminalTake({ cast, out, name: 'again', recipe: { format: 'webp', fps: 1 } });
    assert.ok(image.frames >= 2);
    assert.equal(image.duration, 2);
    const video = await renderTerminalTake({ cast, out, name: 'again-video', recipe: { format: 'mp4', fps: 1 } });
    assert.equal(video.duration, 2);
    assert.equal(await readFile(cast, 'utf8'), source);
  } finally { await rm(out, { recursive: true, force: true }); }
});
