import assert from 'node:assert/strict';
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import * as rootApi from '../src/index.mjs';
import {
  RENDER_PROFILES,
  computeFrameScene,
  moveFileAtomic,
  projectViewportToRender,
  renderTimeline,
  renderTimelinePreview,
  resolvePreviewTargets,
  resolveRenderTargets,
  screenToRender,
} from '../src/render-timeline.mjs';
import { reviewVideo } from '../src/review-video.mjs';
import { runPipeline } from '../src/run.mjs';
import { calculateTimelineMetadata } from '../src/remotion/Root.mjs';
import { buildSquirclePath } from '../src/remotion/layout.mjs';
import {
  compileTimeline,
  projectViewportToScreen,
  projectViewportToStage,
  validateTimeline,
} from '../src/timeline.mjs';
import { probeVideo, renderVideo } from '../src/video.mjs';

const execFile = promisify(execFileCb);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.mjs');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function makeSyntheticEventTrack(overrides = {}) {
  return {
    version: 1,
    captureMode: 'headless',
    viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
    video: { file: 'take.mp4', width: 320, height: 180, fps: 10, duration: 1, frames: 10 },
    events: [
      { t: 0.0, type: 'pointermove', x: 80, y: 90 },
      { t: 0.2, type: 'pointerdown', x: 80, y: 90, button: 'left' },
      { t: 0.3, type: 'pointerup', x: 80, y: 90, button: 'left' },
      { t: 0.4, type: 'wheel', x: 160, y: 90, deltaX: 0, deltaY: -120, duration: 0.3 },
      { t: 0.5, type: 'key', key: 'k', modifiers: ['Meta'], action: 'press', duration: 0.4 },
      { t: 0.8, type: 'pointermove', x: 240, y: 90 },
    ],
    ...overrides,
  };
}

function decodePixelRgb(videoFile, timestampSec, x, y) {
  const raw = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(timestampSec),
    '-i',
    videoFile,
    '-frames:v',
    '1',
    '-vf',
    `format=rgb24,crop=1:1:${x}:${y}`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(raw.length, 3, `expected 3 RGB bytes from ${videoFile}`);
  return [raw[0], raw[1], raw[2]];
}

test('package exports and strict renderer module boundary stay decoupled from capture/recipes', async () => {
  assert.equal(rootApi.renderTimeline, renderTimeline);
  assert.equal(rootApi.resolveRenderTargets, resolveRenderTargets);
  assert.equal(rootApi.computeFrameScene, computeFrameScene);
  assert.equal(rootApi.projectViewportToRender, projectViewportToRender);
  assert.deepEqual(rootApi.RENDER_PROFILES, ['web-loop', 'youtube-master', 'shorts']);

  const subpathMod = await import('@maxvyshniakov/screen-kit/render-timeline');
  assert.equal(subpathMod.renderTimeline, renderTimeline);

  const rendererFiles = [
    join(REPO_ROOT, 'src', 'render-timeline.mjs'),
    join(REPO_ROOT, 'src', 'remotion', 'layout.mjs'),
    join(REPO_ROOT, 'src', 'remotion', 'TimelineComposition.mjs'),
    join(REPO_ROOT, 'src', 'remotion', 'Root.mjs'),
    join(REPO_ROOT, 'src', 'remotion', 'index.mjs'),
  ];

  for (const file of rendererFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:browser|terminal|run|catalog|review)\.mjs/,
      `${file} must not import capture, recipe, or review modules`
    );
  }
});

test('resolveRenderTargets validates timelines and resolves web-loop, youtube-master, and single-file targets', () => {
  assert.throws(
    () => resolveRenderTargets({ timeline: { version: 99 }, outDir: '/tmp/out' }),
    /Invalid timeline/
  );

  const timeline = compileTimeline({
    eventTrack: makeSyntheticEventTrack(),
    recipe: {
      stage: { width: 480, height: 270, padding: 40 },
      camera: { outputWidth: 480, outputHeight: 270 },
    },
  });

  // Default profiles from timeline.outputs: web-loop (webm + mp4 + png poster) + youtube-master (1440p60 mp4)
  const defaultPlan = resolveRenderTargets({ timeline, outDir: '/tmp/renders' });
  assert.equal(defaultPlan.mode, 'directory');
  assert.deepEqual(
    defaultPlan.targets.map((t) => ({
      id: t.id,
      role: t.role,
      format: t.format,
      codec: t.codec,
      width: t.width,
      height: t.height,
      fps: t.fps,
    })),
    [
      { id: 'web-loop', role: 'video', format: 'webm', codec: 'vp9', width: 480, height: 270, fps: 10 },
      { id: 'web-loop', role: 'fallback-video', format: 'mp4', codec: 'h264', width: 480, height: 270, fps: 10 },
      { id: 'web-loop', role: 'poster', format: 'png', codec: undefined, width: 480, height: 270, fps: 10 },
      { id: 'youtube-master', role: 'video', format: 'mp4', codec: 'h264', width: 2560, height: 1440, fps: 60 },
    ]
  );

  // WebP poster option on web-loop only
  const webpPlan = resolveRenderTargets({
    timeline,
    outDir: '/tmp/renders',
    profiles: ['web-loop'],
    posterFormat: 'webp',
    posterTime: 0.4,
  });
  assert.equal(webpPlan.targets.length, 3);
  assert.equal(webpPlan.targets[2].file, resolve('/tmp/renders/web-loop-poster.webp'));
  assert.equal(webpPlan.targets[2].posterTime, 0.4);

  // Single-file --out resolution for mp4, webm, and webp
  const singleMp4 = resolveRenderTargets({ timeline, out: '/tmp/single/demo.mp4' });
  assert.equal(singleMp4.mode, 'file');
  assert.equal(singleMp4.targets.length, 1);
  assert.equal(singleMp4.targets[0].codec, 'h264');
  assert.equal(singleMp4.targets[0].file, resolve('/tmp/single/demo.mp4'));

  const singlePoster = resolveRenderTargets({ timeline, out: '/tmp/single/cover.webp', posterTime: 0.2 });
  assert.equal(singlePoster.mode, 'file');
  assert.equal(singlePoster.targets[0].kind, 'still');
  assert.equal(singlePoster.targets[0].format, 'webp');

  // Invalid options fail cleanly
  assert.throws(
    () => resolveRenderTargets({ timeline, outDir: '/tmp/renders', posterFormat: 'bmp' }),
    /posterFormat/
  );
  assert.throws(
    () => resolveRenderTargets({ timeline, outDir: '/tmp/renders', profiles: ['tiktok-9x16'] }),
    /Unknown output profile/
  );
  assert.throws(
    () => resolveRenderTargets({ timeline, out: '/tmp/demo.mp4', profiles: ['web-loop', 'youtube-master'] }),
    /Single-file/
  );
  assert.deepEqual(RENDER_PROFILES, ['web-loop', 'youtube-master', 'shorts']);
});

test('shorts profile resolution, portrait 9:16 smart-follow bounds, verticalKeyframes override, cursor alignment, and safe HUD/caption zones', () => {
  const desktopEventTrack = makeSyntheticEventTrack({
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
    video: { file: 'take.mp4', width: 2560, height: 1440, fps: 30, duration: 1, frames: 30 },
    events: [
      { t: 0.0, type: 'pointermove', x: 60, y: 120 },
      { t: 0.2, type: 'pointerdown', x: 60, y: 120, button: 'left' },
      { t: 0.3, type: 'pointerup', x: 60, y: 120, button: 'left' },
      { t: 0.5, type: 'key', key: 'k', modifiers: ['Meta'], action: 'press', duration: 0.4 },
      { t: 0.6, type: 'pointermove', x: 640, y: 360 },
      { t: 0.9, type: 'pointermove', x: 1220, y: 600 },
    ],
  });

  // 1. Profile resolution via timeline.outputs: ['shorts'] and --profiles shorts
  const shortsOnlyTimeline = compileTimeline({
    eventTrack: desktopEventTrack,
    recipe: {
      stage: { width: 1520, height: 960, padding: 120 },
      window: { frame: 'macos', title: 'Shorts Demo', width: 1280, height: 720 },
      camera: { outputWidth: 1280, outputHeight: 720 },
      overlays: {
        captions: {
          enabled: true,
          tracks: [
            {
              language: 'en',
              cues: [
                {
                  start: 0.1,
                  end: 0.9,
                  text: 'Smart-follow portrait framing keeps the action centered in 9:16 Shorts.',
                },
              ],
            },
          ],
        },
      },
      outputs: ['shorts'],
    },
  });

  assert.deepEqual(shortsOnlyTimeline.outputs, [
    {
      id: 'shorts',
      format: 'mp4',
      codec: 'h264',
      width: 1080,
      height: 1920,
      fps: 60,
      loop: false,
      poster: false,
    },
  ]);

  const dirPlan = resolveRenderTargets({
    timeline: shortsOnlyTimeline,
    outDir: '/tmp/renders',
    profiles: ['shorts'],
  });
  assert.equal(dirPlan.mode, 'directory');
  assert.deepEqual(
    dirPlan.targets.map((t) => ({
      id: t.id,
      role: t.role,
      format: t.format,
      codec: t.codec,
      width: t.width,
      height: t.height,
      fps: t.fps,
      file: t.file,
    })),
    [
      {
        id: 'shorts',
        role: 'video',
        format: 'mp4',
        codec: 'h264',
        width: 1080,
        height: 1920,
        fps: 60,
        file: resolve('/tmp/renders/shorts.mp4'),
      },
    ]
  );

  // Requesting --profiles shorts on a default landscape-outputs timeline also resolves 1080x1920 @ 60fps
  const landscapeDefaultTimeline = compileTimeline({
    eventTrack: desktopEventTrack,
    recipe: {
      stage: { width: 1520, height: 960, padding: 120 },
      window: { frame: 'macos', title: 'Landscape Source', width: 1280, height: 720 },
      camera: { outputWidth: 1280, outputHeight: 720 },
    },
  });
  const overridePlan = resolveRenderTargets({
    timeline: landscapeDefaultTimeline,
    outDir: '/tmp/renders',
    profiles: ['shorts'],
  });
  assert.equal(overridePlan.targets.length, 1);
  assert.equal(overridePlan.targets[0].width, 1080);
  assert.equal(overridePlan.targets[0].height, 1920);
  assert.equal(overridePlan.targets[0].fps, 60);
  assert.equal(overridePlan.targets[0].codec, 'h264');

  const singleShortsPlan = resolveRenderTargets({
    timeline: landscapeDefaultTimeline,
    out: '/tmp/renders/vertical.mp4',
    profiles: ['shorts'],
  });
  assert.equal(singleShortsPlan.mode, 'file');
  assert.equal(singleShortsPlan.targets[0].width, 1080);
  assert.equal(singleShortsPlan.targets[0].height, 1920);
  assert.equal(singleShortsPlan.targets[0].fps, 60);

  // 2. Smart-follow 9:16 portrait framing bounds, smooth pan, full-bleed fill, and cursor/ripple alignment
  const sampledCenterX = [];
  for (let frame = 0; frame <= 60; frame += 6) {
    const scene = computeFrameScene(shortsOnlyTimeline, {
      frame,
      fps: 60,
      width: 1080,
      height: 1920,
    });
    const { camera, overlays } = scene;
    sampledCenterX.push(camera.sample.x);

    assert.equal(camera.portrait, true);
    assert.equal(camera.reframed, true);
    assert.equal(camera.mode, 'portrait-smart-follow');
    assert.equal(camera.offsetX, 0);
    assert.equal(camera.offsetY, 0);
    assert.equal(camera.logicalWidth, 1080);
    assert.equal(camera.logicalHeight, 1920);

    // Strictly inside stage [0..1520, 0..960] with exact 9:16 visible rect aspect ratio
    assert.ok(camera.visibleRect.left >= -1e-6, `left out of stage: ${camera.visibleRect.left}`);
    assert.ok(camera.visibleRect.top >= -1e-6, `top out of stage: ${camera.visibleRect.top}`);
    assert.ok(
      camera.visibleRect.right <= shortsOnlyTimeline.stage.width + 1e-6,
      `right out of stage: ${camera.visibleRect.right}`
    );
    assert.ok(
      camera.visibleRect.bottom <= shortsOnlyTimeline.stage.height + 1e-6,
      `bottom out of stage: ${camera.visibleRect.bottom}`
    );
    assert.ok(
      Math.abs(camera.visibleRect.width / camera.visibleRect.height - 9 / 16) < 1e-6,
      `expected 9:16 visible crop, got ${camera.visibleRect.width}x${camera.visibleRect.height}`
    );

    // Cursor matches both CSS stage transform and projectViewportToRender with 0 px error
    assert.ok(overlays.cursor, 'expected visible cursor');
    const stagePt = projectViewportToStage(
      overlays.cursor.viewportX,
      overlays.cursor.viewportY,
      shortsOnlyTimeline
    );
    const cssX = camera.translateX + stagePt.x * camera.effectiveScale;
    const cssY = camera.translateY + stagePt.y * camera.effectiveScale;
    assert.ok(Math.abs(overlays.cursor.x - cssX) < 1e-6, `cursor x drift: ${overlays.cursor.x} vs ${cssX}`);
    assert.ok(Math.abs(overlays.cursor.y - cssY) < 1e-6, `cursor y drift: ${overlays.cursor.y} vs ${cssY}`);

    const directPt = projectViewportToRender(
      overlays.cursor.viewportX,
      overlays.cursor.viewportY,
      shortsOnlyTimeline,
      scene.t,
      1080,
      1920
    );
    assert.ok(Math.abs(overlays.cursor.x - directPt.x) < 1e-6);
    assert.ok(Math.abs(overlays.cursor.y - directPt.y) < 1e-6);
    assert.ok(overlays.cursor.x >= 0 && overlays.cursor.x <= 1080, `cursor x outside 1080: ${overlays.cursor.x}`);
    assert.ok(overlays.cursor.y >= 0 && overlays.cursor.y <= 1920, `cursor y outside 1920: ${overlays.cursor.y}`);
    assert.equal(overlays.cursor.scale, 1.5);
  }

  // Smart-follow panned horizontally from left focus to right focus
  assert.ok(
    sampledCenterX.at(-1) - sampledCenterX[0] > 400,
    `expected smart-follow horizontal pan > 400px, got ${sampledCenterX[0]} -> ${sampledCenterX.at(-1)}`
  );

  // Ripple alignment & portrait HUD/caption safe zones at t=0.25s and t=0.55s
  const sceneClick = computeFrameScene(shortsOnlyTimeline, {
    frame: 15,
    fps: 60,
    width: 1080,
    height: 1920,
  });
  assert.equal(sceneClick.overlays.ripples.length, 1);
  const expectedRipple = projectViewportToRender(60, 120, shortsOnlyTimeline, 0.25, 1080, 1920);
  assert.ok(Math.abs(sceneClick.overlays.ripples[0].x - expectedRipple.x) < 1e-6);
  assert.ok(Math.abs(sceneClick.overlays.ripples[0].y - expectedRipple.y) < 1e-6);

  const sceneHud = computeFrameScene(shortsOnlyTimeline, {
    frame: 33,
    fps: 60,
    width: 1080,
    height: 1920,
  });
  assert.equal(sceneHud.overlays.keystrokes.length, 1);
  assert.equal(sceneHud.overlays.captions.length, 1);
  const { hudAnchor } = sceneHud.overlays;
  assert.equal(hudAnchor.portrait, true);
  assert.ok(1920 - hudAnchor.bottomY >= 180, `bottom safe zone < 180px: ${1920 - hudAnchor.bottomY}`);
  const leftEdge = hudAnchor.centerX - hudAnchor.maxWidth / 2;
  const rightMargin = 1080 - (hudAnchor.centerX + hudAnchor.maxWidth / 2);
  assert.ok(leftEdge >= 32, `left safe margin too small: ${leftEdge}`);
  assert.ok(rightMargin >= 120, `right Shorts chrome safe margin too small: ${rightMargin}`);
  assert.ok(hudAnchor.maxWidth <= 960 && hudAnchor.maxWidth > 600, `unexpected caption maxWidth: ${hudAnchor.maxWidth}`);

  // 3. Optional timeline.camera.verticalKeyframes override + strict schema bounds validation
  const overrideTimeline = compileTimeline({
    eventTrack: desktopEventTrack,
    recipe: {
      stage: { width: 1520, height: 960, padding: 120 },
      window: { frame: 'macos', title: 'Vertical Override', width: 1280, height: 720 },
      camera: {
        outputWidth: 1280,
        outputHeight: 720,
        verticalKeyframes: [
          { t: 0, x: 400, y: 480, zoom: 1, easing: 'linear' },
          { t: 0.5, x: 1000, y: 480, zoom: 1.5, easing: 'smoothstep' },
        ],
      },
      outputs: ['shorts'],
    },
  });
  assert.equal(overrideTimeline.camera.verticalKeyframes.length, 2);

  const vStart = computeFrameScene(overrideTimeline, { frame: 0, fps: 60, width: 1080, height: 1920 });
  assert.equal(vStart.camera.mode, 'portrait-vertical-keyframes');
  assert.equal(vStart.camera.sample.x, 400);
  assert.equal(vStart.camera.sample.y, 480);
  assert.equal(vStart.camera.sample.zoom, 1);

  const vMid = computeFrameScene(overrideTimeline, { frame: 30, fps: 60, width: 1080, height: 1920 });
  assert.equal(vMid.camera.mode, 'portrait-vertical-keyframes');
  assert.equal(vMid.camera.sample.x, 1000);
  assert.equal(vMid.camera.sample.y, 480);
  assert.equal(vMid.camera.sample.zoom, 1.5);

  // Out-of-bounds verticalKeyframes fail validateTimeline cleanly
  const badVertical = structuredClone(overrideTimeline);
  badVertical.camera.verticalKeyframes[0].x = 50; // left = 50 - 270 = -220 < 0
  const badCheck = validateTimeline(badVertical);
  assert.equal(badCheck.ok, false);
  assert.ok(badCheck.errors.some((e) => /verticalKeyframes\[0\].*leaves stage/.test(e)));

  const emptyVertical = structuredClone(overrideTimeline);
  emptyVertical.camera.verticalKeyframes = [];
  assert.equal(validateTimeline(emptyVertical).ok, false);
});

test('headless Remotion renders shorts 9:16 (1080x1920 @ 60fps) MP4 verified by probeVideo and reviewVideo', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-shorts-e2e-'));
  const scratchDir = join(workDir, 'scratch');
  try {
    // Build a fast 0.2s 320x180 @ 5fps take (left half emerald green, right half blue)
    const leftHalf = await sharp({
      create: { width: 160, height: 180, channels: 3, background: { r: 16, g: 185, b: 129 } },
    })
      .png()
      .toBuffer();
    const framePng = await sharp({
      create: { width: 320, height: 180, channels: 3, background: { r: 37, g: 99, b: 235 } },
    })
      .composite([{ input: leftHalf, left: 0, top: 0 }])
      .png()
      .toBuffer();
    await sharp(framePng).toFile(join(workDir, 'frame-0.png'));

    const takeFile = join(workDir, 'short-take.mp4');
    await renderVideo({ input: join(workDir, 'frame-%d.png'), output: takeFile, fps: 5 });

    // Same landscape timeline (480x270 stage, 320x180 window) with cursor focused on emerald left half (80, 90)
    const timeline = compileTimeline({
      take: { video: takeFile, eventTrack: 'event-track.json' },
      eventTrack: makeSyntheticEventTrack({
        video: { file: takeFile, width: 320, height: 180, fps: 5, duration: 0.2, frames: 1 },
        events: [
          { t: 0, type: 'pointermove', x: 80, y: 90 },
          { t: 0.05, type: 'key', key: 'k', modifiers: ['Meta'], action: 'press', duration: 0.2 },
        ],
      }),
      recipe: {
        stage: {
          width: 480,
          height: 270,
          padding: 45,
          background: { type: 'solid', color: '#0f172a' },
        },
        window: {
          frame: 'macos',
          title: 'Shorts 9:16',
          width: 320,
          height: 180,
        },
        camera: {
          outputWidth: 480,
          outputHeight: 270,
        },
        outputs: ['web-loop', 'shorts'],
      },
    });

    const outDir = join(workDir, 'out-shorts');
    const result = await renderTimeline({
      timeline,
      outDir,
      profiles: ['shorts'],
      scratchDir,
    });

    assert.equal(result.outputs.length, 1);
    const shortsOut = result.outputs[0];
    assert.equal(shortsOut.id, 'shorts');
    assert.equal(shortsOut.format, 'mp4');

    const probe = await probeVideo(shortsOut.file);
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
    assert.equal(Math.round(probe.fps), 60);
    assert.equal(probe.codec, 'h264');
    assert.equal(probe.frames, 12);
    assert.equal(probe.colorSpace, 'bt709');
    assert.equal(probe.colorPrimaries, 'bt709');
    assert.equal(probe.colorTransfer, 'bt709');
    assert.equal(probe.colorRange, 'tv');

    // Verify smart-follow centered the 9:16 crop on the emerald-green left half instead of letterboxing
    // Sample 120px left of center (420, 960) to avoid the vector cursor tip drawn directly at (540, 960)
    const emeraldRgb = decodePixelRgb(shortsOut.file, 0.05, 420, 960);
    assert.ok(
      emeraldRgb[1] > 140 && emeraldRgb[0] < 80,
      `expected smart-follow emerald green in 1080x1920 frame, got ${emeraldRgb}`
    );

    const review = await reviewVideo({
      video: shortsOut.file,
      timeline,
      outputId: 'shorts',
    });
    assert.equal(review.ok, true, `reviewVideo failed: ${JSON.stringify(review.findings)}`);
    assert.equal(review.metrics.width, 1080);
    assert.equal(review.metrics.height, 1920);
    assert.equal(Math.round(review.metrics.fps), 60);

    // Scratch directory must be completely cleaned up
    assert.deepEqual(await readdir(scratchDir), []);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('computeFrameScene preserves window content alignment and constant-scale screen-space overlays under zoom', () => {
  for (const frameKind of ['none', 'macos', 'browser', 'device']) {
    const timeline = compileTimeline({
      eventTrack: makeSyntheticEventTrack(),
      recipe: {
        stage: {
          width: 640,
          height: 360,
          padding: 60,
          background:
            frameKind === 'macos'
              ? {
                  type: 'gradient',
                  angle: 120,
                  stops: [
                    { color: '#0f172a', offset: 0 },
                    { color: '#334155', offset: 1 },
                  ],
                }
              : frameKind === 'browser'
                ? { type: 'image', src: 'wallpaper.png', fit: 'cover' }
                : { type: 'solid', color: '#111827' },
        },
        window: {
          frame: frameKind,
          title: 'Demo Window',
          width: 320,
          height: 180,
        },
        camera: {
          outputWidth: 640,
          outputHeight: 360,
          keyframes: [
            { t: 0, x: 320, y: 180, zoom: 1, easing: 'linear' },
            { t: 0.5, viewportX: 80, viewportY: 90, zoom: 2, easing: 'linear' },
          ],
        },
      },
    });

    const sceneStart = computeFrameScene(timeline, {
      frame: 0,
      fps: 10,
      width: 640,
      height: 360,
      mapAsset: (src) => `/static/${src}`,
    });

    // Window chrome wraps around contentRect without shifting viewport stage coordinates
    assert.deepEqual(sceneStart.windowChrome.contentRect, {
      x: timeline.window.x,
      y: timeline.window.y,
      width: timeline.window.width,
      height: timeline.window.height,
    });
    assert.equal(
      sceneStart.windowChrome.outerRect.x + sceneStart.windowChrome.contentOffset.left,
      timeline.window.x
    );
    assert.equal(
      sceneStart.windowChrome.outerRect.y + sceneStart.windowChrome.contentOffset.top,
      timeline.window.y
    );

    if (frameKind === 'browser') {
      assert.equal(sceneStart.stage.background.imageSrc, '/static/wallpaper.png');
    }

    // Frame 5 (t = 0.5s): camera zoomed 2x centered on viewport (80, 90)
    const sceneZoomed = computeFrameScene(timeline, {
      frame: 5,
      fps: 10,
      width: 640,
      height: 360,
    });
    assert.equal(sceneZoomed.camera.sample.zoom, 2);
    assert.equal(sceneZoomed.camera.effectiveScale, 2);

    // Verify stage affine transform projects viewport (80, 90) to exact screen center (320, 180)
    const stagePt = projectViewportToStage(80, 90, timeline);
    const transformedX = sceneZoomed.camera.translateX + stagePt.x * sceneZoomed.camera.effectiveScale;
    const transformedY = sceneZoomed.camera.translateY + stagePt.y * sceneZoomed.camera.effectiveScale;
    assert.ok(Math.abs(transformedX - 320) < 1e-6);
    assert.ok(Math.abs(transformedY - 180) < 1e-6);

    // Cursor scale stays 1.0 despite 2x camera zoom!
    assert.equal(sceneStart.overlays.cursor.scale, 1);
    assert.equal(sceneZoomed.overlays.cursor.scale, 1);

    // Cursor position matches projectViewportToScreen at every frame
    const expectedCursorPt = projectViewportToScreen(
      sceneZoomed.overlays.cursor.viewportX,
      sceneZoomed.overlays.cursor.viewportY,
      timeline,
      0.5
    );
    assert.deepEqual(
      { x: sceneZoomed.overlays.cursor.x, y: sceneZoomed.overlays.cursor.y },
      expectedCursorPt
    );

    // Pressed cursor + active ripple at t = 0.25s
    const sceneClick = computeFrameScene(timeline, { frame: 2.5, fps: 10, width: 640, height: 360 });
    assert.equal(sceneClick.overlays.cursor.pressed, true);
    assert.ok(sceneClick.overlays.cursor.pressScale < 1);
    assert.equal(sceneClick.overlays.ripples.length, 1);
    assert.equal(sceneClick.overlays.ripples[0].scale, 1);

    // Active wheel gesture + keystroke pill at t = 0.55s
    const sceneHud = computeFrameScene(timeline, { frame: 5.5, fps: 10, width: 640, height: 360 });
    assert.equal(sceneHud.overlays.gestures.length, 1);
    assert.equal(sceneHud.overlays.gestures[0].kind, 'wheel');
    assert.equal(sceneHud.overlays.gestures[0].angleDeg, -90);
    assert.equal(sceneHud.overlays.keystrokes.length, 1);
    assert.equal(sceneHud.overlays.keystrokes[0].label, '⌘K');

    // YouTube Master 2560x1440 scaling at t=0.5s (frame 30 @ 60fps): outputScale = 4 (2560/640), still independent of camera zoom
    const scene1440p = computeFrameScene(timeline, { frame: 30, fps: 60, width: 2560, height: 1440 });
    assert.equal(scene1440p.overlays.cursor.scale, 4);
    assert.equal(scene1440p.camera.effectiveScale, 8);
  }

  const meta = calculateTimelineMetadata({
    props: {
      timeline: compileTimeline({ eventTrack: makeSyntheticEventTrack() }),
      output: { width: 2560, height: 1440, fps: 60 },
    },
  });
  assert.deepEqual(
    { width: meta.width, height: meta.height, fps: meta.fps, durationInFrames: meta.durationInFrames },
    { width: 2560, height: 1440, fps: 60, durationInFrames: 60 }
  );
});

test('headless Remotion CLI renders web-loop (WebM + MP4 + poster), youtube-master, re-renders edited timeline without re-capturing, and cleans up scratch files', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-remotion-e2e-'));
  const scratchDir = join(workDir, 'scratch');
  try {
    // 1. Build a synthetic 1-second 320x180 @ 10fps clean take (left half emerald green, right half blue)
    const framesDir = join(workDir, 'frames');
    await writeFile(join(workDir, '.keep'), '');
    const leftHalf = await sharp({
      create: { width: 160, height: 180, channels: 3, background: { r: 16, g: 185, b: 129 } },
    })
      .png()
      .toBuffer();
    const framePng = await sharp({
      create: { width: 320, height: 180, channels: 3, background: { r: 37, g: 99, b: 235 } },
    })
      .composite([{ input: leftHalf, left: 0, top: 0 }])
      .png()
      .toBuffer();

    await sharp(framePng).toFile(join(workDir, 'frame-0.png'));
    for (let i = 0; i < 10; i += 1) {
      await sharp(framePng).toFile(join(workDir, `seq-${i}.png`));
    }
    void framesDir;

    const takeFile = join(workDir, 'take.mp4');
    await renderVideo({ input: join(workDir, 'seq-%d.png'), output: takeFile, fps: 10 });
    const takeBytesBefore = await readFile(takeFile);
    const takeShaBefore = sha256(takeBytesBefore);
    const takeStatBefore = await stat(takeFile);

    // 2. Compile initial timeline.json: dark navy solid stage (#0f172a), zoom 1x showing stage border + macOS window
    const eventTrack = makeSyntheticEventTrack({
      video: { file: 'take.mp4', width: 320, height: 180, fps: 10, duration: 1, frames: 10 },
    });
    const timelinePath = join(workDir, 'timeline.json');
    const initialTimeline = compileTimeline({
      take: { video: 'take.mp4', eventTrack: 'event-track.json' },
      eventTrack,
      recipe: {
        stage: {
          width: 480,
          height: 270,
          padding: 45,
          background: { type: 'solid', color: '#0f172a' },
        },
        window: {
          frame: 'macos',
          title: 'Initial Render',
          width: 320,
          height: 180,
        },
        camera: {
          outputWidth: 480,
          outputHeight: 270,
          keyframes: [{ t: 0, x: 240, y: 135, zoom: 1, easing: 'linear' }],
        },
        outputs: ['web-loop'],
      },
    });
    await writeFile(timelinePath, JSON.stringify(initialTimeline, null, 2));

    // 3. Run real CLI `screen-kit render --input timeline.json --out <dir> --profiles web-loop`
    const outWebLoopDir = join(workDir, 'out-web-loop');
    const { stdout } = await execFile(
      process.execPath,
      [CLI_PATH, 'render', '--input', timelinePath, '--out', outWebLoopDir, '--profiles', 'web-loop'],
      { cwd: REPO_ROOT, timeout: 120000 }
    );
    const cliResult = JSON.parse(stdout);
    assert.equal(cliResult.renderer, 'remotion-4');
    assert.equal(cliResult.outputs.length, 3);

    const webmOut = cliResult.outputs.find((o) => o.format === 'webm');
    const mp4Out = cliResult.outputs.find((o) => o.format === 'mp4');
    const posterOut = cliResult.outputs.find((o) => o.role === 'poster');
    assert.ok(webmOut && mp4Out && posterOut);

    const webmProbe = await probeVideo(webmOut.file);
    assert.equal(webmProbe.width, 480);
    assert.equal(webmProbe.height, 270);
    assert.equal(webmProbe.frames, 10);
    assert.equal(webmProbe.audio, false);
    assert.match(webmProbe.codec, /vp9/);
    assert.equal(webmProbe.colorSpace, 'bt709');
    assert.equal(webmProbe.colorPrimaries, 'bt709');
    assert.equal(webmProbe.colorTransfer, 'bt709');
    assert.equal(webmProbe.colorRange, 'tv');

    const mp4Probe = await probeVideo(mp4Out.file);
    assert.equal(mp4Probe.width, 480);
    assert.equal(mp4Probe.height, 270);
    assert.equal(mp4Probe.frames, 10);
    assert.equal(mp4Probe.audio, false);
    assert.equal(mp4Probe.codec, 'h264');
    assert.equal(mp4Probe.colorSpace, 'bt709');
    assert.equal(mp4Probe.colorPrimaries, 'bt709');
    assert.equal(mp4Probe.colorTransfer, 'bt709');
    assert.equal(mp4Probe.colorRange, 'tv');

    const posterMeta = await sharp(posterOut.file).metadata();
    assert.equal(posterMeta.format, 'png');
    assert.equal(posterMeta.width, 480);
    assert.equal(posterMeta.height, 270);

    // Top-left stage corner (8, 8) in initial render is dark navy (#0f172a -> red channel < 45)
    const initialCornerRgb = decodePixelRgb(mp4Out.file, 0.2, 8, 8);
    assert.ok(initialCornerRgb[0] < 45 && initialCornerRgb[2] < 70, `expected dark stage corner, got ${initialCornerRgb}`);

    // 4. Edit timeline.json ONLY (bright red stage #ef4444 + 2x camera zoom onto green left half at t=0.5s + WebP poster)
    const editedTimeline = structuredClone(initialTimeline);
    editedTimeline.stage.background = { type: 'solid', color: '#ef4444' };
    editedTimeline.camera.keyframes = [
      { t: 0, x: 240, y: 135, zoom: 1, easing: 'linear' },
      { t: 0.5, x: 160, y: 135, zoom: 2, easing: 'smoothstep' },
    ];
    await writeFile(timelinePath, JSON.stringify(editedTimeline, null, 2));

    const editedFile = join(workDir, 'out-edited', 'edited.mp4');
    const editedPoster = join(workDir, 'out-edited', 'poster.webp');
    const rerenderResult = await renderTimeline({
      timeline: timelinePath,
      out: editedFile,
      scratchDir,
    });
    const webpPosterResult = await renderTimeline({
      timeline: timelinePath,
      out: editedPoster,
      posterTime: 0.5,
      scratchDir,
    });

    assert.equal(rerenderResult.outputs[0].sha256 !== mp4Out.sha256, true);
    const webpMeta = await sharp(webpPosterResult.outputs[0].file).metadata();
    assert.equal(webpMeta.format, 'webp');
    assert.equal(webpMeta.width, 480);
    assert.equal(webpMeta.height, 270);

    // Verify take.mp4 was NOT re-captured or touched
    assert.equal(sha256(await readFile(takeFile)), takeShaBefore);
    assert.equal((await stat(takeFile)).mtimeMs, takeStatBefore.mtimeMs);

    // At t=0 in edited.mp4, stage corner (8, 8) is now bright red (#ef4444 -> red > 190, green < 100)
    const editedCornerRgb = decodePixelRgb(editedFile, 0, 8, 8);
    assert.ok(
      editedCornerRgb[0] > 190 && editedCornerRgb[1] < 100,
      `expected red stage corner after timeline edit, got ${editedCornerRgb}`
    );

    // At t=0 in edited.mp4, macOS window title bar at (240, 24) renders dark chrome above viewport content, not red stage
    const titleBarRgb = decodePixelRgb(editedFile, 0, 240, 24);
    assert.ok(
      titleBarRgb[0] < 80 && titleBarRgb[1] < 80 && titleBarRgb[2] < 95,
      `expected dark macOS title bar chrome above window content, got ${titleBarRgb}`
    );

    // At t=0.6s in edited.mp4, 2x zoom centered at stage (160, 135) = viewport (80, 90) places emerald green at screen center (240, 135)
    const zoomedCenterRgb = decodePixelRgb(editedFile, 0.6, 240, 135);
    assert.ok(
      zoomedCenterRgb[1] > 140 && zoomedCenterRgb[0] < 80,
      `expected zoomed emerald-green viewport content at screen center, got ${zoomedCenterRgb}`
    );

    // In poster.webp (t=0.5s), screen-space keystroke pill ⌘K is drawn near bottom-center (240, 212) over the zoomed green take
    const { data: posterRaw, info: posterInfo } = await sharp(editedPoster)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pillIdx = (212 * posterInfo.width + 240) * 4;
    assert.ok(
      posterRaw[pillIdx + 1] < 120,
      `expected dark translucent keystroke pill overlay at bottom-center, got rgba(${posterRaw[pillIdx]},${posterRaw[pillIdx + 1]},${posterRaw[pillIdx + 2]},${posterRaw[pillIdx + 3]})`
    );

    // Verify scratchDir is completely empty after successful renders
    assert.deepEqual(await readdir(scratchDir), []);

    // 5. Verify youtube-master profile (2560x1440 @ 60fps H.264 MP4) on a concise 0.2s take
    const shortTake = join(workDir, 'short-take.mp4');
    await renderVideo({ input: join(workDir, 'frame-%d.png'), output: shortTake, fps: 5 });
    const shortTimeline = compileTimeline({
      take: { video: shortTake, eventTrack: 'event-track.json' },
      eventTrack: makeSyntheticEventTrack({
        video: { file: shortTake, width: 320, height: 180, fps: 5, duration: 0.2, frames: 1 },
        events: [{ t: 0, type: 'pointermove', x: 160, y: 90 }],
      }),
      recipe: {
        outputs: ['youtube-master'],
      },
    });
    const ytOutDir = join(workDir, 'out-yt');
    const ytResult = await renderTimeline({
      timeline: shortTimeline,
      outDir: ytOutDir,
      profiles: ['youtube-master'],
      scratchDir,
    });
    assert.equal(ytResult.outputs.length, 1);
    const ytProbe = await probeVideo(ytResult.outputs[0].file);
    assert.equal(ytProbe.width, 2560);
    assert.equal(ytProbe.height, 1440);
    assert.equal(ytProbe.codec, 'h264');
    assert.equal(ytProbe.frames, 12);
    assert.equal(ytProbe.colorSpace, 'bt709');
    assert.equal(ytProbe.colorPrimaries, 'bt709');
    assert.equal(ytProbe.colorTransfer, 'bt709');
    assert.equal(ytProbe.colorRange, 'tv');
    assert.deepEqual(await readdir(scratchDir), []);

    // 6. Verify failure cleanup both on corrupt media and mid-flight abort after bundling/browser launch
    const corruptVideo = join(workDir, 'corrupt.mp4');
    await writeFile(corruptVideo, 'not a valid video file');
    const brokenTimeline = structuredClone(shortTimeline);
    brokenTimeline.take.video = corruptVideo;
    const failedOutFile = join(workDir, 'out-failed', 'broken.mp4');
    await assert.rejects(
      renderTimeline({
        timeline: brokenTimeline,
        out: failedOutFile,
        scratchDir,
      }),
      /Invalid timeline\.take\.video/
    );
    assert.deepEqual(await readdir(scratchDir), []);

    const abortController = new AbortController();
    abortController.abort();
    await assert.rejects(
      renderTimeline({
        timeline: shortTimeline,
        out: failedOutFile,
        signal: abortController.signal,
        scratchDir,
      }),
      /aborted/i
    );
    assert.deepEqual(await readdir(scratchDir), []);

    // 7. End-to-end CLI `screen-kit timeline --input ... --out ...` -> `render` -> `review`
    const cliTakeDir = join(workDir, 'takes', 'cli-demo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cliTakeDir, { recursive: true });
    const cliTakeVideo = join(cliTakeDir, 'take.mp4');
    await renderVideo({ input: join(workDir, 'seq-%d.png'), output: cliTakeVideo, fps: 10 });
    const cliEventTrackPath = join(cliTakeDir, 'event-track.json');
    await writeFile(
      cliEventTrackPath,
      JSON.stringify(
        makeSyntheticEventTrack({
          video: { file: 'take.mp4', width: 320, height: 180, fps: 10, duration: 1, frames: 10 },
        }),
        null,
        2
      )
    );
    const cliTimelineOut = join(workDir, 'compiled-timeline.json');
    const { stdout: tlStdout } = await execFile(
      process.execPath,
      [CLI_PATH, 'timeline', '--input', cliEventTrackPath, '--out', cliTimelineOut],
      { cwd: REPO_ROOT, timeout: 30000 }
    );
    const tlSummary = JSON.parse(tlStdout);
    assert.equal(tlSummary.ok, true);
    assert.equal(tlSummary.take.video, 'takes/cli-demo/take.mp4');
    assert.equal(tlSummary.take.eventTrack, 'takes/cli-demo/event-track.json');

    const cliRenderedMp4 = join(workDir, 'cli-rendered.mp4');
    await execFile(
      process.execPath,
      [CLI_PATH, 'render', '--input', cliTimelineOut, '--out', cliRenderedMp4],
      { cwd: REPO_ROOT, timeout: 120000 }
    );
    const { stdout: revStdout } = await execFile(
      process.execPath,
      [CLI_PATH, 'review', '--video', cliRenderedMp4, '--timeline', cliTimelineOut],
      { cwd: REPO_ROOT, timeout: 60000 }
    );
    const revJson = JSON.parse(revStdout);
    assert.equal(revJson.ok, true);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('moveFileAtomic copies to <dest>.tmp then renames atomically on EXDEV and CI workflow sets timeout + read permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-atomic-'));
  try {
    const src = join(dir, 'src.bin');
    const dest = join(dir, 'nested', 'dest.bin');
    await writeFile(src, 'atomic-payload');

    const opsLog = [];
    let firstRename = true;
    await moveFileAtomic(src, dest, {
      rename: async (from, to) => {
        opsLog.push(['rename', from, to]);
        if (firstRename) {
          firstRename = false;
          const err = Error('cross-device link not permitted');
          err.code = 'EXDEV';
          throw err;
        }
        const { rename: realRename } = await import('node:fs/promises');
        return realRename(from, to);
      },
      copyFile: async (from, to) => {
        opsLog.push(['copyFile', from, to]);
        const { copyFile: realCopy } = await import('node:fs/promises');
        return realCopy(from, to);
      },
    });

    assert.equal(await readFile(dest, 'utf8'), 'atomic-payload');
    assert.equal(opsLog.length, 3);
    assert.equal(opsLog[0][0], 'rename');
    assert.equal(opsLog[1][0], 'copyFile');
    assert.ok(opsLog[1][2].startsWith(`${dest}.`) && opsLog[1][2].endsWith('.tmp'));
    assert.equal(opsLog[2][0], 'rename');
    assert.equal(opsLog[2][1], opsLog[1][2]);
    assert.equal(opsLog[2][2], dest);
    assert.equal(screenToRender(100, 100, 1440, 900, 2560, 1440).x, 288);

    const ciYaml = await readFile(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ciYaml, /permissions:\s*\n\s*contents:\s*read/);
    assert.match(ciYaml, /timeout-minutes:\s*20/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildSquirclePath produces a strictly convex closed clockwise contour with zero corner cusps', () => {
  const path = buildSquirclePath(1440, 854, 16, 0.6);
  const coords = [...path.matchAll(/[ML]\s+([0-9.]+)\s+([0-9.]+)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  assert.ok(coords.length >= 96, 'expected smooth sampled superellipse contour');

  // Verify every point stays within [0..1440, 0..854] and every consecutive turn is convex (cross >= -1e-6)
  for (const [x, y] of coords) {
    assert.ok(x >= 0 && x <= 1440, `x out of bounds: ${x}`);
    assert.ok(y >= 0 && y <= 854, `y out of bounds: ${y}`);
  }
  const unique = coords.filter((pt, i) => {
    const prev = coords[(i - 1 + coords.length) % coords.length];
    return Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 1e-6;
  });
  for (let i = 0; i < unique.length; i++) {
    const a = unique[i];
    const b = unique[(i + 1) % unique.length];
    const c = unique[(i + 2) % unique.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    assert.ok(cross >= -1e-6, `concave notch/cusp detected at (${b[0]}, ${b[1]}): cross=${cross}`);
  }
});

test('renderTimelinePreview, screen-kit preview CLI, and unified screen-kit run (--preview-only & --reuse-take) work end-to-end', async () => {
  assert.equal(rootApi.renderTimelinePreview, renderTimelinePreview);
  assert.equal(rootApi.resolvePreviewTargets, resolvePreviewTargets);
  assert.equal(rootApi.runPipeline, runPipeline);

  // Verify resolvePreviewTargets caps >12 steps down to maxFrames=12 while keeping first & last
  const manyStepsTimeline = compileTimeline({
    eventTrack: makeSyntheticEventTrack({
      video: { file: 'take.mp4', width: 320, height: 180, fps: 10, duration: 5, frames: 50 },
      events: Array.from({ length: 20 }, (_, i) => ({
        t: Number((i * 0.2).toFixed(2)),
        type: 'step',
        index: i,
        label: `step-${i}`,
      })),
    }),
  });
  const capped = resolvePreviewTargets({ timeline: manyStepsTimeline, maxFrames: 12 });
  assert.equal(capped.length, 12);
  assert.equal(capped[0].index, 0);
  assert.equal(capped.at(-1).index, 19);

  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-preview-run-e2e-'));
  const scratchDir = join(workDir, 'scratch');
  try {
    // Build a real 1.0s 320x180 @ 10fps video (left half emerald #10b981, right half blue #2563eb)
    // with animated brightness shift across frames so FFmpeg freezedetect never flags a static freeze.
    for (let i = 0; i < 10; i += 1) {
      const leftHalf = await sharp({
        create: { width: 160, height: 180, channels: 3, background: { r: 16, g: 170 + i * 2, b: 120 + i } },
      })
        .png()
        .toBuffer();
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 30 + i * 2, g: 95 + i, b: 230 } },
      })
        .composite([{ input: leftHalf, left: 0, top: 0 }])
        .png()
        .toFile(join(workDir, `anim-${i}.png`));
    }

    const baseTakeVideo = join(workDir, 'base-take.mp4');
    await renderVideo({ input: join(workDir, 'anim-%d.png'), output: baseTakeVideo, fps: 10 });
    const baseTakeBytes = await readFile(baseTakeVideo);

    // 1. Test CLI `screen-kit preview --input timeline.json --out <dir> --columns 2`
    const previewTrack = makeSyntheticEventTrack({
      video: { file: 'base-take.mp4', width: 320, height: 180, fps: 10, duration: 1.0, frames: 10 },
      events: [
        { t: 0.0, type: 'pointermove', x: 160, y: 90 },
        { t: 0.1, type: 'step', index: 0, label: 'Wide Intro', camera: 'wide' },
        {
          t: 0.5,
          type: 'step',
          index: 1,
          label: 'Zoom Emerald',
          target: [40, 90],
          camera: { zoom: 2.0, focus: 'target', lead: 0.15, hold: 0.2 },
        },
        { t: 0.9, type: 'step', index: 2, label: 'Wide Outro', camera: 'wide' },
      ],
    });
    const previewTimelinePath = join(workDir, 'preview-timeline.json');
    const compiledForPreview = compileTimeline({
      take: { video: 'base-take.mp4', eventTrack: 'event-track.json' },
      eventTrack: previewTrack,
      recipe: {
        stage: { width: 480, height: 270, padding: 45, background: { type: 'solid', color: '#0f172a' } },
        window: { frame: 'macos', title: 'Preview Window', width: 320, height: 180 },
        camera: { outputWidth: 480, outputHeight: 270 },
      },
    });
    await writeFile(previewTimelinePath, JSON.stringify(compiledForPreview, null, 2));

    const cliPreviewDir = join(workDir, 'cli-preview');
    const { stdout: prevStdout } = await execFile(
      process.execPath,
      [CLI_PATH, 'preview', '--input', previewTimelinePath, '--out', cliPreviewDir, '--columns', '2'],
      { cwd: REPO_ROOT, timeout: 60000 }
    );
    const prevResult = JSON.parse(prevStdout);
    assert.equal(prevResult.renderer, 'remotion-4');
    assert.equal(prevResult.stills.length, 3);
    assert.equal(prevResult.contactSheet.columns, 2);
    assert.equal(prevResult.contactSheet.rows, 2);
    assert.equal(prevResult.contactSheet.count, 3);
    const sheetMeta = await sharp(prevResult.contactSheet.file).metadata();
    assert.equal(sheetMeta.format, 'png');
    assert.ok(sheetMeta.width > 900);

    // Step 1 still (t=0.5, zoomed 2x onto emerald left half) places emerald green at center (240, 135)
    const zoomedStillRaw = await sharp(prevResult.stills[1].file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const centerIdx = (135 * zoomedStillRaw.info.width + 240) * 4;
    assert.ok(
      zoomedStillRaw.data[centerIdx + 1] > 140 && zoomedStillRaw.data[centerIdx] < 80,
      `expected emerald green at center of zoomed preview still, got rgba(${zoomedStillRaw.data[centerIdx]},${zoomedStillRaw.data[centerIdx + 1]},${zoomedStillRaw.data[centerIdx + 2]})`
    );

    // Programmatic renderTimelinePreview cleans up scratchDir completely
    const apiPreviewDir = join(workDir, 'api-preview');
    await renderTimelinePreview({
      timeline: compiledForPreview,
      cwd: workDir,
      outDir: apiPreviewDir,
      width: 320,
      columns: 3,
      scratchDir,
    });
    assert.deepEqual(await readdir(scratchDir), []);

    // 2. Test unified `runPipeline` (fresh capture -> CLI `--reuse-take --preview-only` -> CLI `--reuse-take --profiles web-loop`)
    const dummyJpg = (
      await sharp({ create: { width: 32, height: 24, channels: 3, background: '#10b981' } }).jpeg().toBuffer()
    ).toString('base64');

    const mockPw = {
      chromium: {
        async launch() {
          return {
            async newContext() {
              return {
                async newPage() {
                  return {
                    viewportSize: () => ({ width: 320, height: 180 }),
                    async goto() {},
                    async evaluate() { return true; },
                    getByRole(role, opts) {
                      if (role === 'button' && opts?.name === 'Gallery') {
                        const loc = {
                          async waitFor() {},
                          async scrollIntoViewIfNeeded() {},
                          async boundingBox() { return { x: 20, y: 60, width: 80, height: 40 }; },
                        };
                        return { first: () => loc, nth: () => loc };
                      }
                      throw Error('unexpected role');
                    },
                    mouse: { async move() {}, async down() {}, async up() {}, async wheel() {} },
                    keyboard: { async press() {}, async down() {}, async up() {}, async type() {} },
                  };
                },
                async newCDPSession() {
                  let listener = null;
                  return {
                    on(ev, fn) { if (ev === 'Page.screencastFrame') listener = fn; },
                    async send(method) {
                      if (method === 'Page.captureScreenshot') return { data: dummyJpg };
                      if (method === 'Page.startScreencast' && listener) {
                        listener({ data: dummyJpg, metadata: { timestamp: 1.0 }, sessionId: 1 });
                        listener({ data: dummyJpg, metadata: { timestamp: 1.05 }, sessionId: 2 });
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

    const runOutDir = join(workDir, 'out-run');
    const demoConfig = {
      recipes: {
        showcase: {
          source: 'browser',
          captureMode: 'headless',
          url: 'https://example.test/showcase',
          viewport: [320, 180],
          fps: 10,
          tail: 0.05,
          steps: [
            {
              type: 'click',
              target: { role: 'button', name: 'Gallery' },
              moveDuration: 0.05,
              hold: 0.02,
              label: 'Focus Gallery',
              camera: { zoom: 1.8, focus: 'target', lead: 0.1, hold: 0.2 },
            },
            {
              type: 'key',
              key: 'Escape',
              label: 'Reset Wide',
              camera: 'wide',
            },
          ],
          presentation: {
            stage: { width: 480, height: 270, padding: 45, background: { type: 'solid', color: '#0f172a' } },
            window: { frame: 'macos', title: 'Unified Run', width: 320, height: 180 },
            camera: { outputWidth: 480, outputHeight: 270 },
            outputs: ['web-loop'],
          },
        },
      },
    };

    // Step 2a: Run programmatic pipeline (fresh capture + previewOnly) to populate out-run/takes/showcase/
    const freshPreviewRun = await runPipeline({
      config: demoConfig,
      cwd: workDir,
      out: runOutDir,
      previewOnly: true,
      reuseTake: false,
      captureOptions: {
        playwright: mockPw,
        encodeFrames: async ({ outputFile }) => {
          await writeFile(outputFile, baseTakeBytes);
          const info = await probeVideo(outputFile);
          return { ...info, measuredFps: 10, capturedFrames: 10, truncated: false };
        },
      },
      renderOptions: { scratchDir },
    });

    assert.equal(freshPreviewRun.ok, true);
    assert.equal(freshPreviewRun.mode, 'preview');
    assert.equal(freshPreviewRun.take.reused, false);
    assert.ok(freshPreviewRun.timeline.cameraKeyframes >= 3);
    assert.equal(freshPreviewRun.preview.stills.length, 2);

    const savedTakeVideo = freshPreviewRun.take.video;
    const savedTakeSha = sha256(await readFile(savedTakeVideo));
    const savedTakeStat = await stat(savedTakeVideo);

    // Step 2b: Write config file with tweaked presentation background & run CLI `screen-kit run --reuse-take --preview-only`
    const configPath = join(workDir, 'demo.config.mjs');
    const updatedConfig = structuredClone(demoConfig);
    updatedConfig.recipes.showcase.presentation.stage.background = { type: 'solid', color: '#1e293b' };
    await writeFile(configPath, `export default ${JSON.stringify(updatedConfig, null, 2)};\n`);

    const { stdout: reusePreviewStdout } = await execFile(
      process.execPath,
      [CLI_PATH, 'run', '--config', configPath, '--out', runOutDir, '--only', 'showcase', '--reuse-take', '--preview-only'],
      { cwd: REPO_ROOT, timeout: 60000 }
    );
    const reusePreviewResult = JSON.parse(reusePreviewStdout);
    assert.equal(reusePreviewResult.ok, true);
    assert.equal(reusePreviewResult.mode, 'preview');
    assert.equal(reusePreviewResult.take.reused, true);
    assert.equal(sha256(await readFile(savedTakeVideo)), savedTakeSha);
    assert.equal((await stat(savedTakeVideo)).mtimeMs, savedTakeStat.mtimeMs);

    // Step 2c: Run full CLI `screen-kit run --config demo.config.mjs --out <dir> --reuse-take --profiles web-loop`
    const { stdout: fullRunStdout } = await execFile(
      process.execPath,
      [CLI_PATH, 'run', '--config', configPath, '--out', runOutDir, '--reuse-take', '--profiles', 'web-loop'],
      { cwd: REPO_ROOT, timeout: 120000 }
    );
    const fullRunResult = JSON.parse(fullRunStdout);
    assert.equal(fullRunResult.ok, true);
    assert.equal(fullRunResult.mode, 'full');
    assert.equal(fullRunResult.take.reused, true);
    assert.equal(fullRunResult.render.outputs.length, 3);
    assert.equal(fullRunResult.review.ok, true);
    assert.ok((await stat(fullRunResult.review.contactSheet)).size > 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('Display P3 wide-gamut timeline rendering preserves smpte432 / iec61966-2-1 CICP metadata and P3 pixels across MP4, WebM, and CLI --color-space p3', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-render-p3-'));
  const scratchDir = join(workDir, 'scratch');
  try {
    // 1. Verify resolveRenderTargets precedence: renderTimeline({ colorSpace }) > output.colorSpace > take.colorSpace > 'srgb'
    const mixedOutputsTimeline = compileTimeline({
      eventTrack: makeSyntheticEventTrack({
        video: { file: 'take.mp4', width: 128, height: 64, fps: 10, duration: 0.2, frames: 2, colorSpace: 'p3' },
      }),
      recipe: {
        stage: { width: 128, height: 64, padding: 0 },
        window: { frame: 'none', width: 128, height: 64 },
        camera: { outputWidth: 128, outputHeight: 64 },
        outputs: [
          'web-loop', // inherits take.colorSpace ('p3')
          { preset: 'youtube-master', colorSpace: 'srgb' }, // explicit output override ('srgb')
        ],
      },
    });
    const inheritedPlan = resolveRenderTargets({ timeline: mixedOutputsTimeline, outDir: join(workDir, 'plan') });
    assert.equal(inheritedPlan.targets.find((t) => t.id === 'web-loop' && t.format === 'webm')?.colorSpace, 'p3');
    assert.equal(inheritedPlan.targets.find((t) => t.id === 'web-loop' && t.format === 'mp4')?.colorSpace, 'p3');
    assert.equal(inheritedPlan.targets.find((t) => t.id === 'youtube-master')?.colorSpace, 'srgb');

    const forcedPlan = resolveRenderTargets({
      timeline: mixedOutputsTimeline,
      outDir: join(workDir, 'plan'),
      colorSpace: 'p3',
    });
    assert.ok(forcedPlan.targets.every((t) => t.colorSpace === 'p3'));

    // 2. Encode a Display P3 take video: left half pure Display P3 red (255,0,0), right half sRGB red in P3 (234,51,35)
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
        .toFile(join(workDir, `p3-seq-${i}.png`));
    }
    const p3TakeVideo = join(workDir, 'p3-take.mp4');
    await renderVideo({ input: join(workDir, 'p3-seq-%d.png'), output: p3TakeVideo, fps: 10, colorSpace: 'p3' });
    const srcProbe = await probeVideo(p3TakeVideo);
    assert.equal(srcProbe.colorPrimaries, 'smpte432');
    assert.equal(srcProbe.colorTransfer, 'iec61966-2-1');

    // 3. Render timeline inheriting take.colorSpace = 'p3' into web-loop (VP9 WebM + H.264 MP4)
    const p3Timeline = compileTimeline({
      take: { video: 'p3-take.mp4', eventTrack: 'event-track.json', colorSpace: 'p3' },
      eventTrack: makeSyntheticEventTrack({
        viewport: { width: 128, height: 64, deviceScaleFactor: 1 },
        video: { file: 'p3-take.mp4', width: 128, height: 64, fps: 10, duration: 0.2, frames: 2 },
        events: [],
      }),
      recipe: {
        stage: { width: 128, height: 64, padding: 0, background: { type: 'solid', color: 'color(display-p3 1 0 0)' } },
        window: { frame: 'none', width: 128, height: 64 },
        camera: { outputWidth: 128, outputHeight: 64 },
        overlays: { cursor: { enabled: false } },
        outputs: ['web-loop'],
      },
    });
    const p3TimelinePath = join(workDir, 'p3-timeline.json');
    await writeFile(p3TimelinePath, JSON.stringify(p3Timeline, null, 2));

    const p3DirOut = join(workDir, 'out-p3');
    const p3Render = await renderTimeline({
      timeline: p3TimelinePath,
      outDir: p3DirOut,
      profiles: ['web-loop'],
      scratchDir,
    });

    const webmOut = p3Render.outputs.find((o) => o.format === 'webm');
    const mp4Out = p3Render.outputs.find((o) => o.format === 'mp4');
    assert.ok(webmOut && mp4Out);

    for (const [label, filePath] of [['webm', webmOut.file], ['mp4', mp4Out.file]]) {
      const probed = await probeVideo(filePath);
      assert.equal(probed.colorPrimaries, 'smpte432', `${label} colorPrimaries`);
      assert.equal(probed.colorTransfer, 'iec61966-2-1', `${label} colorTransfer`);
      assert.equal(probed.colorSpace, 'bt709', `${label} colorSpace`);
      assert.equal(probed.colorRange, 'tv', `${label} colorRange`);
    }

    // Verify wide-gamut P3 vs sRGB red separation on decoded BT.709 YUV -> RGB24 frame
    const rawRgb = execFileSync('ffmpeg', [
      '-v', 'error', '-i', mp4Out.file, '-frames:v', '1',
      '-vf', 'scale=in_color_matrix=bt709:in_range=tv',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
    ]);
    const samplePx = (x, y) => {
      const idx = (y * 128 + x) * 3;
      return [rawRgb[idx], rawRgb[idx + 1], rawRgb[idx + 2]];
    };
    const leftP3 = samplePx(24, 32);
    const rightSrgb = samplePx(104, 32);
    const gamutDist = Math.hypot(leftP3[0] - rightSrgb[0], leftP3[1] - rightSrgb[1], leftP3[2] - rightSrgb[2]);
    assert.ok(
      gamutDist >= 20,
      `expected distinct Display P3 red (${leftP3}) vs sRGB red (${rightSrgb}), dist=${gamutDist}`
    );

    // 4. Verify CLI `screen-kit render --input srgb-timeline.json --out cli-p3.mp4 --color-space p3`
    const srgbTimeline = structuredClone(p3Timeline);
    delete srgbTimeline.take.colorSpace;
    const srgbTimelinePath = join(workDir, 'srgb-timeline.json');
    await writeFile(srgbTimelinePath, JSON.stringify(srgbTimeline, null, 2));

    const cliP3Mp4 = join(workDir, 'cli-p3.mp4');
    await execFile(
      process.execPath,
      [CLI_PATH, 'render', '--input', srgbTimelinePath, '--out', cliP3Mp4, '--color-space', 'p3'],
      { cwd: REPO_ROOT, timeout: 120000 }
    );
    const cliProbed = await probeVideo(cliP3Mp4);
    assert.equal(cliProbed.colorPrimaries, 'smpte432');
    assert.equal(cliProbed.colorTransfer, 'iec61966-2-1');
    assert.equal(cliProbed.colorSpace, 'bt709');
    assert.equal(cliProbed.colorRange, 'tv');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
