import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { renderTerminalTake } from '../src/terminal.mjs';
import { TerminalRaster, geometryMask, strokes } from '../src/internal/terminal-raster.mjs';

const THEME = { bg: '#111213', fg: '#cacecd', palette: '#323232:#c22832:#8ec43d:#e0c64f:#43a5d5:#8b57b5:#8ec43d:#eeeeee:#3f3f3f:#c22832:#8ec43d:#e0c64f:#43a5d5:#8b57b5:#8ec43d:#ffffff' };
const HIDE_CURSOR = '\x1b[?25l';

async function withTake(width, height, events, run) {
  const out = await mkdtemp(join(tmpdir(), 'screen-kit-render-'));
  try {
    const cast = join(out, 'take.cast');
    await writeFile(cast, [{ version: 2, width, height }, ...events].map(record => JSON.stringify(record)).join('\n') + '\n');
    return await run({ out, cast });
  } finally { await rm(out, { recursive: true, force: true }); }
}

async function pixels(file, options = {}) {
  const { data, info } = await sharp(file, options).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, at: (x, y) => { const i = (y * info.width + x) * 3; return [data[i], data[i + 1], data[i + 2]]; } };
}

/** The renderer's own cell geometry, so a test samples the pixels the grid promises. */
const layout = (columns, rows, recipe = {}) => TerminalRaster.create({ columns, rows, theme: THEME, fontSize: recipe.fontSize ?? 20, lineHeight: recipe.lineHeight ?? 1.2 });

test('24-bit colours survive exactly: hundreds of distinct tints, no 256-colour quantization', async () => {
  const columns = 40, rows = 10;
  let text = HIDE_CURSOR;
  const expected = [];
  for (let row = 0; row < rows; row++) {
    text += `\x1b[${row + 1};1H`;
    for (let column = 0; column < columns; column++) {
      // A shallow two-channel gradient: neighbours differ by one or two levels, as selection tints do
      const colour = [20 + column, 30 + row * 3 + (column & 1), 40 + ((column * 7 + row) % 50)];
      expected.push({ row, column, colour });
      text += `\x1b[48;2;${colour.join(';')}m `;
    }
  }
  await withTake(columns, rows, [[0, 'o', text + '\x1b[0m']], async ({ out, cast }) => {
    const grid = await layout(columns, rows);
    for (const format of ['png', 'webp']) {
      const result = await renderTerminalTake({ cast, out, name: `tints-${format}`, recipe: { format, theme: THEME, ...(format === 'webp' ? { at: 1 } : {}) } });
      const image = await pixels(result.file);
      const seen = new Set();
      for (const { row, column, colour } of expected) {
        const x = Math.floor((grid.x(column) + grid.x(column + 1)) / 2), y = Math.floor((grid.y(row) + grid.y(row + 1)) / 2);
        assert.deepEqual(image.at(x, y), colour, `${format}: cell ${column},${row}`);
        seen.add(colour.join(','));
      }
      assert.ok(seen.size > 256, `${format}: ${seen.size} distinct colours must exceed a GIF palette`);
    }
  });
});

for (const recipe of [{ fontSize: 20, lineHeight: 1.2 }, { fontSize: 17, lineHeight: 1.2 }, { fontSize: 18.5, lineHeight: 1.35 }]) {
  test(`box-drawing borders are pixel-connected with no gaps at fontSize ${recipe.fontSize}, lineHeight ${recipe.lineHeight}`, async () => {
    const columns = 14, rows = 9;
    const box = (top, [tl, h, tr, v, bl, br], colour) =>
      `\x1b[38;2;${colour}m\x1b[${top};1H${tl}${h.repeat(10)}${tr}` + [1, 2].map(n => `\x1b[${top + n};1H${v}\x1b[${top + n};12H${v}`).join('') + `\x1b[${top + 3};1H${bl}${h.repeat(10)}${br}`;
    const text = HIDE_CURSOR + box(1, ['╭', '─', '╮', '│', '╰', '╯'], '255;0;0') + box(5, ['┏', '━', '┓', '┃', '┗', '┛'], '0;0;255') + '\x1b[0m';
    await withTake(columns, rows, [[0, 'o', text]], async ({ out, cast }) => {
      const result = await renderTerminalTake({ cast, out, name: 'borders', recipe: { format: 'png', theme: THEME, ...recipe } });
      const image = await pixels(result.file);
      const grid = await layout(columns, rows, recipe);
      for (const [top, channel] of [[0, 0], [4, 2]]) {
        const ink = (x, y) => image.at(x, y)[channel] > 160;
        // Coverage summed across the line, so an anti-aliased arc split over two pixels still counts as joined
        const coverage = (x, y) => Math.max(0, image.at(x, y)[channel] - 0x13) / (255 - 0x13);
        const inkInRow = (y, x0, x1) => { let sum = 0; for (let x = x0; x < x1; x++) sum += coverage(x, y); return sum >= 0.6; };
        const inkInColumn = (x, y0, y1) => { let sum = 0; for (let y = y0; y < y1; y++) sum += coverage(x, y); return sum >= 0.6; };
        // Every pixel column across the top and bottom edges, from the first straight cell to the last, carries the line
        for (const row of [top, top + 3]) {
          for (let x = grid.x(1); x < grid.x(11); x++) assert.ok(inkInColumn(x, grid.y(row), grid.y(row + 1)), `horizontal gap at x=${x}, row ${row}`);
        }
        // Every pixel row down the left and right edges, corner to corner, carries the line
        for (const column of [0, 11]) {
          for (let y = Math.floor((grid.y(top) + grid.y(top + 1)) / 2) + 2; y < Math.floor((grid.y(top + 3) + grid.y(top + 4)) / 2) - 2; y++)
            assert.ok(inkInRow(y, grid.x(column), grid.x(column + 1)), `vertical gap at y=${y}, column ${column}`);
        }
        // A straight line is one stroke, at the same pixels in every cell it crosses
        const strokeX = column => { const xs = []; for (let x = grid.x(column); x < grid.x(column + 1); x++) if (ink(x, Math.floor((grid.y(top + 1) + grid.y(top + 2)) / 2))) xs.push(x - grid.x(column)); return xs.join(); };
        assert.equal(strokeX(0), (() => { const xs = []; const y = Math.floor((grid.y(top + 2) + grid.y(top + 3)) / 2); for (let x = grid.x(0); x < grid.x(1); x++) if (ink(x, y)) xs.push(x - grid.x(0)); return xs.join(); })());
      }
    });
  });
}

test('box geometry: arms of every weight run edge to edge through one centre stroke', () => {
  const lines = strokes(20);
  for (const [code, edges] of [[0x2500, 'lr'], [0x2502, 'tb'], [0x253c, 'tblr'], [0x2501, 'lr'], [0x2503, 'tb'], [0x2576, 'r'], [0x2574, 'l'], [0x257b, 'b'], [0x2579, 't'], [0x256d, 'rb'], [0x256f, 'tl'], [0x2550, 'lr'], [0x2551, 'tb'], [0x2554, 'rb']]) {
    for (const [width, height] of [[12, 24], [11, 22], [12, 23]]) {
      const mask = geometryMask(code, width, height, lines);
      const at = (x, y) => mask.data[y * width + x];
      const rowInk = y => mask.data.subarray(y * width, (y + 1) * width).some(Boolean);
      const columnInk = x => { for (let y = 0; y < height; y++) if (at(x, y)) return true; return false; };
      const label = `U+${code.toString(16)} in ${width}×${height}`;
      assert.equal(rowInk(0), edges.includes('t'), `${label}: top edge`);
      assert.equal(rowInk(height - 1), edges.includes('b'), `${label}: bottom edge`);
      assert.equal(columnInk(0), edges.includes('l'), `${label}: left edge`);
      assert.equal(columnInk(width - 1), edges.includes('r'), `${label}: right edge`);
    }
  }
});

test('block elements fill their exact share of the cell, including eighths blocks', () => {
  const lines = strokes(20);
  const filled = (code, width = 12, height = 24) => geometryMask(code, width, height, lines).data.reduce((sum, value) => sum + (value === 255 ? 1 : 0), 0);
  assert.equal(filled(0x2588), 12 * 24);
  assert.equal(filled(0x2580), 12 * 12);
  assert.equal(filled(0x2584), 12 * 12);
  assert.equal(filled(0x258c), 6 * 24);
  assert.equal(filled(0x1fb85), 12 * 18); // 🮅 upper three quarters
  assert.equal(filled(0x1fb8b), 11 * 24); // right seven eighths, rounded to whole pixels
  assert.equal(filled(0x2591), 0); // a shade is partial coverage, never solid
});

test('SGR 4 underlines its cells; an OSC 8 hyperlink alone is not underlined', async () => {
  const text = HIDE_CURSOR + '\x1b[1;1H\x1b[38;2;255;255;255m\x1b[4m1\x1b[24m 2 ' + '\x1b]8;;https://example.com\x1b\\3\x1b]8;;\x1b\\' + '\x1b[0m';
  await withTake(10, 2, [[0, 'o', text]], async ({ out, cast }) => {
    const result = await renderTerminalTake({ cast, out, name: 'underline', recipe: { format: 'png', theme: THEME } });
    const image = await pixels(result.file);
    const grid = await layout(10, 2);
    const underlineRow = grid.y(0) + grid.baseline + grid.underline.offset;
    const white = (x, y) => image.at(x, y).every(value => value > 240);
    const across = column => { let count = 0; for (let x = grid.x(column); x < grid.x(column + 1); x++) if (white(x, underlineRow)) count++; return count; };
    assert.equal(across(0), grid.x(1) - grid.x(0), 'the underlined 1 has a line under its whole cell');
    assert.equal(across(2), 0, 'the plain 2 has none');
    assert.equal(across(4), 0, 'the hyperlinked 3 has none');
  });
});

test('animated WebP and PNG render without agg, gif2webp or any intermediate GIF', async () => {
  const events = [[0, 'o', '\x1b[2J\x1b[H\x1b[38;2;250;10;10malpha'], [1, 'o', '\x1b[H\x1b[38;2;10;250;10mbeta '], [2, 'o', '\x1b[H\x1b[38;2;10;10;250mgamma'], [3, 'm', 'end']];
  await withTake(12, 3, events, async ({ out, cast }) => {
    const emptyPath = join(out, 'no-tools');
    await mkdir(emptyPath);
    const path = process.env.PATH;
    process.env.PATH = emptyPath; // no agg, no gif2webp, no ffmpeg: stills and WebP need no external tool
    let animation, still;
    try {
      animation = await renderTerminalTake({ cast, out, name: 'anim', recipe: { format: 'webp', fps: 2, theme: THEME } });
      still = await renderTerminalTake({ cast, out, name: 'still', recipe: { format: 'png', at: 1.5, theme: THEME } });
    } finally { process.env.PATH = path; }
    assert.equal(animation.frames, 3, 'a repeated screen extends a frame rather than adding one');
    assert.equal(animation.duration, 3);
    const metadata = await sharp(animation.file, { animated: true }).metadata();
    assert.equal(metadata.pages, 3);
    assert.deepEqual(metadata.delay, [1000, 1000, 1000]);
    assert.equal(metadata.pageHeight, animation.height);
    const frames = await pixels(animation.file, { animated: true });
    const dominant = page => {
      const totals = [0, 0, 0];
      for (let y = page * animation.height; y < (page + 1) * animation.height; y++)
        for (let x = 0; x < animation.width; x++) { const [r, g, b] = frames.at(x, y); if (r > 200 || g > 200 || b > 200) { totals[0] += r; totals[1] += g; totals[2] += b; } }
      return totals.indexOf(Math.max(...totals));
    };
    assert.deepEqual([0, 1, 2].map(dominant), [0, 1, 2], 'red, then green, then blue text');
    assert.equal((await sharp(still.file).metadata()).format, 'png');
    assert.equal(still.frames, 1);
    assert.equal(still.videoInput, undefined);
    const files = [...await readdir(out), ...await readdir(join(out, 'takes')).catch(() => [])];
    assert.ok(!files.some(name => name.endsWith('.gif') || name.endsWith('.render.cast')), files.join(', '));
  });
});

test('MP4 and WebM stream from the replayed cells and name the take as their input', async () => {
  const events = [[0, 'o', '\x1b[2J\x1b[Halpha'], [1, 'o', '\x1b[Hbeta '], [2, 'm', 'end']];
  await withTake(20, 4, events, async ({ out, cast }) => {
    for (const format of ['mp4', 'webm']) {
      const video = await renderTerminalTake({ cast, out, name: `clip-${format}`, recipe: { format, fps: 4, theme: THEME } });
      assert.equal(video.videoInput, cast);
      assert.equal(video.frames, 8);
      assert.equal(video.duration, 2);
      assert.ok(video.width % 2 === 0 && video.height % 2 === 0);
    }
  });
});

test('a two-cell emoji takes two cells, so the text after it stays in its column', async () => {
  const text = HIDE_CURSOR + '\x1b[1;1H🆗\x1b[38;2;255;0;255mx\x1b[1;5H⏸️\x1b[38;2;0;255;255my\x1b[0m';
  await withTake(10, 2, [[0, 'o', text]], async ({ out, cast }) => {
    const result = await renderTerminalTake({ cast, out, name: 'emoji', recipe: { format: 'png', theme: THEME } });
    const image = await pixels(result.file);
    const grid = await layout(10, 2);
    const inkOf = (column, test) => { let count = 0; for (let y = grid.y(0); y < grid.y(1); y++) for (let x = grid.x(column); x < grid.x(column + 1); x++) if (test(image.at(x, y))) count++; return count; };
    const magenta = ([r, g, b]) => r > 200 && b > 200 && g < 60, cyan = ([r, g, b]) => g > 200 && b > 200 && r < 60;
    assert.ok(inkOf(2, magenta) > 10, 'x after 🆗 is in column 3');
    assert.equal(inkOf(1, magenta), 0);
    assert.ok(inkOf(6, cyan) > 10, 'y after ⏸️ (VS16) is in column 7');
    assert.equal(inkOf(5, cyan), 0);
  });
});

test('an animation begins when the application first draws, not on the blank screen before it', async () => {
  // Real takes open on an empty terminal while the program starts; that wait is no part of the picture
  const events = [[0.9, 'o', '\x1b[?25l\x1b[2J\x1b[H\x1b[38;2;250;10;10mready'], [1.9, 'o', '\x1b[H\x1b[38;2;10;250;10mnext '], [2.9, 'm', 'end']];
  await withTake(12, 3, events, async ({ out, cast }) => {
    const animation = await renderTerminalTake({ cast, out, name: 'trimmed', recipe: { format: 'webp', fps: 2, theme: THEME } });
    assert.equal(animation.frames, 2, 'red, then green: no blank frame first');
    assert.equal(animation.duration, 2);
    const { data, info } = await sharp(animation.file, { animated: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let red = 0;
    for (let i = 0; i < info.width * animation.height * 3; i += 3) if (data[i] > 200 && data[i + 1] < 80) red++;
    assert.ok(red > 20, 'the first frame already shows the first drawn screen');
    const explicit = await renderTerminalTake({ cast, out, name: 'from-start', recipe: { format: 'webp', fps: 2, start: 0, theme: THEME } });
    assert.equal(explicit.frames, 3, 'an explicit start keeps the blank opening');
    await assert.rejects(renderTerminalTake({ cast, out, name: 'late', recipe: { format: 'webp', start: 5, theme: THEME } }), /start must be within/);
  });
});

test('a changed attribute that draws nothing adds no frame, and the manifest counts the frames the WebP holds', async () => {
  // A bold blank cell is a new screen with the very same pixels; the WebP encoder would merge such frames
  const events = [[0, 'o', HIDE_CURSOR + '\x1b[2J\x1b[Halpha'], [1, 'o', '\x1b[1;8H\x1b[1m \x1b[0m'], [2, 'o', '\x1b[Hbeta '], [3, 'm', 'end']];
  await withTake(12, 2, events, async ({ out, cast }) => {
    const animation = await renderTerminalTake({ cast, out, name: 'same', recipe: { format: 'webp', fps: 2, theme: THEME } });
    const metadata = await sharp(animation.file, { animated: true }).metadata();
    assert.equal(animation.frames, metadata.pages);
    assert.equal(animation.frames, 2);
    assert.deepEqual(metadata.delay, [2000, 1000]);
    assert.equal(animation.duration, 3);
  });
});

test('the first frame is the screen at the start, and the last one ends on the take\'s last screen', async () => {
  // Both changes fall inside a frame's interval at 4 fps: one just after the start, one just before the end
  const events = [[0, 'o', HIDE_CURSOR + '\x1b[2J\x1b[H\x1b[38;2;250;10;10mfirst'], [0.1, 'o', '\x1b[H\x1b[38;2;10;250;10mnext '],
    [0.9, 'o', '\x1b[H\x1b[38;2;10;10;250mlast '], [1, 'm', 'end']];
  await withTake(12, 2, events, async ({ out, cast }) => {
    const animation = await renderTerminalTake({ cast, out, name: 'edges', recipe: { format: 'webp', fps: 4, start: 0, theme: THEME } });
    const frames = await pixels(animation.file, { animated: true });
    const dominant = page => {
      const totals = [0, 0, 0];
      for (let y = page * animation.height; y < (page + 1) * animation.height; y++)
        for (let x = 0; x < animation.width; x++) { const [r, g, b] = frames.at(x, y); if (r > 200 || g > 200 || b > 200) { totals[0] += r; totals[1] += g; totals[2] += b; } }
      return totals.indexOf(Math.max(...totals));
    };
    assert.equal(animation.frames, 3);
    assert.deepEqual([0, 1, 2].map(dominant), [0, 1, 2], 'the start screen, the next one, then the last');
    assert.deepEqual((await sharp(animation.file, { animated: true }).metadata()).delay, [250, 500, 250]);
  });
});

test('a take shorter than one frame shows its last screen', async () => {
  const events = [[0, 'o', HIDE_CURSOR + '\x1b[2J\x1b[H\x1b[38;2;250;10;10mfirst'], [0.05, 'o', '\x1b[H\x1b[38;2;10;10;250mlast '], [0.1, 'm', 'end']];
  await withTake(12, 2, events, async ({ out, cast }) => {
    const animation = await renderTerminalTake({ cast, out, name: 'brief', recipe: { format: 'webp', fps: 4, start: 0, duration: 0.1, theme: THEME } });
    assert.equal(animation.frames, 1);
    const image = await pixels(animation.file);
    let blue = 0, red = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) { const [r, , b] = image.at(x, y); if (b > 200 && r < 60) blue++; if (r > 200 && b < 60) red++; }
    assert.ok(blue > 20 && red === 0, `blue ${blue}, red ${red}`);
  });
});
