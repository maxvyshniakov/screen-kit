import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { compileTimeline, projectViewportToScreen } from '../src/timeline.mjs';
import {
  DEFAULT_CURSOR_THRESHOLD_PX,
  locateCursorMarker,
  reviewVideo,
  snapToFrameBoundary,
  verifyCursorAccuracy,
  verifyRenderedCursorPixels,
} from '../src/review-video.mjs';
import { computeFrameScene, screenToRender } from '../src/remotion/layout.mjs';
import { reviewRun, reviewVideo as reviewVideoFromReview } from '../src/review.mjs';
import * as rootApi from '../src/index.mjs';
import { hash } from '../src/run.mjs';

const exec = promisify(execFile);
const CLI_PATH = resolve(import.meta.dirname, '../src/cli.mjs');

async function runFfmpeg(args) {
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    timeout: 60000,
    maxBuffer: 10e6,
  });
}

function makeFixtureTimeline({
  video = 'dynamic.mp4',
  width = 320,
  height = 180,
  fps = 30,
  duration = 2,
  cameraKeyframes,
} = {}) {
  const eventTrack = {
    version: 1,
    captureMode: 'headless',
    viewport: { width, height, deviceScaleFactor: 1 },
    video: { file: video, width, height, fps, duration, frames: Math.round(fps * duration) },
    events: [
      { t: 0.0, type: 'pointermove', x: 80, y: 60 },
      { t: 0.2, type: 'step', index: 0, label: 'Initial state' },
      { t: 0.5, type: 'pointermove', x: 160, y: 90 },
      { t: 1.0, type: 'pointerdown', x: 160, y: 90, button: 'left' },
      { t: 1.0, type: 'step', index: 1, label: 'Click target' },
      { t: 1.1, type: 'pointerup', x: 160, y: 90, button: 'left' },
      { t: 1.7, type: 'pointermove', x: 220, y: 120 },
      { t: 1.7, type: 'step', index: 2, label: 'Final state' },
    ],
  };

  return compileTimeline({
    take: { video, eventTrack: 'event-track.json' },
    eventTrack,
    recipe: {
      stage: {
        width: width + 80,
        height: height + 60,
        padding: 30,
        background: { type: 'solid', color: '#0f172a' },
      },
      window: { frame: 'none', width, height },
      camera: {
        outputWidth: width,
        outputHeight: height,
        keyframes: cameraKeyframes ?? [
          { t: 0, x: (width + 80) / 2, y: (height + 60) / 2, zoom: 1, easing: 'linear' },
          { t: 1.0, x: (width + 80) / 2, y: (height + 60) / 2, zoom: 1.25, easing: 'ease-in-out' },
          { t: 2.0, x: (width + 80) / 2, y: (height + 60) / 2, zoom: 1, easing: 'ease-out' },
        ],
      },
      overlays: { cursor: { enabled: true, style: 'macos' } },
      outputs: ['web-loop'],
    },
  });
}

test('reviewVideo is wired into src/review.mjs and src/index.mjs', () => {
  assert.equal(reviewVideoFromReview, reviewVideo);
  assert.equal(rootApi.reviewVideo, reviewVideo);
  assert.equal(rootApi.locateCursorMarker, locateCursorMarker);
  assert.equal(rootApi.verifyCursorAccuracy, verifyCursorAccuracy);
  assert.equal(DEFAULT_CURSOR_THRESHOLD_PX, 2);
});

test('reviewVideo passes a valid dynamic video and emits stills, contact sheet, and JSON report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-valid-'));
  try {
    const video = join(dir, 'dynamic.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video,
    ]);

    const timeline = makeFixtureTimeline({ video });
    const outDir = join(dir, 'review-out');
    const report = await reviewVideo({ video, timeline, outDir });

    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
    assert.equal(report.version, 1);
    assert.equal(report.findings.length, 0);
    assert.equal(report.multimodal.enabled, false);
    assert.equal(report.multimodal.ran, false);

    assert.equal(report.metrics.width, 320);
    assert.equal(report.metrics.height, 180);
    assert.equal(report.metrics.frames, 60);
    assert.ok(report.metrics.duration >= 1.9 && report.metrics.duration <= 2.1);
    assert.ok(report.metrics.fps >= 29 && report.metrics.fps <= 31);
    assert.equal(report.metrics.codec, 'h264');
    assert.ok(report.metrics.fileSizeBytes > 0);
    assert.equal(report.metrics.frameTiming.gaps.length, 0);
    assert.equal(report.metrics.freeze.segments.length, 0);
    assert.equal(report.metrics.black.segments.length, 0);

    // Per-step stills (3 steps in timeline)
    assert.equal(report.artifacts.stills.length, 3);
    for (const still of report.artifacts.stills) {
      await access(still.file);
      assert.equal(still.width, 320);
      assert.equal(still.height, 180);
    }

    // Contact sheet PNG
    assert.ok(report.artifacts.contactSheet);
    await access(report.artifacts.contactSheet.file);
    const sheetMeta = await sharp(report.artifacts.contactSheet.file).metadata();
    assert.equal(sheetMeta.format, 'png');
    assert.equal(sheetMeta.width, report.artifacts.contactSheet.width);
    assert.equal(sheetMeta.height, report.artifacts.contactSheet.height);
    assert.equal(report.artifacts.contactSheet.count, 3);

    // Persisted JSON report
    assert.ok(report.artifacts.report);
    const persisted = JSON.parse(await readFile(report.artifacts.report, 'utf8'));
    assert.equal(persisted.ok, true);
    assert.equal(persisted.metrics.frames, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reviewVideo fails frozen video, black video, and capture-gap video with machine-readable findings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-defects-'));
  try {
    const frozenVideo = join(dir, 'frozen.mp4');
    const blackVideo = join(dir, 'black.mp4');
    const gapVideo = join(dir, 'gap.mp4');

    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'color=c=0x2563eb:s=320x180:r=30:d=2',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', frozenVideo,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=2',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', blackVideo,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2',
        '-vf', "select='not(between(n,20,34))'",
        '-fps_mode', 'vfr', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', gapVideo,
      ]),
    ]);

    const frozenReport = await reviewVideo({
      video: frozenVideo,
      outDir: join(dir, 'out-frozen'),
    });
    assert.equal(frozenReport.ok, false);
    assert.equal(frozenReport.checks.find((c) => c.name === 'freeze-frames')?.ok, false);
    assert.equal(frozenReport.checks.find((c) => c.name === 'black-frames')?.ok, true);
    assert.ok(frozenReport.findings.some((f) => f.category === 'freeze-frame' && f.severity === 'error'));
    assert.ok(frozenReport.metrics.freeze.totalFrozenSeconds >= 1.0);

    const blackReport = await reviewVideo({
      video: blackVideo,
      outDir: join(dir, 'out-black'),
    });
    assert.equal(blackReport.ok, false);
    assert.equal(blackReport.checks.find((c) => c.name === 'black-frames')?.ok, false);
    assert.ok(blackReport.findings.some((f) => f.category === 'black-frame' && f.severity === 'error'));
    assert.ok(blackReport.metrics.black.totalBlackSeconds >= 1.5);

    const gapReport = await reviewVideo({
      video: gapVideo,
      outDir: join(dir, 'out-gap'),
    });
    assert.equal(gapReport.ok, false);
    assert.equal(gapReport.checks.find((c) => c.name === 'capture-gaps')?.ok, false);
    assert.ok(gapReport.metrics.frameTiming.gaps.length >= 1);
    assert.ok(gapReport.metrics.frameTiming.totalMissedFrames >= 10);
    assert.ok(gapReport.findings.some((f) => f.category === 'capture-gap' && f.severity === 'error'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reviewVideo fails when camera viewport leaves stage bounds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-camera-'));
  try {
    const video = join(dir, 'dynamic.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video,
    ]);

    const timeline = makeFixtureTimeline({ video, duration: 1.5 });
    // Force keyframe 1 far to the top-left so camera rect [50-160..50+160] leaves stage [0..400].
    timeline.camera.keyframes[1] = { t: 0.75, x: 50, y: 50, zoom: 1, easing: 'ease-in-out' };

    const report = await reviewVideo({ video, timeline, outDir: join(dir, 'out') });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.name === 'camera-bounds')?.ok, false);
    assert.ok(report.metrics.camera.violations > 0);
    assert.ok(report.findings.some((f) => f.category === 'camera-bounds' && /leaves stage/i.test(f.message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor accuracy check verifies geometric samples and real image-based marker localization within 2 px', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-cursor-'));
  try {
    // 1. Direct unit test of locateCursorMarker (color marker & cleanImage diff modes)
    const cleanBuf = await sharp({
      create: { width: 120, height: 80, channels: 3, background: { r: 20, g: 30, b: 40 } },
    })
      .png()
      .toBuffer();
    const markerBuf = await sharp({
      create: { width: 120, height: 80, channels: 3, background: { r: 20, g: 30, b: 40 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 9, height: 9, channels: 3, background: { r: 255, g: 0, b: 255 } },
          })
            .png()
            .toBuffer(),
          left: 46,
          top: 26,
        },
      ])
      .png()
      .toBuffer();

    const byColor = await locateCursorMarker(markerBuf, { color: '#ff00ff' });
    assert.equal(byColor.found, true);
    assert.equal(byColor.x, 50);
    assert.equal(byColor.y, 30);

    const byTopLeft = await locateCursorMarker(markerBuf, { color: '#ff00ff', anchor: 'top-left' });
    assert.equal(byTopLeft.found, true);
    assert.equal(byTopLeft.x, 46);
    assert.equal(byTopLeft.y, 26);

    const byDiff = await locateCursorMarker(markerBuf, { cleanImage: cleanBuf });
    assert.equal(byDiff.found, true);
    assert.equal(byDiff.x, 50);
    assert.equal(byDiff.y, 30);

    // 2. Pure geometric/sample verifier
    const timeline = makeFixtureTimeline({
      duration: 1.5,
      cameraKeyframes: [
        { t: 0, x: 200, y: 120, zoom: 1, easing: 'linear' },
        { t: 1.5, x: 200, y: 120, zoom: 1, easing: 'linear' },
      ],
    });
    const expectedAtHalf = projectViewportToScreen(160, 90, timeline, 0.5);

    const passGeo = verifyCursorAccuracy({
      timeline,
      cursorSamples: [{ t: 0.5, x: expectedAtHalf.x + 1.2, y: expectedAtHalf.y - 1.2 }],
      thresholdPx: 2,
    });
    assert.equal(passGeo.ok, true);
    assert.ok(passGeo.maxErrorPx <= 2);

    const failGeo = verifyCursorAccuracy({
      timeline,
      cursorSamples: [{ t: 0.5, x: expectedAtHalf.x + 4.5, y: expectedAtHalf.y }],
      thresholdPx: 2,
    });
    assert.equal(failGeo.ok, false);
    assert.equal(failGeo.violations.length, 1);
    assert.ok(failGeo.maxErrorPx > 2);

    // Event-track alignment when drag coexists with interior minimum-jerk pointermove samples
    const dragEventTrack = {
      version: 1,
      captureMode: 'headless',
      viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
      video: { file: 'drag.mp4', width: 320, height: 180, fps: 30, duration: 1.0, frames: 30 },
      events: [
        { t: 0.1, type: 'drag', from: [40, 50], to: [200, 120], duration: 0.35 },
        { t: 0.11, type: 'pointerdown', x: 40, y: 50, button: 'left' },
        { t: 0.28, type: 'pointermove', x: 112, y: 84 },
        { t: 0.48, type: 'pointermove', x: 200, y: 120 },
        { t: 0.51, type: 'pointerup', x: 200, y: 120, button: 'left' },
      ],
    };
    const dragTimeline = compileTimeline({ eventTrack: dragEventTrack });
    const dragAlign = verifyCursorAccuracy({ timeline: dragTimeline, eventTrack: dragEventTrack });
    assert.equal(dragAlign.ok, true);
    assert.equal(dragAlign.mode, 'event-track-alignment');
    assert.equal(dragAlign.maxErrorPx, 0);

    // 3. End-to-end video cursor marker check (accurate marker passes, 10px drifted marker fails)
    const accurateVideo = join(dir, 'cursor-accurate.mp4');
    const driftedVideo = join(dir, 'cursor-drifted.mp4');
    const bx = Math.round(expectedAtHalf.x - 5);
    const by = Math.round(expectedAtHalf.y - 5);

    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
        '-vf', `hue=s=0,drawbox=x=${bx}:y=${by}:w=11:h=11:color=0xff00ff:t=fill`,
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '10', accurateVideo,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
        '-vf', `hue=s=0,drawbox=x=${bx + 10}:y=${by}:w=11:h=11:color=0xff00ff:t=fill`,
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '10', driftedVideo,
      ]),
    ]);

    const accurateReport = await reviewVideo({
      video: accurateVideo,
      timeline,
      outDir: join(dir, 'out-acc'),
      cursorDetection: { color: '#ff00ff', tolerance: 45, timestamps: [0.5] },
    });
    assert.equal(accurateReport.ok, true, JSON.stringify(accurateReport.findings, null, 2));
    assert.equal(accurateReport.checks.find((c) => c.name === 'cursor-accuracy')?.ok, true);
    assert.ok(accurateReport.metrics.cursor.maxErrorPx <= 2);

    const driftedReport = await reviewVideo({
      video: driftedVideo,
      timeline,
      outDir: join(dir, 'out-drift'),
      cursorDetection: { color: '#ff00ff', tolerance: 45, timestamps: [0.5] },
    });
    assert.equal(driftedReport.ok, false);
    assert.equal(driftedReport.checks.find((c) => c.name === 'cursor-accuracy')?.ok, false);
    assert.ok(driftedReport.metrics.cursor.maxErrorPx >= 8);
    assert.ok(driftedReport.findings.some((f) => f.category === 'cursor-accuracy' && /drift/i.test(f.message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reviewVideo generates per-step baseline diffs and flags visual regressions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-baseline-'));
  try {
    const videoA = join(dir, 'video-a.mp4');
    const videoB = join(dir, 'video-b.mp4');
    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', videoA,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
        '-vf', 'hue=h=180',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', videoB,
      ]),
    ]);

    const timeline = makeFixtureTimeline({ video: videoA, duration: 1.5 });
    const approvedOut = join(dir, 'approved');
    const initial = await reviewVideo({ video: videoA, timeline, outDir: approvedOut });
    assert.equal(initial.ok, true);

    const baselineStillsDir = join(approvedOut, 'stills');

    // Same video against approved baseline passes
    const matching = await reviewVideo({
      video: videoA,
      timeline,
      baseline: baselineStillsDir,
      outDir: join(dir, 'review-match'),
    });
    assert.equal(matching.ok, true);
    assert.equal(matching.checks.find((c) => c.name === 'baseline-diff')?.ok, true);
    assert.equal(matching.metrics.baseline.compared, 3);
    assert.equal(matching.metrics.baseline.mismatches, 0);
    assert.equal(matching.artifacts.diffs.length, 3);
    await access(matching.artifacts.diffs[0].diffFile);

    // Visually altered video against approved baseline fails with diff PNGs & findings
    const diverged = await reviewVideo({
      video: videoB,
      timeline,
      baseline: baselineStillsDir,
      outDir: join(dir, 'review-diverged'),
    });
    assert.equal(diverged.ok, false);
    assert.equal(diverged.checks.find((c) => c.name === 'baseline-diff')?.ok, false);
    assert.ok(diverged.metrics.baseline.mismatches > 0);
    assert.ok(diverged.metrics.baseline.maxChangedRatio > 0.1);
    assert.ok(diverged.findings.some((f) => f.category === 'baseline-diff' && f.severity === 'error'));
    await access(diverged.artifacts.diffs[0].diffFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multimodal review hook never runs implicitly and merges structured findings when enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-mm-'));
  try {
    const video = join(dir, 'dynamic.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video,
    ]);
    const timeline = makeFixtureTimeline({ video, duration: 1.5 });

    // 1. Disabled explicitly: reviewFn must NEVER be called
    let calledWhenDisabled = false;
    const disabledReport = await reviewVideo({
      video,
      timeline,
      outDir: join(dir, 'out-disabled'),
      multimodal: {
        enabled: false,
        reviewFn: async () => {
          calledWhenDisabled = true;
          return { findings: [{ severity: 'error', category: 'bug', message: 'should not run' }] };
        },
      },
    });
    assert.equal(calledWhenDisabled, false);
    assert.equal(disabledReport.ok, true);
    assert.equal(disabledReport.multimodal.ran, false);

    // 2. Enabled with Gemini provider but no credentials: skipped cleanly, no network call
    const prevGeminiKey = process.env.GEMINI_API_KEY;
    const prevGoogleKey = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    let fetchCalled = false;
    try {
      const noCredsReport = await reviewVideo({
        video,
        timeline,
        outDir: join(dir, 'out-nocreds'),
        multimodal: {
          enabled: true,
          provider: 'gemini',
          fetchImpl: async () => {
            fetchCalled = true;
            throw Error('fetch should not be called without credentials');
          },
        },
      });
      assert.equal(fetchCalled, false);
      assert.equal(noCredsReport.multimodal.enabled, true);
      assert.equal(noCredsReport.multimodal.ran, false);
      assert.equal(noCredsReport.multimodal.skipped, true);
      assert.match(noCredsReport.multimodal.reason, /API key/i);
    } finally {
      if (prevGeminiKey !== undefined) process.env.GEMINI_API_KEY = prevGeminiKey;
      if (prevGoogleKey !== undefined) process.env.GOOGLE_API_KEY = prevGoogleKey;
    }

    // 3. Enabled with custom reviewFn returning warning (passes) vs error (fails)
    let capturedPayload = null;
    const warnReport = await reviewVideo({
      video,
      timeline,
      outDir: join(dir, 'out-warn'),
      multimodal: {
        enabled: true,
        reviewFn: async (payload) => {
          capturedPayload = payload;
          return {
            summary: 'Minor spacing observation',
            findings: [
              {
                severity: 'warning',
                category: 'zoom-timing',
                timestamp: 1.0,
                message: 'Zoom settles slightly after click',
              },
            ],
          };
        },
      },
    });
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.video, video);
    assert.ok(capturedPayload.contactSheet.endsWith('contact-sheet.png'));
    assert.equal(capturedPayload.stills.length, 3);
    assert.equal(capturedPayload.timelineSummary.steps.length, 3);
    assert.equal(warnReport.ok, true);
    assert.equal(warnReport.multimodal.ran, true);
    assert.deepEqual(warnReport.findings, [
      {
        source: 'multimodal',
        severity: 'warning',
        category: 'zoom-timing',
        timestamp: 1.0,
        message: 'Zoom settles slightly after click',
      },
    ]);

    const errorReport = await reviewVideo({
      video,
      timeline,
      outDir: join(dir, 'out-err'),
      multimodal: {
        enabled: true,
        reviewFn: async () => ({
          findings: [
            {
              severity: 'error',
              category: 'clipped-text',
              timestamp: 0.2,
              message: 'Header title is clipped on right edge',
            },
          ],
        }),
      },
    });
    assert.equal(errorReport.ok, false);
    assert.equal(errorReport.checks.find((c) => c.name === 'multimodal')?.ok, false);
    assert.ok(
      errorReport.findings.some(
        (f) => f.source === 'multimodal' && f.severity === 'error' && f.category === 'clipped-text'
      )
    );

    // 4. Gemini provider adapter with mocked fetchImpl (verifying x-goog-api-key header, no key in URL)
    let geminiRequestUrl = null;
    let geminiRequestHeaders = null;
    let geminiRequestBody = null;
    const geminiReport = await reviewVideo({
      video,
      timeline,
      outDir: join(dir, 'out-gemini'),
      multimodal: {
        enabled: true,
        provider: 'gemini',
        apiKey: 'test-key-not-real',
        fetchImpl: async (url, init) => {
          geminiRequestUrl = url;
          geminiRequestHeaders = init.headers;
          geminiRequestBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          ok: true,
                          summary: 'Clean demo render',
                          findings: [
                            {
                              severity: 'info',
                              category: 'composition',
                              message: 'Framing looks balanced',
                            },
                          ],
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
          };
        },
      },
    });
    assert.equal(geminiReport.ok, true);
    assert.equal(geminiReport.multimodal.ran, true);
    assert.equal(geminiReport.multimodal.provider, 'gemini');
    assert.doesNotMatch(geminiRequestUrl, /key=/i);
    assert.doesNotMatch(geminiRequestUrl, /test-key-not-real/);
    assert.equal(geminiRequestHeaders['x-goog-api-key'], 'test-key-not-real');
    assert.ok(geminiRequestBody.contents[0].parts.some((p) => p.inline_data?.mime_type === 'image/png'));
    assert.ok(geminiReport.findings.some((f) => f.source === 'multimodal' && f.category === 'composition'));

    // 5. Empty Gemini response is treated as skipped (not pass)
    const emptyReplyReport = await reviewVideo({
      video,
      timeline,
      multimodal: {
        enabled: true,
        provider: 'gemini',
        apiKey: 'test-key-not-real',
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: '   ' }] } }] }),
        }),
      },
    });
    assert.equal(emptyReplyReport.ok, true);
    assert.equal(emptyReplyReport.multimodal.ran, false);
    assert.equal(emptyReplyReport.multimodal.skipped, true);
    assert.equal(emptyReplyReport.checks.find((c) => c.name === 'multimodal')?.skipped, true);

    // 6. Malformed non-JSON Gemini response fails multimodal check without throwing away deterministic report
    const malformedReport = await reviewVideo({
      video,
      timeline,
      outDir: join(dir, 'out-malformed'),
      multimodal: {
        enabled: true,
        provider: 'gemini',
        apiKey: 'test-key-not-real',
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '```json\n{ truncated...' }] } }],
          }),
        }),
      },
    });
    assert.equal(malformedReport.ok, false);
    assert.equal(malformedReport.checks.find((c) => c.name === 'ffprobe')?.ok, true);
    assert.equal(malformedReport.checks.find((c) => c.name === 'multimodal')?.ok, false);
    assert.equal(malformedReport.artifacts.stills.length, 3);
    assert.ok(malformedReport.findings.some((f) => f.category === 'multimodal-parse' && f.severity === 'error'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI review --video exits 0 on valid video, non-zero on broken video, and reviewRun supports timeline videos', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-cli-'));
  try {
    const validVideo = join(dir, 'valid.mp4');
    const blackVideo = join(dir, 'black.mp4');
    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', validVideo,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=1.5',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', blackVideo,
      ]),
    ]);

    const timeline = makeFixtureTimeline({ video: validVideo, duration: 1.5 });
    const timelinePath = join(dir, 'timeline.json');
    await writeFile(timelinePath, JSON.stringify(timeline, null, 2));

    // CLI passing run
    const passOutDir = join(dir, 'cli-pass');
    const { stdout: passStdout } = await exec('node', [
      CLI_PATH, 'review',
      '--video', validVideo,
      '--timeline', timelinePath,
      '--out-dir', passOutDir,
    ]);
    const cliPass = JSON.parse(passStdout);
    assert.equal(cliPass.ok, true);
    await access(cliPass.artifacts.contactSheet.file);

    // CLI failing run exits non-zero
    let failedExitCode = 0;
    let failedStdout = '';
    try {
      await exec('node', [
        CLI_PATH, 'review',
        '--video', blackVideo,
        '--out-dir', join(dir, 'cli-fail'),
      ]);
    } catch (error) {
      failedExitCode = error.code;
      failedStdout = error.stdout;
    }
    assert.equal(failedExitCode, 1);
    const cliFail = JSON.parse(failedStdout);
    assert.equal(cliFail.ok, false);
    assert.equal(cliFail.checks.find((c) => c.name === 'black-frames')?.ok, false);

    // reviewRun manifest integration for timeline-backed video
    const validBytes = await readFile(validVideo);
    const manifestPath = join(dir, 'run.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        status: 'complete',
        recipes: {
          demo: {
            status: 'complete',
            file: 'valid.mp4',
            timeline: 'timeline.json',
            width: 320,
            height: 180,
            frames: 45,
            duration: 1.5,
            sha256: hash(validBytes),
          },
        },
      })
    );

    const runResult = await reviewRun({ manifest: manifestPath, outDir: join(dir, 'manifest-review') });
    assert.equal(runResult.ok, true, JSON.stringify(runResult.checks, null, 2));
    assert.ok(runResult.videos?.demo);
    assert.equal(runResult.videos.demo.ok, true);
    await access(runResult.videos.demo.artifacts.contactSheet.file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('1440x900 camera rendered to 2560x1440 matches screenToRender between layout.mjs and review-video.mjs with 0 px error', () => {
  const eventTrack = {
    version: 1,
    captureMode: 'quality',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    video: { file: 'take.mp4', width: 2880, height: 1800, fps: 60, duration: 2, frames: 120 },
    events: [
      { t: 0, type: 'pointermove', x: 100, y: 100 },
      { t: 1, type: 'pointermove', x: 1340, y: 800 },
    ],
  };
  const timeline = compileTimeline({
    eventTrack,
    recipe: {
      stage: { width: 1680, height: 1140, padding: 120 },
      window: { frame: 'macos', width: 1440, height: 900 },
      camera: { outputWidth: 1440, outputHeight: 900 },
      outputs: ['youtube-master'],
    },
  });

  // 1440x900 -> 2560x1440 uses uniform scale = min(2560/1440, 1440/900) = 1.6 and pillarbox offsetX = 128
  const mapped = screenToRender(100, 100, 1440, 900, 2560, 1440);
  assert.equal(mapped.scale, 1.6);
  assert.equal(mapped.offsetX, 128);
  assert.equal(mapped.offsetY, 0);
  assert.equal(mapped.x, 288);
  assert.equal(mapped.y, 160);

  const sceneStart = computeFrameScene(timeline, { frame: 0, fps: 60, width: 2560, height: 1440 });
  const sceneEnd = computeFrameScene(timeline, { frame: 60, fps: 60, width: 2560, height: 1440 });

  const accuracy = verifyCursorAccuracy({
    timeline,
    cursorSamples: [
      { t: 0, x: sceneStart.overlays.cursor.x, y: sceneStart.overlays.cursor.y },
      { t: 1, x: sceneEnd.overlays.cursor.x, y: sceneEnd.overlays.cursor.y },
    ],
    outputWidth: 2560,
    outputHeight: 1440,
    fps: 60,
    thresholdPx: 2,
  });
  assert.equal(accuracy.ok, true);
  assert.equal(accuracy.checked, true);
  assert.equal(accuracy.skipped, false);
  assert.equal(accuracy.maxErrorPx, 0);
});

test('non-pixel cursor modes report checked=false/skipped=true, frame-boundary rounding avoids inter-frame drift, and drag end-samples match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-cursor-honesty-'));
  try {
    // 1. Non-pixel modes (projection-self-check & event-track-alignment) report checked: false, skipped: true
    const eventTrack = {
      version: 1,
      captureMode: 'headless',
      viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
      video: { file: 'move.mp4', width: 320, height: 180, fps: 10, duration: 1, frames: 10 },
      events: [
        { t: 0.0, type: 'pointermove', x: 20, y: 90 },
        // Fast drag with real pointerdown + pointermove + pointerup extending slightly past drag.duration
        { t: 0.2, type: 'drag', from: [20, 90], to: [220, 90], duration: 0.4 },
        { t: 0.21, type: 'pointerdown', x: 20, y: 90, button: 'left' },
        { t: 0.5, type: 'pointermove', x: 170, y: 90 },
        { t: 0.65, type: 'pointermove', x: 220, y: 90 },
        { t: 0.68, type: 'pointerup', x: 220, y: 90, button: 'left' },
      ],
    };
    const timeline = compileTimeline({
      eventTrack,
      recipe: {
        stage: { width: 320, height: 180, padding: 0 },
        window: { frame: 'none', width: 320, height: 180 },
        camera: { outputWidth: 320, outputHeight: 180 },
      },
    });

    const selfCheck = verifyCursorAccuracy({ timeline });
    assert.equal(selfCheck.mode, 'projection-self-check');
    assert.equal(selfCheck.ok, true);
    assert.equal(selfCheck.checked, false);
    assert.equal(selfCheck.skipped, true);

    const alignCheck = verifyCursorAccuracy({ timeline, eventTrack });
    assert.equal(alignCheck.mode, 'event-track-alignment');
    assert.equal(alignCheck.ok, true);
    assert.equal(alignCheck.checked, false);
    assert.equal(alignCheck.skipped, true);
    assert.equal(alignCheck.maxErrorPx, 0);

    // 2. Frame-boundary rounding: 10 fps video where marker moves X = 20 + 200 * (N / 10)
    // Sampled at non-boundary t = 0.58s -> floor(0.58 * 10) / 10 = 0.5s (frame 5, X = 120; at 0.58s X would be 136 -> 16px error without rounding!)
    assert.equal(snapToFrameBoundary(0.58, 10), 0.5);
    const fastTimeline = compileTimeline({
      eventTrack: {
        version: 1,
        captureMode: 'headless',
        viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
        video: { file: 'fast.mp4', width: 320, height: 180, fps: 10, duration: 1, frames: 10 },
        events: [
          { t: 0.0, type: 'pointermove', x: 20, y: 90 },
          { t: 1.0, type: 'pointermove', x: 220, y: 90 },
        ],
      },
      recipe: {
        stage: { width: 320, height: 180, padding: 0 },
        window: { frame: 'none', width: 320, height: 180 },
        camera: { outputWidth: 320, outputHeight: 180 },
      },
    });

    for (let n = 0; n < 10; n += 1) {
      const cx = 20 + n * 20;
      const marker = await sharp({
        create: { width: 9, height: 9, channels: 3, background: { r: 255, g: 0, b: 255 } },
      }).png().toBuffer();
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 20, g: 30 + n * 5, b: 50 } },
      })
        .composite([{ input: marker, left: cx - 4, top: 86 }])
        .png()
        .toFile(join(dir, `f-${n}.png`));
    }
    const fastVideo = join(dir, 'fast.mp4');
    await runFfmpeg([
      '-framerate', '10', '-i', join(dir, 'f-%d.png'),
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '10', fastVideo,
    ]);

    const nonPixelReview = await reviewVideo({ video: fastVideo, timeline: fastTimeline });
    const cursorCheck = nonPixelReview.checks.find((c) => c.name === 'cursor-accuracy');
    assert.equal(nonPixelReview.ok, true);
    assert.equal(cursorCheck?.checked, false);
    assert.equal(cursorCheck?.skipped, true);

    const roundedReview = await reviewVideo({
      video: fastVideo,
      timeline: fastTimeline,
      cursorDetection: { color: '#ff00ff', tolerance: 45, searchRadius: 24, timestamps: [0.58] },
    });
    assert.equal(roundedReview.ok, true, JSON.stringify(roundedReview.findings, null, 2));
    assert.equal(roundedReview.metrics.cursor.checked, true);
    assert.equal(roundedReview.metrics.cursor.skipped, false);
    assert.ok(roundedReview.metrics.cursor.maxErrorPx <= 2);

    // 3. CLI --cursor-detection and --cursor-threshold validation
    const fastTimelineFile = join(dir, 'fast-timeline.json');
    await writeFile(fastTimelineFile, JSON.stringify(fastTimeline, null, 2));
    const { stdout: cliCursorOut } = await exec('node', [
      CLI_PATH, 'review',
      '--video', fastVideo,
      '--timeline', fastTimelineFile,
      '--cursor-detection', '#ff00ff',
    ]);
    const cliCursorReport = JSON.parse(cliCursorOut);
    assert.equal(cliCursorReport.ok, true);
    assert.equal(cliCursorReport.metrics.cursor.checked, true);

    await assert.rejects(
      exec('node', [CLI_PATH, 'review', '--video', fastVideo, '--cursor-threshold', '0']),
      /positive finite number/
    );
    await assert.rejects(
      exec('node', [CLI_PATH, 'review', '--video', fastVideo, '--cursor-threshold', 'not-a-number']),
      /positive finite number/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reviewVideo catches CFR-resampled raw capture gaps, excuses intentional quiet pauses outside active windows, diffs baseline without outDir, and reviewRun checks manifest videos without timeline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-rawgaps-pause-'));
  try {
    // 1. CFR video whose PTS deltas are uniform, but eventTrack.video.capture recorded raw screencast stalls
    const cfrVideo = join(dir, 'cfr.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', cfrVideo,
    ]);

    const stalledEventTrack = {
      version: 1,
      captureMode: 'quality',
      startedAt: '2026-11-22T00:00:00.000Z',
      viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
      video: {
        file: 'cfr.mp4',
        width: 320,
        height: 180,
        fps: 30,
        encodedFps: 30,
        duration: 1.5,
        frames: 45,
        capture: {
          rawFrames: 18,
          firstFrameAt: 0,
          lastFrameAt: 1.46,
          elapsedDuration: 1.5,
          rawFps: 12,
          maxGapMs: 420,
          gapsOver2Frames: 3,
          truncated: false,
        },
      },
      events: [{ t: 0, type: 'pointermove', x: 160, y: 90 }],
    };

    const rawGapReport = await reviewVideo({ video: cfrVideo, eventTrack: stalledEventTrack });
    assert.equal(rawGapReport.ok, false);
    assert.equal(rawGapReport.checks.find((c) => c.name === 'capture-gaps')?.ok, false);
    assert.ok(rawGapReport.findings.some((f) => f.category === 'capture-gap' && /raw capture/i.test(f.message)));

    // 2. Intentional quiet pause (1.3s static hold between active segments) passes with timeline, while frozen active segment fails
    const pauseVideo = join(dir, 'quiet-pause.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=0.6',
      '-f', 'lavfi', '-i', 'color=c=0x1e293b:s=320x180:r=30:d=1.3',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=0.6',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', pauseVideo,
    ]);

    const pauseEventTrack = {
      version: 1,
      captureMode: 'headless',
      viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
      video: { file: 'quiet-pause.mp4', width: 320, height: 180, fps: 30, duration: 2.5, frames: 75 },
      events: [
        { t: 0.1, type: 'pointerdown', x: 80, y: 90, button: 'left' },
        { t: 0.2, type: 'pointerup', x: 80, y: 90, button: 'left' },
        { t: 0.7, type: 'step', index: 0, label: 'Read static modal' },
        { t: 2.15, type: 'pointerdown', x: 200, y: 90, button: 'left' },
        { t: 2.25, type: 'pointerup', x: 200, y: 90, button: 'left' },
      ],
    };
    const pauseTimeline = compileTimeline({
      eventTrack: pauseEventTrack,
      recipe: {
        stage: { width: 320, height: 180, padding: 0 },
        window: { frame: 'none', width: 320, height: 180 },
        camera: { outputWidth: 320, outputHeight: 180 },
      },
    });

    const quietPauseReport = await reviewVideo({ video: pauseVideo, timeline: pauseTimeline });
    assert.equal(quietPauseReport.ok, true, JSON.stringify(quietPauseReport.checks, null, 2));
    assert.equal(quietPauseReport.checks.find((c) => c.name === 'freeze-frames')?.ok, true);
    assert.equal(quietPauseReport.metrics.freeze.quietPauseSegments.length, 1);
    assert.ok(quietPauseReport.findings.some((f) => f.category === 'freeze-pause' && f.severity === 'info'));

    // Without timeline/eventTrack, the same 1.3s static segment still fails freeze-frames
    const unscheduledFreezeReport = await reviewVideo({ video: pauseVideo });
    assert.equal(unscheduledFreezeReport.ok, false);
    assert.equal(unscheduledFreezeReport.checks.find((c) => c.name === 'freeze-frames')?.ok, false);

    // 3. Baseline diff WITHOUT outDir runs via ephemeral temp dir and catches regressions
    const baselinePrepDir = join(dir, 'baseline-prep');
    const timelineCfr = makeFixtureTimeline({ video: cfrVideo, duration: 1.5 });
    await reviewVideo({ video: cfrVideo, timeline: timelineCfr, outDir: baselinePrepDir });
    const baselineStills = join(baselinePrepDir, 'stills');

    const noOutDirMatch = await reviewVideo({ video: cfrVideo, timeline: timelineCfr, baseline: baselineStills });
    assert.equal(noOutDirMatch.ok, true);
    assert.equal(noOutDirMatch.metrics.baseline.checked, true);
    assert.equal(noOutDirMatch.metrics.baseline.compared, 3);

    const hueShiftedVideo = join(dir, 'shifted.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1.5',
      '-vf', 'hue=h=120',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', hueShiftedVideo,
    ]);
    const noOutDirFail = await reviewVideo({ video: hueShiftedVideo, timeline: timelineCfr, baseline: baselineStills });
    assert.equal(noOutDirFail.ok, false);
    assert.equal(noOutDirFail.checks.find((c) => c.name === 'baseline-diff')?.ok, false);

    // 4. reviewRun runs deterministic video checks even WITHOUT artifact.timeline and forwards --baseline / --out-dir
    const cfrBytes = await readFile(cfrVideo);
    const stalledTrackPath = join(dir, 'stalled-track.json');
    const stalledTrackText = JSON.stringify(stalledEventTrack, null, 2);
    await writeFile(stalledTrackPath, stalledTrackText);
    const manifestNoTimeline = join(dir, 'run-no-timeline.json');
    await writeFile(
      manifestNoTimeline,
      JSON.stringify({
        version: 1,
        status: 'complete',
        recipes: {
          rawTake: {
            status: 'complete',
            file: 'cfr.mp4',
            eventTrack: 'stalled-track.json',
            eventTrackSha256: hash(stalledTrackText),
            captureMode: 'quality',
            width: 320,
            height: 180,
            frames: 45,
            duration: 1.5,
            sha256: hash(cfrBytes),
          },
        },
      })
    );
    const manifestReview = await reviewRun({ manifest: manifestNoTimeline });
    assert.equal(manifestReview.ok, false);
    assert.ok(manifestReview.videos?.rawTake);
    assert.equal(manifestReview.checks.find((c) => c.name === 'rawTake:video:ffprobe')?.ok, true);
    assert.equal(manifestReview.checks.find((c) => c.name === 'rawTake:video:capture-gaps')?.ok, false);

    // 5. Motion-window-aware rawCapture: static pause gaps pass when activeMotionGapsOver2Frames === 0, while active-motion stalls fail
    const staticPauseTrack = {
      ...stalledEventTrack,
      video: {
        ...stalledEventTrack.video,
        capture: {
          rawFrames: 28,
          firstFrameAt: 0,
          lastFrameAt: 1.48,
          elapsedDuration: 1.5,
          rawFps: 18.67,
          maxGapMs: 620,
          gapsOver2Frames: 2,
          activeMotionWindows: [{ start: 0.1, end: 0.45 }, { start: 1.1, end: 1.45 }],
          activeMotionMaxGapMs: 18.4,
          activeMotionGapsOver2Frames: 0,
          truncated: false,
        },
      },
    };
    const pauseGapPass = await reviewVideo({ video: cfrVideo, eventTrack: staticPauseTrack });
    assert.equal(pauseGapPass.ok, true, JSON.stringify(pauseGapPass.checks, null, 2));
    assert.equal(pauseGapPass.checks.find((c) => c.name === 'capture-gaps')?.ok, true);
    assert.equal(pauseGapPass.metrics.rawCapture.rawFps, 18.67);
    assert.equal(pauseGapPass.metrics.rawCapture.maxGapMs, 620);
    assert.equal(pauseGapPass.metrics.rawCapture.activeMotionGapsOver2Frames, 0);

    const activeStallTrack = {
      ...staticPauseTrack,
      video: {
        ...staticPauseTrack.video,
        capture: {
          ...staticPauseTrack.video.capture,
          activeMotionMaxGapMs: 240,
          activeMotionGapsOver2Frames: 1,
        },
      },
    };
    const activeStallFail = await reviewVideo({ video: cfrVideo, eventTrack: activeStallTrack });
    assert.equal(activeStallFail.ok, false);
    assert.equal(activeStallFail.checks.find((c) => c.name === 'capture-gaps')?.ok, false);
    assert.ok(
      activeStallFail.findings.some(
        (f) => f.category === 'capture-gap' && /active-motion gap/i.test(f.message)
      )
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('automated pixel-level cursor verification (--verify-cursor & verifyRenderedCursorPixels) proves <= 2 px accuracy across 1x and zoomed/panned Remotion frames', async () => {
  assert.equal(rootApi.verifyRenderedCursorPixels, verifyRenderedCursorPixels);

  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-verify-cursor-'));
  try {
    // 1. Build a colorful dynamic take that even includes a magenta (#ff00ff) patch on screen
    // so clean-vs-marker localization proves robustness on ANY background.
    for (let i = 0; i < 12; i += 1) {
      const magentaBadge = await sharp({
        create: { width: 48, height: 32, channels: 3, background: { r: 255, g: 0, b: 255 } },
      })
        .png()
        .toBuffer();
      const rightCard = await sharp({
        create: { width: 120, height: 100, channels: 3, background: { r: 16, g: 165 + i * 2, b: 129 } },
      })
        .png()
        .toBuffer();
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 24 + i * 2, g: 40 + i, b: 85 } },
      })
        .composite([
          { input: magentaBadge, left: 16, top: 16 },
          { input: rightCard, left: 170, top: 40 },
        ])
        .png()
        .toFile(join(dir, `take-frame-${i}.png`));
    }

    const takeVideo = join(dir, 'take.mp4');
    await runFfmpeg([
      '-framerate', '12',
      '-i', join(dir, 'take-frame-%d.png'),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-crf', '14',
      takeVideo,
    ]);

    const eventTrack = {
      version: 1,
      captureMode: 'headless',
      viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
      video: { file: 'take.mp4', width: 320, height: 180, fps: 12, duration: 1.0, frames: 12 },
      events: [
        { t: 0.0, type: 'pointermove', x: 70, y: 80 },
        { t: 0.0, type: 'step', index: 0, label: 'Wide 1x overview', camera: 'wide' },
        { t: 0.42, type: 'pointermove', x: 220, y: 95 },
        { t: 0.5, type: 'pointerdown', x: 220, y: 95, button: 'left' },
        {
          t: 0.5,
          type: 'step',
          index: 1,
          label: 'Zoomed & panned click',
          target: [220, 95],
          camera: { zoom: 2.0, focus: 'target', lead: 0.25, hold: 0.25 },
        },
        { t: 0.58, type: 'pointerup', x: 220, y: 95, button: 'left' },
        { t: 0.9, type: 'pointermove', x: 160, y: 110 },
        { t: 0.9, type: 'step', index: 2, label: 'Return wide', camera: 'wide' },
      ],
    };

    const eventTrackPath = join(dir, 'event-track.json');
    await writeFile(eventTrackPath, JSON.stringify(eventTrack, null, 2));

    const timeline = compileTimeline({
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
          title: 'Zoom & Pan Verification',
          width: 320,
          height: 180,
        },
        camera: { outputWidth: 480, outputHeight: 270 },
        overlays: { cursor: { enabled: true, style: 'macos' } },
        outputs: ['web-loop'],
      },
    });
    const timelinePath = join(dir, 'timeline.json');
    await writeFile(timelinePath, JSON.stringify(timeline, null, 2));

    // Render real Remotion output MP4
    const { renderTimeline } = await import('../src/render-timeline.mjs');
    const renderedMp4 = join(dir, 'rendered.mp4');
    await renderTimeline({
      timeline: timelinePath,
      out: renderedMp4,
    });

    // 2. Default reviewVideo stays fast and marks cursor pixel check as skipped
    const fastDefaultReport = await reviewVideo({
      video: renderedMp4,
      timeline: timelinePath,
      eventTrack: eventTrackPath,
    });
    assert.equal(fastDefaultReport.ok, true, JSON.stringify(fastDefaultReport.checks, null, 2));
    assert.equal(fastDefaultReport.metrics.cursor.checked, false);
    assert.equal(fastDefaultReport.metrics.cursor.skipped, true);

    // 3. Direct verifyRenderedCursorPixels across 1x (t=0), mid-pan/zoom (t=0.34), zoomed 2x (t=0.5), and wide (t=0.9)
    const directPixelVerify = await verifyRenderedCursorPixels({
      timeline: timelinePath,
      sampleTimes: [0.0, 0.34, 0.5, 0.9],
      thresholdPx: 2,
      outDir: join(dir, 'direct-verify-stills'),
    });
    assert.equal(directPixelVerify.ok, true, JSON.stringify(directPixelVerify.violations, null, 2));
    assert.equal(directPixelVerify.checked, true);
    assert.equal(directPixelVerify.skipped, false);
    assert.equal(directPixelVerify.mode, 'pixel-marker');
    assert.equal(directPixelVerify.samplesChecked, 4);
    assert.ok(directPixelVerify.maxErrorPx <= 2, `expected <= 2 px, got ${directPixelVerify.maxErrorPx}`);

    // 4. CLI `screen-kit review --video ... --timeline ... --verify-cursor --out-dir ...`
    const cliReviewDir = join(dir, 'cli-verify-out');
    const { stdout: cliOut } = await exec('node', [
      CLI_PATH,
      'review',
      '--video', renderedMp4,
      '--timeline', timelinePath,
      '--event-track', eventTrackPath,
      '--verify-cursor',
      '--out-dir', cliReviewDir,
    ]);
    const cliReport = JSON.parse(cliOut);
    assert.equal(cliReport.ok, true, JSON.stringify(cliReport.findings, null, 2));
    assert.equal(cliReport.metrics.cursor.checked, true);
    assert.equal(cliReport.metrics.cursor.skipped, false);
    assert.equal(cliReport.metrics.cursor.mode, 'pixel-marker');
    assert.ok(cliReport.metrics.cursor.samplesChecked >= 3);
    assert.ok(cliReport.metrics.cursor.maxErrorPx <= 2);
    assert.equal(cliReport.cursor.checked, true);
    assert.equal(cliReport.cursor.mode, 'pixel-marker');
    assert.equal(cliReport.cursor.violations.length, 0);

    const persistedReview = JSON.parse(await readFile(join(cliReviewDir, 'review.json'), 'utf8'));
    assert.equal(persistedReview.metrics.cursor.checked, true);
    assert.equal(persistedReview.metrics.cursor.mode, 'pixel-marker');
    assert.ok(persistedReview.metrics.cursor.maxErrorPx <= 2);

    // 5. Corrupted timeline cursor coordinates (+12 px drift vs eventTrack) fail --verify-cursor
    const driftedTimeline = structuredClone(timeline);
    driftedTimeline.overlays.cursor.samples = driftedTimeline.overlays.cursor.samples.map((s) => ({
      ...s,
      x: s.x + 12,
    }));
    const driftedReport = await reviewVideo({
      video: renderedMp4,
      timeline: driftedTimeline,
      eventTrack,
      verifyCursor: { sampleTimes: [0.5], baseDir: dir },
    });
    assert.equal(driftedReport.ok, false);
    assert.equal(driftedReport.checks.find((c) => c.name === 'cursor-accuracy')?.ok, false);
    assert.equal(driftedReport.metrics.cursor.checked, true);
    assert.equal(driftedReport.metrics.cursor.mode, 'pixel-marker');
    assert.ok(driftedReport.metrics.cursor.maxErrorPx > 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
