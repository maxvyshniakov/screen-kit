// TrueType (glyf) fonts read and rasterized in JavaScript, so terminal exports draw the bundled fonts
// exactly, on every platform, without a font system that may ignore a font file or substitute
// another family. Outlines only: no hinting, no CFF; a font without a `glyf` table is skipped.
import { open, readFile } from 'node:fs/promises';

function tables(view, offset) {
  const count = view.getUint16(offset + 4);
  const found = {};
  for (let i = 0; i < count; i++) {
    const record = offset + 12 + i * 16;
    const tag = String.fromCharCode(view.getUint8(record), view.getUint8(record + 1), view.getUint8(record + 2), view.getUint8(record + 3));
    found[tag] = { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) };
  }
  return found;
}

function faceOffsets(view) {
  if (view.getUint32(0) !== 0x74746366) return [0]; // 'ttcf'
  const count = view.getUint32(8);
  return Array.from({ length: count }, (_, i) => view.getUint32(12 + i * 4));
}

function decodeName(view, start, length, platform) {
  if (platform === 0 || platform === 3) {
    let text = '';
    for (let i = 0; i + 1 < length; i += 2) text += String.fromCharCode(view.getUint16(start + i));
    return text;
  }
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(start + i));
  return text;
}

/** A face's family name and weight from its `name`, `OS/2` and `head` tables. */
function describe(view, table) {
  const names = {};
  if (table.name) {
    const base = table.name.offset;
    const count = view.getUint16(base + 2), strings = base + view.getUint16(base + 4);
    for (let i = 0; i < count; i++) {
      const record = base + 6 + i * 12;
      const platform = view.getUint16(record), language = view.getUint16(record + 4), id = view.getUint16(record + 6);
      if (![1, 2, 16, 17].includes(id)) continue;
      const english = platform === 3 ? language === 0x409 : platform === 1 ? language === 0 : true;
      if (names[id] && !english) continue;
      names[id] = decodeName(view, strings + view.getUint16(record + 10), view.getUint16(record + 8), platform);
    }
  }
  const weight = table['OS/2'] ? view.getUint16(table['OS/2'].offset + 4) : 400;
  const macStyle = table.head ? view.getUint16(table.head.offset + 44) : 0;
  const style = names[17] ?? names[2] ?? '';
  return {
    family: names[16] ?? names[1] ?? '',
    bold: weight >= 600 || Boolean(macStyle & 1) || /bold|black|heavy/i.test(style),
    italic: Boolean(macStyle & 2) || /italic|oblique/i.test(style),
  };
}

/** Faces in a font file (one, or several in a collection) with their family names; nothing is parsed further. */
export async function scanFontFile(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const read = async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return new DataView(buffer.buffer, buffer.byteOffset, bytesRead);
    };
    const header = await read(0, 12 + 4 * 64);
    if (header.byteLength < 12) return [];
    const faces = [];
    for (const [index, offset] of faceOffsets(header).entries()) {
      const directory = await read(offset, 12);
      const count = directory.getUint16(4);
      const records = await read(offset, 12 + count * 16);
      const found = tables(records, 0);
      if (!found.glyf || !found.loca || !found.cmap) continue;
      // The tables the description needs, read into a sparse buffer at their own offsets
      const needed = ['name', 'OS/2', 'head'].filter(tag => found[tag]);
      const end = Math.max(...needed.map(tag => found[tag].offset + found[tag].length), 0);
      const sparse = new DataView(new ArrayBuffer(end));
      for (const tag of needed) {
        const part = await read(found[tag].offset, found[tag].length);
        new Uint8Array(sparse.buffer, found[tag].offset, part.byteLength).set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
      }
      faces.push({ path, index, ...describe(sparse, found) });
    }
    return faces;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

const cache = new Map();

/** A parsed face, kept per file and index: reading a font is the expensive part. */
export async function loadFont(path, index = 0) {
  const key = `${path}#${index}`;
  if (!cache.has(key)) cache.set(key, readFile(path).then(bytes => new Font(bytes, index, path)));
  return cache.get(key);
}

export class Font {
  constructor(bytes, index = 0, path = '') {
    this.path = path;
    const view = this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const table = this.tables = tables(view, faceOffsets(view)[index] ?? 0);
    for (const tag of ['head', 'hhea', 'hmtx', 'maxp', 'loca', 'glyf', 'cmap'])
      if (!table[tag]) throw Error(`${path}: not a TrueType outline font (no ${tag} table)`);
    Object.assign(this, describe(view, table));
    const head = table.head.offset;
    this.unitsPerEm = view.getUint16(head + 18);
    this.longLoca = view.getInt16(head + 50) === 1;
    const hhea = table.hhea.offset;
    this.ascender = view.getInt16(hhea + 4);
    this.descender = view.getInt16(hhea + 6);
    this.lineGap = view.getInt16(hhea + 8);
    this.metricCount = view.getUint16(hhea + 34);
    this.glyphCount = view.getUint16(table.maxp.offset + 4);
    const post = table.post?.offset;
    this.underlinePosition = post === undefined ? -Math.round(this.unitsPerEm / 10) : view.getInt16(post + 8);
    this.underlineThickness = post === undefined ? Math.round(this.unitsPerEm / 20) : view.getInt16(post + 10);
    const os2 = table['OS/2']?.offset;
    this.strikeoutSize = os2 === undefined ? this.underlineThickness : view.getInt16(os2 + 26);
    this.strikeoutPosition = os2 === undefined ? Math.round(this.unitsPerEm * 0.25) : view.getInt16(os2 + 28);
    this.cmap = this.readCmap();
    this.outlines = new Map();
  }

  readCmap() {
    const view = this.view, base = this.tables.cmap.offset;
    const count = view.getUint16(base + 2);
    let best, rank = -1;
    for (let i = 0; i < count; i++) {
      const platform = view.getUint16(base + 4 + i * 8), encoding = view.getUint16(base + 6 + i * 8);
      const offset = base + view.getUint32(base + 8 + i * 8), format = view.getUint16(offset);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode || ![4, 12].includes(format)) continue;
      const score = format === 12 ? 2 : 1;
      if (score > rank) { best = { format, offset }; rank = score; }
    }
    if (!best) return () => 0;
    if (best.format === 12) {
      const groups = view.getUint32(best.offset + 12);
      return code => {
        let low = 0, high = groups - 1;
        while (low <= high) {
          const middle = (low + high) >> 1, group = best.offset + 16 + middle * 12;
          const start = view.getUint32(group), end = view.getUint32(group + 4);
          if (code < start) high = middle - 1;
          else if (code > end) low = middle + 1;
          else return view.getUint32(group + 8) + code - start;
        }
        return 0;
      };
    }
    const segments = view.getUint16(best.offset + 6) / 2;
    const ends = best.offset + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
    return code => {
      if (code > 0xffff) return 0;
      let low = 0, high = segments - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const end = view.getUint16(ends + middle * 2), start = view.getUint16(starts + middle * 2);
        if (code > end) low = middle + 1;
        else if (code < start) high = middle - 1;
        else {
          const delta = view.getInt16(deltas + middle * 2), rangeAt = ranges + middle * 2, range = view.getUint16(rangeAt);
          if (range === 0) return (code + delta) & 0xffff;
          const glyph = view.getUint16(rangeAt + range + (code - start) * 2);
          return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
        }
      }
      return 0;
    };
  }

  glyphIndex(code) { return this.cmap(code); }

  advance(glyph) {
    const index = Math.min(glyph, this.metricCount - 1);
    return this.view.getUint16(this.tables.hmtx.offset + index * 4);
  }

  /** A glyph's contours in font units, each a list of [x, y, onCurve]. */
  outline(glyph, depth = 0) {
    if (this.outlines.has(glyph)) return this.outlines.get(glyph);
    const view = this.view, loca = this.tables.loca.offset;
    const start = this.longLoca ? view.getUint32(loca + glyph * 4) : view.getUint16(loca + glyph * 2) * 2;
    const end = this.longLoca ? view.getUint32(loca + glyph * 4 + 4) : view.getUint16(loca + glyph * 2 + 2) * 2;
    let contours = [];
    if (glyph < this.glyphCount && end > start) {
      const at = this.tables.glyf.offset + start;
      const count = view.getInt16(at);
      contours = count >= 0 ? this.simple(at, count) : depth < 8 ? this.composite(at, depth) : [];
    }
    this.outlines.set(glyph, contours);
    return contours;
  }

  simple(at, count) {
    const view = this.view;
    const endPoints = Array.from({ length: count }, (_, i) => view.getUint16(at + 10 + i * 2));
    const points = count ? endPoints[count - 1] + 1 : 0;
    let p = at + 10 + count * 2;
    p += 2 + view.getUint16(p);
    const flags = new Uint8Array(points);
    for (let i = 0; i < points;) {
      const flag = view.getUint8(p++);
      flags[i++] = flag;
      if (flag & 8) for (let repeat = view.getUint8(p++); repeat > 0 && i < points; repeat--) flags[i++] = flag;
    }
    const xs = new Int32Array(points), ys = new Int32Array(points);
    for (const [values, short, same] of [[xs, 2, 16], [ys, 4, 32]]) {
      let value = 0;
      for (let i = 0; i < points; i++) {
        const flag = flags[i];
        if (flag & short) { const delta = view.getUint8(p++); value += flag & same ? delta : -delta; }
        else if (!(flag & same)) { value += view.getInt16(p); p += 2; }
        values[i] = value;
      }
    }
    const contours = [];
    let first = 0;
    for (const last of endPoints) {
      const contour = [];
      for (let i = first; i <= last; i++) contour.push([xs[i], ys[i], Boolean(flags[i] & 1)]);
      contours.push(contour);
      first = last + 1;
    }
    return contours;
  }

  composite(at, depth) {
    const view = this.view, contours = [];
    let p = at + 10, flags;
    do {
      flags = view.getUint16(p);
      const component = view.getUint16(p + 2);
      p += 4;
      let dx, dy;
      if (flags & 1) { dx = view.getInt16(p); dy = view.getInt16(p + 2); p += 4; }
      else { dx = view.getInt8(p); dy = view.getInt8(p + 1); p += 2; }
      if (!(flags & 2)) dx = dy = 0; // point matching: rare in practice, placed at the origin
      let a = 1, b = 0, c = 0, d = 1;
      const f2dot14 = offset => view.getInt16(offset) / 16384;
      if (flags & 8) { a = d = f2dot14(p); p += 2; }
      else if (flags & 0x40) { a = f2dot14(p); d = f2dot14(p + 2); p += 4; }
      else if (flags & 0x80) { a = f2dot14(p); b = f2dot14(p + 2); c = f2dot14(p + 4); d = f2dot14(p + 6); p += 8; }
      for (const contour of this.outline(component, depth + 1))
        contours.push(contour.map(([x, y, on]) => [a * x + c * y + dx, b * x + d * y + dy, on]));
    } while (flags & 0x20);
    return contours;
  }

  /**
   * A glyph's coverage at `size` pixels per em, its origin at (originX, baseline) inside a
   * width × height mask; ink outside the mask is clipped.
   */
  rasterize(glyph, size, mask, originX, baseline, embolden = 0) {
    const scale = size / this.unitsPerEm;
    const lines = [];
    for (const contour of this.outline(glyph)) {
      const points = contour.map(([x, y, on]) => [originX + x * scale, baseline - y * scale, on]);
      lines.push(...flatten(points));
    }
    fill(lines, mask, embolden);
  }
}

/** A closed TrueType contour (on/off-curve points) as line segments in pixels. */
function flatten(points) {
  const count = points.length, segments = [];
  if (count < 2) return segments;
  let start = points.findIndex(point => point[2]);
  let first;
  if (start < 0) { // all off-curve: start between the first two
    first = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
    start = 0;
  } else first = points[start];
  let current = first, control = null;
  const curve = (end) => {
    const [x0, y0] = current, [cx, cy] = control, [x1, y1] = end;
    const ddx = x0 - 2 * cx + x1, ddy = y0 - 2 * cy + y1;
    const steps = Math.max(1, Math.ceil(Math.sqrt(Math.hypot(ddx, ddy) * 2)));
    let previous = current;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps, u = 1 - t;
      const next = [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
      segments.push([previous, next]);
      previous = next;
    }
  };
  for (let i = 1; i <= count; i++) {
    const point = points[(start + i) % count];
    const reachedStart = i === count;
    const target = reachedStart && points[start][2] === false ? first : point;
    if (target[2] === false && !reachedStart) {
      if (control) {
        const middle = [(control[0] + target[0]) / 2, (control[1] + target[1]) / 2];
        curve(middle);
        current = middle;
      }
      control = target;
      continue;
    }
    const end = reachedStart ? first : target;
    if (control) { curve(end); control = null; } else segments.push([current, end]);
    current = end;
  }
  if (control) curve(first);
  return segments;
}

/** Signed-area coverage (as font-rs and stb_truetype draw): exact anti-aliasing for any outline. */
function fill(lines, mask, embolden) {
  const { width, height } = mask;
  const area = new Float32Array(width * height + 4);
  for (const [[ax, ay], [bx, by]] of lines) {
    if (ay === by) continue;
    const [direction, x0, y0, x1, y1] = ay < by ? [1, ax, ay, bx, by] : [-1, bx, by, ax, ay];
    const slope = (x1 - x0) / (y1 - y0);
    let x = x0 - Math.min(0, y0) * slope;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
      const row = y * width;
      const dy = Math.min(y + 1, y1) - Math.max(y, y0);
      const next = x + slope * dy, d = dy * direction;
      const left = Math.max(0, Math.min(x, next)), right = Math.min(width - 1, Math.max(x, next));
      const leftFloor = Math.floor(left), rightCeil = Math.ceil(right);
      if (rightCeil <= leftFloor + 1) {
        const middle = Math.min(Math.max((x + next) / 2, 0), width - 1) - leftFloor;
        area[row + leftFloor] += d - d * middle;
        area[row + leftFloor + 1] += d * middle;
      } else {
        const inverse = 1 / (right - left), leftFraction = left - leftFloor;
        const first = 0.5 * inverse * (1 - leftFraction) * (1 - leftFraction);
        const rightFraction = right - rightCeil + 1, last = 0.5 * inverse * rightFraction * rightFraction;
        area[row + leftFloor] += d * first;
        if (rightCeil === leftFloor + 2) area[row + leftFloor + 1] += d * (1 - first - last);
        else {
          const second = inverse * (1.5 - leftFraction);
          area[row + leftFloor + 1] += d * (second - first);
          for (let column = leftFloor + 2; column < rightCeil - 1; column++) area[row + column] += d * inverse;
          const before = second + (rightCeil - leftFloor - 3) * inverse;
          area[row + rightCeil - 1] += d * (1 - before - last);
        }
        area[row + rightCeil] += d * last;
      }
      x = next;
    }
  }
  const data = mask.data;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += area[y * width + x];
      const value = Math.round(Math.min(1, Math.abs(sum)) * 255);
      if (value > data[y * width + x]) data[y * width + x] = value;
    }
  }
  if (embolden > 0) { // synthetic bold for a family without a bold face: the ink widened by a pixel
    for (let y = 0; y < height; y++)
      for (let x = width - 1; x > 0; x--) data[y * width + x] = Math.max(data[y * width + x], data[y * width + x - 1]);
  }
}
