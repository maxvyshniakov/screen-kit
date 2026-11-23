import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import * as rootApi from '../src/index.mjs';
import {
  DEFAULT_DUCK_UNDER_SPEECH_DB,
  DEFAULT_LYRIA_MODEL,
  DEFAULT_MUSIC_LUFS,
  DEFAULT_SPEECH_MUSIC_LUFS,
  buildDuckingVolumeExpression,
  collectUiSfxEvents,
  computeMusicCacheKey,
  generateMusicBed,
  generateUiSfx,
  measureSegmentRmsDb,
  mixTimelineAudio,
  muxAudioIntoVideo,
  prepareMusicBed,
  resolveSpeechWindows,
} from '../src/audio-mix.mjs';
import {
  DEFAULT_LOUDNESS_BOUNDS,
  encodePcm16Wav,
  measureLoudness,
  probeAudio,
  reviewNarration,
} from '../src/narration.mjs';
import { reviewVideo } from '../src/review-video.mjs';
import { compileTimeline, validateTimeline } from '../src/timeline.mjs';

const exec = promisify(execFile);

async function runFfmpeg(args) {
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    timeout: 60000,
    maxBuffer: 10e6,
  });
}

function makeStereoSinePcm16({ duration = 1.5, sampleRate = 48000, freqL = 220, freqR = 330, amplitude = 0.22 } = {}) {
  const frames = Math.round(duration * sampleRate);
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const l = Math.sin((2 * Math.PI * freqL * i) / sampleRate) * amplitude;
    const r = Math.sin((2 * Math.PI * freqR * i) / sampleRate) * amplitude;
    pcm.writeInt16LE(Math.round(l * 32767), i * 4);
    pcm.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
  }
  return pcm;
}

function makeInteractiveTimeline({ video = 'demo.mp4', duration = 5.0, fps = 30 } = {}) {
  const eventTrack = {
    version: 1,
    captureMode: 'headless',
    viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
    video: { file: video, width: 320, height: 180, fps, duration, frames: Math.round(duration * fps) },
    events: [
      { t: 0.0, type: 'pointermove', x: 80, y: 60 },
      { t: 0.6, type: 'pointerdown', x: 120, y: 80, button: 'left' },
      { t: 0.7, type: 'pointerup', x: 120, y: 80, button: 'left' },
      { t: 2.1, type: 'key', key: 'k', modifiers: ['Meta'], action: 'press', duration: 0.4 },
      { t: 3.6, type: 'pointerdown', x: 220, y: 120, button: 'right' },
      { t: 3.7, type: 'pointerup', x: 220, y: 120, button: 'right' },
    ],
  };

  return compileTimeline({
    take: { video, eventTrack: 'event-track.json' },
    eventTrack,
    recipe: {
      stage: {
        width: 400,
        height: 240,
        padding: 30,
        background: { type: 'solid', color: '#0f172a' },
      },
      window: { frame: 'none', width: 320, height: 180 },
      camera: { outputWidth: 320, outputHeight: 180 },
      outputs: ['web-loop'],
    },
  });
}

test('audio-mix exports cleanly from subpath ./audio-mix and root src/index.mjs', async () => {
  const subpath = await import('screen-kit/audio-mix');
  assert.equal(subpath.generateUiSfx, generateUiSfx);
  assert.equal(subpath.generateMusicBed, generateMusicBed);
  assert.equal(subpath.mixTimelineAudio, mixTimelineAudio);
  assert.equal(rootApi.generateUiSfx, generateUiSfx);
  assert.equal(rootApi.generateMusicBed, generateMusicBed);
  assert.equal(rootApi.mixTimelineAudio, mixTimelineAudio);
  assert.equal(rootApi.prepareMusicBed, prepareMusicBed);
  assert.equal(rootApi.muxAudioIntoVideo, muxAudioIntoVideo);
  assert.equal(DEFAULT_MUSIC_LUFS, -18);
  assert.equal(DEFAULT_SPEECH_MUSIC_LUFS, -30);
  assert.equal(DEFAULT_DUCK_UNDER_SPEECH_DB, -10);
});

test('procedural UI SFX synthesis and strict timestamp placement at overlays.ripples and overlays.keystrokes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-sfx-'));
  try {
    const sfx = await generateUiSfx({ outDir: join(dir, 'sfx') });
    await access(sfx.clickFile);
    await access(sfx.secondaryClickFile);
    await access(sfx.keystrokeFile);

    const clickProbe = await probeAudio(sfx.clickFile);
    const keyProbe = await probeAudio(sfx.keystrokeFile);
    assert.equal(clickProbe.hasAudio, true);
    assert.equal(clickProbe.channels, 2);
    assert.equal(clickProbe.sampleRate, 48000);
    assert.ok(clickProbe.duration >= 0.03 && clickProbe.duration <= 0.08);
    assert.equal(keyProbe.hasAudio, true);
    assert.ok(keyProbe.duration >= 0.03 && keyProbe.duration <= 0.08);

    const timeline = makeInteractiveTimeline({ duration: 5.0 });
    // Ripples at 0.6s (left) & 3.6s (right); keystroke at 2.1s (⌘K)
    const events = collectUiSfxEvents(timeline);
    assert.deepEqual(
      events.map((e) => ({ kind: e.kind, variant: e.variant, t: e.t })),
      [
        { kind: 'click', variant: 'click', t: 0.6 },
        { kind: 'keystroke', variant: 'keystroke', t: 2.1 },
        { kind: 'click', variant: 'secondaryClick', t: 3.6 },
      ]
    );

    const sfxMixFile = join(dir, 'sfx-only.wav');
    const mixResult = await mixTimelineAudio({
      timeline,
      sfx: true,
      outFile: sfxMixFile,
    });

    assert.equal(mixResult.ok, true, JSON.stringify(mixResult.loudnessIssues));
    assert.equal(mixResult.sfx.count, 3);
    assert.equal(mixResult.sfx.clicks, 2);
    assert.equal(mixResult.sfx.keystrokes, 1);
    assert.ok(mixResult.loudness.truePeakDbfs <= DEFAULT_LOUDNESS_BOUNDS.maxTruePeakDbfs);
    assert.equal(validateTimeline(mixResult.timeline).ok, true);

    // Verify acoustic energy exists strictly at ripple/keystroke timestamps and silence elsewhere
    const rmsSilentBefore = await measureSegmentRmsDb(sfxMixFile, 0.05, 0.45);
    const rmsClick1 = await measureSegmentRmsDb(sfxMixFile, 0.58, 0.68);
    const rmsSilentMid = await measureSegmentRmsDb(sfxMixFile, 1.0, 1.8);
    const rmsKeystroke = await measureSegmentRmsDb(sfxMixFile, 2.08, 2.18);
    const rmsSilentLate = await measureSegmentRmsDb(sfxMixFile, 2.5, 3.3);
    const rmsClick2 = await measureSegmentRmsDb(sfxMixFile, 3.58, 3.68);

    assert.equal(rmsSilentBefore, -Infinity);
    assert.equal(rmsSilentMid, -Infinity);
    assert.equal(rmsSilentLate, -Infinity);
    assert.ok(rmsClick1 > -40 && rmsClick1 < -10, `expected subtle click transient, got ${rmsClick1} dBFS`);
    assert.ok(rmsKeystroke > -42 && rmsKeystroke < -10, `expected subtle keystroke transient, got ${rmsKeystroke} dBFS`);
    assert.ok(rmsClick2 > -42 && rmsClick2 < -10, `expected subtle right-click transient, got ${rmsClick2} dBFS`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prepareMusicBed loops short music, trims long music, calibrates loudness, and applies smooth fade-in/fade-out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-music-loop-'));
  try {
    const shortLoopSrc = join(dir, 'short-0.8s.wav');
    const longSrc = join(dir, 'long-7s.wav');

    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.8:sample_rate=48000',
        '-af', 'volume=-6dB',
        '-c:a', 'pcm_s16le',
        shortLoopSrc,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=260:duration=7.0:sample_rate=48000',
        '-af', 'volume=-3dB',
        '-c:a', 'pcm_s16le',
        longSrc,
      ]),
    ]);

    // 1. Short 0.8s bed seamlessly looped to 4.0s with 0.5s fade-in and 0.7s fade-out
    const loopedOut = join(dir, 'looped-4s.wav');
    const looped = await prepareMusicBed({
      src: shortLoopSrc,
      outputFile: loopedOut,
      duration: 4.0,
      fadeIn: 0.5,
      fadeOut: 0.7,
      targetLufs: -18,
    });
    assert.equal(looped.looped, true);
    assert.equal(looped.trimmed, false);
    assert.ok(Math.abs(looped.duration - 4.0) < 0.05);

    const startFadeRms = await measureSegmentRmsDb(loopedOut, 0.0, 0.15);
    const steadyMidRms = await measureSegmentRmsDb(loopedOut, 1.2, 2.8);
    const endFadeRms = await measureSegmentRmsDb(loopedOut, 3.82, 4.0);
    assert.ok(startFadeRms < steadyMidRms - 8, `expected fade-in start (${startFadeRms}) < steady (${steadyMidRms})`);
    assert.ok(endFadeRms < steadyMidRms - 8, `expected fade-out end (${endFadeRms}) < steady (${steadyMidRms})`);

    const loopedLoudness = await measureLoudness(loopedOut);
    assert.ok(
      loopedLoudness.integratedLufs >= -21 && loopedLoudness.integratedLufs <= -16,
      `expected ~-18 LUFS bed, got ${loopedLoudness.integratedLufs}`
    );

    // 2. Long 7.0s bed trimmed cleanly to 2.5s
    const trimmedOut = join(dir, 'trimmed-2.5s.wav');
    const trimmed = await prepareMusicBed({
      src: longSrc,
      outputFile: trimmedOut,
      duration: 2.5,
      fadeIn: 0.3,
      fadeOut: 0.4,
    });
    assert.equal(trimmed.looped, false);
    assert.equal(trimmed.trimmed, true);
    assert.ok(Math.abs(trimmed.duration - 2.5) < 0.05);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('automatic voice ducking (envelope and sidechain) attenuates music under speech, recovers in silent gaps, and passes ebur128 + reviewVideo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-ducking-'));
  try {
    const musicSrc = join(dir, 'music-bed.wav');
    const speechStep0 = join(dir, 'speech-0.wav');
    const speechStep1 = join(dir, 'speech-1.wav');
    const demoVideo = join(dir, 'clean-video.mp4');

    // Music at 180 Hz, voice clips at 520 Hz (+6 dB ~ -15.7 LUFS)
    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=180:duration=2.0:sample_rate=48000',
        '-c:a', 'pcm_s16le',
        musicSrc,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=520:duration=1.2:sample_rate=24000',
        '-af', 'volume=+6dB',
        '-c:a', 'pcm_s16le',
        speechStep0,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=520:duration=1.1:sample_rate=24000',
        '-af', 'volume=+6dB',
        '-c:a', 'pcm_s16le',
        speechStep1,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6.0',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
        demoVideo,
      ]),
    ]);

    // Timeline 6.0s:
    // - [0.0..1.0): silent gap (music unducked ~ -18 LUFS)
    // - [1.0..2.2]: speech 0 (music ducked by -10 dB)
    // - [2.2..4.2]: 2.0s silent gap (music smoothly recovers to ~ -18 LUFS!)
    // - [4.2..5.3]: speech 1 (music ducked by -10 dB again)
    const timeline = makeInteractiveTimeline({ video: demoVideo, duration: 6.0 });
    timeline.steps = [
      { t: 0.8, index: 0, label: 'Explain palette' },
      { t: 4.0, index: 1, label: 'Trigger shortcut' },
    ];
    timeline.audio.tracks = [
      { id: 'narr-0', kind: 'narration', src: speechStep0, start: 1.0, volume: 1 },
      { id: 'narr-1', kind: 'narration', src: speechStep1, start: 4.2, volume: 1 },
    ];
    timeline.overlays.captions = {
      enabled: true,
      tracks: [
        {
          language: 'en',
          cues: [
            { start: 1.0, end: 2.2, text: 'Inspect the node.' },
            { start: 4.2, end: 5.3, text: 'Open quick actions.' },
          ],
        },
      ],
    };

    const windows = await resolveSpeechWindows({ timeline, totalDuration: 6.0 });
    assert.deepEqual(windows, [
      { start: 1.0, end: 2.2, duration: 1.2 },
      { start: 4.2, end: 5.3, duration: 1.1 },
    ]);
    const expr = buildDuckingVolumeExpression(windows, { duckDb: -10, attack: 0.18, release: 0.4 });
    assert.match(expr, /pow\(10,\(-10\*/);

    // 1. Envelope ducking + UI SFX + mux into MP4
    const envOutDir = join(dir, 'mix-envelope');
    const muxedMp4 = join(dir, 'demo-mixed.mp4');
    const envMix = await mixTimelineAudio({
      timeline,
      music: { src: musicSrc, fadeIn: 0.25, fadeOut: 0.35, targetLufs: -18 },
      sfx: true,
      outDir: envOutDir,
      duckUnderSpeechDb: -10,
      duckAttack: 0.18,
      duckRelease: 0.4,
      duckingMode: 'envelope',
      keepStems: true,
      videoFile: demoVideo,
      muxOutFile: muxedMp4,
    });

    assert.equal(envMix.ok, true, JSON.stringify(envMix.loudnessIssues));
    assert.equal(envMix.ducking.applied, true);
    assert.equal(envMix.ducking.mode, 'envelope');

    // Measure music stem RMS strictly during speech [1.15..2.05] vs silent gap [2.8..3.8]
    const musicStem = envMix.music.stemFile;
    const speechMusicRms = await measureSegmentRmsDb(musicStem, 1.15, 2.05);
    const gapMusicRms = await measureSegmentRmsDb(musicStem, 2.8, 3.8);
    const secondSpeechMusicRms = await measureSegmentRmsDb(musicStem, 4.35, 5.15);

    assert.ok(
      gapMusicRms - speechMusicRms >= 8.5 && gapMusicRms - speechMusicRms <= 11.5,
      `expected ~10 dB ducking attenuation in speech 0, got gap=${gapMusicRms} dB vs speech=${speechMusicRms} dB`
    );
    assert.ok(
      gapMusicRms - secondSpeechMusicRms >= 8.5,
      `expected ~10 dB ducking attenuation in speech 1, got gap=${gapMusicRms} dB vs speech=${secondSpeechMusicRms} dB`
    );

    // Verify ebur128 loudness bounds on mixed audio & updated timeline via reviewNarration + reviewVideo
    assert.equal(envMix.loudness.isSilent, false);
    assert.ok(
      envMix.loudness.integratedLufs >= DEFAULT_LOUDNESS_BOUNDS.minLufs &&
        envMix.loudness.integratedLufs <= DEFAULT_LOUDNESS_BOUNDS.maxLufs,
      `mixed LUFS out of bounds: ${envMix.loudness.integratedLufs}`
    );
    assert.ok(
      envMix.loudness.truePeakDbfs <= DEFAULT_LOUDNESS_BOUNDS.maxTruePeakDbfs,
      `true peak exceeded ceiling: ${envMix.loudness.truePeakDbfs}`
    );

    const narrCheck = await reviewNarration({ timeline: envMix.timeline });
    assert.equal(narrCheck.ok, true, JSON.stringify(narrCheck.findings, null, 2));

    const videoCheck = await reviewVideo({
      video: muxedMp4,
      timeline: envMix.timeline,
    });
    assert.equal(videoCheck.ok, true, JSON.stringify(videoCheck.findings, null, 2));
    assert.equal(videoCheck.metrics.audio, true);
    assert.equal(videoCheck.checks.find((c) => c.name === 'audio-loudness')?.ok, true);

    // 2. Sidechain compressor ducking mode (`sidechaincompress`) also attenuates music under speech
    const scOutDir = join(dir, 'mix-sidechain');
    const scMix = await mixTimelineAudio({
      timeline,
      music: { src: musicSrc, fadeIn: 0.2, fadeOut: 0.3, targetLufs: -18 },
      sfx: false,
      outDir: scOutDir,
      duckingMode: 'sidechain',
      duckAttack: 0.02,
      duckRelease: 0.3,
      keepStems: true,
    });
    assert.equal(scMix.ok, true, JSON.stringify(scMix.loudnessIssues));
    assert.equal(scMix.ducking.applied, true);
    assert.equal(scMix.ducking.mode, 'sidechain');

    const scSpeechRms = await measureSegmentRmsDb(scMix.music.stemFile, 1.2, 2.1);
    const scGapRms = await measureSegmentRmsDb(scMix.music.stemFile, 2.8, 3.8);
    assert.ok(
      scGapRms - scSpeechRms >= 5.0,
      `expected sidechaincompress to duck music during speech, got gap=${scGapRms} dB vs speech=${scSpeechRms} dB`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Google Lyria opt-in music bed generation enforces x-goog-api-key header, prompt-hash cache, missing-key rejection, and never runs implicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-lyria-'));
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    const cacheDir = join(dir, 'lyria-cache');

    // 1. Missing API key rejects cleanly with zero network calls
    let unauthenticatedFetchCalled = false;
    await assert.rejects(
      () =>
        generateMusicBed({
          prompt: 'Minimal warm electronic ambient pulse',
          cacheDir,
          fetchImpl: async () => {
            unauthenticatedFetchCalled = true;
            throw Error('fetch should not run without credentials');
          },
        }),
      /GEMINI_API_KEY/i
    );
    assert.equal(unauthenticatedFetchCalled, false);

    // 2. Passing prompt without explicit provider='lyria' in mixTimelineAudio rejects (never implicit)
    const timeline = makeInteractiveTimeline({ duration: 2.0 });
    await assert.rejects(
      () =>
        mixTimelineAudio({
          timeline,
          music: { prompt: 'Accidental cloud call' },
          outFile: join(dir, 'blocked.wav'),
        }),
      /opt-in/i
    );

    // 3. Mocked Lyria API call verifies x-goog-api-key header, no key in URL, PCM decoding, and cache reuse
    const pcmStereo = makeStereoSinePcm16({ duration: 2.5, sampleRate: 48000, amplitude: 0.2 });
    let fetchCalls = 0;
    let lastUrl = '';
    let lastHeaders = null;
    let lastBody = null;

    const mockFetch = async (url, init) => {
      fetchCalls += 1;
      lastUrl = url;
      lastHeaders = init.headers;
      lastBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/L16;codec=pcm;rate=48000;channels=2',
                      data: pcmStereo.toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        }),
      };
    };

    const firstGen = await generateMusicBed({
      prompt: 'Soft modern ambient marimba and synth pad',
      bpm: 96,
      duration: 2.5,
      cacheDir,
      outputFile: join(dir, 'bed-first.wav'),
      apiKey: 'lyria-secret-test-key',
      fetchImpl: mockFetch,
    });

    assert.equal(fetchCalls, 1);
    assert.equal(firstGen.cached, false);
    assert.equal(firstGen.provider, 'lyria');
    assert.equal(firstGen.model, DEFAULT_LYRIA_MODEL);
    assert.doesNotMatch(lastUrl, /key=/i);
    assert.doesNotMatch(lastUrl, /lyria-secret-test-key/);
    assert.equal(lastHeaders['x-goog-api-key'], 'lyria-secret-test-key');
    assert.match(lastBody.contents[0].parts[0].text, /96 BPM/);
    assert.equal(
      firstGen.cacheKey,
      computeMusicCacheKey({
        prompt: 'Soft modern ambient marimba and synth pad',
        bpm: 96,
        duration: 2.5,
      })
    );

    const firstProbed = await probeAudio(firstGen.file);
    assert.equal(firstProbed.hasAudio, true);
    assert.equal(firstProbed.sampleRate, 48000);
    assert.equal(firstProbed.channels, 2);
    assert.ok(Math.abs(firstProbed.duration - 2.5) < 0.05);

    // Second call with identical prompt + params hits cache (`cached: true`), zero additional fetch calls!
    const secondGen = await generateMusicBed({
      prompt: '  Soft modern ambient marimba and synth pad  ',
      bpm: 96,
      duration: 2.5,
      cacheDir,
      outputFile: join(dir, 'bed-second.wav'),
      fetchImpl: async () => {
        throw Error('should have served from cache without calling fetchImpl');
      },
    });
    assert.equal(secondGen.cached, true);
    assert.equal(secondGen.cacheKey, firstGen.cacheKey);
    assert.equal(fetchCalls, 1);

    // Also works seamlessly inside mixTimelineAudio when provider: 'lyria' is explicitly passed
    const wavPayload = encodePcm16Wav(pcmStereo, { sampleRate: 48000, channels: 2 });
    const lyriaMix = await mixTimelineAudio({
      timeline,
      music: {
        provider: 'lyria',
        prompt: 'Bright clean plucked synth loop',
        cacheDir,
        apiKey: 'lyria-secret-test-key',
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            output_audio: { mimeType: 'audio/wav', data: wavPayload.toString('base64') },
          }),
        }),
      },
      sfx: true,
      outFile: join(dir, 'lyria-mixed.wav'),
    });

    assert.equal(lyriaMix.ok, true, JSON.stringify(lyriaMix.loudnessIssues));
    assert.equal(lyriaMix.music.provider, 'lyria');
    assert.equal(lyriaMix.music.cached, false);
  } finally {
    if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
    if (prevGoogle !== undefined) process.env.GOOGLE_API_KEY = prevGoogle;
    await rm(dir, { recursive: true, force: true });
  }
});

test('mixTimelineAudio defaults music bed to quiet -30 LUFS under narration while keeping music-only videos at -18 LUFS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-speech-music-lufs-'));
  try {
    const musicSrc = join(dir, 'bed.wav');
    const speechSrc = join(dir, 'speech.wav');
    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=200:duration=4.0:sample_rate=48000',
        '-c:a', 'pcm_s16le', musicSrc,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=520:duration=1.2:sample_rate=24000',
        '-af', 'volume=+6dB',
        '-c:a', 'pcm_s16le', speechSrc,
      ]),
    ]);

    // 1. Music-only timeline uses DEFAULT_MUSIC_LUFS (-18 LUFS)
    const silentVisualTimeline = makeInteractiveTimeline({ duration: 4.0 });
    const musicOnlyMix = await mixTimelineAudio({
      timeline: silentVisualTimeline,
      music: musicSrc,
      outDir: join(dir, 'music-only'),
      keepStems: true,
    });
    assert.equal(musicOnlyMix.ok, true);

    // 2. Narrated timeline uses DEFAULT_SPEECH_MUSIC_LUFS (-30 LUFS) when targetLufs/musicLufs is omitted
    const narratedTimeline = makeInteractiveTimeline({ duration: 4.0 });
    narratedTimeline.audio.tracks = [
      { id: 'narr-0', kind: 'narration', src: speechSrc, start: 0.4, volume: 1 },
    ];
    const narratedMix = await mixTimelineAudio({
      timeline: narratedTimeline,
      music: musicSrc,
      outDir: join(dir, 'narrated'),
      keepStems: true,
    });
    assert.equal(narratedMix.ok, true);

    // Compare unducked tail segment [2.4..3.3s] of the music stem: narrated music stem is ~12 dB quieter (-30 vs -18 LUFS)!
    const musicOnlyGapRms = await measureSegmentRmsDb(musicOnlyMix.music.stemFile, 2.4, 3.3);
    const narratedGapRms = await measureSegmentRmsDb(narratedMix.music.stemFile, 2.4, 3.3);
    assert.ok(
      musicOnlyGapRms - narratedGapRms >= 10.5 && musicOnlyGapRms - narratedGapRms <= 13.5,
      `expected ~12 dB quieter default music bed with speech (-30 vs -18 LUFS), got musicOnly=${musicOnlyGapRms} dB vs narrated=${narratedGapRms} dB`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
