import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { computeWindowChrome } from '../src/remotion/layout.mjs';
import { renderTimeline } from '../src/render-timeline.mjs';
import { reviewVideo } from '../src/review-video.mjs';
import { loadConfiguration, selectedRecipes } from '../src/run.mjs';
import { captureBrowserTake } from '../src/take-browser.mjs';
import { cameraViewportRect, compileTimeline, sampleCamera, validateTimeline } from '../src/timeline.mjs';
import { startDataGridFixtureServer } from './fixtures/benchmarks/data-grid-fixture.mjs';
import {
  buildDataGridSmokeRecipe,
  buildDataGridSmokeTimeline,
  buildStraylightAcceptanceRecipe,
  buildStraylightAcceptanceTimeline,
} from './fixtures/benchmarks/recipes.mjs';
import {
  startStraylightFixtureServer,
  writeStraylightWallpaper,
} from './fixtures/benchmarks/straylight-fixture.mjs';

const execFile = promisify(execFileCb);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.mjs');

async function listOwnedBrowserProcesses(marker) {
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,command=']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line.includes(marker));
  } catch {
    return [];
  }
}

function assertCameraLeavesWindowInsideStage(timeline) {
  const validation = validateTimeline(timeline);
  assert.equal(validation.ok, true, `Expected valid timeline, got: ${validation.errors.join('; ')}`);

  const chrome = computeWindowChrome(timeline.window);
  const winOuter = chrome.outerRect;
  let revealsLeft = false;
  let revealsRight = false;
  let revealsTop = false;
  let revealsBottom = false;

  for (const kf of timeline.camera.keyframes) {
    const rect = cameraViewportRect(timeline.camera, sampleCamera(timeline.camera, kf.t));
    assert.ok(rect.left >= -1e-6 && rect.top >= -1e-6, 'camera stays >= 0 inside stage');
    assert.ok(
      rect.right <= timeline.stage.width + 1e-6 && rect.bottom <= timeline.stage.height + 1e-6,
      'camera stays <= stage dimensions',
    );
    if (rect.left < winOuter.x - 4) revealsLeft = true;
    if (rect.right > winOuter.x + winOuter.width + 4) revealsRight = true;
    if (rect.top < winOuter.y - 4) revealsTop = true;
    if (rect.bottom > winOuter.y + winOuter.height + 4) revealsBottom = true;
  }

  assert.ok(
    revealsLeft && revealsRight && revealsTop && revealsBottom,
    `Expected camera keyframes to leave window outerRect ${JSON.stringify(winOuter)} to reveal frame & wallpaper`,
  );
}

test('consumer benchmark example configs load standalone and satisfy stage/window/camera invariants', async () => {
  const dgExamplePath = join(REPO_ROOT, 'examples', 'data-grid.screen-kit.mjs');
  const slExamplePath = join(REPO_ROOT, 'examples', 'straylight.screen-kit.mjs');

  const [dgLoaded, slLoaded, dgMod, slMod] = await Promise.all([
    loadConfiguration(dgExamplePath, REPO_ROOT),
    loadConfiguration(slExamplePath, REPO_ROOT),
    import('../examples/data-grid.screen-kit.mjs'),
    import('../examples/straylight.screen-kit.mjs'),
  ]);

  const [[dgName, dgRecipe]] = selectedRecipes(dgLoaded.config);
  const [[slName, slRecipe]] = selectedRecipes(slLoaded.config);
  assert.equal(dgName, 'rubber-band-smoke');
  assert.equal(dgRecipe.story, 'data-grid-regression-datagrid--playground');
  assert.equal(slName, 'scenario-editor-acceptance');
  assert.equal(slRecipe.story, 'straylight-scenarios--linear');

  const syntheticTrack = {
    version: 1,
    captureMode: 'quality',
    viewport: { width: 1440, height: 810, deviceScaleFactor: 2 },
    video: { file: 'take.mp4', width: 2880, height: 1620, fps: 60, duration: 4.6, frames: 276 },
    events: [
      { t: 0, type: 'pointermove', x: 720, y: 405 },
      { t: 0.4, type: 'step', index: 0, label: 'Drag action card from palette' },
      { t: 0.5, type: 'drag', from: [640, 42], to: [860, 520], duration: 0.45 },
      { t: 1.3, type: 'gesture', kind: 'scroll', x: 720, y: 405, deltaX: -160, deltaY: -80, duration: 0.3 },
      { t: 1.8, type: 'gesture', kind: 'pinch', x: 720, y: 405, deltaX: 0, deltaY: -48, duration: 0.3 },
      { t: 3.6, type: 'key', key: 'a', modifiers: ['Meta'], action: 'press' },
      { t: 4.0, type: 'key', key: 'l', modifiers: ['Shift', 'Meta'], action: 'press' },
    ],
  };

  const dgTimeline = compileTimeline({
    eventTrack: { ...syntheticTrack, video: { ...syntheticTrack.video, duration: 3.4, frames: 204 } },
    recipe: dgMod.timelinePresentation,
  });
  assert.equal(dgTimeline.window.frame, 'browser');
  assertCameraLeavesWindowInsideStage(dgTimeline);

  const slTimeline = compileTimeline({
    eventTrack: syntheticTrack,
    recipe: slMod.timelinePresentation,
  });
  assert.equal(slTimeline.window.frame, 'macos');
  assert.equal(slTimeline.stage.background.type, 'image');
  assert.deepEqual(
    slTimeline.overlays.keystrokes.map((k) => k.label),
    ['⌘A', '⇧⌘L'],
  );
  assertCameraLeavesWindowInsideStage(slTimeline);
});

test('fast non-browser pipeline integration: compileTimeline -> renderTimeline -> reviewVideo', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-bench-fast-'));
  const scratchDir = join(workDir, 'scratch');
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const takePath = join(workDir, 'take.mp4');
  const wallpaperPath = join(workDir, 'wallpaper.png');
  await Promise.all([
    execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=15:duration=1.2',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '18',
      takePath,
    ], { timeout: 60000 }),
    writeStraylightWallpaper(wallpaperPath, { width: 800, height: 480 }),
  ]);

  const eventTrack = {
    version: 1,
    captureMode: 'headless',
    viewport: { width: 480, height: 270, deviceScaleFactor: 1 },
    video: { file: 'take.mp4', width: 480, height: 270, fps: 15, duration: 1.2, frames: 18 },
    startedAt: '2026-11-22T00:00:00.000Z',
    events: [
      { t: 0.0, type: 'pointermove', x: 180, y: 40 },
      { t: 0.05, type: 'step', index: 0, label: 'Palette drag' },
      { t: 0.08, type: 'drag', from: [180, 40], to: [310, 175], duration: 0.28 },
      { t: 0.1, type: 'pointerdown', x: 180, y: 40, button: 'left' },
      { t: 0.22, type: 'pointermove', x: 245, y: 110 },
      { t: 0.36, type: 'pointerup', x: 310, y: 175, button: 'left' },
      { t: 0.45, type: 'step', index: 1, label: 'Pan and pinch-zoom' },
      { t: 0.48, type: 'gesture', kind: 'scroll', x: 310, y: 175, deltaX: -80, deltaY: -30, duration: 0.2 },
      { t: 0.68, type: 'gesture', kind: 'pinch', x: 310, y: 175, deltaX: 0, deltaY: -50, duration: 0.2 },
      { t: 0.88, type: 'step', index: 2, label: 'Tidy shortcut' },
      { t: 0.9, type: 'key', key: 'l', modifiers: ['Shift', 'Meta'], action: 'press', duration: 0.28 },
    ],
  };

  const eventTrackPath = join(workDir, 'event-track.json');
  await writeFile(eventTrackPath, JSON.stringify(eventTrack, null, 2) + '\n');

  const timeline = compileTimeline({
    take: { video: 'take.mp4', eventTrack: 'event-track.json' },
    eventTrack,
    recipe: {
      stage: {
        width: 720,
        height: 432,
        padding: 72,
        background: { type: 'image', src: 'wallpaper.png', fit: 'cover' },
      },
      window: {
        frame: 'macos',
        title: 'Straylight — Fast Pipeline Check',
        width: 480,
        height: 270,
      },
      camera: {
        outputWidth: 640,
        outputHeight: 360,
        keyframes: [
          { t: 0, x: 360, y: 210, zoom: 1.0, easing: 'linear' },
          { t: 0.6, x: 330, y: 196, zoom: 1.15, easing: 'ease-in-out' },
          { t: 1.2, x: 360, y: 210, zoom: 0.96, easing: 'ease-in-out' },
        ],
      },
      outputs: ['web-loop'],
    },
  });
  assertCameraLeavesWindowInsideStage(timeline);

  const timelinePath = join(workDir, 'timeline.json');
  await writeFile(timelinePath, JSON.stringify(timeline, null, 2) + '\n');

  const renderOutFile = join(workDir, 'renders', 'pipeline.mp4');
  const renderResult = await renderTimeline({
    timeline: timelinePath,
    out: renderOutFile,
    scratchDir,
  });

  assert.equal(renderResult.renderer, 'remotion-4');
  assert.equal(renderResult.outputs.length, 1);
  assert.deepEqual(await readdir(scratchDir), []);

  const mp4Out = renderResult.outputs[0];
  assert.equal(mp4Out.format, 'mp4');

  const reviewDir = join(workDir, 'review');
  const { stdout } = await execFile(
    process.execPath,
    [
      CLI_PATH, 'review',
      '--video', mp4Out.file,
      '--timeline', timelinePath,
      '--event-track', eventTrackPath,
      '--out-dir', reviewDir,
    ],
    { cwd: REPO_ROOT, timeout: 90000 },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.equal(report.findings.length, 0);
  assert.equal(report.metrics.width, 640);
  assert.equal(report.metrics.height, 360);
  assert.equal(report.metrics.frames, 18);
  assert.ok(report.metrics.cursor.maxErrorPx <= 2);
  assert.equal(report.artifacts.stills.length, 3);
  await access(report.artifacts.contactSheet.file);
});

test('Benchmark 1 (Smoke): Data Grid horizontal rubber-band full browser -> timeline -> Remotion -> review pipeline', {
  skip: !process.env.SCREEN_KIT_BROWSER_TESTS,
}, async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-dg-smoke-'));
  const scratchDir = join(workDir, 'scratch');
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const server = await startDataGridFixtureServer();
  t.after(() => server.close());

  const captureMode = process.env.SCREEN_KIT_CAPTURE_MODE ?? 'headless';
  const takeDir = join(workDir, 'take');
  const recipe = buildDataGridSmokeRecipe({ url: server.url, captureMode });

  // 1. Real browser take capture
  const takeResult = await captureBrowserTake({
    name: 'data-grid-rubber-band',
    recipe,
    cwd: workDir,
    out: takeDir,
    captureMode,
  });

  assert.equal(takeResult.captureMode, captureMode);
  assert.ok(takeResult.capturedFrames >= 8, `expected >= 8 screencast frames, got ${takeResult.capturedFrames}`);
  assert.ok(takeResult.measuredFps > 0, `expected positive measuredFps, got ${takeResult.measuredFps}`);
  assert.ok(takeResult.frames >= 30, `expected >= 30 encoded take frames, got ${takeResult.frames}`);

  // 2. Compile timeline.json (gradient stage + browser window chrome + subtle camera zoom + cursor/gesture overlays)
  const eventTrack = JSON.parse(await readFile(takeResult.eventTrack, 'utf8'));
  const timeline = buildDataGridSmokeTimeline({
    take: {
      video: takeResult.file,
      eventTrack: takeResult.eventTrack,
      width: takeResult.width,
      height: takeResult.height,
      fps: takeResult.fps,
      duration: takeResult.duration,
      frames: takeResult.frames,
      captureMode: takeResult.captureMode,
      viewport: takeResult.viewport,
    },
    eventTrack,
  });
  assert.equal(timeline.window.frame, 'browser');
  assert.ok(timeline.overlays.gestures.length >= 3, 'expected scroll/rubber-band gesture overlays');
  assert.ok(timeline.overlays.ripples.length >= 1, 'expected click ripple overlay');

  const timelinePath = join(workDir, 'timeline.json');
  await writeFile(timelinePath, JSON.stringify(timeline, null, 2) + '\n');

  // 3. Render silent web-loop (VP9 WebM + H.264 MP4 + PNG poster) via CLI boundary
  const renderDir = join(workDir, 'renders');
  const { stdout: renderStdout } = await execFile(
    process.execPath,
    [CLI_PATH, 'render', '--input', timelinePath, '--out', renderDir, '--profiles', 'web-loop'],
    { cwd: REPO_ROOT, timeout: 240000 },
  );
  const renderResult = JSON.parse(renderStdout);
  assert.equal(renderResult.renderer, 'remotion-4');
  assert.equal(renderResult.outputs.length, 3);

  const webmOut = renderResult.outputs.find((o) => o.format === 'webm');
  const mp4Out = renderResult.outputs.find((o) => o.format === 'mp4');
  const posterOut = renderResult.outputs.find((o) => o.role === 'poster');
  assert.ok(webmOut && mp4Out && posterOut);

  const posterMeta = await sharp(posterOut.file).metadata();
  assert.equal(posterMeta.width, 1120);
  assert.equal(posterMeta.height, 630);

  // 4. Automated video review on both MP4 and WebM outputs
  const [mp4Review, webmReview] = await Promise.all([
    reviewVideo({
      video: mp4Out.file,
      timeline,
      eventTrack,
      outDir: join(workDir, 'review-mp4'),
      expected: { width: 1120, height: 630, codec: 'h264', fps: takeResult.fps },
    }),
    reviewVideo({
      video: webmOut.file,
      timeline,
      eventTrack,
      outDir: join(workDir, 'review-webm'),
      expected: { width: 1120, height: 630, codec: 'vp9', fps: takeResult.fps },
    }),
  ]);

  assert.equal(mp4Review.ok, true, JSON.stringify(mp4Review.checks, null, 2));
  assert.equal(webmReview.ok, true, JSON.stringify(webmReview.checks, null, 2));
  assert.equal(mp4Review.findings.length, 0);
  assert.ok(mp4Review.metrics.cursor.maxErrorPx <= 2);
  assert.equal(mp4Review.artifacts.stills.length, 4);
  await access(mp4Review.artifacts.contactSheet.file);
  await access(webmReview.artifacts.contactSheet.file);
  void scratchDir;

  const summary = {
    benchmark: 'data-grid-rubber-band-smoke',
    captureMode: takeResult.captureMode,
    take: {
      width: takeResult.width,
      height: takeResult.height,
      requestedFps: takeResult.requestedFps,
      encodedFps: takeResult.fps,
      measuredScreencastFps: takeResult.measuredFps,
      capturedScreencastFrames: takeResult.capturedFrames,
      frames: takeResult.frames,
      durationSec: takeResult.duration,
    },
    renders: {
      mp4: {
        width: mp4Review.metrics.width,
        height: mp4Review.metrics.height,
        fps: mp4Review.metrics.fps,
        frames: mp4Review.metrics.frames,
        durationSec: mp4Review.metrics.duration,
        bytes: mp4Review.metrics.fileSizeBytes,
        reviewOk: mp4Review.ok,
      },
      webm: {
        width: webmReview.metrics.width,
        height: webmReview.metrics.height,
        fps: webmReview.metrics.fps,
        frames: webmReview.metrics.frames,
        durationSec: webmReview.metrics.duration,
        bytes: webmReview.metrics.fileSizeBytes,
        reviewOk: webmReview.ok,
      },
      poster: {
        file: basename(posterOut.file),
        width: posterMeta.width,
        height: posterMeta.height,
        bytes: posterOut.bytes,
      },
    },
    review: {
      ok: mp4Review.ok && webmReview.ok,
      checksPassed: mp4Review.checks.filter((c) => c.ok).length,
      checksTotal: mp4Review.checks.length,
      cursorMaxErrorPx: mp4Review.metrics.cursor.maxErrorPx,
      stillsCount: mp4Review.artifacts.stills.length,
      contactSheet: `${mp4Review.artifacts.contactSheet.width}x${mp4Review.artifacts.contactSheet.height}`,
    },
  };
  console.log('BENCHMARK_METRICS_JSON:' + JSON.stringify(summary));
});

test('Benchmark 2 (Acceptance): Straylight scenario editor full flow on wallpaper stage with macOS frame & zero leaked processes', {
  skip: !process.env.SCREEN_KIT_BROWSER_TESTS,
}, async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-straylight-e2e-'));
  const scratchDir = join(workDir, 'scratch');
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const server = await startStraylightFixtureServer();
  t.after(() => server.close());

  const wallpaperPath = await writeStraylightWallpaper(join(workDir, 'wallpaper.png'), {
    width: 1600,
    height: 960,
  });

  const captureMode = process.env.SCREEN_KIT_CAPTURE_MODE ?? 'headless';
  const takeDir = join(workDir, 'take');
  const recipe = buildStraylightAcceptanceRecipe({ url: server.url, captureMode });

  // 1. Drive real scenario editor interactions in Chromium
  const takeResult = await captureBrowserTake({
    name: 'straylight-scenario-editor',
    recipe,
    cwd: workDir,
    out: takeDir,
    captureMode,
  });

  assert.equal(takeResult.captureMode, captureMode);
  assert.ok(takeResult.capturedFrames >= 12, `expected >= 12 screencast frames, got ${takeResult.capturedFrames}`);
  assert.ok(takeResult.measuredFps > 0, `expected positive measuredFps, got ${takeResult.measuredFps}`);
  assert.ok(takeResult.frames >= 60, `expected >= 60 encoded take frames, got ${takeResult.frames}`);

  // 2. Compile timeline.json: macOS window frame on wallpaper stage where camera leaves window bounds
  const eventTrack = JSON.parse(await readFile(takeResult.eventTrack, 'utf8'));
  const timeline = buildStraylightAcceptanceTimeline({
    take: {
      video: takeResult.file,
      eventTrack: takeResult.eventTrack,
      width: takeResult.width,
      height: takeResult.height,
      fps: takeResult.fps,
      duration: takeResult.duration,
      frames: takeResult.frames,
      captureMode: takeResult.captureMode,
      viewport: takeResult.viewport,
    },
    eventTrack,
    wallpaperSrc: wallpaperPath,
  });

  assert.equal(timeline.window.frame, 'macos');
  assert.equal(timeline.stage.background.type, 'image');
  assertCameraLeavesWindowInsideStage(timeline);

  const gestureKinds = new Set(timeline.overlays.gestures.map((g) => g.kind));
  assert.ok(gestureKinds.has('drag'), 'expected palette/marquee drag gesture overlays');
  assert.ok(gestureKinds.has('scroll'), 'expected canvas pan gesture overlay');
  assert.ok(gestureKinds.has('pinch'), 'expected canvas pinch-zoom gesture overlay');
  assert.ok(timeline.overlays.ripples.length >= 3, 'expected click & drag ripples');
  assert.deepEqual(
    timeline.overlays.keystrokes.map((k) => k.label),
    ['⌘A', '⇧⌘L'],
  );

  const timelinePath = join(workDir, 'timeline.json');
  await writeFile(timelinePath, JSON.stringify(timeline, null, 2) + '\n');

  // 3. Render web-loop (VP9 WebM + H.264 MP4 + PNG poster) via Remotion 4
  const renderDir = join(workDir, 'renders');
  const renderResult = await renderTimeline({
    timeline: timelinePath,
    outDir: renderDir,
    profiles: ['web-loop'],
    scratchDir,
  });

  assert.equal(renderResult.renderer, 'remotion-4');
  assert.equal(renderResult.outputs.length, 3);
  assert.deepEqual(await readdir(scratchDir), []);

  const webmOut = renderResult.outputs.find((o) => o.format === 'webm');
  const mp4Out = renderResult.outputs.find((o) => o.format === 'mp4');
  const posterOut = renderResult.outputs.find((o) => o.role === 'poster');
  assert.ok(webmOut && mp4Out && posterOut);

  // Verify poster (t=0, zoom=1.0) shows wallpaper outside window (top-left corner 24,24 is non-black wallpaper)
  const { data: posterRaw, info: posterInfo } = await sharp(posterOut.file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(posterInfo.width, 1280);
  assert.equal(posterInfo.height, 720);
  const wpIdx = (24 * posterInfo.width + 24) * 4;
  assert.ok(
    posterRaw[wpIdx + 2] > 25,
    `expected visible stage wallpaper outside macOS window at (24,24), got rgb(${posterRaw[wpIdx]},${posterRaw[wpIdx + 1]},${posterRaw[wpIdx + 2]})`,
  );

  // 4. Full automated review (deterministic checks + contact sheet + per-step stills + multimodal payload verification)
  let multimodalInspected = false;
  const reviewDir = join(workDir, 'review-mp4');
  const [mp4Review, webmReview] = await Promise.all([
    reviewVideo({
      video: mp4Out.file,
      timeline,
      eventTrack,
      outDir: reviewDir,
      expected: { width: 1280, height: 720, codec: 'h264', fps: takeResult.fps },
      multimodal: {
        enabled: true,
        provider: 'benchmark-inspector',
        reviewFn: async (payload) => {
          multimodalInspected = true;
          assert.ok(payload.contactSheet?.endsWith('contact-sheet.png'));
          assert.ok(payload.stills.length >= 8);
          assert.equal(payload.timelineSummary.window.frame, 'macos');
          assert.equal(payload.timelineSummary.overlays.keystrokes, 2);
          return {
            ok: true,
            summary: 'macOS traffic-light frame, wallpaper stage, cursor, ripples, gestures, and keystroke pills verified',
            findings: [],
          };
        },
      },
    }),
    reviewVideo({
      video: webmOut.file,
      timeline,
      eventTrack,
      outDir: join(workDir, 'review-webm'),
      expected: { width: 1280, height: 720, codec: 'vp9', fps: takeResult.fps },
    }),
  ]);

  assert.equal(multimodalInspected, true);
  assert.equal(mp4Review.ok, true, JSON.stringify(mp4Review.checks, null, 2));
  assert.equal(webmReview.ok, true, JSON.stringify(webmReview.checks, null, 2));
  assert.equal(mp4Review.findings.length, 0);
  assert.ok(mp4Review.metrics.cursor.maxErrorPx <= 2);
  assert.equal(mp4Review.artifacts.stills.length, 8);
  await access(mp4Review.artifacts.contactSheet.file);
  await access(mp4Review.artifacts.report);

  // 5. Verify zero leaked Chromium/Remotion processes referencing our workDir or scratchDir
  const leakedWork = await listOwnedBrowserProcesses(workDir);
  const leakedRemotion = await listOwnedBrowserProcesses('screen-kit-remotion-');
  assert.deepEqual(leakedWork, [], `Leaked processes for workDir: ${leakedWork.join('\n')}`);
  assert.deepEqual(leakedRemotion, [], `Leaked Remotion browser processes: ${leakedRemotion.join('\n')}`);

  const summary = {
    benchmark: 'straylight-scenario-editor-acceptance',
    captureMode: takeResult.captureMode,
    take: {
      width: takeResult.width,
      height: takeResult.height,
      requestedFps: takeResult.requestedFps,
      encodedFps: takeResult.fps,
      measuredScreencastFps: takeResult.measuredFps,
      capturedScreencastFrames: takeResult.capturedFrames,
      frames: takeResult.frames,
      durationSec: takeResult.duration,
    },
    renders: {
      mp4: {
        width: mp4Review.metrics.width,
        height: mp4Review.metrics.height,
        fps: mp4Review.metrics.fps,
        frames: mp4Review.metrics.frames,
        durationSec: mp4Review.metrics.duration,
        bytes: mp4Review.metrics.fileSizeBytes,
        reviewOk: mp4Review.ok,
      },
      webm: {
        width: webmReview.metrics.width,
        height: webmReview.metrics.height,
        fps: webmReview.metrics.fps,
        frames: webmReview.metrics.frames,
        durationSec: webmReview.metrics.duration,
        bytes: webmReview.metrics.fileSizeBytes,
        reviewOk: webmReview.ok,
      },
      poster: {
        file: basename(posterOut.file),
        width: posterInfo.width,
        height: posterInfo.height,
        bytes: posterOut.bytes,
      },
    },
    review: {
      ok: mp4Review.ok && webmReview.ok,
      checksPassed: mp4Review.checks.filter((c) => c.ok).length,
      checksTotal: mp4Review.checks.length,
      cursorMaxErrorPx: mp4Review.metrics.cursor.maxErrorPx,
      stillsCount: mp4Review.artifacts.stills.length,
      contactSheet: `${mp4Review.artifacts.contactSheet.width}x${mp4Review.artifacts.contactSheet.height}`,
      multimodalRan: mp4Review.multimodal.ran,
    },
  };
  console.log('BENCHMARK_METRICS_JSON:' + JSON.stringify(summary));
});
