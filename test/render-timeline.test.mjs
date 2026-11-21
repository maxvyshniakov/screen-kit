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
  renderTimeline,
  resolveRenderTargets,
  screenToRender,
} from '../src/render-timeline.mjs';
import { calculateTimelineMetadata } from '../src/remotion/Root.mjs';
import {
  compileTimeline,
  projectViewportToScreen,
  projectViewportToStage,
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
  assert.deepEqual(rootApi.RENDER_PROFILES, ['web-loop', 'youtube-master']);

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
  assert.deepEqual(RENDER_PROFILES, ['web-loop', 'youtube-master']);
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
