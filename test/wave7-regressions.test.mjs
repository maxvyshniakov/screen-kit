import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { mixTimelineAudio, prepareMusicBed } from '../src/audio-mix.mjs';
import {
  alignWithGemini,
  buildNarrationTracks,
  encodePcm16Wav,
  narrateTimeline,
  probeAudio,
  reviewNarration,
  synthesizeWithKokoro,
} from '../src/narration.mjs';
import { publishYouTube } from '../src/publish.mjs';
import { computeOverlaysAtTime, projectViewportToRender } from '../src/remotion/layout.mjs';
import {
  renderTimeline,
  renderTimelineStills,
  resolveRenderTargets,
} from '../src/render-timeline.mjs';
import {
  reviewVideo,
  verifyRenderedCursorPixels,
} from '../src/review-video.mjs';
import { runPipeline } from '../src/run.mjs';
import { compileTimeline, validateTimeline } from '../src/timeline.mjs';
import { probeVideo, renderVideo } from '../src/video.mjs';

const exec = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = resolve(REPO_ROOT, 'src/cli.mjs');

async function runFfmpeg(args) {
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    timeout: 60000,
    maxBuffer: 10e6,
  });
}

function makeSinePcm16Buffer({ duration = 1.0, sampleRate = 24000, frequency = 440, amplitude = 0.25 } = {}) {
  const sampleCount = Math.round(duration * sampleRate);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2);
  }
  return pcm;
}

function makeSimpleEventTrack({
  video = 'take.mp4',
  viewport,
  startedAt = '2026-11-22T00:00:00.000Z',
  width = 320,
  height = 180,
  fps = 10,
  duration = 1.0,
  events,
} = {}) {
  const resolvedViewport = viewport ?? { width, height, deviceScaleFactor: 1 };
  const resolvedVideo =
    video && typeof video === 'object'
      ? video
      : {
          file: video,
          width: resolvedViewport.width ?? width,
          height: resolvedViewport.height ?? height,
          fps,
          duration,
          frames: Math.max(1, Math.round(duration * fps)),
        };
  return {
    version: 1,
    captureMode: 'headless',
    startedAt,
    viewport: resolvedViewport,
    video: resolvedVideo,
    events: events ?? [
      { t: 0.0, type: 'pointermove', x: 60, y: 90 },
      { t: 0.2, type: 'pointerdown', x: 100, y: 90, button: 'left' },
      { t: 0.3, type: 'pointerup', x: 100, y: 90, button: 'left' },
      { t: 0.6, type: 'key', key: 'k', modifiers: ['Meta'], action: 'press', duration: 0.3 },
      { t: 0.8, type: 'pointermove', x: 260, y: 90 },
    ],
  };
}

test('Finding #1: strict case-insensitive boolean CLI parser handles TRUE/yes/false/0/no and rejects invalid values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-bool-'));
  try {
    const video = join(dir, 'sample.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=1.0',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video,
    ]);

    const cleanEnv = { ...process.env };
    delete cleanEnv.YOUTUBE_ACCESS_TOKEN;
    delete cleanEnv.GEMINI_API_KEY;
    delete cleanEnv.GOOGLE_API_KEY;

    // --dry-run TRUE and --dry-run yes must evaluate to true (never silently false!)
    for (const truthy of ['TRUE', 'yes', 'YES', '1', 'true']) {
      const { stdout } = await exec(
        process.execPath,
        [CLI_PATH, 'publish', '--target', 'youtube', '--input', video, '--title', 'Bool Check', '--dry-run', truthy],
        { env: cleanEnv }
      );
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.dryRun, true, `expected --dry-run ${truthy} to enable dryRun`);
      assert.equal(parsed.uploaded, false);
    }

    // --dry-run false / no / 0 disables dryRun and hits OAuth token check
    for (const falsy of ['false', 'FALSE', 'no', '0']) {
      await assert.rejects(
        exec(
          process.execPath,
          [CLI_PATH, 'publish', '--target', 'youtube', '--input', video, '--title', 'Bool Check', '--dry-run', falsy],
          { env: cleanEnv }
        ),
        (err) => err.code === 1 && /OAuth access token/i.test(err.stderr)
      );
    }

    // --multimodal false disables multimodal review instead of calling provider "false"
    for (const falsy of ['false', 'FALSE', 'no', '0']) {
      const { stdout } = await exec(
        process.execPath,
        [CLI_PATH, 'review', '--video', video, '--multimodal', falsy],
        { env: cleanEnv }
      );
      const review = JSON.parse(stdout);
      assert.equal(review.ok, true);
      assert.equal(review.multimodal.enabled, false);
      assert.equal(review.multimodal.ran, false);
    }

    // Invalid boolean strings throw clear validation error
    for (const [cmdArgs, flagName] of [
      [['publish', '--target', 'youtube', '--input', video, '--title', 'Bad', '--dry-run', 'maybe'], '--dry-run'],
      [['review', '--video', video, '--verify-cursor', 'banana'], '--verify-cursor'],
      [['review', '--video', video, '--multimodal', 'sometimes'], '--multimodal'],
    ]) {
      await assert.rejects(
        exec(process.execPath, [CLI_PATH, ...cmdArgs], { env: cleanEnv }),
        (err) => err.code === 1 && err.stderr.includes(`Invalid boolean value for ${flagName}`)
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #2 & #17: path traversal guard on outputs[].id and renderTimelineStills, plus unique audio.tracks[].id', async () => {
  const base = compileTimeline({ eventTrack: makeSimpleEventTrack() });

  // Duplicate audio.tracks[].id rejected by validateTimeline
  const dupAudio = structuredClone(base);
  dupAudio.audio.tracks = [
    { id: 'dup-id', kind: 'sfx', src: 'a.wav', start: 0 },
    { id: 'dup-id', kind: 'sfx', src: 'b.wav', start: 0.5 },
  ];
  const dupRes = validateTimeline(dupAudio);
  assert.equal(dupRes.ok, false);
  assert.ok(dupRes.errors.some((e) => /audio\.tracks\[1\]\.id.*unique/i.test(e)));

  // Unsafe outputs[].id rejected by validateTimeline and resolveRenderTargets
  for (const badId of ['../escape', 'nested/out', 'nested\\out', 'bad\0id', 'foo..bar', '.dotstart', '-dash']) {
    const mutated = structuredClone(base);
    mutated.outputs = [{ id: badId, format: 'mp4', width: 320, height: 180, fps: 10 }];
    const v = validateTimeline(mutated);
    assert.equal(v.ok, false, `validateTimeline should reject outputs[].id="${badId}"`);

    assert.throws(
      () =>
        resolveRenderTargets({
          timeline: base,
          outDir: '/tmp/safe-renders',
          profiles: [{ id: badId, format: 'mp4', width: 320, height: 180, fps: 10 }],
        }),
      /output\.id/i,
      `resolveRenderTargets should reject profile spec id="${badId}"`
    );

    assert.throws(
      () =>
        resolveRenderTargets({
          timeline: base,
          out: '/tmp/safe-renders/single.mp4',
          profiles: [{ id: badId, format: 'mp4', width: 320, height: 180, fps: 10 }],
        }),
      /output\.id/i
    );
  }

  // renderTimelineStills rejects traversal/separator filenames and bad variant ids before launching Chrome
  for (const badFilename of ['../escape.png', 'sub/still.png', 'sub\\still.png', 'bad\0.png', 'a..b.png', '..']) {
    await assert.rejects(
      renderTimelineStills({
        timeline: base,
        outDir: '/tmp/safe-stills',
        requests: [{ frame: 0, filename: badFilename }],
      }),
      /must not contain|escapes base directory/i
    );
  }
  await assert.rejects(
    renderTimelineStills({
      timeline: base,
      variants: { '../bad': base },
      outDir: '/tmp/safe-stills',
      requests: [{ frame: 0, variant: '../bad' }],
    }),
    /variant/i
  );
});

test('Finding #3 & #13: --verify-cursor passes on 9:16 portrait shorts with smart-follow pan, outputScale dotRadius, and (0,0) SVG cursor tip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-shorts-cursor-'));
  const scratchDir = join(dir, 'scratch');
  try {
    // Create an animated 0.6s 320x180 @ 10fps take so smart-follow pans horizontally across contrasting colors
    for (let i = 0; i < 6; i += 1) {
      const leftCard = await sharp({
        create: { width: 120, height: 140, channels: 3, background: { r: 16, g: 165 + i * 3, b: 129 } },
      })
        .png()
        .toBuffer();
      const rightCard = await sharp({
        create: { width: 120, height: 140, channels: 3, background: { r: 234, g: 88 + i * 3, b: 12 } },
      })
        .png()
        .toBuffer();
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 25 + i * 2, g: 38 + i * 2, b: 78 } },
      })
        .composite([
          { input: leftCard, left: 20, top: 20 },
          { input: rightCard, left: 180, top: 20 },
        ])
        .png()
        .toFile(join(dir, `f-${i}.png`));
    }
    const takeVideo = join(dir, 'take.mp4');
    await renderVideo({ input: join(dir, 'f-%d.png'), output: takeVideo, fps: 10 });

    const eventTrack = makeSimpleEventTrack({
      video: 'take.mp4',
      width: 320,
      height: 180,
      fps: 10,
      duration: 0.6,
      events: [
        { t: 0.0, type: 'pointermove', x: 50, y: 90 },
        { t: 0.0, type: 'step', index: 0, label: 'Left card' },
        { t: 0.3, type: 'pointermove', x: 160, y: 90 },
        { t: 0.5, type: 'pointermove', x: 270, y: 90 },
        { t: 0.5, type: 'step', index: 1, label: 'Right card' },
      ],
    });
    const eventTrackPath = join(dir, 'event-track.json');
    await writeFile(eventTrackPath, JSON.stringify(eventTrack, null, 2));

    const timeline = compileTimeline({
      take: { video: 'take.mp4', eventTrack: 'event-track.json' },
      eventTrack,
      recipe: {
        stage: { width: 480, height: 270, padding: 40, background: { type: 'solid', color: '#0f172a' } },
        window: { frame: 'macos', title: 'Portrait Cursor Verify', width: 320, height: 180 },
        camera: { outputWidth: 480, outputHeight: 270 },
        overlays: { cursor: { enabled: true, style: 'macos' } },
        outputs: ['shorts'],
      },
    });
    const timelinePath = join(dir, 'timeline.json');
    await writeFile(timelinePath, JSON.stringify(timeline, null, 2));

    // Verify SVG vector cursor path starts at exact tip M0 0 (not M1 1)
    const compSource = await readFile(resolve(REPO_ROOT, 'src/remotion/TimelineComposition.mjs'), 'utf8');
    assert.match(compSource, /d:\s*'M0 0L0 22\.2/);
    assert.doesNotMatch(compSource, /M1 1L1 23\.2/);

    // Verify portrait 9:16 (1080x1920) pixel-marker cursor verification passes <= 2 px across panned smart-follow frames!
    const portraitVerify = await verifyRenderedCursorPixels({
      timeline: timelinePath,
      eventTrack: eventTrackPath,
      outputWidth: 1080,
      outputHeight: 1920,
      fps: 60,
      sampleTimes: [0.0, 0.3, 0.5],
      thresholdPx: 2,
      scratchDir,
    });
    assert.equal(portraitVerify.ok, true, JSON.stringify(portraitVerify.violations, null, 2));
    assert.equal(portraitVerify.checked, true);
    assert.equal(portraitVerify.mode, 'pixel-marker');
    assert.equal(portraitVerify.samplesChecked, 3);
    assert.ok(portraitVerify.maxErrorPx <= 2, `expected <= 2 px on 9:16 shorts, got ${portraitVerify.maxErrorPx}`);

    // Also render actual shorts.mp4 and run reviewVideo with verifyCursor: true & outputId: 'shorts'
    const rendered = await renderTimeline({
      timeline: timelinePath,
      outDir: join(dir, 'out-shorts'),
      profiles: ['shorts'],
      scratchDir,
    });
    const shortsVideo = rendered.outputs[0].file;
    const review = await reviewVideo({
      video: shortsVideo,
      timeline: timelinePath,
      eventTrack: eventTrackPath,
      outputId: 'shorts',
      verifyCursor: { sampleTimes: [0.0, 0.5], scratchDir },
    });
    assert.equal(review.ok, true, JSON.stringify(review.findings, null, 2));
    assert.equal(review.metrics.cursor.checked, true);
    assert.ok(review.metrics.cursor.maxErrorPx <= 2);

    // Also verify high-scale landscape (outputScale = 3, 1440x810) edge sample selection uses outputScale for dotRadius
    const scaledPt = projectViewportToRender(50, 90, timeline, 0, 1440, 810);
    assert.equal(scaledPt.cameraState.outputScale, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #4: padTakeVideoWithHolds clones lead holds near t = 0 without double-counting tailHold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-leadhold-'));
  try {
    // Frame 0 (t=0.0..0.1s) is pure RED; frames 1..9 (t=0.1..1.0s) are pure GREEN
    await sharp({
      create: { width: 160, height: 90, channels: 3, background: { r: 235, g: 30, b: 30 } },
    })
      .png()
      .toFile(join(dir, 'seq-0.png'));
    for (let i = 1; i < 10; i += 1) {
      await sharp({
        create: { width: 160, height: 90, channels: 3, background: { r: 20, g: 200, b: 80 } },
      })
        .png()
        .toFile(join(dir, `seq-${i}.png`));
    }
    const sourceVideo = join(dir, 'take.mp4');
    await renderVideo({ input: join(dir, 'seq-%d.png'), output: sourceVideo, fps: 10 });

    // Step 0 at t=0.0, Step 1 at t=0.01 (< minSlice!), Step 2 at t=0.5 (internal hold too!)
    const eventTrack = makeSimpleEventTrack({
      video: 'take.mp4',
      width: 160,
      height: 90,
      fps: 10,
      duration: 1.0,
      events: [
        { t: 0.0, type: 'step', index: 0, label: 'Intro at t=0', narration: 'Hold the opening red frame while introducing.' },
        { t: 0.01, type: 'step', index: 1, label: 'Transition', narration: 'Now watch the green sequence.' },
        { t: 0.5, type: 'step', index: 2, label: 'Outro', narration: 'Finish cleanly.' },
      ],
    });
    const timeline = compileTimeline({
      take: { video: 'take.mp4', eventTrack: 'event-track.json' },
      eventTrack,
    });
    await writeFile(join(dir, 'event-track.json'), JSON.stringify(eventTrack, null, 2));
    await writeFile(join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2));

    const outDir = join(dir, 'narrated');
    const narrated = await narrateTimeline({
      timeline: join(dir, 'timeline.json'),
      eventTrack: join(dir, 'event-track.json'),
      outDir,
      provider: 'kokoro',
      aligner: 'proportional',
      ttsRunner: async ({ outputFile }) => {
        const wav = encodePcm16Wav(makeSinePcm16Buffer({ duration: 0.9, sampleRate: 24000 }), {
          sampleRate: 24000,
          channels: 1,
        });
        await writeFile(outputFile, wav);
      },
    });

    assert.ok(narrated.paddedVideoFile);
    const probed = await probeVideo(narrated.paddedVideoFile);
    // Expected total duration: step 0 (~1.5s, pad ~1.49s) + step 1 (~1.5s, pad ~1.01s) + step 2 (~1.5s, pad ~1.0s) = ~4.5s (not double-counted!)
    assert.ok(Math.abs(probed.duration - narrated.steps.at(-1).end) < 0.25, `unexpected duration ${probed.duration}`);

    // At t = 0.8s (inside Step 0's lead hold before Step 1 starts at ~1.5s), frame MUST still be RED (cloned frame 0)!
    const { stdout: rawRed } = await exec(
      'ffmpeg',
      [
        '-v', 'error', '-ss', '0.8', '-i', narrated.paddedVideoFile,
        '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:80:45', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
      ],
      { encoding: 'buffer' }
    );
    assert.ok(
      rawRed[0] > 170 && rawRed[1] < 90,
      `expected cloned RED frame during leadHold at t=0.8s, got rgb(${rawRed[0]},${rawRed[1]},${rawRed[2]})`
    );

    // After Step 0's lead hold completes (at steps[1].start + 0.25s), video advances into GREEN frames!
    const afterLeadHoldT = (narrated.steps[1].start + 0.25).toFixed(2);
    const { stdout: rawGreen } = await exec(
      'ffmpeg',
      [
        '-v', 'error', '-ss', afterLeadHoldT, '-i', narrated.paddedVideoFile,
        '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:80:45', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
      ],
      { encoding: 'buffer' }
    );
    assert.ok(
      rawGreen[1] > 140 && rawGreen[0] < 90,
      `expected GREEN frame after leadHold at t=${afterLeadHoldT}s, got rgb(${rawGreen[0]},${rawGreen[1]},${rawGreen[2]})`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #5: reviewNarration and reviewVideo validate SFX-only tracks via transient true-peak bounds instead of continuous LUFS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-sfx-loudness-'));
  try {
    const cleanVideo = join(dir, 'clean.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4.0',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', cleanVideo,
    ]);

    const eventTrack = makeSimpleEventTrack({
      video: cleanVideo,
      width: 320,
      height: 180,
      fps: 30,
      duration: 4.0,
      events: [
        { t: 0.5, type: 'pointerdown', x: 100, y: 90, button: 'left' },
        { t: 0.6, type: 'pointerup', x: 100, y: 90, button: 'left' },
      ],
    });
    const timeline = compileTimeline({
      take: { video: cleanVideo, eventTrack: 'event-track.json' },
      eventTrack,
    });

    const sfxWav = join(dir, 'sfx-only.wav');
    const muxedMp4 = join(dir, 'sfx-muxed.mp4');
    const mixed = await mixTimelineAudio({
      timeline,
      sfx: true,
      outFile: sfxWav,
      videoFile: cleanVideo,
      muxOutFile: muxedMp4,
    });

    assert.equal(mixed.ok, true);
    assert.equal(mixed.timeline.audio.tracks.length, 1);
    assert.equal(mixed.timeline.audio.tracks[0].kind, 'sfx');

    // Both reviewNarration and reviewVideo pass on sparse SFX-only audio (integrated LUFS is -inf / < -30)
    const narrReview = await reviewNarration({ timeline: mixed.timeline });
    assert.equal(narrReview.ok, true, JSON.stringify(narrReview.findings, null, 2));
    assert.equal(narrReview.checks.find((c) => c.name === 'audio-loudness')?.ok, true);

    const vidReview = await reviewVideo({ video: muxedMp4, timeline: mixed.timeline });
    assert.equal(vidReview.ok, true, JSON.stringify(vidReview.findings, null, 2));
    assert.equal(vidReview.checks.find((c) => c.name === 'audio-loudness')?.ok, true);

    // Dead-silent SFX track still fails transient check
    const silentSfx = join(dir, 'silent-sfx.wav');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:d=2.0',
      '-c:a', 'pcm_s16le', silentSfx,
    ]);
    const silentTimeline = structuredClone(mixed.timeline);
    silentTimeline.audio.tracks = [{ id: 'sfx-dead', kind: 'sfx', src: silentSfx, start: 0, volume: 1 }];
    const silentReview = await reviewNarration({ timeline: silentTimeline });
    assert.equal(silentReview.ok, false);
    assert.ok(silentReview.findings.some((f) => /no measurable transient/i.test(f.message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #6 & #16: offline Kokoro guardrail never calls Gemini in auto aligner mode; Gemini ms rescaling & Kokoro --text=/env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-kokoro-offline-'));
  try {
    const eventTrack = makeSimpleEventTrack({
      events: [
        { t: 0.0, type: 'step', index: 0, label: 'Intro', narration: 'Offline narration stays strictly local.' },
      ],
    });
    const timeline = compileTimeline({ eventTrack });

    let cloudFetchCalls = 0;
    const narratedOffline = await narrateTimeline({
      timeline,
      outDir: join(dir, 'offline'),
      padVideo: false,
      provider: 'kokoro',
      aligner: 'auto',
      whisperExecutable: false,
      apiKey: 'ambient-key-must-not-leak',
      env: { PATH: '', GEMINI_API_KEY: 'ambient-key-must-not-leak' },
      ttsRunner: async ({ outputFile }) => {
        await writeFile(
          outputFile,
          encodePcm16Wav(makeSinePcm16Buffer({ duration: 1.0, sampleRate: 24000 }), {
            sampleRate: 24000,
            channels: 1,
          })
        );
      },
      fetchImpl: async () => {
        cloudFetchCalls += 1;
        throw Error('Kokoro + aligner=auto must never call cloud Gemini API');
      },
    });
    assert.equal(cloudFetchCalls, 0);
    assert.equal(narratedOffline.aligner, 'proportional');

    // Explicit aligner='gemini' WITH provider='kokoro' DOES call Gemini, and rescales millisecond rawTimings!
    const wavBuf = encodePcm16Wav(makeSinePcm16Buffer({ duration: 1.2, sampleRate: 24000 }), {
      sampleRate: 24000,
      channels: 1,
    });
    const msAligned = await alignWithGemini({
      audioBuffer: wavBuf,
      text: 'Hello millisecond world.',
      duration: 1.2,
      apiKey: 'explicit-gemini-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      words: [
                        { word: 'Hello', start: 100, end: 400 },
                        { word: 'millisecond', start: 420, end: 850 },
                        { word: 'world.', start: 860, end: 1150 },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      }),
    });
    assert.equal(msAligned.words[0].start, 0.1);
    assert.equal(msAligned.words[1].start, 0.42);
    assert.equal(msAligned.words[2].end, 1.15);
    assert.ok(msAligned.words.every((w) => w.method === 'forced'));

    // Wild out-of-range Gemini timings fall back cleanly to proportional instead of collapsing to maxEnd
    const fallbackAligned = await alignWithGemini({
      audioBuffer: wavBuf,
      text: 'Safe proportional fallback.',
      duration: 1.2,
      apiKey: 'explicit-gemini-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      words: [
                        { word: 'Safe', start: 900000, end: 950000 },
                        { word: 'proportional', start: 960000, end: 980000 },
                        { word: 'fallback.', start: 990000, end: 999999 },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      }),
    });
    assert.ok(fallbackAligned.words.every((w) => w.method === 'proportional'));
    assert.ok(fallbackAligned.words[0].end < fallbackAligned.words[2].start);

    // defaultKokoroRunner passes --text=<text> (safe for leading '-') and forwards env to Python fallback
    const fakeKokoroCli = join(dir, 'kokoro-cli-check.mjs');
    const capturedCliArgs = join(dir, 'kokoro-cli-args.json');
    await writeFile(
      fakeKokoroCli,
      [
        `#!${process.execPath}`,
        `import { writeFileSync } from 'node:fs';`,
        `const args = process.argv.slice(2);`,
        `writeFileSync(${JSON.stringify(capturedCliArgs)}, JSON.stringify(args));`,
        `const out = args[args.indexOf('--output') + 1];`,
        `const hdr = Buffer.alloc(44 + 4800);`,
        `hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + 4800, 4); hdr.write('WAVE', 8);`,
        `hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);`,
        `hdr.writeUInt32LE(24000, 24); hdr.writeUInt32LE(48000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);`,
        `hdr.write('data', 36); hdr.writeUInt32LE(4800, 40);`,
        `writeFileSync(out, hdr);`,
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeKokoroCli, 0o755);

    await synthesizeWithKokoro({
      text: '--dash-prefixed script line',
      outputFile: join(dir, 'dash.wav'),
      executable: fakeKokoroCli,
    });
    const cliArgs = JSON.parse(await readFile(capturedCliArgs, 'utf8'));
    assert.ok(cliArgs.includes('--text=--dash-prefixed script line'));

    // Python fallback receives custom { env }
    const fakePython = join(dir, 'fake-python.mjs');
    const capturedPyEnv = join(dir, 'py-env.json');
    await writeFile(
      fakePython,
      [
        `#!${process.execPath}`,
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(capturedPyEnv)}, JSON.stringify({ marker: process.env.CUSTOM_KOKORO_MARKER }));`,
        `const out = process.argv[5];`,
        `const hdr = Buffer.alloc(44 + 4800);`,
        `hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + 4800, 4); hdr.write('WAVE', 8);`,
        `hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);`,
        `hdr.writeUInt32LE(24000, 24); hdr.writeUInt32LE(48000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);`,
        `hdr.write('data', 36); hdr.writeUInt32LE(4800, 40);`,
        `writeFileSync(out, hdr);`,
      ].join('\n'),
      'utf8'
    );
    await chmod(fakePython, 0o755);

    await synthesizeWithKokoro({
      text: 'Python env forwarding test',
      outputFile: join(dir, 'py-out.wav'),
      python: fakePython,
      env: { ...process.env, PATH: '', CUSTOM_KOKORO_MARKER: 'forwarded-ok' },
    });
    const pyEnv = JSON.parse(await readFile(capturedPyEnv, 'utf8'));
    assert.equal(pyEnv.marker, 'forwarded-ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #7 & #8: CI pins agg release + sha256sum; publishYouTube preserves videoId and URL on partial caption/thumbnail failure', async () => {
  const ciYaml = await readFile(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ciYaml, /releases\/latest\/download\/agg/);
  assert.match(ciYaml, /AGG_VERSION="v1\.\d+\.\d+"/);
  assert.match(ciYaml, /x86_64\)/);
  assert.match(ciYaml, /aarch64\|arm64\)/);
  assert.match(ciYaml, /sha256sum -c/);

  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-yt-partial-'));
  try {
    const video = join(dir, 'demo.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=10:duration=0.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video,
    ]);
    const srtFile = join(dir, 'en.srt');
    await writeFile(srtFile, '1\n00:00:00,000 --> 00:00:00,500\nHello\n');
    const thumbFile = join(dir, 'thumb.png');
    await sharp({ create: { width: 64, height: 36, channels: 3, background: '#0f172a' } })
      .png()
      .toFile(thumbFile);

    let caught = null;
    try {
      await publishYouTube({
        video,
        title: 'Partial Failure Test',
        captions: [{ file: srtFile, language: 'en', name: 'English' }],
        thumbnail: thumbFile,
        accessToken: 'ya29.mock',
        fetchImpl: async (url) => {
          const u = String(url);
          if (u.includes('/videos')) {
            return new Response(JSON.stringify({ id: 'yt_partial_999' }), { status: 200 });
          }
          if (u.includes('/captions')) {
            return new Response(JSON.stringify({ id: 'cap_1' }), { status: 200 });
          }
          if (u.includes('/thumbnails/set')) {
            return new Response('quota exceeded', { status: 403 });
          }
          throw Error(`Unexpected URL: ${u}`);
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught, 'expected publishYouTube to throw on thumbnail HTTP 403');
    assert.match(caught.message, /yt_partial_999/);
    assert.match(caught.message, /https:\/\/youtu\.be\/yt_partial_999/);
    assert.equal(caught.cause.videoId, 'yt_partial_999');
    assert.equal(caught.cause.url, 'https://youtu.be/yt_partial_999');
    assert.equal(caught.cause.captionsUploaded.length, 1);
    assert.equal(caught.cause.captionsUploaded[0].id, 'cap_1');
    assert.equal(caught.cause.thumbnailUploaded, false);
    assert.equal(caught.partialReport.videoId, 'yt_partial_999');
    assert.equal(caught.partialReport.partial, true);

    // Also verify CLI `publish --target youtube --out <file>` writes partial report JSON when thumbnail fails
    const mockFetchPreload = join(dir, 'preload-yt-fetch.mjs');
    await writeFile(
      mockFetchPreload,
      [
        `globalThis.fetch = async (url) => {`,
        `  const u = String(url);`,
        `  if (u.includes('/videos')) return new Response(JSON.stringify({ id: 'yt_cli_partial_42' }), { status: 200 });`,
        `  return new Response('thumbnail quota', { status: 429 });`,
        `};`,
      ].join('\n'),
      'utf8'
    );
    const cliPartialReportPath = join(dir, 'cli-partial-report.json');
    await assert.rejects(
      exec(
        process.execPath,
        [
          '--import', mockFetchPreload,
          CLI_PATH,
          'publish',
          '--target', 'youtube',
          '--input', video,
          '--title', 'CLI Partial Upload',
          '--thumbnail', thumbFile,
          '--out', cliPartialReportPath,
        ],
        { env: { ...process.env, YOUTUBE_ACCESS_TOKEN: 'ya29.cli-mock' } }
      ),
      (err) => err.code === 1 && /yt_cli_partial_42/.test(err.stderr)
    );
    const persistedPartial = JSON.parse(await readFile(cliPartialReportPath, 'utf8'));
    assert.equal(persistedPartial.ok, false);
    assert.equal(persistedPartial.partial, true);
    assert.equal(persistedPartial.videoId, 'yt_cli_partial_42');
    assert.equal(persistedPartial.url, 'https://youtu.be/yt_cli_partial_42');
    assert.equal(persistedPartial.thumbnailUploaded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #9 & #15: prepareMusicBed guards short/silent clips and measures before apad when loop=false; sidechain clamps attack/release and scales with duckUnderSpeechDb', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-music-guard-'));
  try {
    const silentSrc = join(dir, 'silent-2s.wav');
    const shortLoudSrc = join(dir, 'short-loud-0.2s.wav');
    const shortQuietSrc = join(dir, 'short-quiet-0.2s.wav');
    const stingSrc = join(dir, 'sting-1s.wav');
    const speechSrc = join(dir, 'speech-1.5s.wav');

    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:d=2.0',
        '-c:a', 'pcm_s16le', silentSrc,
      ]),
      // FFmpeg lavfi sine defaults to -18 dBFS peak; +15 dB yields a loud ~ -3 dBFS peak clip
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.2:sample_rate=48000',
        '-af', 'volume=+15dB',
        '-c:a', 'pcm_s16le', shortLoudSrc,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.2:sample_rate=48000',
        '-af', 'volume=-3dB',
        '-c:a', 'pcm_s16le', shortQuietSrc,
      ]),
      // 1.0s stereo tone at ~ -18 LUFS (sine default ~ -21.7 LUFS mono; stereo + 0.7dB -> ~ -18 LUFS)
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.0:sample_rate=48000',
        '-af', 'aformat=channel_layouts=stereo,volume=+0.7dB',
        '-c:a', 'pcm_s16le', stingSrc,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=520:duration=1.5:sample_rate=24000',
        '-af', 'volume=+6dB',
        '-c:a', 'pcm_s16le', speechSrc,
      ]),
    ]);

    // 1. Silent clip must NOT be boosted by +24 dB
    const silentPrep = await prepareMusicBed({
      src: silentSrc,
      outputFile: join(dir, 'out-silent.wav'),
      duration: 2.0,
      targetLufs: -18,
    });
    assert.equal(silentPrep.appliedGainDb, 0);

    // 2. Short (< 0.4s) clips use RMS/peak fallback instead of +24 dB ebur128 empty-gate boost
    const shortPrep = await prepareMusicBed({
      src: shortLoudSrc,
      outputFile: join(dir, 'out-short-loud.wav'),
      duration: 0.25,
      targetLufs: -18,
    });
    assert.ok(shortPrep.appliedGainDb <= 0, `expected <= 0 dB gain on loud 0.2s clip, got ${shortPrep.appliedGainDb}`);

    const shortQuietPrep = await prepareMusicBed({
      src: shortQuietSrc,
      outputFile: join(dir, 'out-short-quiet.wav'),
      duration: 0.25,
      targetLufs: -18,
    });
    assert.ok(
      shortQuietPrep.appliedGainDb > 0 && shortQuietPrep.appliedGainDb <= 12,
      `expected capped RMS fallback gain (0, 12] dB on quiet 0.2s clip, got ${shortQuietPrep.appliedGainDb}`
    );

    // 3. loop: false on 1.0s clip into 6.0s target measures BEFORE apad (exact same gain as 1.0s target,
    //    never inflated by 5.0s of trailing apad silence!)
    const unlooped1s = await prepareMusicBed({
      src: stingSrc,
      outputFile: join(dir, 'out-unlooped-1s.wav'),
      duration: 1.0,
      loop: false,
      fadeIn: 0,
      fadeOut: 0,
      targetLufs: -18,
    });
    const unlooped6s = await prepareMusicBed({
      src: stingSrc,
      outputFile: join(dir, 'out-unlooped-6s.wav'),
      duration: 6.0,
      loop: false,
      fadeIn: 0,
      fadeOut: 0,
      targetLufs: -18,
    });
    assert.equal(
      unlooped6s.appliedGainDb,
      unlooped1s.appliedGainDb,
      `expected 6.0s unlooped gain (${unlooped6s.appliedGainDb} dB) to match 1.0s unpadded gain (${unlooped1s.appliedGainDb} dB)`
    );
    assert.ok(Math.abs(unlooped6s.duration - 6.0) < 0.05);

    // 4. Sidechain clamping (attack=5s -> 2000ms, release=15s -> 9000ms) + duckUnderSpeechDb scaling (-3 vs -16)
    const timeline = compileTimeline({
      eventTrack: makeSimpleEventTrack({ duration: 4.0 }),
    });
    timeline.audio.tracks = [{ id: 'n-0', kind: 'narration', src: speechSrc, start: 0.5, volume: 1 }];

    const gentleSc = await mixTimelineAudio({
      timeline,
      music: { src: stingSrc, fadeIn: 0.05, fadeOut: 0.05, targetLufs: -18 },
      outDir: join(dir, 'sc-gentle'),
      duckingMode: 'sidechain',
      duckUnderSpeechDb: -3,
      duckAttack: 5.0,
      duckRelease: 15.0,
      keepStems: true,
    });
    const deepSc = await mixTimelineAudio({
      timeline,
      music: { src: stingSrc, fadeIn: 0.05, fadeOut: 0.05, targetLufs: -18 },
      outDir: join(dir, 'sc-deep'),
      duckingMode: 'sidechain',
      duckUnderSpeechDb: -16,
      duckAttack: 0.02,
      duckRelease: 0.2,
      keepStems: true,
    });
    assert.equal(gentleSc.ok, true);
    assert.equal(deepSc.ok, true);
    assert.ok(
      deepSc.ducking.attenuationDb > gentleSc.ducking.attenuationDb,
      `expected -16 dB sidechain (${deepSc.ducking.attenuationDb} dB) > -3 dB (${gentleSc.ducking.attenuationDb} dB)`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #10 & #11: narrateTimeline retimes verticalKeyframes, preserves custom camera.keyframes / fromSteps:false, and prefers edited recipe narration on --reuse-take', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-retime-reuse-'));
  try {
    const eventTrack = {
      version: 1,
      captureMode: 'headless',
      viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
      video: { file: 'take.mp4', width: 1280, height: 720, fps: 30, duration: 2.0, frames: 60 },
      events: [
        { t: 0.0, type: 'pointermove', x: 640, y: 360 },
        {
          t: 0.0,
          type: 'step',
          index: 0,
          label: 'Step 0',
          camera: { zoom: 2.0, focus: [200, 200] }, // step hint that custom keyframes should override!
          narration: 'Stale cached narration from initial capture.',
        },
        {
          t: 1.0,
          type: 'step',
          index: 1,
          label: 'Step 1',
          camera: 'wide',
          narration: 'Second stale cached line.',
        },
      ],
    };

    const customRecipe = {
      steps: [
        { type: 'click', target: [200, 200], narration: 'Fresh edited step zero narration after reuse.' },
        { type: 'key', key: 'Escape', narration: 'Fresh edited step one narration.' },
      ],
      presentation: {
        stage: { width: 1520, height: 960, padding: 120 },
        window: { frame: 'macos', width: 1280, height: 720 },
        camera: {
          outputWidth: 1280,
          outputHeight: 720,
          keyframes: [
            { t: 0, x: 760, y: 480, zoom: 1.15, easing: 'linear' },
            { t: 1.5, x: 760, y: 480, zoom: 1.35, easing: 'ease-in-out' },
          ],
          verticalKeyframes: [
            { t: 0, x: 500, y: 480, zoom: 1.0, easing: 'linear' },
            { t: 1.5, x: 950, y: 480, zoom: 1.25, easing: 'smoothstep' },
          ],
        },
        outputs: ['shorts'],
      },
    };

    const baseTimeline = compileTimeline({ eventTrack, recipe: customRecipe.presentation });
    const spokenTexts = [];
    const narrated = await narrateTimeline({
      timeline: baseTimeline,
      eventTrack,
      recipe: customRecipe,
      outDir: dir,
      padVideo: false,
      provider: 'kokoro',
      aligner: 'proportional',
      ttsRunner: async ({ text, outputFile }) => {
        spokenTexts.push(text);
        await writeFile(
          outputFile,
          encodePcm16Wav(makeSinePcm16Buffer({ duration: 1.6, sampleRate: 24000 }), {
            sampleRate: 24000,
            channels: 1,
          })
        );
      },
    });

    // Edited recipe narration wins over stale cached tlStep/evStep narration!
    assert.deepEqual(spokenTexts, [
      'Fresh edited step zero narration after reuse.',
      'Fresh edited step one narration.',
    ]);
    assert.match(narrated.subtitles.en.srt, /Fresh edited step zero/);

    // Custom camera.keyframes (zoom 1.15 -> 1.35) were retimed, NOT overwritten by step hint (zoom 2.0)!
    assert.equal(narrated.timeline.camera.keyframes[0].zoom, 1.15);
    assert.ok(narrated.timeline.camera.keyframes.every((kf) => kf.zoom !== 2.0));
    assert.ok(narrated.timeline.camera.keyframes.at(-1).t > 2.0, 'custom keyframes retimed past original 1.5s');

    // verticalKeyframes were also retimed with step holds and pass validateTimeline!
    assert.ok(Array.isArray(narrated.timeline.camera.verticalKeyframes));
    assert.ok(
      narrated.timeline.camera.verticalKeyframes.at(-1).t > 2.0,
      `expected verticalKeyframes retimed > 2.0s, got ${narrated.timeline.camera.verticalKeyframes.at(-1).t}`
    );
    assert.deepEqual(validateTimeline(narrated.timeline), { ok: true, errors: [] });

    // Also verify fromSteps: false without explicit keyframes keeps wide zoom=1 instead of compiling step zoom=2.0
    const fromStepsDisabledRecipe = {
      steps: customRecipe.steps,
      presentation: {
        stage: { width: 1520, height: 960, padding: 120 },
        window: { frame: 'macos', width: 1280, height: 720 },
        camera: { outputWidth: 1280, outputHeight: 720, fromSteps: false },
      },
    };
    const wideTimeline = compileTimeline({ eventTrack, recipe: fromStepsDisabledRecipe.presentation });
    const wideNarrated = await narrateTimeline({
      timeline: wideTimeline,
      eventTrack,
      recipe: fromStepsDisabledRecipe,
      outDir: join(dir, 'wide'),
      padVideo: false,
      provider: 'kokoro',
      aligner: 'proportional',
      ttsRunner: async ({ outputFile }) => {
        await writeFile(
          outputFile,
          encodePcm16Wav(makeSinePcm16Buffer({ duration: 1.6, sampleRate: 24000 }), {
            sampleRate: 24000,
            channels: 1,
          })
        );
      },
    });
    assert.ok(wideNarrated.timeline.camera.keyframes.every((kf) => kf.zoom === 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #12 & #17: 9:16 portrait captions & HUD use explicit left/width without shrink-to-fit, increase multi-pill offset, half-open cue [start,end), buildNarrationTracks duration, and trimmed multimodal apiKey', async () => {
  const eventTrack = makeSimpleEventTrack({
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
    video: { file: 'take.mp4', width: 1280, height: 720, fps: 30, duration: 3.0, frames: 90 },
    events: [
      { t: 0.4, type: 'gesture', kind: 'scroll', x: 640, y: 360, deltaX: 0, deltaY: -120, duration: 0.8 },
      { t: 0.45, type: 'pointerdown', x: 640, y: 360, button: 'left', modifiers: ['Shift'] },
      { t: 0.48, type: 'key', key: 'Backspace', modifiers: ['Control', 'Alt', 'Shift', 'Meta'], action: 'press', duration: 0.8 },
      { t: 0.5, type: 'key', key: 'l', modifiers: ['Shift', 'Meta'], action: 'press', duration: 0.8 },
    ],
  });
  const timeline = compileTimeline({
    eventTrack,
    recipe: {
      stage: { width: 1520, height: 960, padding: 120 },
      window: { frame: 'macos', width: 1280, height: 720 },
      camera: { outputWidth: 1280, outputHeight: 720 },
      overlays: {
        captions: {
          enabled: true,
          tracks: [
            {
              language: 'en',
              cues: [
                { start: 0.2, end: 1.0, text: 'First cue uses full portrait safe width without premature wrapping.' },
                { start: 1.0, end: 2.0, text: 'Second cue starts at exact boundary 1.0s.' },
              ],
            },
          ],
        },
      },
      outputs: ['shorts'],
    },
  });

  // 1. Half-open [start, end) caption interval: at t = 1.0s, ONLY the second cue is active (never stacked!)
  const overlaysAtBoundary = computeOverlaysAtTime(timeline, 1.0, 1080, 1920);
  assert.equal(overlaysAtBoundary.captions.length, 1);
  assert.match(overlaysAtBoundary.captions[0].text, /^Second cue/);

  // 2. Portrait HUD & caption DOM styles use explicit left + width + translateY(-100%) (no translate(-50%, -100%))
  //    and multi-pill (gesture + 3 keystrokes = 4 pills) increases caption extraOffset above 1-pill offset!
  const multiScene = computeOverlaysAtTime(timeline, 0.55, 1080, 1920);
  assert.equal(multiScene.hudAnchor.left, 48);
  assert.equal(multiScene.hudAnchor.width, 888);
  assert.equal(multiScene.gestures.length, 1);
  assert.equal(multiScene.keystrokes.length, 3);

  // Verify TimelineComposition source uses translateY(-100%) with explicit left/width and multi-row offset
  const compCode = await readFile(resolve(REPO_ROOT, 'src/remotion/TimelineComposition.mjs'), 'utf8');
  assert.doesNotMatch(compCode, /translate\(-50%,\s*-100%\)/);
  assert.match(compCode, /transform:\s*'translateY\(-100%\)'/);

  // Render real 9:16 stills comparing 1 HUD pill vs wrapped multi-pill HUD to verify captions shift higher without overlapping
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-hud-mm-'));
  try {
    const whiteVid = join(dir, 'white.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=0xf8fafc:s=320x180:r=10:d=2.0',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', whiteVid,
    ]);

    const hudTestBase = structuredClone(timeline);
    hudTestBase.take = {
      ...hudTestBase.take,
      video: whiteVid,
      width: 320,
      height: 180,
      fps: 10,
      duration: 2.0,
      frames: 20,
    };
    hudTestBase.stage.background = { type: 'solid', color: '#f8fafc' };
    hudTestBase.window = { frame: 'none', x: 120, y: 120, width: 1280, height: 720, borderRadius: 0, shadow: false };
    hudTestBase.overlays.cursor.enabled = false;
    hudTestBase.overlays.ripples = [];

    const onePillVariant = structuredClone(hudTestBase);
    onePillVariant.overlays.gestures = [];
    onePillVariant.overlays.keystrokes = [hudTestBase.overlays.keystrokes[0]];

    const hudStills = await renderTimelineStills({
      timeline: hudTestBase,
      variants: { onePill: onePillVariant, multiPills: hudTestBase },
      requests: [
        { key: 'one', variant: 'onePill', t: 0.6, filename: 'one-pill.png' },
        { key: 'multi', variant: 'multiPills', t: 0.6, filename: 'multi-pills.png' },
      ],
      outDir: join(dir, 'hud-stills'),
      width: 540,
      height: 960,
      fps: 10,
    });

    // Caption pill rgba(9,13,22,0.82) over #f8fafc renders ~rgb(52,56,63); HUD pill rgba(12,13,16,0.90) ~rgb(36,37,40)
    const analyzeLowerOverlayRows = async (pngPath) => {
      const { data, info } = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const darkRows = [];
      for (let y = Math.floor(info.height * 0.45); y < info.height; y += 1) {
        let hasDark = false;
        for (let x = 0; x < info.width; x += 1) {
          const idx = (y * info.width + x) * 4;
          if (data[idx] < 110 && data[idx + 1] < 110 && data[idx + 2] < 110) {
            hasDark = true;
            break;
          }
        }
        if (hasDark) darkRows.push(y);
      }
      return darkRows;
    };
    const rowsOnePill = await analyzeLowerOverlayRows(hudStills.stills[0].file);
    const rowsMultiPills = await analyzeLowerOverlayRows(hudStills.stills[1].file);
    const topOnePill = rowsOnePill[0];
    const topMultiPills = rowsMultiPills[0];
    assert.ok(
      topMultiPills < topOnePill - 35,
      `expected multi-pill portrait caption top (${topMultiPills}) well above 1-pill caption top (${topOnePill})`
    );
    let maxVerticalGap = 0;
    for (let i = 1; i < rowsMultiPills.length; i += 1) {
      maxVerticalGap = Math.max(maxVerticalGap, rowsMultiPills[i] - rowsMultiPills[i - 1] - 1);
    }
    assert.ok(maxVerticalGap >= 8, `expected clean vertical gap between caption and wrapped HUD pills, got ${maxVerticalGap}px`);

    // 3. buildNarrationTracks updates timeline.take.duration and frames when narration extends past take.duration
    const shortTimeline = compileTimeline({
      eventTrack: makeSimpleEventTrack({ duration: 1.0, fps: 30 }),
    });
    assert.equal(shortTimeline.take.duration, 1.0);
    assert.equal(shortTimeline.take.frames, 30);

    const built = await buildNarrationTracks({
      steps: [{ index: 0, label: 'Long speech', actionDuration: 1.0, say: 'This narration extends past one second.' }],
      provider: 'kokoro',
      providerOptions: {
        runner: async ({ outputFile }) => {
          await writeFile(
            outputFile,
            encodePcm16Wav(makeSinePcm16Buffer({ duration: 2.4, sampleRate: 24000 }), {
              sampleRate: 24000,
              channels: 1,
            })
          );
        },
      },
      outDir: join(dir, 'narr'),
      timeline: shortTimeline,
    });
    assert.equal(built.timeline.take.duration, 3.0);
    assert.equal(built.timeline.take.frames, 90);

    // 4. callGeminiMultimodalReview trims apiKey and treats whitespace-only key as skipped
    const vid = join(dir, 'mm.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=1.5',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', vid,
    ]);

    const whitespaceReport = await reviewVideo({
      video: vid,
      multimodal: {
        enabled: true,
        provider: 'gemini',
        apiKey: '   \n\t  ',
        fetchImpl: async () => {
          throw Error('must skip whitespace-only apiKey');
        },
      },
    });
    assert.equal(whitespaceReport.multimodal.skipped, true);

    let sentHeaderKey = null;
    const trimmedReport = await reviewVideo({
      video: vid,
      outDir: join(dir, 'mm-out'),
      multimodal: {
        enabled: true,
        provider: 'gemini',
        apiKey: '  trimmed-secret-key\n ',
        fetchImpl: async (_url, init) => {
          sentHeaderKey = init.headers['x-goog-api-key'];
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: '{"ok":true,"summary":"ok","findings":[]}' }] } }],
            }),
          };
        },
      },
    });
    assert.equal(trimmedReport.ok, true);
    assert.equal(sentHeaderKey, 'trimmed-secret-key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Finding #14: CLI audio-mix subcommand, narrate --whisper-model forwarding, and run review flag / outputId wiring', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w7-cli-complete-'));
  try {
    // 1. CLI `screen-kit audio-mix` with --music, --sfx, --duck-mode, --duck-db, --video, --out-video
    const videoIn = join(dir, 'clean.mp4');
    const musicIn = join(dir, 'bed.wav');
    const speechIn = join(dir, 'speech.wav');
    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=2.5',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', videoIn,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2.5:sample_rate=48000',
        '-c:a', 'pcm_s16le', musicIn,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=500:duration=1.0:sample_rate=24000',
        '-af', 'volume=+6dB',
        '-c:a', 'pcm_s16le', speechIn,
      ]),
    ]);

    const baseTl = compileTimeline({
      take: { video: 'clean.mp4', eventTrack: 'event-track.json' },
      eventTrack: makeSimpleEventTrack({ video: 'clean.mp4', width: 160, height: 90, fps: 15, duration: 2.5 }),
    });
    baseTl.audio.tracks = [{ id: 'narr-0', kind: 'narration', src: 'speech.wav', start: 0.4, volume: 1 }];
    const tlPath = join(dir, 'timeline.json');
    await writeFile(tlPath, JSON.stringify(baseTl, null, 2));

    const mixOutDir = join(dir, 'mixed-out');
    const muxedOutVideo = join(dir, 'muxed-final.mp4');
    const { stdout: mixStdout } = await exec(process.execPath, [
      CLI_PATH,
      'audio-mix',
      '--input', tlPath,
      '--out', mixOutDir,
      '--music', musicIn,
      '--sfx',
      '--duck-mode', 'envelope',
      '--duck-db', '-10',
      '--video', videoIn,
      '--out-video', muxedOutVideo,
    ]);
    const mixSummary = JSON.parse(mixStdout);
    assert.equal(mixSummary.ok, true);
    assert.equal(mixSummary.ducking.applied, true);
    assert.ok(mixSummary.timelineFile);
    assert.equal((await probeAudio(muxedOutVideo)).hasAudio, true);
    const savedMixedTl = JSON.parse(await readFile(mixSummary.timelineFile, 'utf8'));
    assert.equal(validateTimeline(savedMixedTl).ok, true);

    // 2. CLI `screen-kit narrate --whisper-model` wires model path to whisper-cli (-m <resolved>)
    const fakeWhisperBin = join(dir, 'whisper-cli');
    const capturedWhisperArgs = join(dir, 'whisper-args.json');
    await writeFile(
      fakeWhisperBin,
      [
        `#!${process.execPath}`,
        `import { writeFileSync } from 'node:fs';`,
        `const args = process.argv.slice(2);`,
        `writeFileSync(${JSON.stringify(capturedWhisperArgs)}, JSON.stringify(args));`,
        `const outBase = args[args.indexOf('-of') + 1];`,
        `writeFileSync(outBase + '.json', JSON.stringify({ transcription: [{ offsets: { from: 0, to: 800 }, text: ' Hello model' }] }));`,
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeWhisperBin, 0o755);

    const fakeKokoroBin = join(dir, 'fake-kokoro');
    await writeFile(
      fakeKokoroBin,
      [
        `#!${process.execPath}`,
        `import { mkdirSync, writeFileSync } from 'node:fs';`,
        `import { dirname } from 'node:path';`,
        `const args = process.argv.slice(2);`,
        `const out = args[args.indexOf('--output') + 1];`,
        `mkdirSync(dirname(out), { recursive: true });`,
        `const hdr = Buffer.alloc(44 + 24000);`,
        `hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + 24000, 4); hdr.write('WAVE', 8);`,
        `hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);`,
        `hdr.writeUInt32LE(24000, 24); hdr.writeUInt32LE(48000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);`,
        `hdr.write('data', 36); hdr.writeUInt32LE(24000, 40);`,
        `writeFileSync(out, hdr);`,
      ].join('\n'),
      'utf8'
    );
    await chmod(fakeKokoroBin, 0o755);

    const modelBinPath = join(dir, 'ggml-base.en.bin');
    await writeFile(modelBinPath, 'dummy-model');

    const narrEventTrack = makeSimpleEventTrack({
      video: 'clean.mp4',
      events: [{ t: 0.0, type: 'step', index: 0, label: 'Greet', narration: 'Hello model.' }],
    });
    const narrTlPath = join(dir, 'narr-input.json');
    await writeFile(
      narrTlPath,
      JSON.stringify(
        compileTimeline({
          take: { video: 'clean.mp4', eventTrack: 'event-track.json' },
          eventTrack: narrEventTrack,
        }),
        null,
        2
      )
    );

    await exec(
      process.execPath,
      [
        CLI_PATH,
        'narrate',
        '--input', narrTlPath,
        '--out', join(dir, 'narr-whisper-out'),
        '--provider', 'kokoro',
        '--aligner', 'whisper',
        '--whisper-model', modelBinPath,
      ],
      {
        env: {
          ...process.env,
          SCREEN_KIT_KOKORO_BIN: fakeKokoroBin,
          SCREEN_KIT_WHISPER_BIN: fakeWhisperBin,
        },
      }
    );
    const whisperArgv = JSON.parse(await readFile(capturedWhisperArgs, 'utf8'));
    assert.ok(whisperArgv.includes('-m'), `expected -m in whisper-cli args: ${JSON.stringify(whisperArgv)}`);
    assert.equal(whisperArgv[whisperArgv.indexOf('-m') + 1], resolve(modelBinPath));

    // 3. runPipeline passes outputId ('shorts') when reviewing rendered profile & CLI `run` forwards review flags
    const runDir = join(dir, 'pipeline-shorts');
    const takeSubDir = join(runDir, 'takes', 'demo');
    await mkdir(takeSubDir, { recursive: true });
    const shortTakeVid = join(takeSubDir, 'take.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=0.3',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', shortTakeVid,
    ]);
    await writeFile(
      join(takeSubDir, 'event-track.json'),
      JSON.stringify(
        makeSimpleEventTrack({
          video: 'take.mp4',
          width: 320,
          height: 180,
          fps: 10,
          duration: 0.3,
          events: [{ t: 0.0, type: 'pointermove', x: 160, y: 90 }],
        }),
        null,
        2
      )
    );

    const cfgPath = join(dir, 'shorts-run.config.mjs');
    const cfg = {
      recipes: {
        demo: {
          source: 'browser',
          captureMode: 'headless',
          url: 'https://example.test',
          viewport: [320, 180],
          fps: 10,
          steps: [],
          presentation: {
            stage: { width: 480, height: 270, padding: 40 },
            window: { frame: 'macos', width: 320, height: 180 },
            camera: { outputWidth: 480, outputHeight: 270 },
          },
        },
      },
    };
    await writeFile(cfgPath, `export default ${JSON.stringify(cfg, null, 2)};\n`);

    const { stdout: runStdout } = await exec(
      process.execPath,
      [
        CLI_PATH,
        'run',
        '--config', cfgPath,
        '--out', runDir,
        '--reuse-take',
        '--profiles', 'shorts',
        '--cursor-threshold', '2.5',
        '--multimodal', 'false',
      ],
      { timeout: 120000 }
    );
    const runRes = JSON.parse(runStdout);
    assert.equal(runRes.ok, true, JSON.stringify(runRes.review?.findings, null, 2));
    assert.equal(runRes.review.outputId, 'shorts');
    const persistedReview = JSON.parse(await readFile(runRes.review.report, 'utf8'));
    assert.equal(persistedReview.metrics.width, 1080);
    assert.equal(persistedReview.metrics.height, 1920);
    assert.equal(persistedReview.cursor.thresholdPx, 2.5);
    assert.equal(persistedReview.multimodal.enabled, false);
    void runPipeline;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
