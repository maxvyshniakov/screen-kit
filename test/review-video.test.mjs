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
  verifyCursorAccuracy,
} from '../src/review-video.mjs';
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

    // 4. Gemini provider adapter with mocked fetchImpl
    let geminiRequestBody = null;
    const geminiReport = await reviewVideo({
      video,
      timeline,
      outDir: join(dir, 'out-gemini'),
      multimodal: {
        enabled: true,
        provider: 'gemini',
        apiKey: 'test-key-not-real',
        fetchImpl: async (_url, init) => {
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
    assert.ok(geminiRequestBody.contents[0].parts.some((p) => p.inline_data?.mime_type === 'image/png'));
    assert.ok(geminiReport.findings.some((f) => f.source === 'multimodal' && f.category === 'composition'));
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
