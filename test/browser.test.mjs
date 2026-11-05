import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureBrowserRecipe } from '../src/browser.mjs';

test('real browser waits for mounted content, applies input, crops and stacks themes', {
  skip: !process.env.SCREEN_KIT_BROWSER_TESTS,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-browser-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const page = join(cwd, 'fixture.html');
  await writeFile(page, `<!doctype html><style>body{margin:0}#tile{width:100px;height:50px;background:red;border:0}</style>
<div id="mount"></div><script>setTimeout(()=>{const tile=document.createElement('button');tile.id='tile';tile.textContent='capture';tile.onclick=()=>tile.style.background='rgb(0, 128, 0)';document.querySelector('#mount').append(tile)},150)</script>`);
  const result = await captureBrowserRecipe({ cwd, out: join(cwd, 'out'), name: 'fixture', scale: 2,
    recipe: { url: pathToFileURL(page).href, viewport: [320, 240], ready: '#tile',
      themes: ['dark', 'light'], prepare: ['document.body.dataset.prepared = String(Number(document.body.dataset.prepared ?? 0) + 1);'],
      steps: ['if (document.body.dataset.prepared !== "1") throw Error("prepare did not run once before steps");', ['click', '#tile']],
      clip: '(() => { if (document.body.dataset.prepared !== "1") throw Error("readiness repeated preparation"); return $.box($.one("#tile")); })()' } });
  assert.deepEqual([result.width, result.height], [200, 200]);
  const meta = await sharp(result.file).metadata();
  assert.ok(meta.icc, 'export carries a colour profile');
  const { data } = await sharp(result.file).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[1] > 100 && data[0] < 10 && data[2] < 10, 'the real click changed the tile to green');
});

test('real browser records timed input to a playable video', {
  skip: !process.env.SCREEN_KIT_BROWSER_TESTS,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-video-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const page = join(cwd, 'fixture.html');
  await writeFile(page, `<!doctype html><style>body{margin:0;background:#123}button{width:160px;height:100px}</style>
<button onclick="document.body.style.background='orange'">change</button>`);
  const result = await captureBrowserRecipe({ cwd, out: join(cwd, 'out'), name: 'video', scale: 1,
    recipe: { url: pathToFileURL(page).href, viewport: [320, 240], format: 'webm', fps: 10, duration: 2,
      steps: [{ at: .5, click: 'button' }] } });
  const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', result.file]);
  const probe = JSON.parse(stdout), video = probe.streams.find(stream => stream.codec_type === 'video');
  assert.deepEqual([video.width, video.height], [320, 240]);
  assert.ok(Number(probe.format.duration) >= 1.8, 'the recording includes the planned hold');
  assert.equal(result.events.length, 1);
  assert.ok(result.events[0].at >= .5, 'real input happens at the planned time');
});

test('readiness preserves a deliberately opened story alert', {
  skip: !process.env.SCREEN_KIT_BROWSER_TESTS,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-alert-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const page = join(cwd, 'fixture.html');
  await writeFile(page, `<!doctype html><style>body{margin:0}#message{display:none;width:120px;height:60px;background:green}</style>
<div id="storybook-root"><button id="open" onclick="document.querySelector('#message').style.display='block'">open</button>
<div id="message" class="group/alert"><button onclick="this.parentElement.style.display='none'">close</button>Keep this alert</div></div>`);
  const result = await captureBrowserRecipe({ cwd, out: join(cwd, 'out'), name: 'alert', scale: 1,
    recipe: { url: pathToFileURL(page).href, story: 'fixture-alert', viewport: [320, 240],
      steps: [['click', '#open']], clip: '$.box($.one("#message"))' } });
  assert.deepEqual([result.width, result.height], [120, 60]);
});
