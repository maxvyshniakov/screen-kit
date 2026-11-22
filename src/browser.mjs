import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { stack } from './images.mjs';

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, Math.max(0, milliseconds)));

const MODIFIER_MAP = new Map([
  ['meta', 'Meta'], ['cmd', 'Meta'], ['command', 'Meta'], ['super', 'Meta'],
  ['control', 'Control'], ['ctrl', 'Control'],
  ['alt', 'Alt'], ['option', 'Alt'], ['opt', 'Alt'],
  ['shift', 'Shift'],
]);

// Trusted recipe expressions run in the page with these geometric helpers.
export const helpers = String.raw`
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
  if (recipe.url) {
    if (base && !/^[a-z][a-z0-9+.-]*:/i.test(recipe.url)) {
      return new URL(recipe.url, base.replace(/\/$/, '') + '/').href;
    }
    return recipe.url;
  }
  if (!base || !recipe.story) throw Error('Browser recipe needs url or base and story');
  const url = new URL('iframe.html', base.replace(/\/$/, '') + '/');
  url.search = `id=${encodeURIComponent(recipe.story)}&viewMode=story&globals=theme:${encodeURIComponent(theme)}`;
  if (recipe.args) url.search += `&args=${recipe.args}`;
  return url.href;
}

function validateName(name) {
  if (!/^[\w][\w.-]*$/.test(name)) throw Error(`Invalid recipe name: ${name}`);
}

function candidateExecutablesInDir(baseDir, subdirPrefix, relativePaths, exists = existsSync) {
  if (!baseDir || !exists(baseDir)) return [];
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(subdirPrefix))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
  const found = [];
  for (const dir of entries) {
    for (const rel of relativePaths) {
      const candidate = join(baseDir, dir, rel);
      if (exists(candidate)) found.push(candidate);
    }
  }
  return found;
}

export function resolveChromiumExecutable({
  playwrightChromium,
  executablePath,
  env = process.env,
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
} = {}) {
  const explicit = executablePath ?? env.SCREEN_KIT_CHROMIUM_PATH ?? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) {
    const resolved = resolve(explicit);
    if (!exists(resolved)) throw Error(`Configured Chromium executable does not exist: ${resolved}`);
    return resolved;
  }

  if (playwrightChromium && typeof playwrightChromium.executablePath === 'function') {
    try {
      const pwDefault = playwrightChromium.executablePath();
      if (pwDefault && exists(pwDefault)) return pwDefault;
    } catch {
      // Fall through to browser cache and system path discovery.
    }
  }

  const macRelatives = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ];
  const linuxRelatives = [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome',
  ];
  const winRelatives = [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome.exe',
  ];
  const relatives = platform === 'darwin' ? macRelatives : platform === 'win32' ? winRelatives : linuxRelatives;

  const pwCacheDir = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? resolve(env.PLAYWRIGHT_BROWSERS_PATH)
    : platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'ms-playwright')
      : platform === 'win32'
        ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright')
        : join(home, '.cache', 'ms-playwright');

  const agentBrowserDir = join(env.AGENT_BROWSER_HOME ?? join(home, '.agent-browser'), 'browsers');

  for (const candidate of [
    ...candidateExecutablesInDir(pwCacheDir, 'chromium-', relatives, exists),
    ...candidateExecutablesInDir(agentBrowserDir, 'chrome-', relatives, exists),
  ]) {
    if (exists(candidate)) return candidate;
  }

  const systemPaths = platform === 'darwin'
    ? [
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : platform === 'linux'
      ? [
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/snap/bin/chromium',
        ]
      : [];

  for (const sysPath of systemPaths) {
    if (exists(sysPath)) return sysPath;
  }

  throw Error(
    'No local Chromium executable found. Run `npx playwright install chromium` or set SCREEN_KIT_CHROMIUM_PATH.'
  );
}

function normalizeColorScheme(theme) {
  if (theme === 'light' || theme === 'dark' || theme === 'no-preference') return theme;
  if (typeof theme === 'string' && theme.toLowerCase().includes('light')) return 'light';
  return 'dark';
}

function formatKeyChord(rawKey, rawModifiers = []) {
  if (typeof rawKey !== 'string' || !rawKey.length) throw Error('Keyboard action requires a non-empty key string');
  const modifiers = [];
  const addMod = (token) => {
    const canonical = MODIFIER_MAP.get(String(token).toLowerCase());
    if (!canonical) throw Error(`Unsupported key modifier: ${token}`);
    if (!modifiers.includes(canonical)) modifiers.push(canonical);
  };
  for (const mod of rawModifiers) addMod(mod);
  if (rawKey.includes('+') && rawKey.length > 1) {
    const parts = rawKey.split('+');
    const mainKey = parts.pop();
    for (const part of parts) addMod(part);
    return [...modifiers, mainKey].join('+');
  }
  return [...modifiers, rawKey].join('+');
}

function isPointTarget(target) {
  if (Array.isArray(target) && target.length === 2 && target.every(Number.isFinite)) return true;
  if (
    target &&
    typeof target === 'object' &&
    target.selector === undefined &&
    target.role === undefined &&
    target.text === undefined &&
    target.label === undefined &&
    target.placeholder === undefined &&
    target.testId === undefined &&
    Number.isFinite(target.x) &&
    Number.isFinite(target.y)
  ) {
    return true;
  }
  return false;
}

function toPoint(target) {
  if (Array.isArray(target)) return [target[0], target[1]];
  return [target.x, target.y];
}

function resolveLocator(page, target) {
  if (typeof target === 'string') {
    if (!target.trim()) throw Error('Locator selector string must be non-empty');
    return page.locator(target).first();
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw Error(`Unsupported browser locator: ${JSON.stringify(target)}`);
  }

  let base = null;
  if (target.role !== undefined) {
    if (typeof target.role !== 'string' || !target.role.trim()) {
      throw Error('Locator role must be a non-empty string');
    }
    const opts = {
      ...(target.name !== undefined ? { name: target.name } : {}),
      ...(target.exact !== undefined ? { exact: Boolean(target.exact) } : {}),
    };
    base = Object.keys(opts).length > 0 ? page.getByRole(target.role, opts) : page.getByRole(target.role);
  } else if (target.label !== undefined) {
    base = target.exact !== undefined
      ? page.getByLabel(target.label, { exact: Boolean(target.exact) })
      : page.getByLabel(target.label);
  } else if (target.text !== undefined) {
    base = target.exact !== undefined
      ? page.getByText(target.text, { exact: Boolean(target.exact) })
      : page.getByText(target.text);
  } else if (target.placeholder !== undefined) {
    base = target.exact !== undefined
      ? page.getByPlaceholder(target.placeholder, { exact: Boolean(target.exact) })
      : page.getByPlaceholder(target.placeholder);
  } else if (target.testId !== undefined) {
    base = page.getByTestId(target.testId);
  } else if (target.selector !== undefined) {
    if (typeof target.selector !== 'string' || !target.selector.trim()) {
      throw Error('Locator selector must be a non-empty string');
    }
    base = page.locator(target.selector);
  } else {
    throw Error(`Unsupported browser locator: ${JSON.stringify(target)}`);
  }

  const nth = target.nth ?? 0;
  if (!Number.isInteger(nth) || nth < 0) {
    throw Error(`Invalid locator nth index: ${JSON.stringify(target.nth)}`);
  }
  if (nth === 0) {
    return typeof base.first === 'function' ? base.first() : base;
  }
  return base.nth(nth);
}

function extractInlineLocator(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.target !== undefined) return obj.target;
  if (obj.locator !== undefined) return obj.locator;
  const common = {
    ...(obj.exact !== undefined ? { exact: obj.exact } : {}),
    ...(obj.nth !== undefined ? { nth: obj.nth } : {}),
    ...(obj.timeout !== undefined ? { timeout: obj.timeout } : {}),
    ...(obj.offset !== undefined ? { offset: obj.offset } : {}),
  };
  if (obj.role !== undefined) {
    return {
      role: obj.role,
      ...(obj.name !== undefined ? { name: obj.name } : {}),
      ...common,
    };
  }
  if (obj.label !== undefined) return { label: obj.label, ...common };
  if (obj.placeholder !== undefined) return { placeholder: obj.placeholder, ...common };
  if (obj.testId !== undefined) return { testId: obj.testId, ...common };
  if (obj.selector !== undefined) return { selector: obj.selector, ...common };
  return null;
}

function toPositionOption(offset) {
  if (!offset) return undefined;
  if (Array.isArray(offset) && offset.length === 2 && offset.every(Number.isFinite)) {
    return { x: offset[0], y: offset[1] };
  }
  if (typeof offset === 'object' && Number.isFinite(offset.x) && Number.isFinite(offset.y)) {
    return { x: offset.x, y: offset.y };
  }
  return undefined;
}

export async function createBrowserCapture({
  cwd = process.cwd(),
  out,
  scale = 3,
  executablePath,
  playwright,
  headless = true,
} = {}) {
  if (!out) throw Error('Browser capture needs an output directory');
  if (!Number.isFinite(scale) || scale <= 0) throw Error('Browser scale must be positive');
  cwd = resolve(cwd);
  out = resolve(cwd, out);
  await mkdir(out, { recursive: true });

  let browser = null;
  let activeContext = null;

  async function ensureBrowser(recipe) {
    if (browser) return browser;
    const pw = playwright ?? await import('playwright-core');
    const chromium = pw.chromium;
    const resolvedExecutable = playwright
      ? executablePath
      : resolveChromiumExecutable({ playwrightChromium: chromium, executablePath });
    browser = await chromium.launch({
      headless,
      ...(resolvedExecutable ? { executablePath: resolvedExecutable } : {}),
      args: [
        '--force-color-profile=display-p3-d65',
        ...(recipe?.browserArgs ?? []),
      ],
    });
    return browser;
  }

  async function closeActiveContext() {
    if (!activeContext) return;
    const ctx = activeContext;
    activeContext = null;
    await ctx.close().catch(() => {});
  }

  const evaluate = (page, code) => page.evaluate(`(async()=>{${code}})()`);

  async function ready(page, recipe) {
    const selector = recipe.ready ?? (recipe.story ? '#storybook-root' : 'body');
    const timeout = recipe.readyTimeout ?? 20000;
    const checkStoryChildren = Boolean(recipe.story && !recipe.ready);
    await page.evaluate(async ({ sel, limit, storyChildren }) => {
      const until = async (test, label) => {
        const deadline = Date.now() + limit;
        while (!test()) {
          if (Date.now() > deadline) throw Error('Capture readiness timed out: ' + label);
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await until(() => {
        const el = document.querySelector(sel);
        return storyChildren ? Boolean(el?.childElementCount) : Boolean(el);
      }, 'mounted content');
      await Promise.race([
        document.fonts.ready,
        new Promise((_, reject) => setTimeout(() => reject(Error('Fonts did not load')), limit)),
      ]);
      for (const image of document.images) image.loading = 'eager';
      await until(() => [...document.images].every((i) => i.complete), 'images');
      if ([...document.images].some((i) => !i.naturalWidth)) throw Error('An image failed to load');
      await Promise.all([...document.images].map((i) => i.decode()));
      await new Promise((r) => setTimeout(r, 100));
      return true;
    }, { sel: selector, limit: timeout, storyChildren: checkStoryChildren });
  }

  async function step(page, action) {
    if (Array.isArray(action)) {
      const [cmd, first, second] = action;
      if (cmd === 'click') {
        if (isPointTarget(first)) {
          const [x, y] = toPoint(first);
          return page.mouse.click(x, y);
        }
        return resolveLocator(page, first).click({ timeout: first?.timeout ?? 10000 });
      }
      if (cmd === 'press') {
        return page.keyboard.press(formatKeyChord(String(first)));
      }
      if (cmd === 'fill') {
        return resolveLocator(page, first).fill(String(second ?? ''), { timeout: first?.timeout ?? 10000 });
      }
      if (cmd === 'type') {
        if (second !== undefined) {
          await resolveLocator(page, first).click({ timeout: first?.timeout ?? 10000 });
          return page.keyboard.type(String(second));
        }
        return page.keyboard.type(String(first ?? ''));
      }
      if (cmd === 'hover') {
        if (isPointTarget(first)) {
          const [x, y] = toPoint(first);
          return page.mouse.move(x, y);
        }
        return resolveLocator(page, first).hover({ timeout: first?.timeout ?? 10000 });
      }
      if (cmd === 'mouse' && first === 'move') {
        return page.mouse.move(Number(second), Number(action[3] ?? 0));
      }
      if (cmd === 'wait') {
        return sleep(Number(first ?? 0));
      }
      throw Error(`Unsupported browser command array: ${JSON.stringify(action)}`);
    }

    if (typeof action === 'string') {
      return evaluate(page, `${helpers}\n${action}`);
    }

    if (!action || typeof action !== 'object') {
      throw Error('Invalid browser action');
    }

    if (action.command) {
      return step(page, action.command);
    }

    const stepKind = typeof action.type === 'string' && [
      'click', 'dblclick', 'hover', 'move', 'fill', 'key', 'eval', 'wait', 'pause',
    ].includes(action.type) && (
      action.target !== undefined ||
      action.click !== undefined ||
      action.hover !== undefined ||
      action.to !== undefined ||
      action.value !== undefined ||
      action.key !== undefined ||
      action.press !== undefined ||
      action.eval !== undefined ||
      action.wait !== undefined ||
      action.pause !== undefined ||
      action.duration !== undefined
    )
      ? action.type
      : (action.type === 'type' && action.text !== undefined ? 'type-step' : null);

    if (action.eval !== undefined || stepKind === 'eval') {
      return evaluate(page, `${helpers}\n${action.eval}`);
    }

    if (action.wait !== undefined || action.pause !== undefined || stepKind === 'wait' || stepKind === 'pause') {
      if (typeof action.wait === 'string' || (action.wait && typeof action.wait === 'object')) {
        return resolveLocator(page, action.wait).waitFor({
          state: 'visible',
          timeout: action.timeout ?? action.wait?.timeout ?? 10000,
        });
      }
      const ms = action.wait !== undefined
        ? Number(action.wait)
        : Number(action.pause ?? action.duration ?? 0) * 1000;
      if (!Number.isFinite(ms) || ms < 0) throw Error(`Invalid wait duration: ${JSON.stringify(action)}`);
      return sleep(ms);
    }

    if (action.key !== undefined || action.press !== undefined || stepKind === 'key') {
      const chord = formatKeyChord(action.key ?? action.press, action.modifiers);
      return page.keyboard.press(chord);
    }

    if (action.click !== undefined || stepKind === 'click' || stepKind === 'dblclick') {
      const target = action.click ?? action.target;
      const clickCount = action.clickCount ?? (stepKind === 'dblclick' ? 2 : 1);
      const button = action.button ?? 'left';
      if (isPointTarget(target)) {
        const [x, y] = toPoint(target);
        return page.mouse.click(x, y, { button, clickCount });
      }
      const position = toPositionOption(action.offset ?? target?.offset);
      return resolveLocator(page, target).click({
        button,
        clickCount,
        timeout: target?.timeout ?? action.timeout ?? 10000,
        ...(position ? { position } : {}),
      });
    }

    if (action.hover !== undefined || (action.move !== undefined && typeof action.move !== 'boolean') || stepKind === 'hover' || stepKind === 'move') {
      const target = action.hover ?? action.to ?? action.target ?? action.move;
      if (isPointTarget(target)) {
        const [x, y] = toPoint(target);
        return page.mouse.move(x, y);
      }
      const position = toPositionOption(action.offset ?? target?.offset);
      return resolveLocator(page, target).hover({
        timeout: target?.timeout ?? action.timeout ?? 10000,
        ...(position ? { position } : {}),
      });
    }

    if (action.fill !== undefined || stepKind === 'fill') {
      let target = null;
      let value = '';
      if (typeof action.fill === 'string') {
        value = action.fill;
        target = extractInlineLocator(action);
      } else if (action.fill && typeof action.fill === 'object') {
        const fillObj = action.fill;
        const explicitTarget = extractInlineLocator(fillObj) ?? extractInlineLocator(action);
        if (explicitTarget) {
          target = explicitTarget;
          value = String(fillObj.value ?? (fillObj.target !== undefined || fillObj.locator !== undefined ? fillObj.text : undefined) ?? action.value ?? action.text ?? '');
        } else if (fillObj.text !== undefined && fillObj.value !== undefined) {
          target = { text: fillObj.text, ...(fillObj.exact !== undefined ? { exact: fillObj.exact } : {}), ...(fillObj.nth !== undefined ? { nth: fillObj.nth } : {}) };
          value = String(fillObj.value);
        } else {
          throw Error(`Invalid fill action: ${JSON.stringify(action)}`);
        }
      } else if (stepKind === 'fill') {
        target = extractInlineLocator(action);
        value = String(action.value ?? action.text ?? '');
      }
      const loc = target ? resolveLocator(page, target) : page.locator(':focus').first();
      return loc.fill(value, { timeout: target?.timeout ?? action.timeout ?? 10000 });
    }

    if (stepKind === 'type-step' || action.type !== undefined) {
      let target = null;
      let text = '';
      let delay = action.delay ?? action.delayMs ?? 0;
      if (stepKind === 'type-step') {
        target = extractInlineLocator(action);
        text = String(action.text);
      } else if (typeof action.type === 'string') {
        text = action.type;
        target = extractInlineLocator(action);
      } else if (action.type && typeof action.type === 'object') {
        const typeObj = action.type;
        delay = typeObj.delay ?? typeObj.delayMs ?? delay;
        if (typeObj.target !== undefined || typeObj.locator !== undefined) {
          target = typeObj.target ?? typeObj.locator;
          text = String(typeObj.text ?? typeObj.value ?? action.text ?? action.value ?? '');
        } else {
          const inlineLoc = extractInlineLocator(typeObj);
          if (inlineLoc) {
            target = inlineLoc;
            text = String(typeObj.text ?? typeObj.value ?? action.text ?? action.value ?? '');
          } else if (typeObj.text !== undefined && typeObj.value !== undefined) {
            target = { text: typeObj.text };
            text = String(typeObj.value);
          } else {
            throw Error(`Invalid type action: ${JSON.stringify(action)}`);
          }
        }
      } else {
        throw Error(`Invalid type action: ${JSON.stringify(action)}`);
      }
      if (target) {
        await resolveLocator(page, target).click({ timeout: target?.timeout ?? action.timeout ?? 10000 });
      }
      return page.keyboard.type(text, ...(delay > 0 ? [{ delay }] : []));
    }

    throw Error(`Unknown browser action: ${JSON.stringify(action)}`);
  }

  async function open(url, viewport, recipe, theme = 'dark', effectiveScale = scale) {
    const [width, height] = viewport ?? [1440, 810];
    if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
      throw Error('Invalid browser viewport');
    }
    if (!Number.isFinite(effectiveScale) || effectiveScale <= 0) {
      throw Error('Browser scale must be positive');
    }

    const activeBrowser = await ensureBrowser(recipe);
    await closeActiveContext();
    activeContext = await activeBrowser.newContext({
      viewport: { width: Math.round(width), height: Math.round(height) },
      deviceScaleFactor: effectiveScale,
      colorScheme: normalizeColorScheme(theme),
    });

    const page = await activeContext.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: recipe.gotoTimeout ?? Math.max(10000, recipe.readyTimeout ?? 30000) });
    await ready(page, recipe);
    for (const action of recipe.prepare ?? []) await step(page, action);
    for (const action of recipe.setup ?? []) await step(page, action);
    return page;
  }

  async function shoot(url, viewport, recipe, file, theme = 'dark', effectiveScale = scale) {
    const effectiveViewport = viewport ?? [1440, 810];
    const page = await open(url, effectiveViewport, recipe, theme, effectiveScale);
    try {
      for (const action of recipe.steps ?? []) await step(page, action);
      await page.mouse.move(0, 0);
      await sleep(recipe.settle ?? 500);
      await ready(page, recipe); // Interactions may have mounted new fonts or images.
      if (!recipe.clip) {
        await page.screenshot({ path: file, type: 'png' });
        return;
      }
      const crop = await evaluate(page, `${helpers}\nreturn (${recipe.clip});`);
      const bands = Array.isArray(crop) ? crop : [crop];
      if (
        !bands.length ||
        bands.some((band) =>
          !band ||
          !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(band[key])) ||
          band.width <= 0 ||
          band.height <= 0
        )
      ) {
        throw Error('Invalid crop rectangles');
      }
      const bottom = Math.max(...bands.map((band) => band.y + band.height));
      const full = `${file}.full.png`;
      try {
        await page.screenshot({
          path: full,
          type: 'png',
          fullPage: bottom > effectiveViewport[1],
        });
        const fullBuffer = await readFile(full);
        const pageMeta = await sharp(fullBuffer).metadata();
        const pieces = await Promise.all(bands.map(async (band) => {
          const left = Math.max(0, Math.round(band.x * effectiveScale));
          const top = Math.max(0, Math.round(band.y * effectiveScale));
          const right = Math.min(pageMeta.width, Math.round((band.x + band.width) * effectiveScale));
          const end = Math.min(pageMeta.height, Math.round((band.y + band.height) * effectiveScale));
          if (right <= left || end <= top) throw Error('Crop is outside the captured page');
          return sharp(fullBuffer)
            .keepIccProfile()
            .extract({ left, top, width: right - left, height: end - top })
            .png()
            .toBuffer();
        }));
        await stack(pieces, file);
      } finally {
        await rm(full, { force: true });
      }
    } finally {
      await closeActiveContext();
    }
  }

  async function captureVideo(name, recipe, base) {
    if (recipe.frame || recipe.clip || (recipe.themes?.length ?? 1) > 1) {
      throw Error('Video capture currently needs one uncropped browser viewport');
    }
    const duration = recipe.duration ?? 5;
    const fps = recipe.fps ?? 30;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600 || !Number.isInteger(fps) || fps < 1 || fps > 60) {
      throw Error('Invalid video duration or fps');
    }
    const format = recipe.format ?? recipe.output?.format ?? 'webm';
    if (!['webm', 'mp4'].includes(format)) {
      throw Error(`Unsupported browser recording format: ${format}`);
    }
    const effectiveScale = recipe.deviceScaleFactor ?? recipe.scale ?? scale;
    const theme = recipe.themes?.[0] ?? 'dark';
    const url = storyUrl(base, recipe, theme);
    const viewport = recipe.viewport ?? [1440, 810];
    const framesDir = join(out, `.browser-video-${randomUUID()}`);
    await mkdir(framesDir, { recursive: true });

    const page = await open(url, viewport, recipe, theme, effectiveScale);
    let cdp = null;
    try {
      await ready(page, recipe);
      await page.mouse.move(0, 0);

      cdp = await activeContext.newCDPSession(page);
      const initialShot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
      const initialFrameFile = join(framesDir, 'init.jpg');
      await writeFile(initialFrameFile, Buffer.from(initialShot.data, 'base64'));

      const rawFrames = [];
      const pendingWrites = [];
      let nextFrameIndex = 1;
      let screencasting = true;
      let start = performance.now();

      cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        const elapsed = (performance.now() - start) / 1000;
        cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (!screencasting) return;
        const index = nextFrameIndex++;
        const frameFile = join(framesDir, `f${String(index).padStart(6, '0')}.jpg`);
        rawFrames.push({
          index,
          file: frameFile,
          cdpTimestamp: metadata?.timestamp,
          elapsed,
        });
        pendingWrites.push(writeFile(frameFile, Buffer.from(data, 'base64')));
      });

      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 92,
        maxWidth: Math.round(viewport[0] * effectiveScale),
        maxHeight: Math.round(viewport[1] * effectiveScale),
        everyNthFrame: 1,
        maxFramesInFlight: 3,
      });

      start = performance.now();
      const file = join(out, `${name}.${format}`);
      const events = [];
      try {
        let previous = 0;
        for (const action of recipe.steps ?? []) {
          const at = action && typeof action === 'object' && !Array.isArray(action) ? action.at ?? previous : previous;
          if (!Number.isFinite(at) || at < previous || at > duration) {
            throw Error('Browser recording action times must be ordered and within duration');
          }
          await sleep(Math.max(0, at * 1000 - (performance.now() - start)));
          const actionAt = (performance.now() - start) / 1000;
          await step(page, action);
          events.push({ at: Math.max(actionAt, (performance.now() - start) / 1000), action });
          previous = at;
        }
        await sleep(Math.max(0, duration * 1000 - (performance.now() - start)));
        await sleep(40);
      } finally {
        screencasting = false;
        await cdp.send('Page.stopScreencast').catch(() => {});
        await Promise.all(pendingWrites);
      }

      const { encodeScreencastFrames } = await import('./take-browser.mjs');
      const encoded = await encodeScreencastFrames({
        initialFrameFile,
        rawFrames,
        framesDir,
        outputFile: file,
        format,
        fps,
        targetDuration: duration,
        colorSpace: recipe.colorSpace ?? 'srgb',
      });

      return {
        file,
        width: encoded.width,
        height: encoded.height,
        duration,
        fps,
        videoInput: file,
        events,
        source: { url, scale: effectiveScale, format, kind: 'browser-recording' },
      };
    } finally {
      await cdp?.detach().catch(() => {});
      await closeActiveContext();
      await rm(framesDir, { recursive: true, force: true });
    }
  }

  async function capture(name, recipe, base) {
    validateName(name);
    const requestedFormat = recipe.format ?? recipe.output?.format;
    if (['webm', 'mp4'].includes(requestedFormat)) {
      return captureVideo(name, recipe, base);
    }
    if (requestedFormat !== undefined && !['webp', 'png'].includes(requestedFormat)) {
      throw Error(`Unsupported browser format: ${requestedFormat}`);
    }

    const effectiveScale = recipe.deviceScaleFactor ?? recipe.scale ?? scale;
    const themes = recipe.themes ?? ['dark'];
    const raws = [];
    const urls = [];

    for (const theme of themes) {
      const file = join(out, `${name}.${theme}.png`);
      if (recipe.frame) {
        const parts = {};
        for (const [key, part] of Object.entries(recipe.frame.parts)) {
          validateName(key);
          const partFile = join(out, `${name}.${key}.png`);
          const url = storyUrl(base, part, theme);
          await shoot(url, part.viewport, part, partFile, theme, part.deviceScaleFactor ?? part.scale ?? effectiveScale);
          parts[key] = pathToFileURL(partFile).href;
          urls.push(url);
        }
        const page = pathToFileURL(resolve(cwd, recipe.frame.page));
        page.search = new URLSearchParams(parts).toString();
        await shoot(page.href, recipe.frame.viewport, { clip: '$.box($.one("#frame"))' }, file, theme, effectiveScale);
      } else {
        const url = storyUrl(base, recipe, theme);
        await shoot(url, recipe.viewport ?? [1440, 810], recipe, file, theme, effectiveScale);
        urls.push(url);
      }
      raws.push(await readFile(file));
    }

    const png = join(out, `${name}.png`);
    await stack(raws, png);
    let pngBytes = await readFile(png);
    const pngMeta = await sharp(pngBytes).metadata();

    if (requestedFormat === 'png') {
      if (!pngMeta.icc) {
        pngBytes = await sharp(pngBytes).withIccProfile('p3').png().toBuffer();
        await writeFile(png, pngBytes);
      }
      const { width, height } = await sharp(pngBytes).metadata();
      return { file: png, width, height, source: { urls, scale: effectiveScale, themes, format: 'png', kind: 'browser' } };
    }

    const file = join(out, `${name}.webp`);
    const webpPipeline = sharp(pngBytes);
    const webpBytes = await (pngMeta.icc ? webpPipeline.keepIccProfile() : webpPipeline.withIccProfile('p3'))
      .webp({ lossless: true })
      .toBuffer();
    await writeFile(file, webpBytes);
    const { width, height } = await sharp(webpBytes).metadata();
    return { file, width, height, source: { urls, scale: effectiveScale, themes, kind: 'browser' } };
  }

  async function close() {
    await closeActiveContext();
    if (browser) {
      const activeBrowser = browser;
      browser = null;
      await activeBrowser.close().catch(() => {});
    }
  }

  return { capture, close };
}

export async function captureBrowserRecipe({ name, recipe, base, ...options }) {
  const capture = await createBrowserCapture(options);
  try {
    return await capture.capture(name, recipe, base);
  } finally {
    await capture.close();
  }
}
