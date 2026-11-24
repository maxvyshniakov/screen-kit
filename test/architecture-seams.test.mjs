import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as rootApi from '../src/index.mjs';
import * as remotionLayout from '../src/remotion/layout.mjs';
import * as renderTimelineMod from '../src/render-timeline.mjs';
import {
  verifyCameraBounds,
  verifyRenderedCursorPixels,
} from '../src/review-video.mjs';
import * as timelineScene from '../src/timeline-scene.mjs';
import {
  applyEasing,
  compileTimeline,
  findUpperBoundIndex,
  sampleCamera,
  sampleCursor,
  validateTimeline,
  validateTimelineDetailed,
} from '../src/timeline.mjs';
import { renderVideo } from '../src/video.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function extractStaticModuleSpecifiers(source) {
  const specs = [];
  const staticRe = /^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(staticRe)) {
    specs.push(match[1]);
  }
  return specs;
}

function makeBaseEventTrack(overrides = {}) {
  return {
    version: 1,
    captureMode: 'headless',
    viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
    video: { file: 'take.mp4', width: 320, height: 180, fps: 10, duration: 1.0, frames: 10 },
    events: [
      { t: 0.0, type: 'pointermove', x: 60, y: 50 },
      { t: 0.3, type: 'pointermove', x: 160, y: 90 },
      { t: 0.6, type: 'pointerdown', x: 220, y: 120, button: 'left' },
      { t: 0.7, type: 'pointerup', x: 220, y: 120, button: 'left' },
      { t: 0.9, type: 'pointermove', x: 260, y: 140 },
    ],
    ...overrides,
  };
}

test('S2 reverse seam guard: review modules have zero static imports of remotion/* and layout.mjs is a pure re-export barrel', async () => {
  const [reviewSrc, reviewVideoSrc, timelineSceneSrc, indexSrc] = await Promise.all([
    readFile(join(REPO_ROOT, 'src', 'review.mjs'), 'utf8'),
    readFile(join(REPO_ROOT, 'src', 'review-video.mjs'), 'utf8'),
    readFile(join(REPO_ROOT, 'src', 'timeline-scene.mjs'), 'utf8'),
    readFile(join(REPO_ROOT, 'src', 'index.mjs'), 'utf8'),
  ]);

  const reviewSpecs = extractStaticModuleSpecifiers(reviewSrc);
  const reviewVideoSpecs = extractStaticModuleSpecifiers(reviewVideoSrc);
  const timelineSceneSpecs = extractStaticModuleSpecifiers(timelineSceneSrc);
  const indexSpecs = extractStaticModuleSpecifiers(indexSrc);

  // Reverse seam: review.mjs and review-video.mjs must have zero static imports of src/remotion/* or render-timeline.mjs
  for (const [name, specs] of [
    ['src/review.mjs', reviewSpecs],
    ['src/review-video.mjs', reviewVideoSpecs],
  ]) {
    for (const spec of specs) {
      assert.doesNotMatch(
        spec,
        /(?:^|\/)remotion(?:\/|$)|render-timeline\.mjs/,
        `${name} must not statically import remotion/* or render-timeline.mjs (found "${spec}")`
      );
    }
  }
  assert.ok(
    reviewVideoSpecs.includes('./timeline-scene.mjs'),
    'src/review-video.mjs should import pure projection math from ./timeline-scene.mjs'
  );

  // timeline-scene.mjs must stay 100% React/Remotion-free and decoupled from capture/review
  for (const spec of timelineSceneSpecs) {
    assert.doesNotMatch(
      spec,
      /^(?:react|react-dom|remotion|@remotion\/)|remotion\/|(?:browser|terminal|run|catalog|review)/,
      `src/timeline-scene.mjs must remain pure and renderer-neutral (found "${spec}")`
    );
  }

  // index.mjs imports pure scene/projection math from ./timeline-scene.mjs (not ./remotion/layout.mjs)
  assert.ok(indexSpecs.includes('./timeline-scene.mjs'));
  assert.ok(!indexSpecs.includes('./remotion/layout.mjs'));

  // 100% export identity preservation across timeline-scene.mjs, remotion/layout.mjs, render-timeline.mjs, and index.mjs
  const expectedSceneExports = [
    'resolveAssetUrl',
    'buildSquirclePath',
    'computeWindowChrome',
    'computeStageBackground',
    'screenToRender',
    'isPortraitOutput',
    'computeCameraTransform',
    'projectViewportToRender',
    'computeOverlaysAtTime',
    'computeFrameScene',
  ];
  for (const name of expectedSceneExports) {
    assert.equal(typeof timelineScene[name], 'function', `missing ${name} in timeline-scene.mjs`);
    assert.equal(remotionLayout[name], timelineScene[name], `layout.mjs must re-export ${name}`);
  }
  assert.equal(rootApi.computeFrameScene, timelineScene.computeFrameScene);
  assert.equal(rootApi.projectViewportToRender, timelineScene.projectViewportToRender);
  assert.equal(rootApi.screenToRender, timelineScene.screenToRender);
  assert.equal(renderTimelineMod.computeFrameScene, timelineScene.computeFrameScene);
  assert.equal(renderTimelineMod.projectViewportToRender, timelineScene.projectViewportToRender);
  assert.equal(renderTimelineMod.screenToRender, timelineScene.screenToRender);
});

test('S1 binary search findUpperBoundIndex, sampleCamera, and sampleCursor preserve exact cut semantics across coincident timestamps and large tracks', () => {
  // Edge cases on findUpperBoundIndex
  assert.equal(findUpperBoundIndex([], 1.0), -1);
  assert.equal(findUpperBoundIndex([{ t: 1.0 }], 0.5), -1);
  assert.equal(findUpperBoundIndex([{ t: 1.0 }], 1.0), 0);
  assert.equal(findUpperBoundIndex([{ t: 1.0 }], 5.0), 0);

  // Coincident timestamp runs at start, middle, and end (rightmost item.t <= t wins)
  const dupItems = [
    { t: 0, id: 'a0' },
    { t: 0, id: 'a1' },
    { t: 1, id: 'b0' },
    { t: 2, id: 'c0' },
    { t: 2, id: 'c1' },
    { t: 2, id: 'c2' },
    { t: 4, id: 'd0' },
    { t: 4, id: 'd1' },
  ];
  assert.equal(findUpperBoundIndex(dupItems, -0.001), -1);
  assert.equal(findUpperBoundIndex(dupItems, 0), 1);
  assert.equal(findUpperBoundIndex(dupItems, 0.5), 1);
  assert.equal(findUpperBoundIndex(dupItems, 1), 2);
  assert.equal(findUpperBoundIndex(dupItems, 1.9999), 2);
  assert.equal(findUpperBoundIndex(dupItems, 2), 5);
  assert.equal(findUpperBoundIndex(dupItems, 3), 5);
  assert.equal(findUpperBoundIndex(dupItems, 4), 7);
  assert.equal(findUpperBoundIndex(dupItems, 10), 7);

  // Reference linear-scan oracles matching pre-S1 implementation
  const linearSampleCamera = (camera, t) => {
    const { keyframes } = camera;
    if (t < keyframes[0].t) {
      return { x: keyframes[0].x || 0, y: keyframes[0].y || 0, zoom: keyframes[0].zoom };
    }
    const last = keyframes[keyframes.length - 1];
    if (t >= last.t) {
      return { x: last.x || 0, y: last.y || 0, zoom: last.zoom };
    }
    let idx = 0;
    while (idx + 1 < keyframes.length && keyframes[idx + 1].t <= t) idx += 1;
    const from = keyframes[idx];
    const to = keyframes[idx + 1];
    if (!to || from.t === t || to.t === from.t) {
      return { x: from.x || 0, y: from.y || 0, zoom: from.zoom };
    }
    const factor = applyEasing(to.easing, (t - from.t) / (to.t - from.t));
    return {
      x: from.x + (to.x - from.x) * factor || 0,
      y: from.y + (to.y - from.y) * factor || 0,
      zoom: from.zoom + (to.zoom - from.zoom) * factor || 0,
    };
  };

  const linearSampleCursor = (cursor, t) => {
    const { samples } = cursor;
    if (t < samples[0].t) {
      return { x: samples[0].x || 0, y: samples[0].y || 0, pressed: samples[0].pressed, visible: samples[0].visible };
    }
    const last = samples[samples.length - 1];
    if (t >= last.t) {
      return { x: last.x || 0, y: last.y || 0, pressed: last.pressed, visible: last.visible };
    }
    let idx = 0;
    while (idx + 1 < samples.length && samples[idx + 1].t <= t) idx += 1;
    const from = samples[idx];
    const to = samples[idx + 1];
    if (!to || from.t === t || to.t === from.t) {
      return { x: from.x || 0, y: from.y || 0, pressed: from.pressed, visible: from.visible };
    }
    const u = (t - from.t) / (to.t - from.t);
    return {
      x: from.x + (to.x - from.x) * u || 0,
      y: from.y + (to.y - from.y) * u || 0,
      pressed: from.pressed,
      visible: from.visible,
    };
  };

  // Large 4,000-element camera & cursor tracks with periodic 2x and 3x coincident cuts
  const easings = ['linear', 'ease-in-out', 'sine-in-out', 'hold', 'smoothstep'];
  const keyframes = [];
  const samples = [];
  let curT = 0;
  for (let i = 0; i < 4000; i += 1) {
    // Every 17th entry creates a coincident cut (same timestamp as previous!)
    if (i > 0 && i % 17 !== 0 && i % 53 !== 0) {
      curT = Math.round((curT + 0.025) * 1e6) / 1e6;
    }
    keyframes.push({
      t: curT,
      x: 400 + ((i * 73) % 800),
      y: 250 + ((i * 41) % 400),
      zoom: 1 + (i % 5) * 0.25,
      easing: easings[i % easings.length],
    });
    samples.push({
      t: curT,
      x: (i * 37) % 1280,
      y: (i * 29) % 720,
      pressed: i % 4 === 1,
      visible: i % 19 !== 0,
    });
  }

  const camera = { outputWidth: 1280, outputHeight: 720, keyframes };
  const cursor = { enabled: true, style: 'macos', samples };

  const queryTimes = [-1, 0, curT, curT + 5];
  for (let i = 0; i < keyframes.length; i += 11) {
    queryTimes.push(keyframes[i].t);
    queryTimes.push(Math.max(0, keyframes[i].t - 1e-4));
    queryTimes.push(keyframes[i].t + 0.0073);
  }

  for (const qt of queryTimes) {
    assert.deepEqual(sampleCamera(camera, qt), linearSampleCamera(camera, qt), `camera mismatch at t=${qt}`);
    assert.deepEqual(sampleCursor(cursor, qt), linearSampleCursor(cursor, qt), `cursor mismatch at t=${qt}`);
  }
});

test('S1 binary-searched ripples & captions and memoized scene geometry preserve exact frame parity', () => {
  const baseTimeline = compileTimeline({
    eventTrack: makeBaseEventTrack({
      video: { file: 'take.mp4', width: 640, height: 360, fps: 60, duration: 120, frames: 7200 },
    }),
    recipe: {
      stage: {
        width: 800,
        height: 500,
        padding: 80,
        background: {
          type: 'gradient',
          angle: 135,
          stops: [
            { color: '#0f172a', offset: 0 },
            { color: '#1e293b', offset: 1 },
          ],
        },
      },
      window: { frame: 'macos', title: 'Scene Cache Test', width: 640, height: 360, borderRadius: 20 },
      camera: { outputWidth: 800, outputHeight: 500 },
    },
  });

  // Populate 1,500 ripples (including non-uniform long/short overlapping durations) and 1,500 cues
  const ripples = [];
  const cues = [];
  for (let i = 0; i < 1500; i += 1) {
    const t = Number((i * 0.08).toFixed(4));
    // Every 50th ripple lasts 1.2s so an earlier ripple stays active past shorter subsequent ripples!
    const duration = i % 50 === 0 ? 1.2 : 0.35;
    ripples.push({
      t,
      x: 40 + (i % 240),
      y: 30 + (i % 120),
      button: i % 3 === 0 ? 'left' : i % 3 === 1 ? 'right' : 'middle',
      duration,
    });
    const cueStart = Number((i * 0.08).toFixed(4));
    const cueEnd = Number((cueStart + (i % 40 === 0 ? 0.5 : 0.06)).toFixed(4));
    cues.push({
      start: cueStart,
      end: cueEnd,
      text: i % 25 === 0 ? '   ' : `Cue #${i}`,
    });
  }
  baseTimeline.overlays.ripples = ripples;
  baseTimeline.overlays.captions = {
    enabled: true,
    tracks: [{ language: 'en', cues }],
  };

  // Verify exact active keys against a brute-force linear filter across boundaries and overlaps
  for (const t of [0, 0.08, 0.25, 0.95, 4.0, 4.06, 40.22, 119.92, 125.0]) {
    const overlays = timelineScene.computeOverlaysAtTime(baseTimeline, t, 800, 500);
    const expectedRippleKeys = ripples
      .map((r, idx) => (t >= r.t && t <= r.t + r.duration ? `ripple-${idx}-${r.t}` : null))
      .filter(Boolean);
    const expectedCaptionKeys = cues
      .map((c, idx) => (t >= c.start && t < c.end && c.text.trim().length > 0 ? `caption-${idx}-${c.start}` : null))
      .filter(Boolean);

    assert.deepEqual(
      overlays.ripples.map((r) => r.key),
      expectedRippleKeys,
      `ripple range mismatch at t=${t}`
    );
    assert.deepEqual(
      overlays.captions.map((c) => c.key),
      expectedCaptionKeys,
      `caption range mismatch at t=${t}`
    );
  }

  // Memoization checks: windowChrome, stage.background, and buildSquirclePath reuse cached values across frames
  const scene0 = timelineScene.computeFrameScene(baseTimeline, { frame: 0, fps: 60, width: 800, height: 500 });
  const scene1 = timelineScene.computeFrameScene(baseTimeline, { frame: 1, fps: 60, width: 800, height: 500 });
  assert.equal(scene0.windowChrome, scene1.windowChrome, 'windowChrome should be memoized across frames');
  assert.equal(scene0.stage.background, scene1.stage.background, 'stageBackground should be memoized across frames');

  // In-place mutation of window or image mapAsset still invalidates cleanly without stale cache bugs
  baseTimeline.window.title = 'Updated Title';
  const sceneAfterEdit = timelineScene.computeFrameScene(baseTimeline, { frame: 2, fps: 60, width: 800, height: 500 });
  assert.notEqual(sceneAfterEdit.windowChrome, scene0.windowChrome);
  assert.equal(sceneAfterEdit.windowChrome.title, 'Updated Title');

  baseTimeline.stage.background = { type: 'image', src: 'wallpaper.png', fit: 'cover' };
  const unmappedScene = timelineScene.computeFrameScene(baseTimeline, { frame: 0, fps: 60 });
  const mappedScene = timelineScene.computeFrameScene(baseTimeline, {
    frame: 1,
    fps: 60,
    mapAsset: (s) => `/public/${s}`,
  });
  assert.equal(unmappedScene.stage.background.imageSrc, 'wallpaper.png');
  assert.equal(mappedScene.stage.background.imageSrc, '/public/wallpaper.png');

  const sqA = timelineScene.buildSquirclePath(1440, 854, 20, 0.6);
  const sqB = timelineScene.buildSquirclePath(1440, 854, 20, 0.6);
  assert.equal(sqA, sqB);
});

test('S2 validateTimeline structured issues preserve deepEqual compatibility and power verifyCameraBounds without regex', () => {
  const valid = compileTimeline({ eventTrack: makeBaseEventTrack() });

  // Strict deepEqual backward-compatibility MUST hold
  assert.deepEqual(validateTimeline(valid), { ok: true, errors: [] });
  assert.deepEqual(validateTimeline(valid).issues, []);
  assert.deepEqual(validateTimelineDetailed(valid), { ok: true, errors: [], issues: [] });

  // Mixed invalid timeline: camera out-of-bounds + window out-of-bounds + bad take field
  const broken = structuredClone(valid);
  broken.take.video = '';
  broken.window.x = broken.stage.width;
  broken.camera.keyframes = [{ t: 0, x: 10, y: 10, zoom: 1, easing: 'linear' }];

  const v = validateTimeline(broken);
  const detailed = validateTimelineDetailed(broken);
  assert.equal(v.ok, false);
  assert.equal(v.issues.length, v.errors.length);
  assert.deepEqual(detailed.issues, v.issues);
  assert.deepEqual(
    v.issues.map((i) => i.message),
    v.errors
  );

  const codes = new Set(v.issues.map((i) => i.code));
  assert.ok(codes.has('CAMERA_OUT_OF_BOUNDS'));
  assert.ok(codes.has('WINDOW_OUT_OF_BOUNDS'));
  assert.ok(codes.has('SCHEMA_INVALID'));

  const camReport = verifyCameraBounds(broken);
  assert.equal(camReport.ok, false);
  assert.equal(camReport.timelineValid, false);
  assert.equal(camReport.cameraBoundsErrors.length, 1);
  assert.match(camReport.cameraBoundsErrors[0], /leaves stage/);
  assert.equal(camReport.schemaErrors.length, 2);
});

test('S2 verifyRenderedCursorPixels works with injected synthetic renderStills (zero Remotion launch) and batches altMarker retries in a single call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-seam-cursor-'));
  try {
    const timeline = compileTimeline({
      eventTrack: makeBaseEventTrack({
        viewport: { width: 160, height: 100, deviceScaleFactor: 1 },
        video: { file: 'synthetic-does-not-need-to-exist.mp4', width: 160, height: 100, fps: 10, duration: 1.0, frames: 10 },
        events: [
          { t: 0.0, type: 'pointermove', x: 30, y: 30 },
          { t: 0.3, type: 'pointermove', x: 70, y: 50 },
          { t: 0.6, type: 'pointermove', x: 110, y: 65 },
          { t: 0.9, type: 'pointermove', x: 140, y: 80 },
        ],
      }),
      recipe: {
        stage: { width: 160, height: 100, padding: 0 },
        window: { frame: 'none', width: 160, height: 100 },
        camera: { outputWidth: 160, outputHeight: 100 },
        overlays: { cursor: { enabled: true, style: 'macos' } },
      },
    });

    const hexToRgb = (hex) => {
      const clean = hex.replace(/^#/, '');
      return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16),
      };
    };

    // Synthetic still renderer: paints frames 1, 2, 3 (3 of 4 frames!) with a solid #ff00ff magenta
    // background so primary #ff00ff marker collides with clean background on ALL 3 frames!
    const calls = [];
    const syntheticRenderStills = async ({ variants, requests, outDir, width, height, fps }) => {
      calls.push({
        variantKeys: Object.keys(variants),
        requestKeys: requests.map((r) => r.key),
        frames: requests.map((r) => r.frame),
      });

      const stills = [];
      for (const req of requests) {
        const variantTimeline = variants[req.variant];
        const scene = timelineScene.computeFrameScene(variantTimeline, {
          frame: req.frame,
          fps,
          width,
          height,
        });
        // Frames 3, 6, 9 use magenta #ff00ff background to force primary marker collision!
        const bg = req.frame > 0 ? { r: 255, g: 0, b: 255 } : { r: 24, g: 32, b: 48 };
        const composites = [];
        const cur = scene.overlays.cursor;
        if (cur && !cur.hidden && cur.color && cur.color !== 'transparent') {
          const dotColor = hexToRgb(cur.color);
          const dot = await sharp({
            create: { width: 9, height: 9, channels: 3, background: dotColor },
          })
            .png()
            .toBuffer();
          composites.push({
            input: dot,
            left: Math.round(cur.x - 4),
            top: Math.round(cur.y - 4),
          });
        }
        const file = join(outDir, req.filename);
        let img = sharp({ create: { width, height, channels: 3, background: bg } });
        if (composites.length > 0) img = img.composite(composites);
        await img.png().toFile(file);

        stills.push({
          key: req.key,
          variant: req.variant,
          frame: req.frame,
          t: req.frame / fps,
          filename: req.filename,
          file,
          width,
          height,
        });
      }
      return { width, height, fps, outDir, stills };
    };

    const result = await verifyRenderedCursorPixels({
      timeline,
      sampleTimes: [0.0, 0.3, 0.6, 0.9],
      thresholdPx: 2,
      renderStills: syntheticRenderStills,
    });

    assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
    assert.equal(result.checked, true);
    assert.equal(result.mode, 'pixel-marker');
    assert.equal(result.samplesChecked, 4);
    assert.ok(result.maxErrorPx <= 1.5, `expected <= 1.5 px error, got ${result.maxErrorPx}`);

    // Crucial S2 assertion: 1 primary batch + 1 SINGLE batched altMarker call for all 3 collided frames (NOT 1 + 3 = 4 calls!)
    assert.equal(calls.length, 2, `expected 2 total renderStills calls, got ${calls.length}`);
    assert.equal(calls[0].requestKeys.length, 8); // 4 clean + 4 marker
    assert.deepEqual(calls[1].variantKeys, ['altMarker']);
    assert.deepEqual(calls[1].requestKeys, ['alt-1', 'alt-2', 'alt-3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('S3 unified Remotion session removes AbortSignal listeners symmetrically and preserves Display P3 gamut in renderTimelineStills & renderTimelinePreview', async t => {
  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-s3-session-'));
  const scratchDir = join(workDir, 'scratch');
  try {
    // Build a 2-frame P3 take video (left half Display P3 red [255,0,0], right half sRGB red in P3 [234,51,35])
    for (let i = 0; i < 2; i += 1) {
      const p3RedHalf = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } },
      })
        .png()
        .toBuffer();
      const srgbRedHalf = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 234, g: 51, b: 35 } },
      })
        .png()
        .toBuffer();
      await sharp({
        create: { width: 128, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .composite([
          { input: p3RedHalf, left: 0, top: 0 },
          { input: srgbRedHalf, left: 64, top: 0 },
        ])
        .png()
        .toFile(join(workDir, `p3-frame-${i}.png`));
    }
    const p3TakeVideo = join(workDir, 'p3-take.mp4');
    await renderVideo({
      input: join(workDir, 'p3-frame-%d.png'),
      output: p3TakeVideo,
      fps: 10,
      colorSpace: 'p3',
    });

    // Stage gradient puts CSS `color(display-p3 1 0 0)` on left half and `#ff0000` (sRGB red) on right half
    const p3StageTimeline = compileTimeline({
      take: { video: 'p3-take.mp4', eventTrack: 'event-track.json', colorSpace: 'p3' },
      eventTrack: makeBaseEventTrack({
        viewport: { width: 128, height: 64, deviceScaleFactor: 1 },
        video: { file: 'p3-take.mp4', width: 128, height: 64, fps: 10, duration: 0.2, frames: 2 },
        events: [{ t: 0, type: 'step', index: 0, label: 'P3 Check' }],
      }),
      recipe: {
        stage: {
          width: 128,
          height: 128,
          padding: 0,
          background: {
            type: 'gradient',
            angle: 90,
            stops: [
              { color: 'color(display-p3 1 0 0)', offset: 0 },
              { color: 'color(display-p3 1 0 0)', offset: 0.5 },
              { color: '#ff0000', offset: 0.5 },
              { color: '#ff0000', offset: 1 },
            ],
          },
        },
        // Place take video in bottom half [0..128, 64..128] so top half [0..128, 0..64] exposes stage CSS colors too!
        window: { frame: 'none', x: 0, y: 64, width: 128, height: 64 },
        camera: { outputWidth: 128, outputHeight: 128 },
        overlays: { cursor: { enabled: false } },
      },
    });
    const timelinePath = join(workDir, 'p3-timeline.json');
    await writeFile(timelinePath, JSON.stringify(p3StageTimeline, null, 2));

    // 1. Pre-aborted signal cleans up listeners and scratchDir immediately
    const abortedController = new AbortController();
    abortedController.abort();
    await assert.rejects(
      renderTimelineMod.renderTimelineStills({
        timeline: timelinePath,
        requests: [{ frame: 0, filename: 'aborted.png' }],
        outDir: join(workDir, 'aborted-out'),
        signal: abortedController.signal,
        scratchDir,
      }),
      /aborted/i
    );
    assert.equal(getEventListeners(abortedController.signal, 'abort').length, 0);
    assert.deepEqual(await readdir(scratchDir), []);

    // 2. Non-aborted reusable AbortController has 0 leaked listeners after renderTimelineStills + renderTimelinePreview
    const liveController = new AbortController();

    const stillsOutDir = join(workDir, 'stills-p3');
    const stillsResult = await renderTimelineMod.renderTimelineStills({
      timeline: timelinePath,
      requests: [{ key: 'f0', frame: 0, filename: 'p3-still.png' }],
      outDir: stillsOutDir,
      signal: liveController.signal,
      scratchDir,
    });
    assert.equal(getEventListeners(liveController.signal, 'abort').length, 0);
    assert.deepEqual(await readdir(scratchDir), []);

    // Also test explicit `colorSpace: 'p3'` override on an sRGB-marked timeline in renderTimelinePreview
    const srgbMarkedTimeline = structuredClone(p3StageTimeline);
    delete srgbMarkedTimeline.take.colorSpace;
    const previewOutDir = join(workDir, 'preview-p3');
    const previewResult = await renderTimelineMod.renderTimelinePreview({
      timeline: srgbMarkedTimeline,
      cwd: workDir,
      outDir: previewOutDir,
      width: 128,
      colorSpace: 'p3',
      signal: liveController.signal,
      scratchDir,
    });
    assert.equal(getEventListeners(liveController.signal, 'abort').length, 0);
    assert.deepEqual(await readdir(scratchDir), []);

    // Both stills (via take.colorSpace='p3' and via explicit colorSpace='p3') must embed a Display P3 ICC profile
    // AND preserve raw Display P3 vs sRGB red channel separation in both CSS and <video> playback!
    // (Read raw encoded PNG bytes via ffmpeg rawvideo so sharp's automatic ICC->sRGB transform does not clamp P3.)
    for (const [label, file] of [
      ['renderTimelineStills (take.colorSpace=p3)', stillsResult.stills[0].file],
      ['renderTimelinePreview (colorSpace=p3)', previewResult.stills[0].file],
    ]) {
      const meta = await sharp(file).metadata();
      assert.ok(meta.icc && meta.icc.length >= 300, `${label}: expected embedded Display P3 ICC profile`);

      const rawRgb = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        file,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        '-',
      ]);
      const px = (x, y) => {
        const idx = (y * meta.width + x) * 3;
        return [rawRgb[idx], rawRgb[idx + 1], rawRgb[idx + 2]];
      };
      // Top half: CSS `color(display-p3 1 0 0)` at (24, 24) vs `#ff0000` at (104, 24).
      // Headless Linux chrome-headless-shell may clamp CSS color(display-p3) to sRGB even with
      // --force-color-profile=display-p3-d65; enforce strict CSS separation on macOS where full Chrome renders P3.
      const cssP3Red = px(24, 24);
      const cssSrgbRed = px(104, 24);
      const cssDist = Math.hypot(
        cssP3Red[0] - cssSrgbRed[0],
        cssP3Red[1] - cssSrgbRed[1],
        cssP3Red[2] - cssSrgbRed[2]
      );
      if (process.platform === 'darwin') {
        assert.ok(
          cssDist >= 50,
          `${label} CSS: expected distinct Display P3 red (${cssP3Red}) vs sRGB #ff0000 (${cssSrgbRed}), dist=${cssDist}`
        );
      }

      // Bottom half: <video> playback of p3-take.mp4 at (24, 96) vs (104, 96). It needs a Chromium that decodes the
      // take: on CI runners the still often shows a black frame, so it belongs to the opt-in real-browser acceptance
      // (SCREEN_KIT_BROWSER_TESTS=1, docs/agents/checks.md) and stays out of the gate
      await t.test(`${label}: <video> keeps Display P3 red apart from sRGB red`, {
        skip: !process.env.SCREEN_KIT_BROWSER_TESTS && 'real-browser acceptance: set SCREEN_KIT_BROWSER_TESTS=1',
      }, () => {
        const vidP3Red = px(24, 96);
        const vidSrgbRed = px(104, 96);
        const vidDist = Math.hypot(
          vidP3Red[0] - vidSrgbRed[0],
          vidP3Red[1] - vidSrgbRed[1],
          vidP3Red[2] - vidSrgbRed[2]
        );
        assert.ok(
          vidDist >= 20,
          `${label} <video>: expected distinct Display P3 red (${vidP3Red}) vs sRGB red (${vidSrgbRed}), dist=${vidDist}`
        );
      });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
