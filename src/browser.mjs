import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { stack } from './images.mjs';

const exec = promisify(execFile);
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

// Trusted recipe expressions run in the page with these geometric helpers.
const helpers = String.raw`
const $ = {
  one: (selector, root = document) => root.querySelector(selector),
  all: (selector, root = document) => [...root.querySelectorAll(selector)],
  text(selector, text, root = document) {
    const found = [...root.querySelectorAll(selector)].filter(e => e.textContent.trim().startsWith(text));
    return found.find(e => !found.some(o => o !== e && e.contains(o))) ?? null;
  },
  section(heading) {
    const code = [...document.querySelectorAll('#storybook-root code, #storybook-root button')]
      .find(e => e.textContent.trim().startsWith(heading));
    return code?.closest('section') ?? code?.closest('button')?.parentElement ?? code?.parentElement ?? null;
  },
  box(...items) {
    const rects = items.flat(Infinity).filter(Boolean).flatMap(e =>
      getComputedStyle(e).display === 'contents' ? [...e.children].map(c => c.getBoundingClientRect()) : [e.getBoundingClientRect()])
      .filter(r => r.width && r.height);
    if (!rects.length) throw Error('clip matched nothing');
    const x = Math.min(...rects.map(r => r.left)), y = Math.min(...rects.map(r => r.top));
    return {x:x+scrollX,y:y+scrollY,width:Math.max(...rects.map(r=>r.right))-x,height:Math.max(...rects.map(r=>r.bottom))-y};
  },
  pad(r, top, right = top, bottom = top, left = right) {
    return {x:r.x-left,y:r.y-top,width:r.width+left+right,height:r.height+top+bottom};
  },
  content(root = '#storybook-root') {
    const r = typeof root === 'string' ? document.querySelector(root) : root;
    return [...r.querySelectorAll('*')].filter(e => e.closest('svg') ? e.tagName === 'svg' : !e.children.length && (e.textContent.trim() || e.tagName === 'IMG'));
  },
  ratio(r, ratio) {
    if (r.width/r.height > ratio) {const height=r.width/ratio;return {...r,y:r.y-(height-r.height)/2,height};}
    const width=r.height*ratio;return {...r,x:r.x-(width-r.width)/2,width};
  },
  click(target) {
    const e=typeof target==='string'?document.querySelector(target):target;
    if(!e) throw Error('nothing to click: '+target);
    for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])
      e.dispatchEvent(new(type.startsWith('pointer')?PointerEvent:MouseEvent)(type,{bubbles:true,cancelable:true,button:0,pointerType:'mouse',isPrimary:true}));
  },
  wait: ms => new Promise(r=>setTimeout(r,ms)),
};`;

export function storyUrl(base, recipe, theme) {
  if (recipe.url) return recipe.url;
  if (!base || !recipe.story) throw Error('Browser recipe needs url or base and story');
  const url = new URL('iframe.html', base.replace(/\/$/, '') + '/');
  url.search = `id=${encodeURIComponent(recipe.story)}&viewMode=story&globals=theme:${encodeURIComponent(theme)}`;
  if (recipe.args) url.search += `&args=${recipe.args}`;
  return url.href;
}

function validateName(name) {
  if (!/^[\w][\w.-]*$/.test(name)) throw Error(`Invalid recipe name: ${name}`);
}

export async function createBrowserCapture({ cwd = process.cwd(), out, scale = 3, session } = {}) {
  if (!out) throw Error('Browser capture needs an output directory');
  if (!Number.isFinite(scale) || scale <= 0) throw Error('Browser scale must be positive');
  cwd = resolve(cwd);
  out = resolve(cwd, out);
  await mkdir(out, { recursive: true });
  session ??= `screen-kit-${process.pid}-${Math.random().toString(36).slice(2, 9)}`;
  let launched = false, recording = false;
  const browse = async (...args) => (await exec('agent-browser', ['--session', session, ...args.map(String)],
    { cwd, timeout: 120000, maxBuffer: 5e7 })).stdout;
  const evaluate = async (code) => {
    const output = (await browse('eval', '--base64', Buffer.from(code).toString('base64'))).trim();
    return output ? JSON.parse(output) : undefined;
  };

  async function ready(recipe) {
    const selector = recipe.ready ?? (recipe.story ? '#storybook-root' : 'body');
    const timeout = recipe.readyTimeout ?? 20000;
    await evaluate(`(async()=>{
      const timeout=${JSON.stringify(timeout)};
      const until=async(test,label)=>{const deadline=Date.now()+timeout;while(!test()){if(Date.now()>deadline)throw Error('Capture readiness timed out: '+label);await new Promise(r=>setTimeout(r,50));}};
      await until(()=>document.querySelector(${JSON.stringify(selector)})${recipe.story ? '?.childElementCount' : ''},'mounted content');
      await Promise.race([document.fonts.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Fonts did not load')),timeout))]);
      for(const image of document.images) image.loading='eager';
      await until(()=>[...document.images].every(i=>i.complete),'images');
      if([...document.images].some(i=>!i.naturalWidth))throw Error('An image failed to load');
      await Promise.all([...document.images].map(i=>i.decode()));
      await new Promise(r=>setTimeout(r,100));return true;
    })()`);
  }

  async function open(url, viewport, recipe) {
    if (!launched) {
      // Mark before opening so a failed launch still attempts cleanup.
      launched = true;
      await browse('--args', '--force-color-profile=display-p3-d65', 'open', 'about:blank');
    }
    const [width, height] = viewport;
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw Error('Invalid browser viewport');
    await browse('set', 'viewport', width, height, scale);
    await browse('open', url);
    await ready(recipe);
    for (const action of recipe.prepare ?? []) await step(action);
  }

  async function step(action) {
    if (Array.isArray(action)) return browse(...action);
    if (typeof action === 'string') return evaluate(`(async()=>{${helpers}\n${action}\n})()`);
    if (!action || typeof action !== 'object') throw Error('Invalid browser action');
    if (action.key) return browse('press', action.key);
    if (action.click) return browse('click', action.click);
    if (action.command) return browse(...action.command);
    if (action.eval) return evaluate(`(async()=>{${helpers}\n${action.eval}\n})()`);
    if (action.wait !== undefined) return sleep(action.wait);
    throw Error(`Unknown browser action: ${JSON.stringify(action)}`);
  }

  async function shoot(url, viewport, recipe, file) {
    await open(url, viewport, recipe);
    for (const action of recipe.steps ?? []) await step(action);
    await browse('mouse', 'move', '0', '0');
    await sleep(recipe.settle ?? 500);
    await ready(recipe); // Interactions may have mounted new fonts or images.
    if (!recipe.clip) return browse('screenshot', file);
    const crop = await evaluate(`(()=>{${helpers}\nreturn (${recipe.clip});})()`);
    const bands = Array.isArray(crop) ? crop : [crop];
    if (!bands.length || bands.some(band => !band || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(band[key])) || band.width <= 0 || band.height <= 0)) throw Error('Invalid crop rectangles');
    const bottom = Math.max(...bands.map(band => band.y + band.height));
    const full = `${file}.full.png`;
    try {
      if (bottom <= viewport[1]) await browse('screenshot', full);
      else await browse('screenshot', '--full', full);
      const page = await sharp(full).metadata();
      const pieces = await Promise.all(bands.map(async (band) => {
        const left = Math.max(0, Math.round(band.x * scale)), top = Math.max(0, Math.round(band.y * scale));
        const right = Math.min(page.width, Math.round((band.x + band.width) * scale));
        const end = Math.min(page.height, Math.round((band.y + band.height) * scale));
        if (right <= left || end <= top) throw Error('Crop is outside the captured page');
        return sharp(full).keepIccProfile().extract({ left, top, width: right - left, height: end - top }).png().toBuffer();
      }));
      await stack(pieces, file);
    } finally { await rm(full, { force: true }); }
  }

  async function captureVideo(name, recipe, base) {
    if (recipe.frame || recipe.clip || (recipe.themes?.length ?? 1) > 1) throw Error('Video capture currently needs one uncropped browser viewport');
    const duration = recipe.duration ?? 5, fps = recipe.fps ?? 30;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600 || !Number.isInteger(fps) || fps < 1 || fps > 60) throw Error('Invalid video duration or fps');
    const format = recipe.format ?? recipe.output?.format ?? 'webm';
    if (!['webm', 'mp4'].includes(format)) throw Error(`Unsupported browser recording format: ${format}`);
    const url = storyUrl(base, recipe, recipe.themes?.[0] ?? 'dark');
    const viewport = recipe.viewport ?? [1440, 810];
    await open(url, viewport, recipe);
    for (const action of recipe.setup ?? []) await step(action);
    await ready(recipe);
    await browse('mouse', 'move', '0', '0');
    const file = join(out, `${name}.${format}`), events = [];
    await browse('record', 'start', file, '--fps', fps);
    recording = true;
    const start = performance.now();
    try {
      let previous = 0;
      for (const action of recipe.steps ?? []) {
        const at = action && typeof action === 'object' && !Array.isArray(action) ? action.at ?? previous : previous;
        if (!Number.isFinite(at) || at < previous || at > duration) throw Error('Browser recording action times must be ordered and within duration');
        await sleep(Math.max(0, at * 1000 - (performance.now() - start)));
        await step(action);
        events.push({ at: (performance.now() - start) / 1000, action });
        previous = at;
      }
      await sleep(Math.max(0, duration * 1000 - (performance.now() - start)));
    } finally {
      await browse('record', 'stop');
      recording = false;
    }
    return { file, width: Math.round(viewport[0] * scale), height: Math.round(viewport[1] * scale),
      duration, fps, videoInput: file, events, source: { url, scale, format, kind: 'browser-recording' } };
  }

  async function capture(name, recipe, base) {
    validateName(name);
    if (['webm', 'mp4'].includes(recipe.format ?? recipe.output?.format)) return captureVideo(name, recipe, base);
    const themes = recipe.themes ?? ['dark'], raws = [], urls = [];
    for (const theme of themes) {
      const file = join(out, `${name}.${theme}.png`);
      if (recipe.frame) {
        const parts = {};
        for (const [key, part] of Object.entries(recipe.frame.parts)) {
          validateName(key);
          const partFile = join(out, `${name}.${key}.png`), url = storyUrl(base, part, theme);
          await shoot(url, part.viewport, part, partFile);
          parts[key] = pathToFileURL(partFile).href;
          urls.push(url);
        }
        const page = pathToFileURL(resolve(cwd, recipe.frame.page));
        page.search = new URLSearchParams(parts).toString();
        await shoot(page.href, recipe.frame.viewport, { clip: '$.box($.one("#frame"))' }, file);
      } else {
        const url = storyUrl(base, recipe, theme);
        await shoot(url, recipe.viewport ?? [1440, 810], recipe, file);
        urls.push(url);
      }
      raws.push(await readFile(file));
    }
    const png = join(out, `${name}.png`);
    await stack(raws, png);
    const file = join(out, `${name}.webp`);
    const image = sharp(png), { icc } = await image.metadata();
    await (icc ? image.keepIccProfile() : image.withIccProfile('p3')).webp({ lossless: true }).toFile(file);
    const { width, height } = await sharp(file).metadata();
    return { file, width, height, source: { urls, scale, themes, kind: 'browser' } };
  }

  async function close() {
    if (recording) await browse('record', 'stop').catch(() => {});
    if (launched) await browse('close').catch(() => {});
    launched = false;
  }
  return { capture, close };
}

export async function captureBrowserRecipe({ name, recipe, base, ...options }) {
  const capture = await createBrowserCapture(options);
  try { return await capture.capture(name, recipe, base); }
  finally { await capture.close(); }
}
