// A terminal's cells drawn straight to 24-bit pixels, the way a GPU terminal such as Ghostty draws
// them: every cell at integer pixel edges (`Math.round(column × cell width)`), so a fractional cell
// size leaves no seam; box drawing and block elements as geometry spanning the exact cell, so
// borders connect at any line height; text from the bundled TrueType fonts; two-cell emoji from the
// system's colour emoji font. No palette quantization anywhere: what the application wrote is what
// the picture holds.
import { readdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadFont, scanFontFile } from './truetype.mjs';

const FONTS = fileURLToPath(new URL('../../fonts/', import.meta.url));
export const DEFAULT_FONT_FAMILY = 'Screen Kit Mono,JetBrains Mono,Noto Sans Symbols 2';

// --- Unicode widths ------------------------------------------------------------------------------

// East Asian Wide and Fullwidth ranges that are not emoji; emoji take their width from
// Emoji_Presentation. Together they match a modern terminal's (and Godfather's) idea of a cell.
const WIDE = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18aff], [0x1b000, 0x1b2ff],
  [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x20000, 0x2fffd], [0x30000, 0x3fffd]];
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const PRESENTATION = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const JOINER = 0x200d, TEXT_STYLE = 0xfe0e, EMOJI_STYLE = 0xfe0f;
const isRegional = code => code >= 0x1f1e6 && code <= 0x1f1ff;
const isSkinTone = code => code >= 0x1f3fb && code <= 0x1f3ff;

export function cellWidth(code) {
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  const char = String.fromCodePoint(code);
  if (code !== 0xad && ZERO_WIDTH.test(char)) return 0;
  if (isRegional(code)) return 1;
  if (PRESENTATION.test(char)) return 2;
  for (const [start, end] of WIDE) if (code >= start && code <= end) return 2;
  return 1;
}

const property = (kind, width, join) => (kind << 3) | ((width & 3) << 1) | (join ? 1 : 0);
const KIND = { other: 1, joiner: 2, regional: 3 };

/**
 * xterm's Unicode provider for widths as a modern terminal sees them: emoji and CJK take two cells; an
 * emoji with VS16 (⏸️) or a joined sequence (👨‍🦳) is one two-cell cluster; marks, skin tones and VS15
 * join the glyph before them. xterm's bundled provider is Unicode 6, which makes 🆗 one cell.
 */
export const unicodeProvider = {
  version: 'screen-kit-15',
  wcwidth: code => cellWidth(code),
  charProperties(code, preceding) {
    const width = cellWidth(code);
    if (preceding) {
      const kind = preceding >> 3, before = (preceding >> 1) & 3;
      if (kind === KIND.joiner) return property(KIND.other, Math.max(2, before, width), true);
      if (code === JOINER) return property(KIND.joiner, Math.max(before, 1), true);
      if (code === EMOJI_STYLE) return property(KIND.other, 2, true);
      if (code === TEXT_STYLE || width === 0 || isSkinTone(code)) return property(KIND.other, before, true);
      if (isRegional(code) && kind === KIND.regional) return property(KIND.other, 2, true);
    }
    return property(isRegional(code) ? KIND.regional : KIND.other, width, false);
  },
};

// --- colours -------------------------------------------------------------------------------------

export const hexColor = value => {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  if (!match) throw Error(`Invalid terminal colour: ${value}`);
  return parseInt(match[1], 16);
};

/** A theme ({bg, fg, palette: '#rrggbb:…' or an array}) as numbers, with the xterm 256-colour table. */
export function resolveTheme(theme) {
  const entries = Array.isArray(theme.palette) ? theme.palette : String(theme.palette ?? '').split(/[:\s,]+/).filter(Boolean);
  if (entries.length !== 8 && entries.length !== 16) throw Error('Terminal theme palette needs 8 or 16 colours');
  const base = entries.map(hexColor);
  const palette = [...base, ...(base.length === 8 ? base : [])];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let n = 0; n < 216; n++) palette.push((steps[Math.floor(n / 36)] << 16) | (steps[Math.floor(n / 6) % 6] << 8) | steps[n % 6]);
  for (let n = 0; n < 24; n++) { const grey = 8 + 10 * n; palette.push((grey << 16) | (grey << 8) | grey); }
  return { background: hexColor(theme.bg), foreground: hexColor(theme.fg), palette };
}

const mix = (a, b, share) => {
  const channel = shift => Math.round(((a >> shift) & 255) * (1 - share) + ((b >> shift) & 255) * share);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
};

// --- reading xterm's screen ----------------------------------------------------------------------

export const STYLE = { bold: 1, underline: 2, strike: 4, invisible: 8, overline: 16 };

/** The visible screen as plain data: per cell its cluster, width, resolved colours and styles. */
export function snapshotScreen(terminal, theme, { cursor = false } = {}) {
  const { columns, rows } = { columns: terminal.cols, rows: terminal.rows };
  const buffer = terminal.buffer.active;
  const text = Array.from({ length: columns * rows }, () => '');
  const widths = new Uint8Array(columns * rows), fg = new Uint32Array(columns * rows), bg = new Uint32Array(columns * rows);
  const styles = new Uint8Array(columns * rows);
  const cell = buffer.getNullCell();
  const cursorX = buffer.cursorX, cursorY = buffer.cursorY;
  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      if (!line?.getCell(column, cell)) { widths[index] = 1; fg[index] = theme.foreground; bg[index] = theme.background; continue; }
      widths[index] = cell.getWidth();
      text[index] = cell.getChars();
      let ink = cell.isFgRGB() ? cell.getFgColor() : cell.isFgPalette() ? theme.palette[cell.getFgColor()] ?? theme.foreground : theme.foreground;
      let paper = cell.isBgRGB() ? cell.getBgColor() : cell.isBgPalette() ? theme.palette[cell.getBgColor()] ?? theme.background : theme.background;
      if (cell.isInverse()) [ink, paper] = [paper, ink];
      if (cursor && row === cursorY && column === cursorX) [ink, paper] = [paper, ink];
      if (cell.isDim()) ink = mix(ink, paper, 0.5);
      fg[index] = ink; bg[index] = paper;
      styles[index] = (cell.isBold() ? STYLE.bold : 0) | (underlined(cell) ? STYLE.underline : 0)
        | (cell.isStrikethrough() ? STYLE.strike : 0) | (cell.isInvisible() ? STYLE.invisible : 0)
        | (cell.isOverline() ? STYLE.overline : 0);
    }
  }
  return { columns, rows, text, widths, fg, bg, styles };
}

/**
 * SGR 4 underline. xterm also reports an OSC 8 hyperlink as a dashed underline, which a terminal shows
 * only under the pointer, so a link's cell counts as underlined only with the SGR flag of its own.
 */
function underlined(cell) {
  if (!cell.isUnderline()) return false;
  if (!cell.extended?.urlId) return true;
  return Boolean((cell.fg ?? 0) & 0x10000000) || Boolean(((cell.extended._ext ?? 0) >> 26) & 7);
}

export function sameScreen(a, b) {
  if (!a || !b || a.columns !== b.columns || a.rows !== b.rows) return false;
  for (const key of ['widths', 'fg', 'bg', 'styles']) {
    const left = a[key], right = b[key];
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  }
  for (let i = 0; i < a.text.length; i++) if (a.text[i] !== b.text[i]) return false;
  return true;
}

// --- geometry: box drawing and blocks ------------------------------------------------------------

class Mask {
  constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8Array(width * height); }

  rect(x0, y0, x1, y1, value = 255) {
    const left = Math.max(0, Math.round(x0)), right = Math.min(this.width, Math.round(x1));
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(this.height, Math.round(y1)); y++)
      if (right > left) this.data.fill(value, y * this.width + left, y * this.width + right);
  }

  /** Pixels in the box covered by the share of their 4×4 samples `inside` holds; the larger coverage wins. */
  shape(inside, x0, y0, x1, y1) {
    const samples = 4;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.width, Math.ceil(x1)); x++) {
        let hits = 0;
        for (let i = 0; i < samples; i++)
          for (let j = 0; j < samples; j++) if (inside(x + (i + 0.5) / samples, y + (j + 0.5) / samples)) hits++;
        const value = Math.round(255 * hits / samples ** 2);
        if (value > this.data[y * this.width + x]) this.data[y * this.width + x] = value;
      }
  }
}

// Arms of U+2500–U+257F, four digits each in the order up, right, down, left: 0 none, 1 light,
// 2 heavy, 3 double; '-' marks a dash, arc or diagonal, drawn by its own rule.
const ARMS = ('0101 0202 1010 2020 - - - - - - - - 0110 0210 0120 0220 0011 0012 0021 0022 1100 1200 2100 2200 '
  + '1001 1002 2001 2002 1110 1210 2110 1120 2120 2210 1220 2220 1011 1012 2011 1021 2021 2012 1022 2022 '
  + '0111 0112 0211 0212 0121 0122 0221 0222 1101 1102 1201 1202 2101 2102 2201 2202 1111 1112 1211 1212 '
  + '2111 1121 2121 2112 2211 1122 1221 2212 1222 2122 2221 2222 - - - - 0303 3030 0310 0130 0330 0013 0031 0033 '
  + '1300 3100 3300 1003 3001 3003 1310 3130 3330 1013 3031 3033 0313 0131 0333 1303 3101 3303 1313 3131 3333 '
  + '- - - - - - - 0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010').split(' ');
// Dashes: [count, heavy, vertical]
const DASHES = { 0x2504: [3, 0, 0], 0x2505: [3, 1, 0], 0x2506: [3, 0, 1], 0x2507: [3, 1, 1], 0x2508: [4, 0, 0],
  0x2509: [4, 1, 0], 0x250a: [4, 0, 1], 0x250b: [4, 1, 1], 0x254c: [2, 0, 0], 0x254d: [2, 1, 0], 0x254e: [2, 0, 1], 0x254f: [2, 1, 1] };
const SHADES = { 0x2591: 64, 0x2592: 128, 0x2593: 191 };
// Quadrants: a upper left, b upper right, c lower left, d lower right
const QUADRANTS = { 0x2596: 'c', 0x2597: 'd', 0x2598: 'a', 0x2599: 'acd', 0x259a: 'ad', 0x259b: 'abc', 0x259c: 'abd',
  0x259d: 'b', 0x259e: 'bc', 0x259f: 'bcd' };

export const isGeometry = code => (code >= 0x2500 && code <= 0x259f) || (code >= 0x1fb82 && code <= 0x1fb8b);

/** Line weights snapped to whole pixels and centred the same way in every cell, so lines meet. */
export function strokes(fontSize) {
  const light = Math.max(1, Math.round(fontSize / 15));
  return { light, heavy: 2 * light };
}
const centred = (size, stroke) => Math.floor((size - stroke) / 2);

/** A box-drawing or block character as coverage over a width × height cell. */
export function geometryMask(code, width, height, lines) {
  const mask = new Mask(width, height);
  if (code >= 0x2580) { block(mask, code); return mask; }
  const arms = ARMS[code - 0x2500];
  if (DASHES[code]) {
    const [count, heavy, vertical] = DASHES[code];
    const t = heavy ? lines.heavy : lines.light, size = vertical ? height : width;
    const x0 = centred(width, t), y0 = centred(height, t);
    for (let n = 0; n < count; n++) {
      const a = Math.round(size * n / count), b = Math.round(size * (n + 0.5) / count + size / count / 4);
      if (vertical) mask.rect(x0, a, x0 + t, b); else mask.rect(a, y0, b, y0 + t);
    }
    return mask;
  }
  if (code >= 0x256d && code <= 0x2570) { // ╭ ╮ ╯ ╰: a quarter circle from the middle of one edge to the next
    const t = lines.light, x0 = centred(width, t), y0 = centred(height, t);
    const sx = code === 0x256d || code === 0x2570 ? 1 : -1, sy = code <= 0x256e ? 1 : -1;
    const cx = x0 + t / 2, cy = y0 + t / 2;
    const radius = Math.min(sx > 0 ? width - cx : cx, sy > 0 ? height - cy : cy);
    const ox = cx + sx * radius, oy = cy + sy * radius;
    mask.shape((x, y) => {
      const dx = x - ox, dy = y - oy;
      return dx * -sx >= 0 && dy * -sy >= 0 && Math.abs(Math.hypot(dx, dy) - radius) <= t / 2;
    }, Math.min(cx, ox) - t, Math.min(cy, oy) - t, Math.max(cx, ox) + t, Math.max(cy, oy) + t);
    if (sy > 0) mask.rect(x0, oy, x0 + t, height); else mask.rect(x0, 0, x0 + t, oy);
    if (sx > 0) mask.rect(ox, y0, width, y0 + t); else mask.rect(0, y0, ox, y0 + t);
    return mask;
  }
  if (code >= 0x2571 && code <= 0x2573) {
    const half = lines.light / 2;
    const segment = (ax, ay, bx, by) => (x, y) => {
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= half;
    };
    if (code !== 0x2572) mask.shape(segment(width, 0, 0, height), 0, 0, width, height);
    if (code !== 0x2571) mask.shape(segment(0, 0, width, height), 0, 0, width, height);
    return mask;
  }
  const [up, right, down, left] = [...arms].map(Number);
  const stroke = weight => (weight === 2 ? lines.heavy : lines.light);
  // The centre stroke every arm runs through: the heaviest single line's, so arms of any weight overlap there
  const t = Math.max(...[up, right, down, left].filter(w => w === 1 || w === 2).map(stroke), lines.light);
  const x0 = centred(width, t), y0 = centred(height, t);
  // A double line: two light strokes a light stroke apart, centred like a single one
  const s = lines.light, doubleX = [centred(width, 3 * s)], doubleY = [centred(height, 3 * s)];
  doubleX[1] = doubleX[0] + 2 * s; doubleY[1] = doubleY[0] + 2 * s;
  const acrossH = left === 3 && right === 3 ? 2 : left === 3 || right === 3 ? 1 : 0;
  const acrossV = up === 3 && down === 3 ? 2 : up === 3 || down === 3 ? 1 : 0;
  for (const [direction, weight] of [['up', up], ['right', right], ['down', down], ['left', left]]) {
    if (!weight) continue;
    if (weight !== 3) {
      // A single line meets a double one at its nearer line where the double runs through, else at its farther
      const w = stroke(weight), sx = centred(width, w), sy = centred(height, w);
      if (direction === 'up') mask.rect(sx, 0, sx + w, [y0 + t, doubleY[1] + s, doubleY[0] + s][acrossH]);
      else if (direction === 'down') mask.rect(sx, [y0, doubleY[0], doubleY[1]][acrossH], sx + w, height);
      else if (direction === 'left') mask.rect(0, sy, [x0 + t, doubleX[1] + s, doubleX[0] + s][acrossV], sy + w);
      else mask.rect([x0, doubleX[0], doubleX[1]][acrossV], sy, width, sy + w);
      continue;
    }
    if (direction === 'left' || direction === 'right') {
      for (const [side, y] of [[-1, doubleY[0]], [1, doubleY[1]]]) {
        const across = side < 0 ? up : down, other = side < 0 ? down : up;
        // Where this line ends at the middle: inside a crossing double, at a single, or round the outside corner
        const inner = across === 3, outer = !across && other === 3;
        const leftEnd = inner ? doubleX[1] : outer ? doubleX[0] : x0;
        const rightEnd = inner ? doubleX[0] + s : outer ? doubleX[1] + s : x0 + t;
        if (direction === 'left') mask.rect(0, y, rightEnd, y + s); else mask.rect(leftEnd, y, width, y + s);
      }
    } else {
      for (const [side, x] of [[-1, doubleX[0]], [1, doubleX[1]]]) {
        const across = side < 0 ? left : right, other = side < 0 ? right : left;
        const inner = across === 3, outer = !across && other === 3;
        const topEnd = inner ? doubleY[1] : outer ? doubleY[0] : y0;
        const bottomEnd = inner ? doubleY[0] + s : outer ? doubleY[1] + s : y0 + t;
        if (direction === 'up') mask.rect(x, 0, x + s, bottomEnd); else mask.rect(x, topEnd, x + s, height);
      }
    }
  }
  return mask;
}

/** A block element: its exact share of the cell, rounded to whole pixels. */
function block(mask, code) {
  const w = mask.width, h = mask.height;
  if (code === 0x2580) mask.rect(0, 0, w, Math.round(h / 2));
  else if (code >= 0x2581 && code <= 0x2588) mask.rect(0, h - Math.round(h * (code - 0x2580) / 8), w, h);
  else if (code >= 0x2589 && code <= 0x258f) mask.rect(0, 0, Math.round(w * (0x2590 - code) / 8), h);
  else if (code === 0x2590) mask.rect(Math.round(w / 2), 0, w, h);
  else if (SHADES[code]) mask.rect(0, 0, w, h, SHADES[code]);
  else if (code === 0x2594) mask.rect(0, 0, w, Math.round(h / 8));
  else if (code === 0x2595) mask.rect(w - Math.round(w / 8), 0, w, h);
  else if (QUADRANTS[code]) {
    const mx = Math.round(w / 2), my = Math.round(h / 2);
    const boxes = { a: [0, 0, mx, my], b: [mx, 0, w, my], c: [0, my, mx, h], d: [mx, my, w, h] };
    for (const part of QUADRANTS[code]) mask.rect(...boxes[part]);
  } else if (code >= 0x1fb82 && code <= 0x1fb86) mask.rect(0, 0, w, Math.round(h * [2, 3, 5, 6, 7][code - 0x1fb82] / 8));
  else if (code >= 0x1fb87 && code <= 0x1fb8b) mask.rect(w - Math.round(w * [2, 3, 5, 6, 7][code - 0x1fb87] / 8), 0, w, h);
}

// --- fonts ---------------------------------------------------------------------------------------

const SYSTEM_FONT_DIRS = platform() === 'darwin'
  ? ['/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library/Fonts')]
  : ['/usr/share/fonts', '/usr/local/share/fonts', join(homedir(), '.local/share/fonts'), join(homedir(), '.fonts')];
// Glyphs no listed family has: symbol and monospace fonts a system usually carries
const FALLBACK_FILES = ['/System/Library/Fonts/Apple Symbols.ttf', '/System/Library/Fonts/Menlo.ttc',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf'];
const EMOJI_FAMILIES = 'Apple Color Emoji, Noto Color Emoji, Segoe UI Emoji, Twemoji';

async function fontFiles(directory, depth = 4) {
  const found = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...await fontFiles(path, depth - 1));
    else if (['.ttf', '.ttc', '.otf'].includes(extname(entry.name).toLowerCase())) found.push(path);
  }
  return found;
}

const scanned = new Map();
async function facesIn(directories) {
  const faces = [];
  for (const directory of directories) {
    if (!scanned.has(directory)) scanned.set(directory, fontFiles(directory).then(async files => (await Promise.all(files.map(scanFontFile))).flat()));
    faces.push(...await scanned.get(directory));
  }
  return faces;
}

const familyKey = name => name.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * The fonts a family list names, in order, each as {regular, bold}: the bundled fonts and `fontDir`
 * first, then the system's font directories. Then the fallbacks for a glyph none of them has.
 */
export async function resolveFonts({ fontFamily = DEFAULT_FONT_FAMILY, fontDir, cwd = process.cwd() } = {}) {
  const local = [FONTS, ...(fontDir ? [resolve(cwd, fontDir)] : [])];
  const families = String(fontFamily).split(',').map(name => name.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const chain = [], missing = [];
  const pick = async faces => {
    const upright = faces.filter(face => !face.italic);
    const pool = upright.length ? upright : faces;
    const regular = pool.find(face => !face.bold) ?? pool[0];
    const bold = pool.find(face => face.bold);
    return { family: regular.family, regular: await loadFont(regular.path, regular.index), bold: bold ? await loadFont(bold.path, bold.index) : null };
  };
  for (const family of families) {
    let faces = (await facesIn(local)).filter(face => familyKey(face.family) === familyKey(family));
    if (!faces.length) faces = (await facesIn(SYSTEM_FONT_DIRS)).filter(face => familyKey(face.family) === familyKey(family));
    if (faces.length) chain.push(await pick(faces)); else missing.push(family);
  }
  for (const family of DEFAULT_FONT_FAMILY.split(',')) {
    if (chain.some(entry => familyKey(entry.family) === familyKey(family))) continue;
    const faces = (await facesIn([FONTS])).filter(face => familyKey(face.family) === familyKey(family));
    if (faces.length) chain.push(await pick(faces));
  }
  for (const path of FALLBACK_FILES) {
    for (const face of await scanFontFile(path)) {
      if (face.italic || chain.some(entry => entry.regular.path === path)) continue;
      chain.push({ family: face.family, regular: await loadFont(path, face.index), bold: null });
      break;
    }
  }
  return { chain, missing };
}

// --- the frame -----------------------------------------------------------------------------------

/** Draws frames of one size, font and theme; glyphs are cached, so a frame like the last costs little. */
export class TerminalRaster {
  static async create({ columns, rows, fontSize = 20, lineHeight = 1.2, fontFamily, fontDir, cwd, theme }) {
    if (!(fontSize >= 4 && fontSize <= 200)) throw Error('Terminal fontSize must be between 4 and 200');
    if (!(lineHeight >= 0.5 && lineHeight <= 4)) throw Error('Terminal lineHeight must be between 0.5 and 4');
    const fonts = await resolveFonts({ fontFamily, fontDir, cwd });
    if (!fonts.chain.length) throw Error('No usable terminal font found');
    return new TerminalRaster({ columns, rows, fontSize, lineHeight, fonts, theme: resolveTheme(theme) });
  }

  constructor({ columns, rows, fontSize, lineHeight, fonts, theme }) {
    Object.assign(this, { columns, rows, fontSize, lineHeight, fonts, theme });
    const primary = this.primary = fonts.chain[0].regular;
    const scale = fontSize / primary.unitsPerEm;
    const glyph = primary.glyphIndex(0x4d) || primary.glyphIndex(0x30);
    // The advance unhinted: a fractional cell width, its edges snapped per cell
    this.cellWidth = primary.advance(glyph) * scale;
    this.cellHeight = fontSize * lineHeight;
    this.padX = Math.round(this.cellWidth);
    this.padY = Math.round(this.cellHeight / 2);
    this.width = this.x(columns) + this.padX;
    this.height = this.y(rows) + this.padY;
    const ascent = primary.ascender * scale, descent = -primary.descender * scale;
    this.baseline = Math.round((this.cellHeight - (ascent + descent)) / 2 + ascent);
    this.lines = strokes(fontSize);
    this.underline = {
      offset: Math.round(-primary.underlinePosition * scale),
      thickness: Math.max(1, Math.round(primary.underlineThickness * scale)),
    };
    this.strike = {
      offset: Math.round(-primary.strikeoutPosition * scale),
      thickness: Math.max(1, Math.round(primary.strikeoutSize * scale)),
    };
    this.glyphs = new Map();
  }

  x(column) { return this.padX + Math.round(column * this.cellWidth); }
  y(row) { return this.padY + Math.round(row * this.cellHeight); }

  /** One frame as packed RGB, 3 bytes a pixel. */
  async render(screen) {
    const { columns, rows } = screen;
    const width = this.width, height = this.height, pixels = Buffer.alloc(width * height * 3);
    fillRect(pixels, width, 0, 0, width, height, this.theme.background);
    const pending = [];
    for (let row = 0; row < rows; row++) {
      const top = this.y(row), bottom = this.y(row + 1);
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column, span = screen.widths[index];
        if (!span) continue;
        const left = this.x(column), right = this.x(Math.min(columns, column + span));
        if (screen.bg[index] !== this.theme.background) fillRect(pixels, width, left, top, right, bottom, screen.bg[index]);
        const text = screen.text[index];
        if (text && text !== ' ' && !(screen.styles[index] & STYLE.invisible))
          pending.push({ index, left, top, right, bottom, text, bold: Boolean(screen.styles[index] & STYLE.bold) });
      }
    }
    // Ink after every background, so a glyph reaching past its cell is not painted over by the next one
    const glyphs = await Promise.all(pending.map(cell => this.glyph(cell.text, cell.bold, cell.right - cell.left, cell.bottom - cell.top)));
    pending.forEach((cell, n) => {
      const glyph = glyphs[n];
      if (!glyph) return;
      if (glyph.rgba) blendImage(pixels, width, height, glyph, cell.left + glyph.x, cell.top + glyph.y);
      else blendMask(pixels, width, height, glyph, cell.left + glyph.x, cell.top + glyph.y, screen.fg[cell.index]);
    });
    for (let row = 0; row < rows; row++) {
      const top = this.y(row);
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column, style = screen.styles[index], span = screen.widths[index];
        if (!span || !(style & (STYLE.underline | STYLE.strike | STYLE.overline))) continue;
        const left = this.x(column), right = this.x(Math.min(columns, column + span)), ink = screen.fg[index];
        if (style & STYLE.underline) {
          const y = Math.min(top + this.baseline + this.underline.offset, this.y(row + 1) - this.underline.thickness);
          fillRect(pixels, width, left, y, right, y + this.underline.thickness, ink);
        }
        if (style & STYLE.strike) {
          const y = top + this.baseline + this.strike.offset;
          fillRect(pixels, width, left, y, right, y + this.strike.thickness, ink);
        }
        if (style & STYLE.overline) fillRect(pixels, width, left, top, right, top + this.underline.thickness, ink);
      }
    }
    return pixels;
  }

  glyph(text, bold, width, height) {
    const key = `${text}\u0000${bold ? 1 : 0}\u0000${width}\u0000${height}`;
    if (!this.glyphs.has(key)) this.glyphs.set(key, this.drawGlyph(text, bold, width, height));
    return this.glyphs.get(key);
  }

  async drawGlyph(text, bold, width, height) {
    const codes = [...text].map(char => char.codePointAt(0));
    const base = codes[0];
    if (isGeometry(base) && codes.every((code, n) => n === 0 || code === TEXT_STYLE)) {
      const mask = geometryMask(base, width, height, this.lines);
      return { data: mask.data, width, height, x: 0, y: 0 };
    }
    const span = Math.round(width / this.cellWidth) || 1;
    if ((span >= 2 || codes.includes(EMOJI_STYLE)) && PICTOGRAPHIC.test(text) && !codes.includes(TEXT_STYLE)) {
      const emoji = await this.emoji(text, width, height);
      if (emoji) return emoji;
    }
    const drawn = codes.filter(code => code !== JOINER && code !== TEXT_STYLE && code !== EMOJI_STYLE && !isSkinTone(code));
    const entry = this.fonts.chain.find(candidate => drawn.every(code => candidate.regular.glyphIndex(code)))
      ?? this.fonts.chain.find(candidate => candidate.regular.glyphIndex(base));
    if (!entry) return this.systemGlyph(text, width, height);
    const font = bold && entry.bold ? entry.bold : entry.regular;
    const scaleUnits = this.fontSize / font.unitsPerEm;
    const glyphs = drawn.map(code => font.glyphIndex(code) || entry.regular.glyphIndex(code)).filter(Boolean);
    if (!glyphs.length) return null;
    const advance = font.advance(glyphs[0]) * scaleUnits;
    // A fallback glyph wider than its cells is narrowed to fit them, as a terminal constrains symbols
    const size = advance > width * 1.05 ? this.fontSize * width / advance : this.fontSize;
    const drawnAdvance = advance * size / this.fontSize;
    const marginX = Math.ceil(this.cellWidth), marginY = Math.ceil(this.cellHeight / 2);
    const mask = new Mask(width + 2 * marginX, height + 2 * marginY);
    const originX = marginX + (width - drawnAdvance) / 2;
    for (const glyph of glyphs) font.rasterize(glyph, size, mask, originX, marginY + this.baseline, bold && !entry.bold ? 1 : 0);
    return { data: mask.data, width: mask.width, height: mask.height, x: -marginX, y: -marginY };
  }

  /** A colour emoji drawn by the system's emoji font, scaled to the text's height and centred in its cells. */
  async emoji(text, width, height) {
    try {
      const target = Math.max(1, Math.min(width, Math.round(this.fontSize * 1.15), height));
      const { data, info } = await sharp({ text: { text: escapeMarkup(text), font: `${EMOJI_FAMILIES} ${target * 4}px`, rgba: true, dpi: 72 } })
        .resize(target, target, { fit: 'inside', kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let ink = 0, colour = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3]) { ink++; if (Math.abs(data[i] - data[i + 1]) + Math.abs(data[i + 1] - data[i + 2]) > 24) colour++; }
      if (!ink || colour < ink / 20) return null; // no colour emoji font drew it: leave it to the text fonts
      return { rgba: true, data, width: info.width, height: info.height,
        x: Math.floor((width - info.width) / 2), y: Math.floor((height - info.height) / 2) };
    } catch { return null; }
  }

  /** A glyph no font file has, drawn by the system's text renderer and centred in its cells: the last resort. */
  async systemGlyph(text, width, height) {
    try {
      const { data, info } = await sharp({ text: { text: `<span foreground="white">${escapeMarkup(text)}</span>`, font: `sans ${this.fontSize}px`, rgba: true, dpi: 72 } })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const mask = new Uint8Array(info.width * info.height);
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3];
      return { data: mask, width: info.width, height: info.height,
        x: Math.floor((width - info.width) / 2), y: Math.floor((height - info.height) / 2) };
    } catch { return null; }
  }
}

const escapeMarkup = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fillRect(pixels, width, x0, y0, x1, y1, colour) {
  const r = (colour >> 16) & 255, g = (colour >> 8) & 255, b = colour & 255;
  const height = pixels.length / 3 / width;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(width, x1); y1 = Math.min(height, y1);
  for (let y = y0; y < y1; y++)
    for (let i = (y * width + x0) * 3, end = (y * width + x1) * 3; i < end; i += 3) { pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; }
}

function blendMask(pixels, width, height, mask, x, y, colour) {
  const r = (colour >> 16) & 255, g = (colour >> 8) & 255, b = colour & 255;
  for (let my = Math.max(0, -y); my < mask.height && y + my < height; my++)
    for (let mx = Math.max(0, -x); mx < mask.width && x + mx < width; mx++) {
      const a = mask.data[my * mask.width + mx];
      if (!a) continue;
      const i = ((y + my) * width + x + mx) * 3;
      if (a === 255) { pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; continue; }
      pixels[i] += Math.round((r - pixels[i]) * a / 255);
      pixels[i + 1] += Math.round((g - pixels[i + 1]) * a / 255);
      pixels[i + 2] += Math.round((b - pixels[i + 2]) * a / 255);
    }
}

function blendImage(pixels, width, height, image, x, y) {
  for (let iy = Math.max(0, -y); iy < image.height && y + iy < height; iy++)
    for (let ix = Math.max(0, -x); ix < image.width && x + ix < width; ix++) {
      const s = (iy * image.width + ix) * 4, a = image.data[s + 3];
      if (!a) continue;
      const i = ((y + iy) * width + x + ix) * 3;
      for (let c = 0; c < 3; c++) pixels[i + c] += Math.round((image.data[s + c] - pixels[i + c]) * a / 255);
    }
}
