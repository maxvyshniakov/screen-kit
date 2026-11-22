import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { reviewRun } from '../src/review.mjs';
import { captureRun, hash } from '../src/run.mjs';
import {
  CAPTURE_MODES,
  captureBrowserTake,
  computeRawCaptureStats,
  createMacFocusController,
  encodeScreencastFrames,
  minimumJerk,
  minimumJerkTrajectory,
  resolveChromiumExecutable,
  resolveTargetPoint,
  serializeEventTrack,
  validateCaptureMode,
  validateEventTrack,
} from '../src/take-browser.mjs';
import { compileTimeline, validateTimeline } from '../src/timeline.mjs';
import { probeVideo } from '../src/video.mjs';

test('validateCaptureMode accepts explicit quality and headless modes and rejects invalid values', () => {
  assert.deepEqual(CAPTURE_MODES, ['quality', 'headless']);
  assert.equal(validateCaptureMode('quality'), 'quality');
  assert.equal(validateCaptureMode('headless'), 'headless');

  for (const invalid of [undefined, null, '', 'auto', 'retina', 'headful', 1, {}]) {
    assert.throws(() => validateCaptureMode(invalid), /Invalid capture mode/);
  }
});

test('minimumJerk profile has zero endpoint speed, midpoint symmetry, and monotonic trajectories', () => {
  assert.equal(minimumJerk(-0.5), 0);
  assert.equal(minimumJerk(0), 0);
  assert.ok(Math.abs(minimumJerk(0.5) - 0.5) < 1e-12);
  assert.equal(minimumJerk(1), 1);
  assert.equal(minimumJerk(1.5), 1);
  assert.throws(() => minimumJerk(Number.NaN), /Invalid minimum-jerk/);

  // Endpoint ease-in / ease-out: first and last steps cover much less distance than middle step.
  const startStep = minimumJerk(0.05) - minimumJerk(0);
  const midStep = minimumJerk(0.525) - minimumJerk(0.475);
  const endStep = minimumJerk(1) - minimumJerk(0.95);
  assert.ok(midStep > startStep * 10, 'midpoint velocity exceeds ease-in start');
  assert.ok(midStep > endStep * 10, 'midpoint velocity exceeds ease-out end');
  assert.ok(Math.abs(startStep - endStep) < 1e-12, 'symmetric ease-in and ease-out');

  const path = minimumJerkTrajectory({
    from: [100, 200],
    to: [500, 200],
    duration: 0.5,
    sampleRate: 60,
    startTime: 1.25,
    arc: 0.1,
  });
  assert.equal(path.length, 31); // 0..30 inclusive
  assert.deepEqual(path[0], { t: 1.25, x: 100, y: 200 });
  assert.deepEqual(path.at(-1), { t: 1.75, x: 500, y: 200 });

  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].t >= path[i - 1].t, 'timestamps are monotonically non-decreasing');
    assert.ok(path[i].x >= path[i - 1].x, 'x progresses monotonically along horizontal trajectory');
  }
  // Positive arc offsets y slightly in the middle before returning to 200.
  const mid = path[15];
  assert.ok(mid.y > 205, `expected slight human arc offset, got ${mid.y}`);

  // Straight trajectory (arc: 0) stays strictly on y = 200.
  const straight = minimumJerkTrajectory({ from: { x: 10, y: 200 }, to: { x: 210, y: 200 }, duration: 0.2, arc: 0 });
  assert.ok(straight.every((pt) => pt.y === 200));

  // Zero duration returns destination immediately.
  assert.deepEqual(
    minimumJerkTrajectory({ from: [10, 20], to: [10, 20], duration: 0, startTime: 0.4 }),
    [{ t: 0.4, x: 10, y: 20 }],
  );
});

test('validateEventTrack and serializeEventTrack enforce Event Track v1 contract', () => {
  const validTrack = {
    version: 1,
    captureMode: 'quality',
    viewport: { width: 1440, height: 810, deviceScaleFactor: 2 },
    video: { file: 'take.mp4', width: 2880, height: 1620, fps: 60, duration: 5.2, frames: 312 },
    startedAt: '2026-11-22T00:00:00.000Z',
    events: [
      { t: 0.0, type: 'pointermove', x: 720, y: 405 },
      { t: 0.5, type: 'pointerdown', x: 400, y: 300, button: 'left' },
      { t: 0.58, type: 'pointerup', x: 400, y: 300, button: 'left' },
      { t: 1.2, type: 'wheel', x: 720, y: 405, deltaX: -180, deltaY: 0, phase: 'changed' },
      { t: 1.4, type: 'gesture', kind: 'scroll', x: 720, y: 405, deltaX: 300, deltaY: 0, duration: 0.35 },
      { t: 2.0, type: 'drag', from: [200, 300], to: [600, 420], duration: 0.6 },
      { t: 3.0, type: 'key', key: 'k', modifiers: ['Meta'], action: 'press' },
      { t: 3.5, type: 'step', index: 0, label: 'drag card' },
    ],
  };

  const json = serializeEventTrack(validTrack);
  assert.ok(json.endsWith('\n'));
  assert.deepEqual(validateEventTrack(JSON.parse(json)), validTrack);

  // Version & mode checks
  assert.throws(() => validateEventTrack({ ...validTrack, version: 2 }), /version/);
  assert.throws(() => validateEventTrack({ ...validTrack, captureMode: 'fast' }), /Invalid capture mode/);
  assert.throws(() => validateEventTrack({ ...validTrack, startedAt: 'not-a-date' }), /startedAt/);

  // Negative & out-of-order timestamps
  assert.throws(
    () => validateEventTrack({ ...validTrack, events: [{ t: -0.01, type: 'pointermove', x: 0, y: 0 }] }),
    />= 0/,
  );
  assert.throws(
    () => validateEventTrack({
      ...validTrack,
      events: [
        { t: 0.5, type: 'pointermove', x: 10, y: 10 },
        { t: 0.49, type: 'pointermove', x: 20, y: 20 },
      ],
    }),
    /monotonically non-decreasing/,
  );

  // Event-specific validation
  assert.throws(
    () => validateEventTrack({ ...validTrack, events: [{ t: 0, type: 'pointerdown', x: 1, y: 2, button: 'thumb' }] }),
    /valid button/,
  );
  assert.throws(
    () => validateEventTrack({ ...validTrack, events: [{ t: 0, type: 'key', key: 'k', modifiers: ['Command'], action: 'press' }] }),
    /modifiers/,
  );
  assert.throws(
    () => validateEventTrack({ ...validTrack, events: [{ t: 0, type: 'drag', from: [1], to: [2, 3], duration: 0.2 }] }),
    /drag/,
  );
});

test('resolveChromiumExecutable honors overrides and Playwright executable without hardcoded paths', () => {
  const existing = new Set(['/custom/chrome', '/pw/chrome']);
  const exists = (p) => existing.has(p);

  assert.equal(
    resolveChromiumExecutable({
      executablePath: '/custom/chrome',
      playwrightChromium: { executablePath: () => '/pw/chrome' },
      exists,
    }),
    '/custom/chrome',
  );

  assert.equal(
    resolveChromiumExecutable({
      env: { SCREEN_KIT_CHROMIUM_PATH: '/custom/chrome' },
      exists,
    }),
    '/custom/chrome',
  );

  assert.equal(
    resolveChromiumExecutable({
      env: {},
      playwrightChromium: { executablePath: () => '/pw/chrome' },
      exists,
    }),
    '/pw/chrome',
  );

  assert.throws(
    () => resolveChromiumExecutable({ executablePath: '/missing/chrome', exists }),
    /does not exist/,
  );

  assert.throws(
    () => resolveChromiumExecutable({
      env: { PLAYWRIGHT_BROWSERS_PATH: '/nonexistent-pw', AGENT_BROWSER_HOME: '/nonexistent-ab' },
      playwrightChromium: { executablePath: () => '/missing/pw' },
      platform: 'linux',
      exists: () => false,
    }),
    /No local Chromium executable found/,
  );
});

test('Linux Chromium fallback paths and non-darwin focus controller no-op', async () => {
  const linuxSystemPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];

  for (const candidate of linuxSystemPaths) {
    assert.equal(
      resolveChromiumExecutable({
        env: { PLAYWRIGHT_BROWSERS_PATH: '/nonexistent-pw', AGENT_BROWSER_HOME: '/nonexistent-ab' },
        playwrightChromium: { executablePath: () => '/missing/pw' },
        platform: 'linux',
        exists: (p) => p === candidate,
      }),
      candidate,
    );
  }

  let execCalled = false;
  const focus = createMacFocusController({
    platform: 'linux',
    runExec: async () => {
      execCalled = true;
      return { stdout: '' };
    },
  });
  assert.equal(await focus.captureFrontmost(), null);
  assert.equal(await focus.restoreFrontmost('com.example.App'), false);
  assert.equal(execCalled, false);
});

test('quality mode configures Retina 2x headful occlusion flags, hands back focus, and cleans up', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-quality-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dummyFrame = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#112233' } }).jpeg().toBuffer();
  const base64Frame = dummyFrame.toString('base64');

  const trace = [];
  let closed = false;
  let cdpDetached = false;

  const focusCalls = [];
  const focusController = createMacFocusController({
    platform: 'darwin',
    runExec: async (cmd, args) => {
      focusCalls.push([cmd, ...args]);
      if (args.some((a) => a.includes('frontmostApplication'))) {
        return { stdout: 'com.mitchellh.ghostty\n' };
      }
      return { stdout: 'true\n' };
    },
  });

  const mockPlaywright = {
    chromium: {
      async launch(opts) {
        trace.push({ step: 'launch', opts });
        return {
          async newContext(ctxOpts) {
            trace.push({ step: 'newContext', ctxOpts });
            return {
              async newPage() {
                return {
                  async goto(url) { trace.push({ step: 'goto', url }); },
                  async evaluate() { return true; },
                  mouse: {
                    async move() {},
                    async down() {},
                    async up() {},
                    async wheel() {},
                  },
                  keyboard: { async press() {}, async down() {}, async up() {} },
                };
              },
              async newCDPSession() {
                let listener = null;
                return {
                  on(event, fn) { if (event === 'Page.screencastFrame') listener = fn; },
                  async send(method, params) {
                    trace.push({ step: `cdp:${method}`, params });
                    if (method === 'Page.captureScreenshot') return { data: base64Frame };
                    if (method === 'Page.startScreencast' && listener) {
                      listener({ data: base64Frame, metadata: { timestamp: 100.0 }, sessionId: 1 });
                      listener({ data: base64Frame, metadata: { timestamp: 100.0166 }, sessionId: 2 });
                    }
                    return {};
                  },
                  async detach() { cdpDetached = true; },
                };
              },
              async close() {},
            };
          },
          async close() { closed = true; },
        };
      },
    },
  };

  const result = await captureBrowserTake({
    out: join(dir, 'take'),
    captureMode: 'quality',
    playwright: mockPlaywright,
    focusController,
    encodeFrames: async ({ outputFile, rawFrames }) => {
      await writeFile(outputFile, Buffer.from('mock-video-bytes'));
      return {
        width: 2880,
        height: 1620,
        fps: 60,
        duration: 0.5,
        frames: 30,
        measuredFps: 60,
        capturedFrames: rawFrames.length,
        codec: 'h264',
        audio: false,
      };
    },
    recipe: {
      url: 'https://example.test/demo',
      duration: 0.05,
      steps: [
        { type: 'click', x: 300, y: 220, move: false, modifiers: ['Shift', 'Meta'], hold: 0.01, label: 'modified click' },
        { type: 'gesture', kind: 'pinch', x: 420, y: 300, scaleFactor: 1.3, steps: 2, duration: 0.04, label: 'pinch zoom' },
        { type: 'key', key: 'Meta+k', label: 'open palette' },
      ],
    },
  });

  const launchCall = trace.find((e) => e.step === 'launch');
  assert.equal(launchCall.opts.headless, false);
  assert.ok(launchCall.opts.args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(launchCall.opts.args.includes('--disable-renderer-backgrounding'));

  const ctxCall = trace.find((e) => e.step === 'newContext');
  assert.deepEqual(ctxCall.ctxOpts, { viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });

  const screencastCall = trace.find((e) => e.step === 'cdp:Page.startScreencast');
  assert.equal(screencastCall.params.maxWidth, 2880);
  assert.equal(screencastCall.params.maxHeight, 1620);

  // Focus captured once before launch, then handed back to com.mitchellh.ghostty via JXA argument array.
  assert.ok(focusCalls.length >= 2);
  assert.equal(focusCalls[0][0], 'osascript');
  assert.equal(focusCalls[1].at(-1), 'com.mitchellh.ghostty');

  assert.equal(result.captureMode, 'quality');
  assert.equal(result.width, 2880);
  assert.equal(result.height, 1620);
  assert.equal(result.fps, 60);
  assert.ok(trace.some((e) => e.step === 'cdp:Input.dispatchMouseEvent' && e.params?.modifiers === 2));
  assert.ok(result.eventTrackData.events.some((e) => e.type === 'gesture' && e.kind === 'pinch' && e.duration >= 0.04));
  assert.equal(result.encodedFps, 60);
  assert.ok(result.rawCapture);
  assert.equal(result.rawCapture.rawFrames, 2);
  assert.equal(result.rawCapture.gapsOver2Frames, 0);
  assert.deepEqual(result.eventTrackData.video.capture, result.rawCapture);
  assert.equal(closed, true);
  assert.equal(cdpDetached, true);

  // Event track emitted by take-browser compiles cleanly through compileTimeline()
  const compiled = compileTimeline({ eventTrack: result.eventTrackData });
  assert.deepEqual(validateTimeline(compiled), { ok: true, errors: [] });
});

test('computeRawCaptureStats reports honest rawFps (including >250ms gaps), captureBrowserTake extends past exceeded duration without silent truncation, and encodeScreencastFrames tags BT.709 / P3 on MP4 & WebM', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-raw-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. Honest rawFps & gap stats (400ms stall is NOT excluded from rawFps)
  const stats = computeRawCaptureStats({
    rawFrames: [
      { index: 1, cdpTimestamp: 10.0, elapsed: 0.01 },
      { index: 2, cdpTimestamp: 10.016, elapsed: 0.026 },
      { index: 3, cdpTimestamp: 10.416, elapsed: 0.426 }, // 400ms stall!
      { index: 4, cdpTimestamp: 10.432, elapsed: 0.442 },
    ],
    elapsedDuration: 1.0,
    requestedFps: 60,
  });
  assert.equal(stats.rawFrames, 4);
  assert.equal(stats.rawFps, 4); // Honest 4 / 1.0s = 4 fps, NOT ~60 fps!
  assert.equal(stats.maxGapMs, 400);
  assert.equal(stats.gapsOver2Frames, 1);
  assert.equal(stats.truncated, false);

  // 2. EventTrack validated by take-browser (with stationary, mayBegin, 0-dur gesture, blank label) compiles cleanly
  const richTrack = validateEventTrack({
    version: 1,
    captureMode: 'headless',
    viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
    video: {
      file: 'take.mp4',
      width: 640,
      height: 360,
      fps: 30,
      encodedFps: 30,
      duration: 2.0,
      frames: 60,
      capture: stats,
    },
    startedAt: '2026-11-22T00:00:00.000Z',
    events: [
      { t: 0, type: 'pointermove', x: 100, y: 100 },
      { t: 0.2, type: 'wheel', x: 100, y: 100, deltaX: 0, deltaY: -20, phase: 'mayBegin' },
      { t: 0.3, type: 'wheel', x: 100, y: 100, deltaX: 0, deltaY: 0, phase: 'stationary' },
      { t: 0.5, type: 'gesture', kind: 'scroll', x: 100, y: 100, deltaX: 50, deltaY: 0, duration: 0 },
      { t: 0.8, type: 'step', index: 0, label: '' },
    ],
  });
  const compiled = compileTimeline({ eventTrack: richTrack });
  assert.deepEqual(validateTimeline(compiled), { ok: true, errors: [] });
  assert.equal(compiled.steps[0].label, 'step-0');

  // 3. Steps exceeding recipe.duration extend targetDuration and flag durationExceeded instead of silently truncating
  const dummyFrame = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#2563eb' } }).png().toBuffer();
  const base64Frame = dummyFrame.toString('base64');
  let encodedTargetDuration = 0;

  const mockPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() {
                return {
                  async goto() {},
                  async evaluate() { return true; },
                  mouse: { async move() {}, async down() {}, async up() {}, async wheel() {} },
                  keyboard: { async press() {}, async down() {}, async up() {} },
                };
              },
              async newCDPSession() {
                let listener = null;
                return {
                  on(ev, fn) { if (ev === 'Page.screencastFrame') listener = fn; },
                  async send(method) {
                    if (method === 'Page.captureScreenshot') return { data: base64Frame };
                    if (method === 'Page.startScreencast' && listener) {
                      listener({ data: base64Frame, metadata: { timestamp: 50.0 }, sessionId: 1 });
                    }
                    return {};
                  },
                  async detach() {},
                };
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
    },
  };

  const overrunTake = await captureBrowserTake({
    out: join(dir, 'overrun'),
    captureMode: 'headless',
    playwright: mockPw,
    encodeFrames: async ({ outputFile, targetDuration, rawFrames }) => {
      encodedTargetDuration = targetDuration;
      await writeFile(outputFile, Buffer.from('video'));
      return {
        width: 640,
        height: 360,
        fps: 30,
        duration: targetDuration,
        frames: Math.max(1, Math.round(targetDuration * 30)),
        measuredFps: 10,
        capturedFrames: rawFrames.length,
        codec: 'h264',
        audio: false,
      };
    },
    recipe: {
      url: 'https://example.test/slow-steps',
      viewport: [640, 360],
      fps: 30,
      duration: 0.05,
      steps: [
        { type: 'pause', duration: 0.16 },
        { type: 'key', key: 'Enter', label: '' },
      ],
    },
  });

  assert.equal(overrunTake.durationExceeded, true);
  assert.equal(overrunTake.rawCapture.durationExceeded, true);
  assert.equal(overrunTake.rawCapture.truncated, false);
  assert.ok(encodedTargetDuration >= 0.15, `expected extended targetDuration >= 0.15s, got ${encodedTargetDuration}`);
  assert.equal(overrunTake.eventTrackData.events.find((e) => e.type === 'step')?.label, 'step-1');

  // 4. Explicit BT.709 (sRGB) and Display P3 color tags across both MP4 and WebM in encodeScreencastFrames
  const encDir = join(dir, 'enc');
  await writeFile(join(dir, 'f0.png'), dummyFrame);
  await writeFile(join(dir, 'f1.png'), dummyFrame);
  for (const format of ['mp4', 'webm']) {
    const srgbOut = join(dir, `srgb.${format}`);
    const p3Out = join(dir, `p3.${format}`);
    await encodeScreencastFrames({
      initialFrameFile: join(dir, 'f0.png'),
      rawFrames: [
        { index: 1, file: join(dir, 'f0.png'), elapsed: 0 },
        { index: 2, file: join(dir, 'f1.png'), elapsed: 0.1 },
      ],
      framesDir: dir,
      outputFile: srgbOut,
      format,
      fps: 10,
      targetDuration: 0.2,
      colorSpace: 'srgb',
    });
    const srgbProbe = await probeVideo(srgbOut);
    assert.equal(srgbProbe.colorPrimaries, 'bt709', `srgb ${format} colorPrimaries`);
    assert.equal(srgbProbe.colorTransfer, 'bt709', `srgb ${format} colorTransfer`);
    assert.equal(srgbProbe.colorSpace, 'bt709', `srgb ${format} colorSpace`);
    assert.equal(srgbProbe.colorRange, 'tv', `srgb ${format} colorRange`);

    await encodeScreencastFrames({
      initialFrameFile: join(dir, 'f0.png'),
      rawFrames: [
        { index: 1, file: join(dir, 'f0.png'), elapsed: 0 },
        { index: 2, file: join(dir, 'f1.png'), elapsed: 0.1 },
      ],
      framesDir: dir,
      outputFile: p3Out,
      format,
      fps: 10,
      targetDuration: 0.2,
      colorSpace: 'p3',
    });
    const p3Probe = await probeVideo(p3Out);
    assert.equal(p3Probe.colorPrimaries, 'smpte432', `p3 ${format} colorPrimaries`);
    assert.equal(p3Probe.colorTransfer, 'iec61966-2-1', `p3 ${format} colorTransfer`);
    assert.equal(p3Probe.colorSpace, 'bt709', `p3 ${format} colorSpace`);
    assert.equal(p3Probe.colorRange, 'tv', `p3 ${format} colorRange`);
    void encDir;
  }
});

test('typing step, modified-click pointerdown modifiers, and motion-window-aware computeRawCaptureStats work end-to-end', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-type-modclick-motion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dummyFrame = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#0f172a' } }).png().toBuffer();
  const base64Frame = dummyFrame.toString('base64');
  const typedCalls = [];

  const mockPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() {
                return {
                  async goto() {},
                  async evaluate() { return [240, 120]; },
                  mouse: { async move() {}, async down() {}, async up() {}, async wheel() {} },
                  keyboard: {
                    async press(chord) { typedCalls.push({ op: 'press', chord }); },
                    async down(mod) { typedCalls.push({ op: 'down', mod }); },
                    async up(mod) { typedCalls.push({ op: 'up', mod }); },
                    async type(text, opts) { typedCalls.push({ op: 'type', text, opts }); },
                  },
                };
              },
              async newCDPSession() {
                let listener = null;
                return {
                  on(ev, fn) { if (ev === 'Page.screencastFrame') listener = fn; },
                  async send(method) {
                    if (method === 'Page.captureScreenshot') return { data: base64Frame };
                    if (method === 'Page.startScreencast' && listener) {
                      listener({ data: base64Frame, metadata: { timestamp: 20.0 }, sessionId: 1 });
                      listener({ data: base64Frame, metadata: { timestamp: 20.016 }, sessionId: 2 });
                    }
                    return {};
                  },
                  async detach() {},
                };
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
    },
  };

  const result = await captureBrowserTake({
    out: join(dir, 'take'),
    captureMode: 'headless',
    playwright: mockPw,
    encodeFrames: async ({ outputFile, targetDuration, rawFrames }) => {
      await writeFile(outputFile, Buffer.from('video'));
      return {
        width: 640,
        height: 360,
        fps: 60,
        duration: targetDuration,
        frames: Math.max(1, Math.round(targetDuration * 60)),
        measuredFps: 60,
        capturedFrames: rawFrames.length,
        codec: 'h264',
        audio: false,
      };
    },
    recipe: {
      url: 'https://example.test/data-grid',
      viewport: [640, 360],
      fps: 60,
      tail: 0.02,
      steps: [
        { type: 'click', x: 200, y: 100, move: false, modifiers: ['Shift'], hold: 0.01, label: 'Shift select row' },
        { type: 'dblclick', x: 200, y: 140, move: false, modifiers: ['cmd'], hold: 0.01, label: 'Command double click' },
        { type: 'type', text: 'oak', delayMs: 5, settle: 0.02, label: 'Filter oak' },
        { type: 'key', key: 'Escape', label: 'Clear filter' },
      ],
    },
  });

  // 1. Typing step invokes keyboard.type('oak', { delay: 5 }), emits step event, and emits NO key toast spam
  assert.deepEqual(
    typedCalls.filter((c) => c.op === 'type'),
    [{ op: 'type', text: 'oak', opts: { delay: 5 } }],
  );
  const events = result.eventTrackData.events;
  assert.ok(events.some((e) => e.type === 'step' && e.label === 'Filter oak'));
  const keyEvents = events.filter((e) => e.type === 'key');
  assert.equal(keyEvents.length, 1);
  assert.equal(keyEvents[0].key, 'Escape');

  // 2. Modified clicks record canonical modifiers on pointerdown and compile into HUD keystroke pills
  const pointerdowns = events.filter((e) => e.type === 'pointerdown');
  assert.deepEqual(pointerdowns[0].modifiers, ['Shift']);
  assert.deepEqual(pointerdowns[1].modifiers, ['Meta']);
  assert.deepEqual(pointerdowns[2].modifiers, ['Meta']);

  // Invalid modifiers on pointerdown/pointerup are rejected by validateEventTrack
  assert.throws(
    () => validateEventTrack({
      ...result.eventTrackData,
      events: [{ t: 0, type: 'pointerdown', x: 10, y: 10, button: 'left', modifiers: ['SuperKey'] }],
    }),
    /modifiers/,
  );

  const compiled = compileTimeline({ eventTrack: result.eventTrackData });
  assert.deepEqual(
    compiled.overlays.keystrokes.map((k) => k.label),
    ['⇧ Click', '⌘ Click', '⌘ Click', 'Esc'],
  );

  // 3. computeRawCaptureStats separates static pause/settle gaps from active-motion-window stalls
  const pauseOnlyEvents = [
    { t: 0.0, type: 'pointermove', x: 100, y: 100 },
    // Active scroll gesture 0.10..0.30 (frames arrive every 16ms)
    { t: 0.10, type: 'gesture', kind: 'scroll', x: 100, y: 100, deltaX: -200, deltaY: 0, duration: 0.2 },
    // Static pause / settle 0.30..0.85 (no screencast frames needed while static!)
    // Active drag + pointermove burst 0.85..1.05 (frames arrive every 16ms)
    { t: 0.85, type: 'drag', from: [100, 100], to: [220, 100], duration: 0.2 },
    { t: 0.88, type: 'pointermove', x: 140, y: 100 },
    { t: 0.94, type: 'pointermove', x: 180, y: 100 },
    { t: 1.00, type: 'pointermove', x: 220, y: 100 },
  ];
  const healthyWithStaticPause = computeRawCaptureStats({
    rawFrames: [
      { index: 1, cdpTimestamp: 1.00, elapsed: 0.00 },
      { index: 2, cdpTimestamp: 1.10, elapsed: 0.10 },
      { index: 3, cdpTimestamp: 1.12, elapsed: 0.12 },
      { index: 4, cdpTimestamp: 1.15, elapsed: 0.15 },
      { index: 5, cdpTimestamp: 1.18, elapsed: 0.18 },
      { index: 6, cdpTimestamp: 1.21, elapsed: 0.21 },
      { index: 7, cdpTimestamp: 1.24, elapsed: 0.24 },
      { index: 8, cdpTimestamp: 1.27, elapsed: 0.27 },
      { index: 9, cdpTimestamp: 1.30, elapsed: 0.30 },
      // 550ms static pause here (1.30 -> 1.85)!
      { index: 10, cdpTimestamp: 1.85, elapsed: 0.85 },
      { index: 11, cdpTimestamp: 1.88, elapsed: 0.88 },
      { index: 12, cdpTimestamp: 1.91, elapsed: 0.91 },
      { index: 13, cdpTimestamp: 1.94, elapsed: 0.94 },
      { index: 14, cdpTimestamp: 1.97, elapsed: 0.97 },
      { index: 15, cdpTimestamp: 2.00, elapsed: 1.00 },
      { index: 16, cdpTimestamp: 2.03, elapsed: 1.03 },
      { index: 17, cdpTimestamp: 2.05, elapsed: 1.05 },
    ],
    elapsedDuration: 1.1,
    requestedFps: 60,
    events: pauseOnlyEvents,
  });
  assert.equal(healthyWithStaticPause.maxGapMs, 550);
  assert.ok(healthyWithStaticPause.gapsOver2Frames >= 1);
  assert.equal(healthyWithStaticPause.activeMotionGapsOver2Frames, 0);
  assert.ok(healthyWithStaticPause.activeMotionMaxGapMs <= 30);
  assert.deepEqual(healthyWithStaticPause.activeMotionWindows, [
    { start: 0.1, end: 0.3 },
    { start: 0.85, end: 1.05 },
  ]);

  // Real stall DURING active wheel / pressed pointermove burst IS flagged in activeMotionGapsOver2Frames
  const stalledDuringMotion = computeRawCaptureStats({
    rawFrames: [
      { index: 1, cdpTimestamp: 5.00, elapsed: 0.00 },
      { index: 2, cdpTimestamp: 5.10, elapsed: 0.10 },
      // 180ms stall right in the middle of wheel + pressed pointermove bursts!
      { index: 3, cdpTimestamp: 5.28, elapsed: 0.28 },
      { index: 4, cdpTimestamp: 5.30, elapsed: 0.30 },
    ],
    elapsedDuration: 0.4,
    requestedFps: 60,
    events: [
      { t: 0.10, type: 'wheel', x: 50, y: 50, deltaX: 0, deltaY: 120, duration: 0.05 },
      { t: 0.10, type: 'pointerdown', x: 50, y: 50, button: 'left' },
      { t: 0.15, type: 'pointermove', x: 90, y: 50 },
      { t: 0.22, type: 'pointermove', x: 130, y: 50 },
      { t: 0.28, type: 'pointermove', x: 170, y: 50 },
      { t: 0.30, type: 'pointerup', x: 170, y: 50, button: 'left' },
    ],
  });
  assert.equal(stalledDuringMotion.activeMotionGapsOver2Frames, 1);
  assert.equal(stalledDuringMotion.activeMotionMaxGapMs, 180);
});

test('semantic DOM locators ({ selector, role, text, label, offset, nth }) scroll off-screen elements, drive minimum-jerk steps, and record resolved target + camera hints', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-semantic-locators-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dummyFrame = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#0f172a' } }).png().toBuffer();
  const base64Frame = dummyFrame.toString('base64');

  let galleryScrolledIntoView = false;
  const locatorTrace = [];
  const mouseMoves = [];
  const typedText = [];

  const makeMockLocator = (id, getBox) => {
    const createIndexed = (nthIndex) => ({
      async waitFor({ state, timeout }) {
        locatorTrace.push({ op: 'waitFor', id, nthIndex, state, timeout });
      },
      async scrollIntoViewIfNeeded() {
        locatorTrace.push({ op: 'scrollIntoViewIfNeeded', id, nthIndex });
        if (id === 'role:button:Gallery') galleryScrolledIntoView = true;
      },
      async boundingBox() {
        return getBox(nthIndex);
      },
    });
    return {
      first: () => createIndexed(0),
      nth: (n) => createIndexed(n),
    };
  };

  const mockPage = {
    viewportSize: () => ({ width: 640, height: 360 }),
    async goto() {},
    async evaluate() { return true; },
    locator(selector) {
      locatorTrace.push({ op: 'locator', selector });
      if (selector === '.row-item') {
        return makeMockLocator('selector:.row-item', (n) => ({
          x: 200,
          y: 40 + n * 30,
          width: 100,
          height: 24,
        }));
      }
      if (selector === '#drop-slot') {
        return makeMockLocator('selector:#drop-slot', () => ({ x: 420, y: 180, width: 120, height: 60 }));
      }
      return makeMockLocator(`selector:${selector}`, () => null);
    },
    getByRole(role, opts) {
      locatorTrace.push({ op: 'getByRole', role, opts });
      if (role === 'button' && opts?.name === 'Gallery' && opts?.exact === true) {
        return makeMockLocator('role:button:Gallery', () =>
          galleryScrolledIntoView
            ? { x: 100, y: 140, width: 120, height: 40 } // scrolled into viewport -> center [160, 160]
            : { x: 100, y: 980, width: 120, height: 40 }, // initially off-screen below 360px fold!
        );
      }
      return makeMockLocator(`role:${role}`, () => null);
    },
    getByText(text, opts) {
      locatorTrace.push({ op: 'getByText', text, opts });
      if (text === 'Quick search') {
        return makeMockLocator('text:Quick search', () => ({ x: 300, y: 30, width: 140, height: 32 }));
      }
      return makeMockLocator(`text:${text}`, () => null);
    },
    getByLabel(label, opts) {
      locatorTrace.push({ op: 'getByLabel', label, opts });
      if (label === 'Filter query') {
        return makeMockLocator('label:Filter query', () => ({ x: 40, y: 36, width: 200, height: 36 }));
      }
      return makeMockLocator(`label:${label}`, () => null);
    },
    mouse: {
      async move(x, y) { mouseMoves.push([x, y]); },
      async down() {},
      async up() {},
      async wheel() {},
    },
    keyboard: {
      async press() {},
      async down() {},
      async up() {},
      async type(text) { typedText.push(text); },
    },
  };

  // Direct unit checks on resolveTargetPoint error handling
  await assert.rejects(
    resolveTargetPoint(mockPage, { role: 'button', name: 'Missing', timeout: 50 }),
    /matched no visible element/,
  );
  await assert.rejects(
    resolveTargetPoint(mockPage, { selector: '.row-item', nth: -1 }),
    /Invalid target\.nth/,
  );
  await assert.rejects(
    resolveTargetPoint(mockPage, { selector: '#a', role: 'button' }),
    /Unsupported target specification/,
  );

  const mockPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() { return mockPage; },
              async newCDPSession() {
                let listener = null;
                return {
                  on(ev, fn) { if (ev === 'Page.screencastFrame') listener = fn; },
                  async send(method) {
                    if (method === 'Page.captureScreenshot') return { data: base64Frame };
                    if (method === 'Page.startScreencast' && listener) {
                      listener({ data: base64Frame, metadata: { timestamp: 10.0 }, sessionId: 1 });
                      listener({ data: base64Frame, metadata: { timestamp: 10.016 }, sessionId: 2 });
                    }
                    return {};
                  },
                  async detach() {},
                };
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
    },
  };

  // Reject invalid per-step camera hint before running broken choreography
  await assert.rejects(
    captureBrowserTake({
      out: join(dir, 'bad-cam'),
      captureMode: 'headless',
      playwright: mockPw,
      encodeFrames: async () => ({ width: 640, height: 360, fps: 30, duration: 0.2, frames: 6, codec: 'h264', audio: false }),
      recipe: {
        url: 'https://example.test/app',
        viewport: [640, 360],
        steps: [{ type: 'click', target: { text: 'Quick search' }, camera: { zoom: 0, focus: 'invalid' } }],
      },
    }),
    /Invalid step camera hint/,
  );

  const take = await captureBrowserTake({
    out: join(dir, 'locator-take'),
    captureMode: 'headless',
    playwright: mockPw,
    encodeFrames: async ({ outputFile, targetDuration, rawFrames }) => {
      await writeFile(outputFile, Buffer.from('video'));
      return {
        width: 640,
        height: 360,
        fps: 60,
        duration: targetDuration,
        frames: Math.max(1, Math.round(targetDuration * 60)),
        measuredFps: 60,
        capturedFrames: rawFrames.length,
        codec: 'h264',
        audio: false,
      };
    },
    recipe: {
      url: 'https://example.test/app',
      viewport: [640, 360],
      fps: 60,
      tail: 0.02,
      steps: [
        // 0: off-screen ARIA role locator -> scrolls into view -> [160, 160]
        {
          type: 'click',
          target: { role: 'button', name: 'Gallery', exact: true },
          moveDuration: 0.05,
          hold: 0.01,
          label: 'Open Gallery',
          camera: { zoom: 1.75, focus: 'target', lead: 0.1, hold: 0.2 },
        },
        // 1: move to text locator with offset [10, -6] -> [370 + 10, 46 - 6] = [380, 40]
        {
          type: 'move',
          target: { text: 'Quick search', exact: true, offset: [10, -6] },
          duration: 0.04,
          label: 'Hover Search',
        },
        // 2: dblclick CSS selector with nth: 2 -> y = 40 + 60 + 12 = 112, x = 250
        {
          type: 'dblclick',
          target: { selector: '.row-item', nth: 2 },
          moveDuration: 0.04,
          hold: 0.01,
          label: 'Inspect Row 2',
        },
        // 3: drag from nth: 1 ([250, 82]) to #drop-slot ([480, 210]) -> midpoint [365, 146]
        {
          type: 'drag',
          from: { selector: '.row-item', nth: 1 },
          to: { selector: '#drop-slot' },
          moveDuration: 0.03,
          duration: 0.05,
          releaseHold: 0.01,
          label: 'Drag Row',
          camera: { zoom: 1.5, focus: 'target' },
        },
        // 4: wheel on #drop-slot
        {
          type: 'wheel',
          target: { selector: '#drop-slot' },
          moveDuration: 0.03,
          deltaX: 0,
          deltaY: 80,
          label: 'Wheel Slot',
        },
        // 5: gesture on #drop-slot
        {
          type: 'gesture',
          kind: 'pinch',
          target: { selector: '#drop-slot' },
          scaleFactor: 1.2,
          steps: 2,
          duration: 0.03,
          label: 'Pinch Slot',
        },
        // 6: type into label locator -> [140, 54], reset camera wide
        {
          type: 'type',
          target: { label: 'Filter query' },
          moveDuration: 0.03,
          hold: 0.01,
          delayMs: 2,
          text: 'hi',
          label: 'Type Filter',
          camera: 'wide',
        },
      ],
    },
  });

  // Off-screen Gallery button triggered scrollIntoViewIfNeeded before pointer glide
  assert.equal(galleryScrolledIntoView, true);
  assert.ok(locatorTrace.some((t) => t.op === 'scrollIntoViewIfNeeded' && t.id === 'role:button:Gallery'));
  assert.deepEqual(typedText, ['hi']);

  // Verify step events preserved exact resolved target coordinates and camera hints
  const stepEvents = take.eventTrackData.events.filter((e) => e.type === 'step');
  assert.equal(stepEvents.length, 7);
  assert.deepEqual(stepEvents[0].target, [160, 160]);
  assert.deepEqual(stepEvents[0].camera, { zoom: 1.75, focus: 'target', lead: 0.1, hold: 0.2 });
  assert.deepEqual(stepEvents[1].target, [380, 40]);
  assert.deepEqual(stepEvents[2].target, [250, 112]);
  assert.deepEqual(stepEvents[3].target, [365, 146]);
  assert.deepEqual(stepEvents[3].camera, { zoom: 1.5, focus: 'target' });
  assert.deepEqual(stepEvents[4].target, [480, 210]);
  assert.deepEqual(stepEvents[5].target, [480, 210]);
  assert.deepEqual(stepEvents[6].target, [140, 54]);
  assert.equal(stepEvents[6].camera, 'wide');

  // Verify real pointerdowns landed at exact resolved semantic locator coordinates
  const pointerdowns = take.eventTrackData.events.filter((e) => e.type === 'pointerdown');
  assert.deepEqual([pointerdowns[0].x, pointerdowns[0].y], [160, 160]); // Gallery click
  assert.deepEqual([pointerdowns[1].x, pointerdowns[1].y], [250, 112]); // Row 2 dblclick #1
  assert.deepEqual([pointerdowns[2].x, pointerdowns[2].y], [250, 112]); // Row 2 dblclick #2
  assert.deepEqual([pointerdowns[3].x, pointerdowns[3].y], [250, 82]); // Drag start from Row 1
  assert.deepEqual([pointerdowns[4].x, pointerdowns[4].y], [140, 54]); // Type input focus click

  // Compiles cleanly into a validated timeline with automatic step camera keyframes
  const compiled = compileTimeline({ eventTrack: take.eventTrackData });
  assert.deepEqual(validateTimeline(compiled), { ok: true, errors: [] });
  assert.ok(compiled.camera.keyframes.length >= 4);
});

test('real headless browser captures clean video take, rich event-track.json, and verifiable run.json', {
  skip: !process.env.SCREEN_KIT_BROWSER_TESTS,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-take-browser-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: rgb(18, 28, 45); font: 16px system-ui; overflow: hidden; user-select: none; }
  #action-btn {
    position: absolute; left: 40px; top: 30px; width: 160px; height: 70px;
    background: rgb(180, 40, 40); color: #fff; border: 0; border-radius: 8px; font-size: 16px;
  }
  #action-btn:hover { background: rgb(220, 140, 20); }
  #action-btn:active { transform: scale(0.97); }
  #card {
    position: absolute; left: 60px; top: 130px; width: 90px; height: 50px;
    background: rgb(60, 120, 220); color: #fff; display: flex; align-items: center; justify-content: center; border-radius: 6px;
  }
  #scroller {
    position: absolute; left: 40px; top: 210px; width: 560px; height: 110px;
    overflow-x: auto; overscroll-behavior-x: contain; background: rgb(35, 45, 65);
  }
  #scroller-inner {
    width: 2200px; height: 100%;
    background: repeating-linear-gradient(90deg, rgb(50, 70, 100) 0 80px, rgb(90, 130, 180) 80px 160px);
  }
  #pulse {
    position: absolute; right: 6px; bottom: 6px; width: 8px; height: 8px; border-radius: 50%;
    background: rgb(40, 80, 120);
  }
</style>
</head>
<body>
  <button id="action-btn">Activate</button>
  <div id="card">Drag</div>
  <div id="scroller"><div id="scroller-inner"></div></div>
  <div id="pulse"></div>
  <script>
    const pulseEl = document.getElementById('pulse');
    let pulseTick = 0;
    (function loop() {
      pulseTick = (pulseTick + 1) % 60;
      pulseEl.style.opacity = String(0.4 + (pulseTick / 60) * 0.5);
      requestAnimationFrame(loop);
    })();
    window.__state = { hovered: false, clicked: false, draggedTo: null, wheelEvents: 0, scrolledMax: 0, shortcut: null };
    const btn = document.getElementById('action-btn');
    btn.addEventListener('pointerenter', () => { window.__state.hovered = true; });
    btn.addEventListener('click', () => {
      window.__state.clicked = true;
      document.body.style.background = 'rgb(20, 150, 70)';
    });

    const card = document.getElementById('card');
    let dragging = false, offsetX = 0, offsetY = 0;
    card.addEventListener('pointerdown', (e) => {
      dragging = true;
      card.setPointerCapture(e.pointerId);
      const r = card.getBoundingClientRect();
      offsetX = e.clientX - r.left;
      offsetY = e.clientY - r.top;
    });
    card.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nx = Math.round(e.clientX - offsetX);
      const ny = Math.round(e.clientY - offsetY);
      card.style.left = nx + 'px';
      card.style.top = ny + 'px';
      window.__state.draggedTo = [nx, ny];
    });
    card.addEventListener('pointerup', () => { dragging = false; });

    const scroller = document.getElementById('scroller');
    scroller.addEventListener('wheel', () => { window.__state.wheelEvents++; }, { passive: true });
    scroller.addEventListener('scroll', () => {
      window.__state.scrolledMax = Math.max(window.__state.scrolledMax, scroller.scrollLeft);
    }, { passive: true });

    window.addEventListener('keydown', (e) => {
      if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        window.__state.shortcut = 'Meta+k';
      }
    });
  </script>
</body>
</html>`;

  const server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  const out = join(cwd, 'out');
  const config = {
    recipes: {
      demo: {
        source: 'browser',
        captureMode: 'headless',
        format: 'mp4',
        url,
        viewport: [640, 360],
        fps: 30,
        steps: [
          { type: 'hover', target: { role: 'button', name: 'Activate', exact: true }, duration: 0.2, label: 'hover button' },
          { type: 'click', target: { role: 'button', name: 'Activate', exact: true }, hold: 0.06, label: 'click button', camera: { zoom: 1.5, focus: 'target' } },
          { type: 'drag', from: { text: 'Drag', exact: true }, to: [340, 155], duration: 0.25, label: 'drag card', camera: 'wide' },
          { type: 'wheel', target: '#scroller', deltaX: 160, deltaY: 0, phase: 'changed', label: 'wheel scroll' },
          { type: 'gesture', kind: 'scroll', target: '#scroller', deltaX: -240, deltaY: 0, duration: 0.25, settle: 0.15, label: 'trackpad scroll' },
          { type: 'key', key: 'k', modifiers: ['Meta'], action: 'press', label: 'command palette' },
          { type: 'pause', duration: 0.15 },
          {
            type: 'eval',
            eval: `
              const s = window.__state;
              if (!s.hovered) throw Error('pointer hover never triggered');
              if (!s.clicked) throw Error('button click never triggered');
              if (!s.draggedTo || s.draggedTo[0] < 250) throw Error('card drag did not move card: ' + JSON.stringify(s.draggedTo));
              if (s.wheelEvents < 1) throw Error('wheel event did not reach scroller');
              if (s.scrolledMax < 150) throw Error('scroll did not advance scroller: ' + s.scrolledMax);
              if (s.shortcut !== 'Meta+k') throw Error('Meta+k shortcut did not fire');
              if (document.getElementById('__demo_cursor')) throw Error('cursor must not be baked into DOM');
            `,
          },
        ],
      },
    },
  };

  const report = await captureRun({ config, cwd, out });
  assert.equal(report.status, 'complete');

  const entry = report.recipes.demo;
  assert.equal(entry.status, 'complete');
  assert.equal(entry.captureMode, 'headless');
  assert.equal(entry.requestedFps, 30);
  assert.equal(entry.fps, 30);
  assert.ok(entry.measuredFps > 0, `expected positive measuredFps, got ${entry.measuredFps}`);
  assert.ok(entry.capturedFrames >= 2, `expected multiple captured screencast frames, got ${entry.capturedFrames}`);
  assert.equal(entry.width, 640);
  assert.equal(entry.height, 360);
  assert.ok(entry.frames >= 30);
  assert.ok(entry.duration >= 1.0);

  // Verify video take and event-track.json files and hashes in run.json.
  const exportedVideo = join(out, entry.file);
  const takeVideo = join(out, entry.take);
  const eventTrackFile = join(out, entry.eventTrack);

  assert.equal(entry.sha256, hash(await readFile(exportedVideo)));
  assert.equal(entry.takeSha256, hash(await readFile(takeVideo)));
  assert.equal(entry.eventTrackSha256, hash(await readFile(eventTrackFile)));
  assert.equal(entry.inputs.length, 2);

  const probe = await probeVideo(exportedVideo);
  assert.deepEqual([probe.width, probe.height], [640, 360]);
  assert.equal(probe.audio, false);

  // Verify first frame (dark blue background) vs last frame (green background after real click) and no baked cursor.
  const firstPixel = execFileSync('ffmpeg', [
    '-v', 'error', '-i', exportedVideo, '-vf', 'crop=10:10:580:20,scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ]);
  const lastPixel = execFileSync('ffmpeg', [
    '-v', 'error', '-sseof', '-0.15', '-i', exportedVideo, '-vf', 'crop=10:10:580:20,scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ]);
  assert.ok(firstPixel[2] > firstPixel[1], `initial background should be dark blue, got rgb(${firstPixel[0]},${firstPixel[1]},${firstPixel[2]})`);
  assert.ok(lastPixel[1] > 110 && lastPixel[0] < 60, `final background should turn green after click, got rgb(${lastPixel[0]},${lastPixel[1]},${lastPixel[2]})`);

  // Validate Event Track v1 contents.
  const track = validateEventTrack(JSON.parse(await readFile(eventTrackFile, 'utf8')));
  assert.equal(track.version, 1);
  assert.equal(track.captureMode, 'headless');
  assert.deepEqual(track.viewport, { width: 640, height: 360, deviceScaleFactor: 1 });
  assert.equal(track.video.file, 'take.mp4');
  assert.equal(track.video.width, 640);
  assert.equal(track.video.height, 360);

  const types = new Set(track.events.map((e) => e.type));
  for (const expectedType of ['pointermove', 'pointerdown', 'pointerup', 'drag', 'wheel', 'gesture', 'key', 'step']) {
    assert.ok(types.has(expectedType), `event-track missing event type: ${expectedType}`);
  }

  // Review passes on valid manifest, and fails if event-track.json is tampered with.
  const manifest = join(out, 'run.json');
  const reviewOk = await reviewRun({ manifest });
  assert.equal(reviewOk.ok, true);

  const tampered = { ...track, events: [{ t: 2, type: 'pointermove', x: 0, y: 0 }, { t: 1, type: 'pointermove', x: 1, y: 1 }] };
  const tamperedText = JSON.stringify(tampered);
  await writeFile(eventTrackFile, tamperedText);
  const reviewHashFail = await reviewRun({ manifest });
  assert.equal(reviewHashFail.ok, false);
});

test('failed browser take closes Chromium cleanly and leaves an inspectable failed manifest', {
  skip: !process.env.SCREEN_KIT_BROWSER_TESTS,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-take-fail-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const pageFile = join(cwd, 'page.html');
  await writeFile(pageFile, '<!doctype html><body><p>ready</p></body>');
  const out = join(cwd, 'out');

  await assert.rejects(
    captureRun({
      cwd,
      out,
      config: {
        recipes: {
          broken: {
            source: 'browser',
            captureMode: 'headless',
            format: 'mp4',
            url: pathToFileURL(pageFile).href,
            viewport: [320, 240],
            steps: [{ type: 'click', target: '#does-not-exist' }],
          },
        },
      },
    }),
    /matched no visible element/,
  );

  const report = JSON.parse(await readFile(join(out, 'run.json'), 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.recipes.broken.status, 'failed');
  assert.match(report.recipes.broken.error, /matched no visible element/);
});
