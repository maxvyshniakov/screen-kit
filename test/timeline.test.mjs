import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TIMELINE_VERSION,
  applyEasing,
  sampleCamera,
  cameraViewportRect,
  sampleCursor,
  projectViewportToStage,
  projectViewportToScreen,
  validateEventTrack,
  validateTimeline,
  assertValidTimeline,
  compileTimeline,
} from '../src/timeline.mjs';
import * as rootApi from '../src/index.mjs';

function makeFixtureEventTrack(overrides = {}) {
  return {
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
    ...overrides,
  };
}

test('root entry point re-exports timeline compiler and helpers', () => {
  assert.equal(rootApi.compileTimeline, compileTimeline);
  assert.equal(rootApi.validateTimeline, validateTimeline);
  assert.equal(rootApi.sampleCamera, sampleCamera);
  assert.equal(rootApi.projectViewportToScreen, projectViewportToScreen);
});

test('compileTimeline transforms Event Track v1 into a validated, deterministic timeline.json', () => {
  const eventTrack = makeFixtureEventTrack();
  const recipe = {
    stage: {
      width: 1920,
      height: 1080,
      padding: 135,
      background: {
        type: 'gradient',
        angle: 135,
        stops: [
          { color: '#0f172a', offset: 0 },
          { color: '#1e293b', offset: 1 },
        ],
      },
    },
    window: {
      frame: 'macos',
      title: 'Straylight Scenario Editor',
      borderRadius: 14,
      shadow: true,
    },
    camera: {
      outputWidth: 1920,
      outputHeight: 1080,
      keyframes: [
        { t: 0, x: 960, y: 540, zoom: 1, easing: 'linear' },
        { t: 1.0, viewportX: 400, viewportY: 300, zoom: 1.5, easing: 'easeInOut' },
        { t: 3.5, x: 960, y: 540, zoom: 1, easing: 'ease-out' },
      ],
    },
    overlays: {
      cursor: { enabled: true, style: 'macos' },
    },
    outputs: ['web-loop', 'youtube-master'],
  };

  const timelineA = compileTimeline({
    take: { video: 'takes/demo.mp4', eventTrack: 'takes/event-track.json' },
    eventTrack,
    recipe,
  });
  const timelineB = compileTimeline({
    take: { video: 'takes/demo.mp4', eventTrack: 'takes/event-track.json' },
    eventTrack,
    recipe,
  });

  // Deterministic byte-for-byte JSON output and lossless round-trip stability
  const jsonA = JSON.stringify(timelineA, null, 2);
  const jsonB = JSON.stringify(timelineB, null, 2);
  assert.equal(jsonA, jsonB);
  const roundTripped = JSON.parse(jsonA);
  assert.deepEqual(roundTripped, timelineA);
  assert.deepEqual(validateTimeline(roundTripped), { ok: true, errors: [] });

  assert.equal(timelineA.version, TIMELINE_VERSION);
  assert.deepEqual(timelineA.take, {
    video: 'takes/demo.mp4',
    eventTrack: 'takes/event-track.json',
    width: 2880,
    height: 1620,
    fps: 60,
    duration: 5.2,
    frames: 312,
    captureMode: 'quality',
    viewport: { width: 1440, height: 810, deviceScaleFactor: 2 },
  });

  // Window centered inside 1920x1080 stage: x = (1920-1440)/2 = 240, y = (1080-810)/2 = 135
  assert.deepEqual(timelineA.window, {
    frame: 'macos',
    title: 'Straylight Scenario Editor',
    x: 240,
    y: 135,
    width: 1440,
    height: 810,
    borderRadius: 14,
    shadow: true,
  });

  // Viewport target (400, 300) converted to stage (640, 435) and camelCase easing normalized
  assert.deepEqual(timelineA.camera.keyframes[1], {
    t: 1,
    x: 640,
    y: 435,
    zoom: 1.5,
    easing: 'ease-in-out',
  });

  // Overlays compiled from event track
  assert.equal(timelineA.overlays.cursor.enabled, true);
  assert.equal(timelineA.overlays.cursor.style, 'macos');
  assert.equal(timelineA.overlays.cursor.samples.length, 7);
  assert.deepEqual(timelineA.overlays.cursor.samples[0], {
    t: 0,
    x: 720,
    y: 405,
    pressed: false,
    visible: true,
  });
  assert.deepEqual(timelineA.overlays.cursor.samples[1], {
    t: 0.5,
    x: 400,
    y: 300,
    pressed: true,
    visible: true,
  });
  assert.deepEqual(timelineA.overlays.cursor.samples[5], {
    t: 2,
    x: 200,
    y: 300,
    pressed: true,
    visible: true,
  });
  assert.deepEqual(timelineA.overlays.cursor.samples[6], {
    t: 2.6,
    x: 600,
    y: 420,
    pressed: false,
    visible: true,
  });

  // Click ripple + drag start ripple
  assert.equal(timelineA.overlays.ripples.length, 2);
  assert.deepEqual(timelineA.overlays.ripples[0], {
    t: 0.5,
    x: 400,
    y: 300,
    button: 'left',
    duration: 0.45,
  });
  assert.deepEqual(timelineA.overlays.ripples[1], {
    t: 2,
    x: 200,
    y: 300,
    button: 'left',
    duration: 0.45,
  });

  // Wheel, scroll gesture, and drag gesture
  assert.equal(timelineA.overlays.gestures.length, 3);
  assert.deepEqual(timelineA.overlays.gestures[0], {
    t: 1.2,
    kind: 'wheel',
    x: 720,
    y: 405,
    deltaX: -180,
    deltaY: 0,
    duration: 0.25,
  });
  assert.deepEqual(timelineA.overlays.gestures[1], {
    t: 1.4,
    kind: 'scroll',
    x: 720,
    y: 405,
    deltaX: 300,
    deltaY: 0,
    duration: 0.35,
  });
  assert.deepEqual(timelineA.overlays.gestures[2], {
    t: 2,
    kind: 'drag',
    x: 200,
    y: 300,
    deltaX: 400,
    deltaY: 120,
    duration: 0.6,
  });

  // Keystroke pill formatting
  assert.deepEqual(timelineA.overlays.keystrokes, [
    { t: 3, label: '⌘K', keys: ['Meta', 'k'], duration: 1.2 },
  ]);

  // Increment 2 slots + steps + outputs
  assert.deepEqual(timelineA.overlays.captions, { enabled: false, tracks: [] });
  assert.deepEqual(timelineA.audio, { tracks: [] });
  assert.deepEqual(timelineA.steps, [{ t: 3.5, index: 0, label: 'drag card' }]);
  assert.deepEqual(
    timelineA.outputs.map((o) => o.id),
    ['web-loop', 'youtube-master']
  );
});

test('compileTimeline defaults produce a padded stage >= output and valid timeline without recipe options', () => {
  const timeline = compileTimeline({ eventTrack: makeFixtureEventTrack() });
  assert.equal(timeline.stage.width, 1440 + 240);
  assert.equal(timeline.stage.height, 810 + 240);
  assert.equal(timeline.camera.outputWidth, 1440);
  assert.equal(timeline.camera.outputHeight, 810);
  assert.equal(timeline.window.x, 120);
  assert.equal(timeline.window.y, 120);
  assert.equal(timeline.take.video, 'take.mp4');
  assert.equal(timeline.take.eventTrack, 'event-track.json');
  assert.deepEqual(validateTimeline(timeline), { ok: true, errors: [] });

  // At default zoom=1 centered on window, viewport (0, 0) maps to screen (0, 0)
  assert.deepEqual(projectViewportToScreen(0, 0, timeline, 0), { x: 0, y: 0 });
  assert.deepEqual(projectViewportToScreen(720, 405, timeline, 0), { x: 720, y: 405 });
  assert.deepEqual(projectViewportToScreen(1440, 810, timeline, 0), { x: 1440, y: 810 });
});

test('projectViewportToScreen and sampleCamera match exact geometry under zoom, pan, easing, and cuts', () => {
  const timeline = compileTimeline({
    eventTrack: makeFixtureEventTrack(),
    recipe: {
      stage: { width: 1920, height: 1080, padding: 135 },
      window: { frame: 'browser', width: 1440, height: 810 },
      camera: {
        outputWidth: 1920,
        outputHeight: 1080,
        keyframes: [
          { t: 0, x: 960, y: 540, zoom: 1, easing: 'linear' },
          { t: 2, x: 640, y: 435, zoom: 2, easing: 'linear' },
          { t: 3, x: 640, y: 435, zoom: 2, easing: 'hold' },
          { t: 3, x: 1200, y: 600, zoom: 2, easing: 'linear' },
          { t: 4, x: 960, y: 540, zoom: 1, easing: 'ease-in-out' },
        ],
      },
    },
  });

  // t = 0: zoom 1 at stage center (960, 540); window top-left is (240, 135)
  assert.deepEqual(projectViewportToStage(400, 300, timeline), { x: 640, y: 435 });
  assert.deepEqual(projectViewportToScreen(400, 300, timeline, 0), { x: 640, y: 435 });

  // t = 2: zoom 2 centered on stage (640, 435) -> viewport (400, 300) sits at exact screen center (960, 540)
  assert.deepEqual(projectViewportToScreen(400, 300, timeline, 2), { x: 960, y: 540 });
  // +100px right, +50px down in viewport -> +200px right, +100px down on screen at 2x zoom
  assert.deepEqual(projectViewportToScreen(500, 350, timeline, 2), { x: 1160, y: 640 });

  // t = 1: halfway linearly between (960, 540, 1) and (640, 435, 2) -> (800, 487.5, 1.5)
  const mid = sampleCamera(timeline.camera, 1);
  assert.deepEqual(mid, { x: 800, y: 487.5, zoom: 1.5 });
  const projectedMid = projectViewportToScreen(400, 300, timeline, 1);
  assert.equal(projectedMid.x, (640 - 800) * 1.5 + 960);
  assert.equal(projectedMid.y, (435 - 487.5) * 1.5 + 540);

  // Instant cut at t = 3 is right-continuous
  assert.deepEqual(sampleCamera(timeline.camera, 2.999), { x: 640, y: 435, zoom: 2 });
  assert.deepEqual(sampleCamera(timeline.camera, 3), { x: 1200, y: 600, zoom: 2 });

  // Midpoint of ease-in-out at t = 3.5 has factor 0.5
  assert.equal(applyEasing('ease-in-out', 0.5), 0.5);
  assert.deepEqual(sampleCamera(timeline.camera, 3.5), { x: 1080, y: 570, zoom: 1.5 });

  // Clamping before first and after last keyframe
  assert.deepEqual(sampleCamera(timeline.camera, -1), { x: 960, y: 540, zoom: 1 });
  assert.deepEqual(sampleCamera(timeline.camera, 99), { x: 960, y: 540, zoom: 1 });

  // Cursor interpolation helper (2.3 is midpoint of drag 2.0..2.6 from [200,300] to [600,420])
  const cursorMid = sampleCursor(timeline.overlays.cursor, 2.3);
  assert.ok(Math.abs(cursorMid.x - 400) < 1e-9);
  assert.ok(Math.abs(cursorMid.y - 360) < 1e-9);
  assert.equal(cursorMid.pressed, true);
  assert.equal(cursorMid.visible, true);
});

test('projectViewportToScreen handles scaled windows on stage under zoom and pan', () => {
  const timeline = compileTimeline({
    eventTrack: makeFixtureEventTrack(),
    recipe: {
      stage: { width: 1920, height: 1080, padding: 135 },
      window: { frame: 'device', x: 600, y: 337.5, width: 720, height: 405 },
      camera: {
        outputWidth: 1920,
        outputHeight: 1080,
        keyframes: [
          { t: 0, x: 960, y: 540, zoom: 1, easing: 'linear' },
          { t: 1, viewportX: 720, viewportY: 405, zoom: 2, easing: 'linear' },
        ],
      },
    },
  });

  // Viewport (0, 0) maps to window top-left (600, 337.5); viewport (1440, 810) to (1320, 742.5)
  assert.deepEqual(projectViewportToStage(0, 0, timeline), { x: 600, y: 337.5 });
  assert.deepEqual(projectViewportToStage(1440, 810, timeline), { x: 1320, y: 742.5 });

  // At t=1, camera is centered on viewport center (stage 960, 540) at zoom=2
  assert.deepEqual(projectViewportToScreen(720, 405, timeline, 1), { x: 960, y: 540 });
  // Viewport (0, 0) is -360 stage px in X, -202.5 stage px in Y -> at 2x zoom: -720, -405 from (960, 540)
  assert.deepEqual(projectViewportToScreen(0, 0, timeline, 1), { x: 240, y: 135 });
});

test('overlay switches, key up suppression, and invalid backgrounds behave as specified', () => {
  const eventTrack = makeFixtureEventTrack({
    events: [
      { t: 0.0, type: 'pointermove', x: 100, y: 100 },
      { t: 0.5, type: 'pointerdown', x: 100, y: 100, button: 'right' },
      { t: 1.0, type: 'key', key: 'p', modifiers: ['Meta', 'Shift'], action: 'down' },
      { t: 1.1, type: 'key', key: 'p', modifiers: ['Meta', 'Shift'], action: 'up' },
    ],
  });

  const timeline = compileTimeline({
    eventTrack,
    recipe: {
      overlays: {
        cursor: { enabled: false, style: 'ring' },
        ripples: { enabled: false },
        gestures: { enabled: false },
        keystrokes: { enabled: true, duration: 1.5 },
      },
    },
  });

  assert.equal(timeline.overlays.cursor.enabled, false);
  assert.equal(timeline.overlays.cursor.style, 'ring');
  // Samples stay recorded so toggling cursor.enabled in timeline.json works post-capture
  assert.equal(timeline.overlays.cursor.samples.length, 2);
  assert.equal(sampleCursor(timeline.overlays.cursor, 0.25), null);
  assert.deepEqual(timeline.overlays.ripples, []);
  assert.deepEqual(timeline.overlays.gestures, []);
  assert.deepEqual(timeline.overlays.keystrokes, [
    { t: 1, label: '⌘⇧P', keys: ['Meta', 'Shift', 'p'], duration: 1.5 },
  ]);

  // Invalid stage backgrounds are rejected
  assert.throws(
    () =>
      compileTimeline({
        eventTrack,
        recipe: { stage: { background: { type: 'gradient', stops: [{ color: '#000', offset: 0 }] } } },
      }),
    /at least 2 color stops/
  );
  assert.throws(
    () =>
      compileTimeline({
        eventTrack,
        recipe: { stage: { background: { type: 'image', src: '' } } },
      }),
    /background\.src/
  );
});

test('validateTimeline rejects camera keyframes that leave stage bounds', () => {
  const base = compileTimeline({
    eventTrack: makeFixtureEventTrack(),
    recipe: {
      stage: { width: 1920, height: 1080, padding: 135 },
      camera: { outputWidth: 1920, outputHeight: 1080 },
    },
  });

  // Case 1: Zoomed in 2x (visible 960x540 -> halfWidth 480) but panned too far left (x=400 -> left=-80)
  const pannedOut = structuredClone(base);
  pannedOut.camera.keyframes = [{ t: 0, x: 400, y: 540, zoom: 2, easing: 'linear' }];
  const res1 = validateTimeline(pannedOut);
  assert.equal(res1.ok, false);
  assert.ok(res1.errors.some((e) => /leaves stage/.test(e)));
  assert.throws(() => assertValidTimeline(pannedOut), /leaves stage/);

  // Case 2: Zoom < 1 on stage === output (visible 2400x1350 exceeds 1920x1080)
  const zoomedTooFarOut = structuredClone(base);
  zoomedTooFarOut.camera.keyframes = [{ t: 0, x: 960, y: 540, zoom: 0.8, easing: 'linear' }];
  const res2 = validateTimeline(zoomedTooFarOut);
  assert.equal(res2.ok, false);
  assert.ok(res2.errors.some((e) => /leaves stage/.test(e)));

  // Case 3: compileTimeline rejects out-of-bounds recipe keyframes immediately
  assert.throws(
    () =>
      compileTimeline({
        eventTrack: makeFixtureEventTrack(),
        recipe: {
          stage: { width: 1920, height: 1080, padding: 135 },
          camera: {
            outputWidth: 1920,
            outputHeight: 1080,
            keyframes: [
              { t: 0, x: 960, y: 540, zoom: 1 },
              { t: 1, x: 1600, y: 540, zoom: 2 }, // right = 1600 + 480 = 2080 > 1920
            ],
          },
        },
      }),
    /leaves stage/
  );

  // Case 4: Stage larger than output allows zooming slightly below 1 while staying strictly inside stage
  const wideStage = compileTimeline({
    eventTrack: makeFixtureEventTrack(),
    recipe: {
      stage: { width: 2000, height: 1125, padding: 100 },
      camera: {
        outputWidth: 1600,
        outputHeight: 900,
        keyframes: [
          { t: 0, x: 1000, y: 562.5, zoom: 0.8, easing: 'linear' }, // visible 2000x1125 -> exact stage fit
          { t: 1, x: 1000, y: 562.5, zoom: 1.0, easing: 'ease-in-out' },
        ],
      },
    },
  });
  const rect = cameraViewportRect(wideStage.camera, 0);
  assert.deepEqual(rect, { left: 0, top: 0, right: 2000, bottom: 1125, width: 2000, height: 1125 });
  assert.deepEqual(validateTimeline(wideStage), { ok: true, errors: [] });
});

test('validateTimeline rejects missing take references, invalid frames, bad timestamps, and malformed overlays', () => {
  assert.equal(validateTimeline(null).ok, false);
  assert.equal(validateTimeline({ version: 2 }).ok, false);

  const valid = compileTimeline({ eventTrack: makeFixtureEventTrack() });

  // Missing take video / eventTrack references
  const missingTake = structuredClone(valid);
  missingTake.take.video = '';
  missingTake.take.eventTrack = null;
  const takeRes = validateTimeline(missingTake);
  assert.equal(takeRes.ok, false);
  assert.ok(takeRes.errors.some((e) => /take\.video/.test(e)));
  assert.ok(takeRes.errors.some((e) => /take\.eventTrack/.test(e)));

  // Invalid window frame and window exceeding stage
  const badWindow = structuredClone(valid);
  badWindow.window.frame = 'windows95';
  badWindow.window.x = 500;
  const winRes = validateTimeline(badWindow);
  assert.equal(winRes.ok, false);
  assert.ok(winRes.errors.some((e) => /window\.frame/.test(e)));
  assert.ok(winRes.errors.some((e) => /exceeds stage/.test(e)));

  // Stage smaller than output frame
  const tinyStage = structuredClone(valid);
  tinyStage.stage.width = 1000;
  const stageRes = validateTimeline(tinyStage);
  assert.equal(stageRes.ok, false);
  assert.ok(stageRes.errors.some((e) => /larger than or equal to camera output/.test(e)));

  // Non-monotonic camera keyframes and overlay timestamps
  const badTimestamps = structuredClone(valid);
  badTimestamps.camera.keyframes = [
    { t: 1, x: 840, y: 525, zoom: 1, easing: 'linear' },
    { t: 0.5, x: 840, y: 525, zoom: 1, easing: 'linear' },
  ];
  badTimestamps.overlays.cursor.samples[1].t = 0.2;
  badTimestamps.overlays.cursor.samples[2].t = 0.1;
  badTimestamps.overlays.ripples[1].t = 0.1;
  badTimestamps.overlays.gestures[1].kind = 'teleport';
  badTimestamps.overlays.keystrokes[0].keys = [];
  const tsRes = validateTimeline(badTimestamps);
  assert.equal(tsRes.ok, false);
  assert.ok(tsRes.errors.some((e) => /camera\.keyframes\[1\]\.t/.test(e)));
  assert.ok(tsRes.errors.some((e) => /cursor\.samples\[2\]\.t/.test(e)));
  assert.ok(tsRes.errors.some((e) => /ripples\[1\]\.t/.test(e)));
  assert.ok(tsRes.errors.some((e) => /gestures\[1\]\.kind/.test(e)));
  assert.ok(tsRes.errors.some((e) => /keystrokes\[0\]\.keys/.test(e)));
});

test('validateEventTrack and compileTimeline reject malformed event tracks', () => {
  assert.equal(validateEventTrack(null).ok, false);
  assert.equal(validateEventTrack({ version: 99, events: [] }).ok, false);

  const outOfOrder = makeFixtureEventTrack({
    events: [
      { t: 1.0, type: 'pointermove', x: 10, y: 10 },
      { t: 0.5, type: 'pointermove', x: 20, y: 20 },
    ],
  });
  assert.equal(validateEventTrack(outOfOrder).ok, false);
  assert.throws(() => compileTimeline({ eventTrack: outOfOrder }), /monotonically non-decreasing/);

  const badDrag = makeFixtureEventTrack({
    events: [{ t: 0.2, type: 'drag', from: [10], to: [20, 30], duration: -1 }],
  });
  const dragCheck = validateEventTrack(badDrag);
  assert.equal(dragCheck.ok, false);
  assert.ok(dragCheck.errors.some((e) => /\.from/.test(e)));
  assert.ok(dragCheck.errors.some((e) => /\.duration/.test(e)));

  const missingVideoRef = makeFixtureEventTrack({
    video: { width: 2880, height: 1620, fps: 60, duration: 5.2, frames: 312 },
  });
  assert.throws(() => compileTimeline({ eventTrack: missingVideoRef }), /take\.video/);
});

test('post-capture edits to timeline.json remain valid and update projections without recompiling', () => {
  const timeline = compileTimeline({
    eventTrack: makeFixtureEventTrack(),
    recipe: {
      stage: { width: 1920, height: 1080, padding: 135 },
      camera: { outputWidth: 1920, outputHeight: 1080 },
    },
  });

  // Post-capture edit: change window chrome, cursor style, background, and zoom in
  const edited = structuredClone(timeline);
  edited.window.frame = 'macos';
  edited.window.title = 'Edited Title';
  edited.overlays.cursor.style = 'dot';
  edited.stage.background = { type: 'image', src: 'wallpapers/studio.png', fit: 'cover' };
  edited.camera.keyframes.push({ t: 0.5, x: 640, y: 435, zoom: 2, easing: 'smoothstep' });

  assert.deepEqual(validateTimeline(edited), { ok: true, errors: [] });
  // Click at (400, 300) at t=0.5 now projects to exact screen center (960, 540)
  const click = edited.overlays.ripples[0];
  assert.deepEqual(projectViewportToScreen(click.x, click.y, edited, click.t), { x: 960, y: 540 });
});

test('unified Event Track v1 schema supports stationary/mayBegin wheel phases, 0-duration gestures, optional step labels, and drag pressed state tracking', () => {
  const track = makeFixtureEventTrack({
    video: {
      file: 'take.mp4',
      width: 2880,
      height: 1620,
      fps: 60,
      encodedFps: 60,
      duration: 4.0,
      frames: 240,
      capture: {
        rawFrames: 240,
        firstFrameAt: 0,
        lastFrameAt: 3.9833,
        elapsedDuration: 4.0,
        rawFps: 60,
        maxGapMs: 18.2,
        gapsOver2Frames: 0,
        truncated: false,
      },
    },
    events: [
      { t: 0.0, type: 'pointermove', x: 100, y: 100 },
      { t: 0.2, type: 'wheel', x: 100, y: 100, deltaX: 0, deltaY: 0, phase: 'mayBegin', duration: 0 },
      { t: 0.3, type: 'wheel', x: 100, y: 100, deltaX: 0, deltaY: -40, phase: 'stationary' },
      { t: 0.5, type: 'gesture', kind: 'scroll', x: 100, y: 100, deltaX: 120, deltaY: 0, duration: 0 },
      // Drag WITHOUT explicit pointerdown/pointerup, WITH interior pointermove events
      { t: 1.0, type: 'drag', from: [100, 100], to: [300, 200], duration: 0.6 },
      { t: 1.2, type: 'pointermove', x: 180, y: 140 },
      { t: 1.4, type: 'pointermove', x: 250, y: 175 },
      // After drag ends at 1.6, pointermove at 2.0 must have pressed: false
      { t: 2.0, type: 'pointermove', x: 320, y: 210 },
      { t: 2.5, type: 'step', index: 0 },
      { t: 2.8, type: 'step', index: 1, label: '' },
    ],
  });

  assert.deepEqual(validateEventTrack(track), { ok: true, errors: [] });
  const compiled = compileTimeline({ eventTrack: track });
  assert.deepEqual(validateTimeline(compiled), { ok: true, errors: [] });

  // Interior pointermove samples during drag (1.2, 1.4) keep pressed: true; release at 1.6 and move at 2.0 have pressed: false
  const samples = compiled.overlays.cursor.samples;
  assert.equal(samples.find((s) => s.t === 1.0)?.pressed, true);
  assert.equal(samples.find((s) => s.t === 1.2)?.pressed, true);
  assert.equal(samples.find((s) => s.t === 1.4)?.pressed, true);
  assert.equal(samples.find((s) => s.t === 1.6)?.pressed, false);
  assert.deepEqual(
    { x: samples.find((s) => s.t === 1.6)?.x, y: samples.find((s) => s.t === 1.6)?.y },
    { x: 300, y: 200 }
  );
  assert.equal(samples.find((s) => s.t === 2.0)?.pressed, false);

  // Missing and empty step labels normalize to non-empty fallback step-<index>
  assert.deepEqual(compiled.steps, [
    { t: 2.5, index: 0, label: 'step-0' },
    { t: 2.8, index: 1, label: 'step-1' },
  ]);
});
