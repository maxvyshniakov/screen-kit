// Probe: Display P3 preservation across Chromium still screenshot, CDP Page.startScreencast,
// ffmpeg H.264 MP4 / VP9 WebM encoding, ffprobe metadata, decoded pixels, and Chromium <video> playback.
//
// Run under slotfather:
//   slotfather run -n 1 -- node docs/research/p3-video-spike-2026-11-22/probe.mjs
//
// Artifacts are written to a temporary directory and removed on exit unless KEEP_OUT=1 is set.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';

const W = 640;
const H = 360;

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const cacheDir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(cacheDir)) {
    const dirs = fs.readdirSync(cacheDir)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
        const bin = path.join(cacheDir, d, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
        if (fs.existsSync(bin)) return bin;
      }
    }
  }
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(sys)) return sys;
  throw Error('Could not find Chromium/Chrome binary; set CHROME_BIN');
}

function parseIccDescription(iccBuf) {
  if (!iccBuf || iccBuf.length < 132) return null;
  const tagCount = iccBuf.readUInt32BE(128);
  for (let i = 0; i < tagCount; i++) {
    const off = 132 + i * 12;
    if (off + 12 > iccBuf.length) break;
    const sig = iccBuf.subarray(off, off + 4).toString('ascii');
    if (sig !== 'desc') continue;
    const dataOff = iccBuf.readUInt32BE(off + 4);
    const dataLen = iccBuf.readUInt32BE(off + 8);
    if (dataOff + dataLen > iccBuf.length) break;
    const tagType = iccBuf.subarray(dataOff, dataOff + 4).toString('ascii');
    if (tagType === 'desc') {
      const strLen = iccBuf.readUInt32BE(dataOff + 8);
      return iccBuf.subarray(dataOff + 12, dataOff + 12 + Math.max(0, strLen - 1)).toString('ascii');
    }
    if (tagType === 'mluc') {
      const recCount = iccBuf.readUInt32BE(dataOff + 8);
      if (recCount > 0) {
        const len = iccBuf.readUInt32BE(dataOff + 20);
        const strOff = iccBuf.readUInt32BE(dataOff + 24);
        const raw = iccBuf.subarray(dataOff + strOff, dataOff + strOff + len);
        let out = '';
        for (let j = 0; j + 1 < raw.length; j += 2) out += String.fromCharCode(raw.readUInt16BE(j));
        return out;
      }
    }
  }
  return `icc(${iccBuf.length}B)`;
}

function inspectPngChunks(buf) {
  const info = { iccpName: null, iccDesc: null, cicp: null, srgb: null, gama: null, chrm: false };
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return info;
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'iCCP') {
      const nul = data.indexOf(0);
      if (nul !== -1) {
        info.iccpName = data.subarray(0, nul).toString('latin1');
        try {
          const icc = zlib.inflateSync(data.subarray(nul + 2));
          info.iccDesc = parseIccDescription(icc);
        } catch {
          info.iccDesc = 'inflate-error';
        }
      }
    } else if (type === 'cICP' && data.length >= 4) {
      info.cicp = { primaries: data[0], transfer: data[1], matrix: data[2], fullRange: data[3] };
    } else if (type === 'sRGB' && data.length >= 1) {
      info.srgb = data[0];
    } else if (type === 'gAMA' && data.length >= 4) {
      info.gama = data.readUInt32BE(0) / 100000;
    } else if (type === 'cHRM') {
      info.chrm = true;
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  return info;
}

function inspectJpegIcc(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { iccBytes: 0, iccDesc: null };
  let pos = 2;
  const chunks = [];
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break;
    const marker = buf[pos + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = buf.readUInt16BE(pos + 2);
    if (marker === 0xe2 && len > 16) {
      const seg = buf.subarray(pos + 4, pos + 2 + len);
      if (seg.subarray(0, 12).toString('ascii') === 'ICC_PROFILE\0') {
        chunks.push({ seq: seg[12], data: seg.subarray(14) });
      }
    }
    pos += 2 + len;
  }
  if (!chunks.length) return { iccBytes: 0, iccDesc: null };
  chunks.sort((a, b) => a.seq - b.seq);
  const icc = Buffer.concat(chunks.map((c) => c.data));
  return { iccBytes: icc.length, iccDesc: parseIccDescription(icc) };
}

function sampleRawRgb(raw, width, height, channels = 3) {
  const pick = (x, y) => {
    const off = (Math.floor(y) * width + Math.floor(x)) * channels;
    return [raw[off], raw[off + 1], raw[off + 2]];
  };
  const p3Red = pick(width * 0.25, height * 0.5);
  const srgbRed = pick(width * 0.75, height * 0.5);
  const delta = [p3Red[0] - srgbRed[0], p3Red[1] - srgbRed[1], p3Red[2] - srgbRed[2]];
  const dist = Number(Math.hypot(...delta).toFixed(1));
  return { p3Red, srgbRed, delta, dist, distinct: dist >= 10 };
}

async function analyzeImage(file) {
  const buf = fs.readFileSync(file);
  const meta = await sharp(buf).metadata();
  const isPng = buf.readUInt32BE(0) === 0x89504e47;
  const formatMeta = isPng ? inspectPngChunks(buf) : inspectJpegIcc(buf);
  const iccBytes = meta.icc?.length ?? 0;
  const iccDesc = meta.icc ? parseIccDescription(meta.icc) : (formatMeta.iccDesc ?? null);

  // Decode raw encoded pixel values via ffmpeg (never applies ICC color management),
  // unlike sharp/libvips which may transform ICC-tagged inputs into sRGB.
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  const pixels = sampleRawRgb(raw, meta.width, meta.height, 3);

  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    iccBytes,
    iccDesc,
    ...(isPng ? { cicp: formatMeta.cicp, srgbChunk: formatMeta.srgb } : {}),
    ...pixels,
  };
}

function probeVideoStream(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height,color_range,color_space,color_transfer,color_primaries,nb_read_frames',
    '-count_frames', '-of', 'json', file,
  ], { encoding: 'utf8' });
  const stream = JSON.parse(out).streams[0];
  return {
    codec: stream.codec_name,
    profile: stream.profile,
    pix_fmt: stream.pix_fmt,
    size: `${stream.width}x${stream.height}`,
    frames: Number(stream.nb_read_frames),
    color_primaries: stream.color_primaries ?? 'unspecified',
    color_transfer: stream.color_transfer ?? 'unspecified',
    color_space: stream.color_space ?? 'unspecified',
    color_range: stream.color_range ?? 'unspecified',
  };
}

function decodeVideoFramePixels(file, inColorMatrix) {
  const vf = inColorMatrix
    ? `select=eq(n\\,10),scale=in_color_matrix=${inColorMatrix}`
    : 'select=eq(n\\,10)';
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-vf', vf, '-vframes', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return sampleRawRgb(raw, W, H, 3);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }
  off(method, fn) {
    this.listeners.get(method)?.delete(fn);
  }
  close() {
    this.ws.close();
  }
}

async function launchChromium({ headless, chromeBin }) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-probe-profile-'));
  const args = [
    '--force-color-profile=display-p3-d65',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${W},${H}`,
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const proc = spawn(chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let port = null;
  let stderrBuf = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Chromium launch timed out. stderr:\n${stderrBuf}`)), 15000);
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const m = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        port = Number(m[1]);
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`Chromium exited early (${code}). stderr:\n${stderrBuf}`));
    });
  });

  const versionInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === 'page');
  if (!pageTarget?.webSocketDebuggerUrl) throw Error('No page target found');

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new CDP(ws);

  async function close() {
    try { cdp.close(); } catch {}
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  return { cdp, version: versionInfo.Browser, close };
}

const TEST_HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; display: flex; }
  #p3   { width: 50%; height: 100%; background: color(display-p3 1 0 0); }
  #srgb { width: 50%; height: 100%; background: rgb(255, 0, 0); }
  #tick { position: fixed; right: 0; bottom: 0; width: 8px; height: 8px; background: #000; }
</style>
<div id="p3"></div><div id="srgb"></div><div id="tick"></div>
<script>
  let n = 0;
  const el = document.getElementById('tick');
  function step() { el.style.background = (++n & 1) ? '#000' : '#fff'; requestAnimationFrame(step); }
  requestAnimationFrame(step);
</script>`;

async function captureScreencastFrame(cdp, format, quality) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off('Page.screencastFrame', onFrame);
      cdp.send('Page.stopScreencast').catch(() => {});
      reject(Error(`Screencast (${format}) timed out`));
    }, 10000);
    let count = 0;
    const onFrame = async ({ data, sessionId }) => {
      await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      count++;
      if (count >= 3) {
        clearTimeout(timer);
        cdp.off('Page.screencastFrame', onFrame);
        await cdp.send('Page.stopScreencast').catch(() => {});
        resolve(Buffer.from(data, 'base64'));
      }
    };
    cdp.on('Page.screencastFrame', onFrame);
    await cdp.send('Page.startScreencast', {
      format,
      ...(format === 'jpeg' ? { quality } : {}),
      maxWidth: W,
      maxHeight: H,
      everyNthFrame: 1,
    });
  });
}

async function runBrowserMode({ headless, chromeBin, outDir }) {
  const label = headless ? 'headless' : 'headful';
  const session = await launchChromium({ headless, chromeBin });
  try {
    const { cdp } = session;
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(TEST_HTML)}`;
    await cdp.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 400));

    const gamut = await cdp.send('Runtime.evaluate', {
      expression: '({ p3: matchMedia("(color-gamut: p3)").matches, rec2020: matchMedia("(color-gamut: rec2020)").matches })',
      returnByValue: true,
    });

    const stillRes = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const stillPath = path.join(outDir, `${label}-still.png`);
    fs.writeFileSync(stillPath, Buffer.from(stillRes.data, 'base64'));

    const scPngPath = path.join(outDir, `${label}-screencast.png`);
    fs.writeFileSync(scPngPath, await captureScreencastFrame(cdp, 'png'));

    const scJpgPath = path.join(outDir, `${label}-screencast.jpg`);
    fs.writeFileSync(scJpgPath, await captureScreencastFrame(cdp, 'jpeg', 95));

    return {
      version: session.version,
      mediaGamut: gamut.result.value,
      stillPath,
      scPngPath,
      stillPng: await analyzeImage(stillPath),
      screencastPng: await analyzeImage(scPngPath),
      screencastJpeg: await analyzeImage(scJpgPath),
    };
  } finally {
    await session.close();
  }
}

function encodeVariant({ inputPng, outFile, args, decodeMatrix }) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', '30', '-t', '1', '-i', inputPng,
    '-an', ...args, '-threads', '2', outFile,
  ]);
  const stream = probeVideoStream(outFile);
  const decoded = decodeVideoFramePixels(outFile, decodeMatrix);
  return { file: outFile, stream, decoded };
}

async function testChromiumVideoPlayback({ chromeBin, videos, outDir }) {
  const session = await launchChromium({ headless: true, chromeBin });
  const results = {};
  try {
    const { cdp } = session;
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });
    for (const [name, info] of Object.entries(videos)) {
      const mime = info.file.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
      const b64 = fs.readFileSync(info.file).toString('base64');
      const html = `<!doctype html><style>html,body,video{margin:0;padding:0;width:${W}px;height:${H}px;display:block;background:#000}</style>
        <video id="v" muted autoplay playsinline src="data:${mime};base64,${b64}"></video>`;
      await cdp.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
      await cdp.send('Runtime.evaluate', {
        awaitPromise: true,
        expression: `new Promise((resolve, reject) => {
          const v = document.getElementById('v');
          const done = () => resolve({ readyState: v.readyState, w: v.videoWidth, h: v.videoHeight });
          if (v.readyState >= 2) return done();
          v.addEventListener('loadeddata', done, { once: true });
          v.addEventListener('error', () => reject(new Error('video error ' + v.error?.code)), { once: true });
          setTimeout(() => reject(new Error('video load timeout')), 8000);
        })`,
      });
      await new Promise((r) => setTimeout(r, 250));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const shotPath = path.join(outDir, `playback-${name}.png`);
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      results[name] = await analyzeImage(shotPath);
    }
  } finally {
    await session.close();
  }
  return results;
}

const chromeBin = findChrome();
const ffmpegVer = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0];
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-video-spike-'));

try {
  const headless = await runBrowserMode({ headless: true, chromeBin, outDir });
  let headful = null;
  if (!process.env.SKIP_HEADFUL) {
    try {
      headful = await runBrowserMode({ headless: false, chromeBin, outDir });
    } catch (err) {
      headful = { error: err.message };
    }
  }

  const basePng = headless.stillPath;
  const scPng = headless.scPngPath;
  const variants = {
    mp4_current: {
      input: basePng,
      ext: 'mp4',
      decodeMatrix: null,
      args: ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart'],
    },
    mp4_p3_cli_only: {
      input: basePng,
      ext: 'mp4',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart',
        '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    mp4_p3_setparams_iec61966_8bit: {
      input: basePng,
      ext: 'mp4',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart',
        '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    mp4_p3_setparams_bt709trc_8bit: {
      input: basePng,
      ext: 'mp4',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=bt709:colorspace=bt709:range=tv',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart',
        '-color_primaries', 'smpte432', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    mp4_p3_setparams_iec61966_10bit: {
      input: basePng,
      ext: 'mp4',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv',
        '-pix_fmt', 'yuv420p10le',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart',
        '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    mp4_p3_from_screencast_png: {
      input: scPng,
      ext: 'mp4',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart',
        '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    webm_current: {
      input: basePng,
      ext: 'webm',
      decodeMatrix: null,
      args: ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good'],
    },
    webm_p3_cli_only: {
      input: basePng,
      ext: 'webm',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-pix_fmt', 'yuv420p',
        '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good',
        '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    webm_p3_setparams_iec61966_8bit: {
      input: basePng,
      ext: 'webm',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good',
        '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    webm_p3_setparams_bt709trc_8bit: {
      input: basePng,
      ext: 'webm',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=bt709:colorspace=bt709:range=tv',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good',
        '-color_primaries', 'smpte432', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    webm_p3_setparams_iec61966_10bit: {
      input: basePng,
      ext: 'webm',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv',
        '-pix_fmt', 'yuv420p10le', '-profile:v', '2',
        '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good',
        '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
    webm_p3_from_screencast_png: {
      input: scPng,
      ext: 'webm',
      decodeMatrix: 'bt709',
      args: [
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good',
        '-color_primaries', 'smpte432', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
      ],
    },
  };

  const encodes = {};
  for (const [name, spec] of Object.entries(variants)) {
    const outFile = path.join(outDir, `${name}.${spec.ext}`);
    try {
      encodes[name] = encodeVariant({ inputPng: spec.input, outFile, args: spec.args, decodeMatrix: spec.decodeMatrix });
    } catch (err) {
      encodes[name] = { error: err.message };
    }
  }

  const playable = Object.fromEntries(Object.entries(encodes).filter(([, v]) => !v.error));
  const playback = await testChromiumVideoPlayback({ chromeBin, videos: playable, outDir });

  // Strip internal temp paths from JSON output
  const cleanBrowser = (b) => b && !b.error ? {
    version: b.version,
    mediaGamut: b.mediaGamut,
    stillPng: b.stillPng,
    screencastPng: b.screencastPng,
    screencastJpeg: b.screencastJpeg,
  } : b;
  const cleanEncodes = Object.fromEntries(Object.entries(encodes).map(([k, v]) => [k, v.error ? v : { stream: v.stream, decoded: v.decoded }]));

  console.log(JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    chromeBin,
    chromeVersion: headless.version,
    ffmpegVersion: ffmpegVer,
    capture: { headless: cleanBrowser(headless), headful: cleanBrowser(headful) },
    encodes: cleanEncodes,
    chromiumPlayback: playback,
  }, null, 2));
} finally {
  if (!process.env.KEEP_OUT) fs.rmSync(outDir, { recursive: true, force: true });
  else console.error(`Kept probe outputs in ${outDir}`);
}
