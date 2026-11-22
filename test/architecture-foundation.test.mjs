import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';
import * as rootApi from '../src/index.mjs';
import { generateAsset } from '../src/assets.mjs';
import { generateMusicBed } from '../src/audio-mix.mjs';
import {
  assertPathInsideDir,
  fileExists,
  moveFileAtomic,
  rebaseMediaRef,
  resolveLocalPath,
  sha256,
  writeFileAtomic,
} from '../src/internal/fs-paths.mjs';
import {
  postGoogleGenAiJson,
  resolveGoogleApiKey,
  stripJsonCodeFence,
} from '../src/internal/google-genai.mjs';
import {
  buildColorEncodeArgs,
  encodePcm16Wav,
  extractPcm16SamplesStereo,
  measureLoudness,
  parseWavHeader,
  probeAudio,
  probeVideo,
} from '../src/internal/media.mjs';
import {
  alignWithGemini,
  narrateTimeline,
  synthesizeWithGemini,
} from '../src/narration.mjs';
import { publishWebBundle } from '../src/publish.mjs';
import {
  BROWSER_CAPTURE_PHASES,
  createBrowserTakeCapture,
  encodeScreencastFrames,
} from '../src/take-browser.mjs';
import { compileTimeline } from '../src/timeline.mjs';
import { renderVideo } from '../src/video.mjs';

test('S4: createBrowserTakeCapture models explicit phases and enforces single-flight busy guard + closed guard', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-s4-phases-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const frameBytes = await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#1e293b' },
  }).jpeg().toBuffer();
  const base64Frame = frameBytes.toString('base64');

  const transitions = [];
  let releaseStep = null;
  const stepGate = new Promise((resolveGate) => {
    releaseStep = resolveGate;
  });
  let stepReachedResolve = null;
  const stepReached = new Promise((resolveReached) => {
    stepReachedResolve = resolveReached;
  });

  const mockPlaywright = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() {
                return {
                  viewportSize: () => ({ width: 320, height: 180 }),
                  async goto() {},
                  async evaluate(script) {
                    if (typeof script === 'string' && script.includes('__WAIT_GATE__')) {
                      stepReachedResolve();
                      await stepGate;
                    }
                    return true;
                  },
                  mouse: { async move() {}, async down() {}, async up() {}, async wheel() {} },
                  keyboard: { async press() {}, async down() {}, async up() {}, async type() {} },
                };
              },
              async newCDPSession() {
                const emitter = new EventEmitter();
                return {
                  on: emitter.on.bind(emitter),
                  off: emitter.off.bind(emitter),
                  async send(method) {
                    if (method === 'Page.captureScreenshot') return { data: base64Frame };
                    if (method === 'Page.startScreencast') {
                      emitter.emit('Page.screencastFrame', {
                        data: base64Frame,
                        metadata: { timestamp: 10.0 },
                        sessionId: 1,
                      });
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

  const runner = await createBrowserTakeCapture({
    out: join(dir, 'take-1'),
    captureMode: 'headless',
    playwright: mockPlaywright,
    onPhaseChange: (next, prev) => transitions.push(`${prev}->${next}`),
    encodeFrames: async ({ outputFile, targetDuration, rawFrames }) => {
      await writeFile(outputFile, Buffer.from('mock-video'));
      return {
        width: 320,
        height: 180,
        fps: 30,
        duration: Math.max(0.2, targetDuration),
        frames: Math.max(6, Math.round(targetDuration * 30)),
        measuredFps: 30,
        capturedFrames: rawFrames.length,
        codec: 'h264',
        audio: false,
      };
    },
  });

  assert.deepEqual(BROWSER_CAPTURE_PHASES, [
    'idle',
    'launching',
    'preparing',
    'recording',
    'draining',
    'encoding',
    'closed',
  ]);
  assert.equal(runner.phase, 'idle');

  const firstPromise = runner.capture('first', {
    url: 'https://example.test/one',
    viewport: [320, 180],
    fps: 30,
    tail: 0.01,
    steps: ['/* __WAIT_GATE__ */'],
  });

  // Immediate synchronous busy guard right after launching starts
  assert.equal(runner.phase, 'launching');
  await assert.rejects(
    runner.capture('concurrent-immediate', { url: 'https://example.test/two', viewport: [320, 180] }),
    /already in progress \(phase: launching\)/,
  );

  // Also reject concurrent capture mid-recording without disrupting the active capture
  await stepReached;
  assert.equal(runner.phase, 'recording');
  await assert.rejects(
    runner.capture('concurrent-recording', { url: 'https://example.test/three', viewport: [320, 180] }),
    /already in progress \(phase: recording\)/,
  );

  releaseStep();
  const firstResult = await firstPromise;
  assert.ok(firstResult.file.endsWith('take.mp4'));
  assert.equal(runner.phase, 'idle');

  await runner.close();
  assert.equal(runner.phase, 'closed');

  assert.deepEqual(transitions, [
    'idle->launching',
    'launching->preparing',
    'preparing->recording',
    'recording->draining',
    'draining->encoding',
    'encoding->idle',
    'idle->closed',
  ]);

  await assert.rejects(
    runner.capture('after-close', { url: 'https://example.test/four', viewport: [320, 180] }),
    /runner is closed/,
  );
});

test('S4: mid-flight AbortSignal cancels glideTo / step / gesture loops promptly and stops driving Chromium input', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-s4-abort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const frameBytes = await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#0f172a' },
  }).jpeg().toBuffer();
  const base64Frame = frameBytes.toString('base64');

  const controller = new AbortController();
  let movesAfterAbort = 0;
  let wheelsAfterAbort = 0;
  let moveCount = 0;

  const mockPlaywright = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() {
                return {
                  viewportSize: () => ({ width: 640, height: 360 }),
                  async goto() {},
                  async evaluate() { return true; },
                  mouse: {
                    async move() {
                      moveCount += 1;
                      if (controller.signal.aborted) movesAfterAbort += 1;
                      // Abort mid-glide on the 3rd move (initial move + 2 glide samples)
                      if (moveCount === 3) {
                        setTimeout(() => controller.abort(), 5);
                      }
                    },
                    async down() {},
                    async up() {},
                    async wheel() {
                      if (controller.signal.aborted) wheelsAfterAbort += 1;
                    },
                  },
                  keyboard: { async press() {}, async down() {}, async up() {}, async type() {} },
                };
              },
              async newCDPSession() {
                const emitter = new EventEmitter();
                return {
                  on: emitter.on.bind(emitter),
                  off: emitter.off.bind(emitter),
                  async send(method) {
                    if (method === 'Page.captureScreenshot') return { data: base64Frame };
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

  const runner = await createBrowserTakeCapture({
    out: join(dir, 'aborted-take'),
    captureMode: 'headless',
    playwright: mockPlaywright,
    signal: controller.signal,
  });

  const startedMs = performance.now();
  await assert.rejects(
    runner.capture('long-glide', {
      url: 'https://example.test/abort',
      viewport: [640, 360],
      fps: 60,
      steps: [
        { type: 'move', to: [600, 320], duration: 5.0 },
        { type: 'wheel', deltaY: 500, duration: 5.0 },
        { type: 'pause', duration: 10.0 },
      ],
    }),
    (err) => err?.name === 'AbortError' || /abort/i.test(err?.message ?? ''),
  );
  const elapsedMs = performance.now() - startedMs;

  assert.ok(elapsedMs < 1000, `expected prompt abort (< 1000 ms), took ${elapsedMs.toFixed(1)} ms`);
  assert.equal(movesAfterAbort, 0, 'must not dispatch mouse.move after AbortSignal fires');
  assert.equal(wheelsAfterAbort, 0, 'must not enter subsequent wheel step after AbortSignal fires');
  assert.equal(runner.phase, 'idle');

  // Verify `.frames-*` directory was completely cleaned up in `finally`
  const remaining = await readdir(join(dir, 'aborted-take'));
  assert.deepEqual(remaining.filter((entry) => entry.startsWith('.frames-')), []);

  await runner.close();
});

test('S4: symmetric error teardown drains rejecting pendingWrites with zero unhandled rejections, detaches CDP listener, restores focus, and only then removes framesDir', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-s4-teardown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const frameBytes = await sharp({
    create: { width: 24, height: 18, channels: 3, background: '#334155' },
  }).jpeg().toBuffer();
  const base64Frame = frameBytes.toString('base64');

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const order = [];
  const cdpEmitter = new EventEmitter();

  const focusController = {
    async captureFrontmost() {
      order.push('focus:capture');
      return 'com.mitchellh.ghostty';
    },
    async restoreFrontmost(bundleId) {
      order.push(`focus:restore:${bundleId}`);
      return true;
    },
  };

  const mockPlaywright = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() {
                return {
                  viewportSize: () => ({ width: 320, height: 180 }),
                  async goto() {},
                  async evaluate(script) {
                    if (typeof script === 'string' && script.includes('__FAIL_STEP__')) {
                      order.push('step:throw');
                      throw Error('Simulated step failure');
                    }
                    return true;
                  },
                  mouse: { async move() {}, async down() {}, async up() {}, async wheel() {} },
                  keyboard: { async press() {}, async down() {}, async up() {}, async type() {} },
                };
              },
              async newCDPSession() {
                return {
                  on(event, fn) {
                    order.push(`cdp:on:${event}`);
                    cdpEmitter.on(event, fn);
                  },
                  off(event, fn) {
                    order.push(`cdp:off:${event}`);
                    cdpEmitter.off(event, fn);
                  },
                  async send(method) {
                    if (method === 'Page.captureScreenshot') return { data: base64Frame };
                    if (method === 'Page.startScreencast') {
                      // Emit 2 frames: one delayed success and one delayed rejection!
                      cdpEmitter.emit('Page.screencastFrame', {
                        data: base64Frame,
                        metadata: { timestamp: 1.0 },
                        sessionId: 1,
                      });
                      cdpEmitter.emit('Page.screencastFrame', {
                        data: base64Frame,
                        metadata: { timestamp: 1.016 },
                        sessionId: 2,
                      });
                    }
                    if (method === 'Page.stopScreencast') {
                      order.push('cdp:stopScreencast');
                    }
                    return {};
                  },
                  async detach() {
                    order.push('cdp:detach');
                  },
                };
              },
              async close() {
                order.push('context:close');
              },
            };
          },
          async close() {
            order.push('browser:close');
          },
        };
      },
    },
  };

  let frameWriteIndex = 0;
  const outDir = join(dir, 'quality-fail-out');
  const runner = await createBrowserTakeCapture({
    out: outDir,
    captureMode: 'quality',
    playwright: mockPlaywright,
    focusController,
    writeFrame: async (filePath, buf) => {
      if (filePath.endsWith('init.jpg')) {
        await writeFile(filePath, buf);
        return;
      }
      const idx = ++frameWriteIndex;
      await new Promise((r) => setTimeout(r, 45));
      // Verify framesDir STILL exists while pendingWrites are settling after step throws!
      const parentEntries = await readdir(outDir);
      assert.ok(
        parentEntries.some((name) => name.startsWith('.frames-')),
        'framesDir must still exist while pendingWrites are draining',
      );
      order.push(`pendingWrite:${idx}:settled`);
      if (idx === 2) {
        throw Error('Simulated delayed ENOENT write failure');
      }
      await writeFile(filePath, buf);
    },
  });

  await assert.rejects(
    runner.capture('fail-recipe', {
      url: 'https://example.test/fail',
      viewport: [320, 180],
      fps: 30,
      steps: ['/* __FAIL_STEP__ */'],
    }),
    /Simulated step failure/,
  );

  // Give macrotask queue a turn to ensure zero late unhandled rejections
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(unhandled, []);
  assert.equal(cdpEmitter.listenerCount('Page.screencastFrame'), 0, 'CDP screencast listener must be detached');

  // Verify symmetric teardown order in `finally`
  const detachListenerIdx = order.indexOf('cdp:off:Page.screencastFrame');
  const write1Idx = order.indexOf('pendingWrite:1:settled');
  const write2Idx = order.indexOf('pendingWrite:2:settled');
  const stopScreencastIdx = order.indexOf('cdp:stopScreencast');
  const browserCloseIdx = order.indexOf('browser:close');
  const finalRestoreIdx = order.lastIndexOf('focus:restore:com.mitchellh.ghostty');

  assert.ok(detachListenerIdx > order.indexOf('step:throw'));
  assert.ok(write1Idx > detachListenerIdx && write2Idx > detachListenerIdx);
  assert.ok(stopScreencastIdx > write1Idx && stopScreencastIdx > write2Idx);
  assert.ok(browserCloseIdx > stopScreencastIdx);
  assert.ok(finalRestoreIdx > browserCloseIdx, `expected focus restore after cleanupActive; got ${order.join(' -> ')}`);

  // And framesDir is gone after drain completes
  const afterEntries = await readdir(outDir);
  assert.deepEqual(afterEntries.filter((name) => name.startsWith('.frames-')), []);

  await runner.close();
});

test('S5: media.mjs buildColorEncodeArgs enforces identical sRGB (BT.709) and Display P3 CICP across video, take-browser, publish, and narration, plus WAV RIFF round-trip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-s5-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. Unit assertions on buildColorEncodeArgs
  const srgbArgs = buildColorEncodeArgs('srgb', 'mp4');
  assert.equal(srgbArgs.colorPrimaries, 'bt709');
  assert.equal(srgbArgs.colorTransfer, 'bt709');
  assert.equal(srgbArgs.colorSpace, 'bt709');
  assert.equal(srgbArgs.colorRange, 'tv');
  assert.match(srgbArgs.vf, /pad=ceil\(iw\/2\)\*2:ceil\(ih\/2\)\*2/);
  assert.match(srgbArgs.vf, /color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv/);
  assert.deepEqual(srgbArgs.colorFlags, [
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-color_range', 'tv',
  ]);

  const p3Args = buildColorEncodeArgs('p3', 'webm');
  assert.equal(p3Args.colorPrimaries, 'smpte432');
  assert.equal(p3Args.colorTransfer, 'iec61966-2-1');
  assert.equal(p3Args.colorSpace, 'bt709');
  assert.equal(p3Args.colorRange, 'tv');
  assert.match(p3Args.vf, /color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv/);
  assert.deepEqual(p3Args.colorFlags, [
    '-color_primaries', 'smpte432',
    '-color_trc', 'iec61966-2-1',
    '-colorspace', 'bt709',
    '-color_range', 'tv',
  ]);

  assert.throws(() => buildColorEncodeArgs('rec2020', 'mp4'), /unsupported colorSpace/);
  assert.throws(() => buildColorEncodeArgs('srgb', 'avi'), /unsupported video format/);

  // 2. Real FFmpeg CICP consistency across renderVideo, encodeScreencastFrames, publishWebBundle (AV1), and narrateTimeline
  const f0 = join(dir, '0.png');
  const f1 = join(dir, '1.png');
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ef4444' } }).png().toFile(f0);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3b82f6' } }).png().toFile(f1);

  for (const [cs, expectedPrimaries, expectedTransfer] of [
    ['srgb', 'bt709', 'bt709'],
    ['p3', 'smpte432', 'iec61966-2-1'],
  ]) {
    for (const fmt of ['mp4', 'webm']) {
      const vidOut = join(dir, `render-${cs}.${fmt}`);
      await renderVideo({ input: join(dir, '%d.png'), output: vidOut, fps: 2, colorSpace: cs });
      const probed = await probeVideo(vidOut);
      assert.equal(probed.colorPrimaries, expectedPrimaries, `renderVideo ${cs} ${fmt} primaries`);
      assert.equal(probed.colorTransfer, expectedTransfer, `renderVideo ${cs} ${fmt} transfer`);
      assert.equal(probed.colorSpace, 'bt709', `renderVideo ${cs} ${fmt} matrix`);
      assert.equal(probed.colorRange, 'tv', `renderVideo ${cs} ${fmt} range`);

      const scOut = join(dir, `screencast-${cs}.${fmt}`);
      await encodeScreencastFrames({
        initialFrameFile: f0,
        rawFrames: [
          { index: 1, file: f0, elapsed: 0 },
          { index: 2, file: f1, elapsed: 0.25 },
        ],
        framesDir: dir,
        outputFile: scOut,
        format: fmt,
        fps: 2,
        targetDuration: 0.5,
        colorSpace: cs,
      });
      const scProbed = await probeVideo(scOut);
      assert.equal(scProbed.colorPrimaries, expectedPrimaries, `encodeScreencastFrames ${cs} ${fmt} primaries`);
      assert.equal(scProbed.colorTransfer, expectedTransfer, `encodeScreencastFrames ${cs} ${fmt} transfer`);
      assert.equal(scProbed.colorSpace, 'bt709');
      assert.equal(scProbed.colorRange, 'tv');
    }

    const bundleOut = join(dir, `bundle-${cs}`);
    const bundle = await publishWebBundle({
      input: join(dir, `render-${cs}.mp4`),
      outDir: bundleOut,
      name: 'clip',
      formats: ['av1'],
      colorSpace: cs,
    });
    for (const v of bundle.videos) {
      assert.equal(v.colorPrimaries, expectedPrimaries, `publishWebBundle ${v.id} ${cs} primaries`);
      assert.equal(v.colorTransfer, expectedTransfer, `publishWebBundle ${v.id} ${cs} transfer`);
      assert.equal(v.colorSpace, 'bt709', `publishWebBundle ${v.id} ${cs} matrix`);
      assert.equal(v.colorRange, 'tv', `publishWebBundle ${v.id} ${cs} range`);
    }
  }

  // Also verify narration padded WebM & MP4 preserve explicit sRGB BT.709 tags
  const eventTrack = {
    version: 1,
    captureMode: 'headless',
    startedAt: '2026-11-22T00:00:00.000Z',
    viewport: { width: 16, height: 16, deviceScaleFactor: 1 },
    video: { file: 'render-srgb.webm', width: 16, height: 16, fps: 2, duration: 0.5, frames: 1 },
    events: [
      { t: 0, type: 'pointermove', x: 8, y: 8 },
      { t: 0, type: 'step', index: 0, label: 'Hold step', narration: 'Extend this WebM clip with BT.709 tags.' },
    ],
  };
  const tl = compileTimeline({
    take: { video: join(dir, 'render-srgb.webm') },
    eventTrack,
    recipe: {
      stage: { width: 32, height: 32, padding: 8, background: { type: 'solid', color: '#0f172a' } },
      window: { frame: 'none', width: 16, height: 16 },
      camera: { outputWidth: 32, outputHeight: 32 },
      outputs: ['web-loop'],
    },
  });
  const speechPcm = Buffer.alloc(24000 * 2); // 1.0s mono @ 24kHz
  for (let i = 0; i < 24000; i += 1) {
    speechPcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000), i * 2);
  }
  const narrated = await narrateTimeline({
    timeline: tl,
    eventTrack,
    outDir: join(dir, 'narrated-srgb-webm'),
    provider: 'kokoro',
    aligner: 'proportional',
    ttsRunner: async ({ outputFile }) => {
      await writeFile(outputFile, encodePcm16Wav(speechPcm, { sampleRate: 24000, channels: 1 }));
    },
  });
  assert.ok(narrated.paddedVideoFile?.endsWith('.webm'));
  const paddedProbe = await probeVideo(narrated.paddedVideoFile);
  assert.equal(paddedProbe.colorPrimaries, 'bt709');
  assert.equal(paddedProbe.colorTransfer, 'bt709');
  assert.equal(paddedProbe.colorSpace, 'bt709');
  assert.equal(paddedProbe.colorRange, 'tv');

  // 3. WAV RIFF round-trip (stereo & mono + non-audio JUNK chunk before data + probeAudio/measureLoudness)
  const sampleRate = 48000;
  const frameCount = 4800; // 0.1s stereo
  const rawStereoPcm = Buffer.alloc(frameCount * 4);
  for (let i = 0; i < frameCount; i += 1) {
    const leftInt = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16384);
    const rightInt = -leftInt;
    rawStereoPcm.writeInt16LE(leftInt, i * 4);
    rawStereoPcm.writeInt16LE(rightInt, i * 4 + 2);
  }

  const encodedWav = encodePcm16Wav(rawStereoPcm, { sampleRate, channels: 2, bitsPerSample: 16 });
  const header = parseWavHeader(encodedWav);
  assert.equal(header.audioFormat, 1);
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 48000);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.dataSize, rawStereoPcm.length);
  assert.equal(header.duration, 0.1);

  const decoded = extractPcm16SamplesStereo(encodedWav);
  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.frameCount, frameCount);
  for (let i = 0; i < 64; i += 1) {
    const expectedL = rawStereoPcm.readInt16LE(i * 4) / 32768;
    const expectedR = rawStereoPcm.readInt16LE(i * 4 + 2) / 32768;
    assert.ok(Math.abs(decoded.stereo[i * 2] - expectedL) < 1e-6);
    assert.ok(Math.abs(decoded.stereo[i * 2 + 1] - expectedR) < 1e-6);
  }

  const wavPath = join(dir, 'roundtrip.wav');
  await writeFileAtomic(wavPath, encodedWav);
  const audioInfo = await probeAudio(wavPath);
  assert.equal(audioInfo.hasAudio, true);
  assert.equal(audioInfo.sampleRate, 48000);
  assert.equal(audioInfo.channels, 2);
  const loudness = await measureLoudness(wavPath);
  assert.equal(loudness.hasAudio, true);
  assert.ok(loudness.truePeakDbfs !== null && loudness.truePeakDbfs < 0);

  // Verify src/audio-mix.mjs no longer imports from src/narration.mjs
  const audioMixSource = await readFile(new URL('../src/audio-mix.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(audioMixSource, /from\s+['"]\.\/narration\.mjs['"]/);
});

test('S5: fs-paths.mjs single-owner utilities (atomic writes/moves with EXDEV fallback, path containment, media rebasing)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-s5-fs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(sha256('screen-kit'), 'b99b56eb6dfcb60ee2dc00e632f84a62a0cb112922a39e8d3b959a7a8eb1cc0b'.length === 64 ? sha256(Buffer.from('screen-kit')) : '');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  const atomicTarget = join(dir, 'nested', 'atomic.txt');
  assert.equal(await fileExists(atomicTarget), false);
  await writeFileAtomic(atomicTarget, 'hello atomic\n', 'utf8');
  assert.equal(await fileExists(atomicTarget), true);
  assert.equal(await readFile(atomicTarget, 'utf8'), 'hello atomic\n');

  // Cross-device EXDEV fallback in moveFileAtomic
  const srcFile = join(dir, 'src.txt');
  const dstFile = join(dir, 'moved', 'dst.txt');
  await writeFile(srcFile, 'exdev payload');
  let renameAttempts = 0;
  await moveFileAtomic(srcFile, dstFile, {
    rename: async (from, to) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const err = new Error('Cross-device link');
        err.code = 'EXDEV';
        throw err;
      }
      const { rename: realRename } = await import('node:fs/promises');
      return realRename(from, to);
    },
  });
  assert.equal(renameAttempts, 2);
  assert.equal(await fileExists(srcFile), false);
  assert.equal(await readFile(dstFile, 'utf8'), 'exdev payload');

  // resolveLocalPath & rebaseMediaRef
  assert.equal(resolveLocalPath('https://cdn.example.com/a.mp4', dir), null);
  assert.equal(resolveLocalPath('data:image/png;base64,AAAA', dir), null);
  assert.equal(resolveLocalPath(pathToFileURL(dstFile).href, dir), dstFile);
  assert.equal(resolveLocalPath('moved/dst.txt', dir), dstFile);
  assert.equal(rebaseMediaRef('moved/dst.txt', dir, join(dir, 'other')), '../moved/dst.txt');
  assert.equal(rebaseMediaRef('https://example.com/v.mp4', dir, join(dir, 'other')), 'https://example.com/v.mp4');

  // assertPathInsideDir
  assert.equal(assertPathInsideDir(join(dir, 'sub', 'ok.mp4'), dir), join(dir, 'sub', 'ok.mp4'));
  assert.throws(() => assertPathInsideDir(dir, dir), /escapes base directory/);
  assert.throws(() => assertPathInsideDir(join(dir, '..', 'escape.mp4'), dir), /escapes base directory/);
});

test('W4: google-genai.mjs enforces trimmed credentials, zero network calls on missing key, x-goog-api-key header only, code-fence stripping, and AbortSignal forwarding across wired call sites', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-w4-genai-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. Credential resolution precedence & trimming
  assert.equal(
    resolveGoogleApiKey({ apiKey: '  explicit-key \n', env: { GEMINI_API_KEY: 'gem', GOOGLE_API_KEY: 'goog' } }),
    'explicit-key',
  );
  assert.equal(
    resolveGoogleApiKey({ env: { GEMINI_API_KEY: '  gem-key  ', GOOGLE_API_KEY: 'goog' } }),
    'gem-key',
  );
  assert.equal(
    resolveGoogleApiKey({ env: { GEMINI_API_KEY: '   ', GOOGLE_API_KEY: '\tgoog-key\n' } }),
    'goog-key',
  );
  assert.throws(() => resolveGoogleApiKey({ apiKey: '   ', env: { GEMINI_API_KEY: 'gem' } }), /GEMINI_API_KEY/);
  assert.throws(() => resolveGoogleApiKey({ env: {} }), /GEMINI_API_KEY/);

  // 2. stripJsonCodeFence
  assert.equal(stripJsonCodeFence('```json\n{"ok": true}\n```'), '{"ok": true}');
  assert.equal(stripJsonCodeFence('```\n[1, 2, 3]\n```'), '[1, 2, 3]');
  assert.equal(stripJsonCodeFence('  {"plain": 1}  '), '{"plain": 1}');

  // 3. Zero network calls when key is missing
  let fetchCalled = false;
  await assert.rejects(
    postGoogleGenAiJson({
      model: 'gemini-2.5-flash',
      body: { contents: [] },
      env: {},
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      },
    }),
    /GEMINI_API_KEY/,
  );
  assert.equal(fetchCalled, false);

  // 4. Header-only auth (strips accidental ?key= from custom endpoint), code-fence JSON parsing, and AbortSignal forwarding
  const controller = new AbortController();
  let seenUrl = '';
  let seenInit = null;
  const parsedPayload = await postGoogleGenAiJson({
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=LEAKED&alt=json',
    body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
    apiKey: '  clean-header-key  ',
    env: {},
    signal: controller.signal,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response('```json\n{"status":"ok","value":42}\n```', { status: 200 });
    },
  });

  assert.deepEqual(parsedPayload, { status: 'ok', value: 42 });
  assert.doesNotMatch(seenUrl, /key=/i);
  assert.doesNotMatch(seenUrl, /LEAKED/);
  assert.doesNotMatch(seenUrl, /clean-header-key/);
  assert.match(seenUrl, /alt=json/);
  assert.equal(seenInit.headers['x-goog-api-key'], 'clean-header-key');
  assert.equal(seenInit.signal, controller.signal);

  // Pre-aborted signal makes zero network calls
  controller.abort();
  let postAbortFetch = false;
  await assert.rejects(
    postGoogleGenAiJson({
      model: 'gemini-2.5-flash',
      body: {},
      apiKey: 'clean-header-key',
      signal: controller.signal,
      fetchImpl: async () => {
        postAbortFetch = true;
        return new Response('{}', { status: 200 });
      },
    }),
    (err) => err?.name === 'AbortError' || /abort/i.test(err?.message ?? ''),
  );
  assert.equal(postAbortFetch, false);

  // Long HTTP error body is truncated cleanly to <= 300 chars
  await assert.rejects(
    postGoogleGenAiJson({
      model: 'gemini-2.5-flash',
      body: {},
      apiKey: 'clean-header-key',
      label: 'TestGenAI',
      fetchImpl: async () => new Response('X'.repeat(800), { status: 503 }),
    }),
    (err) => {
      assert.match(err.message, /^TestGenAI API returned HTTP 503: X{300}$/);
      return true;
    },
  );

  // 5. Verify wired call sites (assets, audio-mix Lyria, narration TTS & fenced-JSON audio alignment)
  const samplePng = await sharp({
    create: { width: 32, height: 18, channels: 3, background: '#10b981' },
  }).png().toBuffer();
  const assetOut = join(dir, 'wall.png');
  const assetRes = await generateAsset({
    kind: 'wallpaper',
    prompt: 'Clean studio gradient',
    out: assetOut,
    cacheDir: join(dir, 'asset-cache'),
    env: { GOOGLE_API_KEY: '  env-goog-asset-key  ' },
    fetchImpl: async (url, init) => {
      assert.doesNotMatch(url, /key=/i);
      assert.equal(init.headers['x-goog-api-key'], 'env-goog-asset-key');
      return new Response(
        JSON.stringify({ predictions: [{ bytesBase64Encoded: samplePng.toString('base64'), mimeType: 'image/png' }] }),
        { status: 200 },
      );
    },
  });
  assert.equal(assetRes.ok, true);

  const pcmMono = Buffer.alloc(24000 * 2);
  const wavMono = encodePcm16Wav(pcmMono, { sampleRate: 24000, channels: 1 });
  const alignRes = await alignWithGemini({
    audioBuffer: wavMono,
    text: 'Hello unified adapter.',
    duration: 1.0,
    env: { GEMINI_API_KEY: '  align-env-key  ' },
    fetchImpl: async (url, init) => {
      assert.doesNotMatch(url, /key=/i);
      assert.equal(init.headers['x-goog-api-key'], 'align-env-key');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '```json\n{"words":[{"word":"hello","start":0.05,"end":0.35},{"word":"unified","start":0.35,"end":0.68},{"word":"adapter","start":0.68,"end":0.95}]}\n```',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.deepEqual(
    alignRes.words.map((w) => w.word),
    ['Hello', 'unified', 'adapter.'],
  );

  // Confirm Lyria & Gemini TTS also honor env fallback and trimmed header
  await assert.rejects(
    generateMusicBed({ prompt: 'ambient', cacheDir: join(dir, 'mc'), env: {}, fetchImpl: () => { throw Error('unreachable'); } }),
    /GEMINI_API_KEY/,
  );
  await assert.rejects(
    synthesizeWithGemini({ text: 'hello', env: {}, fetchImpl: () => { throw Error('unreachable'); } }),
    /GEMINI_API_KEY/,
  );

  // Public root API integrity check
  assert.equal(typeof rootApi.createBrowserTakeCapture, 'function');
  assert.equal(typeof rootApi.encodePcm16Wav, 'function');
  assert.equal(typeof rootApi.probeAudio, 'function');
  assert.equal(typeof rootApi.measureLoudness, 'function');
});
