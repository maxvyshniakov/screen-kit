import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

/** Stack bands or themes without losing their colour space. */
export async function stack(buffers, file) {
  if (!buffers.length) throw Error('Cannot stack zero images');
  if (buffers.length === 1) return writeFile(file, buffers[0]);
  const metas = await Promise.all(buffers.map((buffer) => sharp(buffer).metadata()));
  // Existing browser captures share a profile. Preserve their encoded values;
  // converting P3 to sRGB before attaching P3 again clips saturated colours.
  const profile = metas[0].icc;
  const sameProfile = metas.every(meta => profile ? meta.icc?.equals(profile) : !meta.icc);
  const pieces = sameProfile ? buffers : await Promise.all(buffers.map(buffer =>
    sharp(buffer).pipelineColourspace('rgb16').withIccProfile('p3').png().toBuffer()));
  const width = Math.max(...metas.map((meta) => meta.width));
  let top = 0;
  const layers = metas.map((meta, index) => {
    const layer = { input: pieces[index], top, left: Math.round((width - meta.width) / 2) };
    top += meta.height;
    return layer;
  });
  const first = metas[0], left = Math.round((width - first.width) / 2);
  await sharp(pieces[0]).keepIccProfile().ensureAlpha().extend({
    top: 0, bottom: top - first.height, left, right: width - first.width - left, background: '#00000000',
  }).composite(layers.slice(1)).png().toFile(file);
}

/** Fraction of visibly different pixels, or null for incompatible dimensions. */
export async function difference(a, b) {
  const [x, y] = await Promise.all([a, b].map((file) =>
    sharp(file).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (x.info.width !== y.info.width || x.info.height !== y.info.height) return null;
  let changed = 0;
  for (let offset = 0; offset < x.data.length; offset += 4) {
    if ([0, 1, 2, 3].some((channel) => Math.abs(x.data[offset + channel] - y.data[offset + channel]) > 8)) changed++;
  }
  return changed / (x.data.length / 4);
}

export async function comparison(before, after, file) {
  const height = 900;
  const side = (path) => path
    ? sharp(path).resize({ height, width: 1400, fit: 'inside' }).flatten({ background: '#222' }).toBuffer()
    : sharp({ create: { width: 600, height, channels: 3, background: '#222' } }).png().toBuffer();
  const [left, right] = await Promise.all([side(before), side(after)]);
  const [a, b] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()]);
  await sharp({ create: { width: a.width + b.width + 24, height, channels: 3, background: '#555' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: a.width + 24, top: 0 }])
    .jpeg({ quality: 82 }).toFile(file);
}

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function reportPage(report) {
  const rows = Object.entries(report.shots).map(([name, shot]) => {
    const note = shot.changed === null
      ? `size ${shot.before ? `${shot.before.width}×${shot.before.height} → ` : ''}${shot.width}×${shot.height}`
      : `${(shot.changed * 100).toFixed(1)}% changed`;
    return `<h2>${escape(name)} <small>${escape(note)}</small></h2><img src="compare/${encodeURIComponent(name)}.jpg" loading="lazy">`;
  }).join('\n');
  const books = Object.entries(report.books ?? {}).map(([name, value]) =>
    `${name} ${value.version} (${String(value.revision).slice(0, 7)})`).join(', ');
  return `<!doctype html><meta charset="utf-8"><title>Screen-kit review</title>
<style>body{background:#111;color:#ddd;font:14px system-ui;margin:24px}img{max-width:100%;display:block}h2{font-size:16px;margin:32px 0 8px}small{color:#999;font-weight:400}</style>
<h1>Screen-kit review, ${escape(report.date)}</h1><p>Before on the left, after on the right. ${escape(books)}.</p>${rows}`;
}
