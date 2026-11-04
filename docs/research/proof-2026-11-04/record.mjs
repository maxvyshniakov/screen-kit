// Scripted demo clip: a DOM cursor glides in, a trackpad-like swipe scrolls the Data Grid,
// a second swipe overshoots the left edge and the rows rubber-band back, the cursor glides out.
// Headless Chromium (Playwright), 1280x800 CSS px at deviceScaleFactor 2, frames from CDP Page.startScreencast.
//
// Usage: node record.mjs <outDir>
//   STORY_URL  default http://localhost:6010/iframe.html?id=data-grid-showcase--default&viewMode=story
//   OB         overscroll-behavior-x forced on the grid's horizontal scrollers ('' = leave the story as shipped)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire('/Users/maxwish/data-grid/package.json');
const { chromium } = require('playwright');

const out = process.argv[2] ?? 'rec';
const framesDir = path.join(out, 'frames');
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });
const STORY = process.env.STORY_URL ?? 'http://localhost:6010/iframe.html?id=data-grid-showcase--default&viewMode=story';
const OB = process.env.OB ?? 'contain';

const W = 1280, H = 800, DPR = 2;
// Page.startScreencast caps frames at the viewport's CSS size (probe: 1280x800 even at deviceScaleFactor 2).
// ZOOM=1 renders at 2x instead: a 2560x1600 viewport at DPR 1 with html { zoom: 2 }, so layout stays 1280 px wide.
const ZOOM = process.env.ZOOM === '1';
const S = ZOOM ? DPR : 1; // input coordinates are in viewport px
const browser = await chromium.launch({ headless: true, ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}), args: (process.env.ARGS ?? '').split(' ').filter(Boolean) });
try {
  const ctx = await browser.newContext(ZOOM ? { viewport: { width: W * DPR, height: H * DPR }, deviceScaleFactor: 1 } : { viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  await page.goto(STORY, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-dg-shell="center-scroll"]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000); // product photos and layout settle
  if (ZOOM) await page.addStyleTag({ content: `html { zoom: ${DPR}; }` });
  if (ZOOM) await page.waitForTimeout(500);
  if (OB) await page.addStyleTag({ content: `[data-dg-shell] { overscroll-behavior-x: ${OB} !important; }` });

  // Cursor overlay: a macOS-style arrow drawn in the page, moved by rAF along a minimum-jerk path
  // with a slight arc, so its motion is as smooth as the page's own frames (no CDP round trip per step).
  await page.evaluate((ka) => { window.__keepalive = ka; }, process.env.KEEPALIVE !== '0');
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = '__demo_cursor';
    el.innerHTML = `<svg width="26" height="32" viewBox="0 0 26 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 1.5 L2 25 L7.6 19.6 L11.4 28.6 L15.6 26.8 L11.9 18.1 L19.6 18.1 Z"
        fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    Object.assign(el.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
      filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.35))', willChange: 'transform',
      transform: 'translate3d(1400px, 900px, 0)',
    });
    document.documentElement.appendChild(el);
    const state = { x: 1400, y: 900 };
    // Minimum-jerk profile (Flash & Hogan 1985): s(t) = 10t^3 - 15t^4 + 6t^5.
    const mj = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
    // Keep-alive: one near-invisible pixel changes every frame, so the compositor never idles and the
    // screencast does not need ~300 ms to wake up after a pause (seen without it). KEEPALIVE=0 turns it off.
    if (window.__keepalive) {
      const ka = document.createElement('div');
      Object.assign(ka.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', zIndex: '2147483647', pointerEvents: 'none' });
      document.documentElement.appendChild(ka);
      let k = 0; const tick = () => { ka.style.background = (k++ & 1) ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.02)'; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
    window.__loaf = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 80) window.__loaf.push({ start: e.startTime, dur: e.duration, block: e.blockingDuration, render: e.renderStart, style: e.styleAndLayoutStart,
      scripts: e.scripts.map((x) => ({ inv: x.invoker, type: x.invokerType, src: (x.sourceURL || '').split('/').slice(-2).join('/'), fn: x.sourceFunctionName, dur: Math.round(x.duration), layout: Math.round(x.forcedStyleAndLayoutDuration) })) }); })
      .observe({ type: 'long-animation-frame', buffered: false }); } catch {}
    window.__raf = [];
    const log = (now) => { const sc = document.querySelector('[data-dg-shell="center-scroll"]');
      window.__raf.push([now, sc ? sc.scrollLeft : 0, state.x, state.y]); requestAnimationFrame(log); };
    requestAnimationFrame(log);
    window.__cursorTo = (x, y, ms, arc = 0.12) => new Promise((resolve) => {
      const x0 = state.x, y0 = state.y, dx = x - x0, dy = y - y0;
      // Control point offset perpendicular to the path: hands move in slight arcs, not rulers.
      const cx = x0 + dx / 2 - dy * arc, cy = y0 + dy / 2 + dx * arc;
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms), s = mj(t), u = 1 - s;
        state.x = u * u * x0 + 2 * u * s * cx + s * s * x;
        state.y = u * u * y0 + 2 * u * s * cy + s * s * y;
        el.style.transform = `translate3d(${state.x}px, ${state.y}px, 0)`;
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  });

  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let writes = [];
  cdp.on('Page.screencastFrame', (f) => {
    const i = frames.length;
    frames.push(f.metadata.timestamp);
    writes.push(fs.promises.writeFile(path.join(framesDir, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const marks = [];
  const mark = (name) => marks.push({ name, t: Date.now() / 1000 });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * DPR, maxHeight: H * DPR, everyNthFrame: 1, maxFramesInFlight: Number(process.env.INFLIGHT ?? 3) });

  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-dg-shell="center-scroll"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width };
  });
  const gx = 700, gy = 400; // CSS px in the 1280x800 layout
  console.log('center-scroll rect', JSON.stringify(box));
  const swipe = (dx, speed) => cdp.send('Input.synthesizeScrollGesture', {
    x: gx * S, y: gy * S, xDistance: dx * S, yDistance: 0, gestureSourceType: 'mouse', speed: speed * S, preventFling: false,
  });

  if (process.env.WARMUP !== '0') {
    // Warm-up off the record: one swipe there and back mounts the off-screen columns and JIT-compiles the scroll path.
    // The screencast keeps running through the warm-up: in earlier takes the first scroll of a screencast
    // session lost ~267 ms of frames even though the page rendered them.
    await swipe(-300, 900); await page.waitForTimeout(400); await swipe(300, 900); await page.waitForTimeout(800);
    // SINGLE=1: start the take already scrolled to the right end; CDP screencast skipped every frame of a
    // plain in-range swipe in earlier takes (rAF kept ticking), while the overshoot swipe was captured whole.
    if (process.env.SINGLE === '1') await swipe(-300, 900);
    await page.waitForTimeout(1200);
    await Promise.all(writes); frames.length = 0; writes = []; fs.rmSync(framesDir, { recursive: true, force: true }); fs.mkdirSync(framesDir);
  }
  if (process.env.NUDGE === '1') {
    // Experiment: keep the scroller from idling before the swipe (1 px programmatic nudges every 250 ms).
    await page.evaluate(() => { const sc = document.querySelector('[data-dg-shell="center-scroll"]'); let k = 0;
      window.__nudge = setInterval(() => { sc.scrollLeft = sc.scrollWidth - sc.clientWidth - (k++ & 1); }, 250); });
  }
  await page.waitForTimeout(500);
  mark('cursor-in');
  await page.evaluate(([x, y]) => window.__cursorTo(x, y, 1100), [gx, gy]);
  await page.waitForTimeout(350);
  if (process.env.SINGLE !== '1') {
    mark('swipe-right');
    await swipe(-300, 900);           // negative xDistance scrolls right: content moves left
    await page.waitForTimeout(600);
  }
  await page.evaluate(() => clearInterval(window.__nudge));
  if (process.env.PRIME === '1') {
    // A 2 px gesture at the right end (nothing visibly moves): in every take the screencast lost ~267 ms of
    // frames at the start of the first gesture, while a gesture 0.6 s after another was captured whole.
    await swipe(-2, 200); await page.waitForTimeout(250);
  }
  mark('swipe-left-overshoot');
  await swipe(560, 1600);             // back past the left edge: 300 px of range, the rest is overscroll
  await page.waitForTimeout(1100);    // spring-back
  mark('cursor-out');
  await page.evaluate(() => window.__cursorTo(1400, 900, 1000, -0.1));
  await page.waitForTimeout(450);
  mark('end');
  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  const raf = await page.evaluate(() => ({ origin: performance.timeOrigin, log: window.__raf, loaf: window.__loaf }));
  fs.writeFileSync(path.join(out, 'raf.json'), JSON.stringify(raf));
  const scrollLeft = await page.evaluate(() => document.querySelector('[data-dg-shell="center-scroll"]').scrollLeft);
  fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify({ frames, marks, scrollLeft, OB, W, H, DPR }, null, 1));
  console.log(`frames ${frames.length}, span ${(frames.at(-1) - frames[0]).toFixed(2)}s, scrollLeft at end ${scrollLeft}`);
} finally {
  await browser.close();
}
