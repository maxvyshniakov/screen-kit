import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileTimeline, validateTimeline } from '../src/timeline.mjs';
import { reviewVideo } from '../src/review-video.mjs';
import * as rootApi from '../src/index.mjs';
import {
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_VOICE,
  DEFAULT_KOKORO_VOICE,
  NETFLIX_CAPTION_RULES,
  alignWords,
  buildNarrationTracks,
  computeStepDuration,
  encodePcm16Wav,
  formatNetflixCues,
  formatSrt,
  formatVtt,
  measureLoudness,
  probeAudio,
  reviewNarration,
  synthesizeSpeech,
  synthesizeWithGemini,
  synthesizeWithKokoro,
  validateCaptionCues,
  verifyStepSpeechFit,
} from '../src/narration.mjs';

const exec = promisify(execFile);

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

function makeBaseTimeline({ video = 'demo.mp4', duration = 6, width = 320, height = 180, fps = 30 } = {}) {
  const eventTrack = {
    version: 1,
    captureMode: 'headless',
    viewport: { width, height, deviceScaleFactor: 1 },
    video: { file: video, width, height, fps, duration, frames: Math.round(duration * fps) },
    events: [
      { t: 0.0, type: 'pointermove', x: 60, y: 60 },
      { t: 0.5, type: 'pointerdown', x: 160, y: 90, button: 'left' },
      { t: 0.6, type: 'pointerup', x: 160, y: 90, button: 'left' },
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
        keyframes: [
          { t: 0, x: (width + 80) / 2, y: (height + 60) / 2, zoom: 1, easing: 'linear' },
          { t: duration, x: (width + 80) / 2, y: (height + 60) / 2, zoom: 1, easing: 'linear' },
        ],
      },
      outputs: ['web-loop'],
    },
  });
}

test('narration module is exported cleanly from src/index.mjs', () => {
  assert.equal(rootApi.synthesizeWithGemini, synthesizeWithGemini);
  assert.equal(rootApi.synthesizeWithKokoro, synthesizeWithKokoro);
  assert.equal(rootApi.synthesizeSpeech, synthesizeSpeech);
  assert.equal(rootApi.computeStepDuration, computeStepDuration);
  assert.equal(rootApi.alignWords, alignWords);
  assert.equal(rootApi.formatNetflixCues, formatNetflixCues);
  assert.equal(rootApi.formatSrt, formatSrt);
  assert.equal(rootApi.formatVtt, formatVtt);
  assert.equal(rootApi.buildNarrationTracks, buildNarrationTracks);
  assert.equal(rootApi.measureLoudness, measureLoudness);
  assert.equal(rootApi.validateCaptionCues, validateCaptionCues);
  assert.equal(rootApi.verifyStepSpeechFit, verifyStepSpeechFit);
  assert.equal(rootApi.reviewNarration, reviewNarration);
});

test('Gemini TTS provider fails cleanly without API key and makes zero network calls', async () => {
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  let fetched = false;

  try {
    await assert.rejects(
      () =>
        synthesizeWithGemini({
          text: 'Open the command palette.',
          fetchImpl: async () => {
            fetched = true;
            throw Error('should never invoke fetch without credentials');
          },
        }),
      /GEMINI_API_KEY/i
    );
    assert.equal(fetched, false);
  } finally {
    if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
    if (prevGoogle !== undefined) process.env.GOOGLE_API_KEY = prevGoogle;
  }
});

test('Gemini TTS provider sends natural-language steering and decodes PCM16 to playable WAV', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-gemini-tts-'));
  try {
    const pcmBytes = makeSinePcm16Buffer({ duration: 1.25, sampleRate: 24000, amplitude: 0.25 });
    let capturedUrl = '';
    let capturedBody = null;

    const outputFile = join(dir, 'ru-step-0.wav');
    const result = await synthesizeWithGemini({
      text: 'Откройте редактор сценариев и перетащите узел.',
      outputFile,
      apiKey: 'fake-test-key',
      language: 'ru',
      voice: 'Aoede',
      style: 'product explainer',
      tone: 'calm and clear',
      pacing: 'measured',
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body);
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
                        mimeType: 'audio/L16;codec=pcm;rate=24000',
                        data: pcmBytes.toString('base64'),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        };
      },
    });

    assert.match(capturedUrl, new RegExp(`${DEFAULT_GEMINI_TTS_MODEL}:generateContent\\?key=fake-test-key$`));
    assert.deepEqual(capturedBody.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(capturedBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
    assert.equal(capturedBody.generationConfig.speechConfig.languageCode, 'ru-RU');
    assert.match(capturedBody.contents[0].parts[0].text, /calm and clear/i);
    assert.match(capturedBody.contents[0].parts[0].text, /measured/i);
    assert.match(capturedBody.contents[0].parts[0].text, /Откройте редактор/);

    assert.equal(result.provider, 'gemini');
    assert.equal(result.voice, 'Aoede');
    assert.equal(result.language, 'ru-RU');
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.sampleRate, 24000);
    assert.equal(result.channels, 1);
    assert.equal(result.duration, 1.25);

    // Verify the written WAV file is genuinely decodable by ffprobe
    await access(outputFile);
    const probed = await probeAudio(outputFile);
    assert.equal(probed.hasAudio, true);
    assert.equal(probed.sampleRate, 24000);
    assert.equal(probed.channels, 1);
    assert.ok(Math.abs(probed.duration - 1.25) < 0.02);

    // Also verify already-wrapped WAV response bytes pass through cleanly
    const wavBytes = encodePcm16Wav(makeSinePcm16Buffer({ duration: 0.5, sampleRate: 16000 }), {
      sampleRate: 16000,
      channels: 1,
    });
    const wavRes = await synthesizeSpeech({
      provider: 'gemini',
      text: 'Hello world.',
      apiKey: 'fake-test-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ inline_data: { mime_type: 'audio/wav', data: wavBytes.toString('base64') } }],
              },
            },
          ],
        }),
      }),
    });
    assert.equal(wavRes.voice, DEFAULT_GEMINI_VOICE);
    assert.equal(wavRes.sampleRate, 16000);
    assert.equal(wavRes.duration, 0.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Kokoro offline fallback synthesizes real WAV via injectable runner and reports install instructions when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-kokoro-'));
  try {
    const outWav = join(dir, 'kokoro-step.wav');
    let runnerArgs = null;

    const result = await synthesizeWithKokoro({
      text: 'Drag the filter node onto the canvas.',
      outputFile: outWav,
      language: 'en-US',
      speed: 1.05,
      runner: async (args) => {
        runnerArgs = args;
        await runFfmpeg([
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.8:sample_rate=24000',
          '-af', 'volume=0.25',
          '-c:a', 'pcm_s16le',
          args.outputFile,
        ]);
      },
    });

    assert.equal(runnerArgs.voice, DEFAULT_KOKORO_VOICE);
    assert.equal(runnerArgs.speed, 1.05);
    assert.equal(result.provider, 'kokoro');
    assert.equal(result.file, outWav);
    assert.equal(result.sampleRate, 24000);
    assert.equal(result.channels, 1);
    assert.ok(Math.abs(result.duration - 1.8) < 0.05);

    // Missing runtime gives actionable install instructions
    await assert.rejects(
      () =>
        synthesizeWithKokoro({
          text: 'Offline fallback check.',
          outputFile: join(dir, 'missing.wav'),
          python: 'nonexistent-python-binary-for-screen-kit-test',
        }),
      /pip install kokoro/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('computeStepDuration enforces max(actionDuration, 0.2 + speechDuration + 0.4)', () => {
  assert.equal(computeStepDuration({ actionDuration: 1.0, speechDuration: 2.0 }), 2.6);
  assert.equal(computeStepDuration({ actionDuration: 3.5, speechDuration: 2.0 }), 3.5);
  assert.equal(computeStepDuration({ actionDuration: 0.4, speechDuration: 0.5 }), 1.1);
  assert.equal(computeStepDuration({ actionDuration: 1.2, speechDuration: 0 }), 1.2);
  assert.equal(computeStepDuration({ actionDuration: 0.5, speechDuration: 1.0, leadIn: 0.3, leadOut: 0.5 }), 1.8);

  assert.throws(() => computeStepDuration({ actionDuration: -1, speechDuration: 1 }), /non-negative/i);
  assert.throws(() => computeStepDuration({ actionDuration: 1, speechDuration: Number.NaN }), /non-negative/i);
});

test('alignWords supports forced alignment timings and deterministic EN/RU proportional fallback', () => {
  // 1. Forced alignment preserves script spelling and enforces monotonic timestamps
  const forced = alignWords({
    text: 'Click the HTTP node.',
    duration: 1.6,
    startOffset: 0.2,
    wordTimings: [
      { word: 'click', start: 0.0, end: 0.3 },
      { word: 'the', start: 0.3, end: 0.45 },
      { word: 'H.T.T.P.', start: 0.45, end: 1.05 }, // ASR misspelling ignored in favor of script
      { word: 'node', start: 1.05, end: 1.55 },
    ],
  });

  assert.equal(forced.length, 4);
  assert.deepEqual(
    forced.map((w) => w.word),
    ['Click', 'the', 'HTTP', 'node.']
  );
  assert.equal(forced[0].start, 0.2);
  assert.equal(forced[2].start, 0.65);
  assert.equal(forced[3].end, 1.75);
  assert.ok(forced.every((w) => w.method === 'forced'));

  // 2. Deterministic proportional fallback (English)
  const propA = alignWords({
    text: 'Select multiple nodes, then align them horizontally.',
    duration: 3.0,
    startOffset: 1.0,
  });
  const propB = alignWords({
    text: 'Select multiple nodes, then align them horizontally.',
    duration: 3.0,
    startOffset: 1.0,
  });
  assert.deepEqual(propA, propB);
  assert.equal(propA[0].start, 1.0);
  assert.equal(propA[propA.length - 1].end, 4.0);
  for (let i = 1; i < propA.length; i += 1) {
    assert.ok(propA[i].start >= propA[i - 1].end);
    assert.ok(propA[i].end >= propA[i].start);
  }
  // Longer word ("horizontally.") takes longer than short word ("then")
  const thenWord = propA.find((w) => w.word === 'then');
  const horizWord = propA.find((w) => w.word === 'horizontally.');
  assert.ok(horizWord.end - horizWord.start > thenWord.end - thenWord.start);

  // 3. Cyrillic Russian proportional alignment
  const ruWords = alignWords({
    text: 'Перетащите узел фильтра на рабочую область.',
    duration: 2.5,
    startOffset: 0.2,
  });
  assert.equal(ruWords.length, 6);
  assert.equal(ruWords[0].start, 0.2);
  assert.equal(ruWords[ruWords.length - 1].end, 2.7);
});

test('Netflix caption formatting, SRT/VTT export, and rule validation', () => {
  const longText =
    'Open the scenario editor to inspect every transition, then drag the filter node onto the stage and zoom in to verify the alignment.';
  const cues = formatNetflixCues({
    text: longText,
    duration: 9.2,
    startOffset: 0.2,
    stepEnd: 10.0,
  });

  assert.ok(cues.length >= 2, `expected multi-cue split, got ${cues.length}`);
  const validation = validateCaptionCues(cues);
  assert.equal(validation.ok, true, JSON.stringify(validation.violations, null, 2));
  assert.ok(validation.maxLinesObserved <= NETFLIX_CAPTION_RULES.maxLines);
  assert.ok(validation.maxLineLengthObserved <= NETFLIX_CAPTION_RULES.maxCharsPerLine);
  assert.ok(validation.minDurationObserved >= NETFLIX_CAPTION_RULES.minDuration - 0.005);
  assert.ok(validation.maxDurationObserved <= NETFLIX_CAPTION_RULES.maxDuration + 0.005);

  // Short cue gets padded to meet 0.833 s minimum duration within stepEnd
  const shortCues = formatNetflixCues({
    text: 'Click Save.',
    duration: 0.5,
    startOffset: 0.2,
    stepEnd: 1.2,
  });
  assert.equal(shortCues.length, 1);
  assert.ok(shortCues[0].duration >= NETFLIX_CAPTION_RULES.minDuration - 0.005);
  assert.ok(shortCues[0].end <= 1.2);
  assert.equal(validateCaptionCues(shortCues).ok, true);

  // SRT & VTT formatting (including minute rollover rounding)
  const rolloverCues = [
    { start: 0.2, end: 2.45, text: 'First line\nSecond line' },
    { start: 59.9999, end: 62.5, text: 'Minute rollover cue' },
  ];
  const srt = formatSrt(rolloverCues);
  assert.match(srt, /^1\n00:00:00,200 --> 00:00:02,450\nFirst line\nSecond line\n\n2\n00:01:00,000 --> 00:01:02,500\nMinute rollover cue\n$/);

  const vtt = formatVtt(rolloverCues);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.200 --> 00:00:02\.450\nFirst line\nSecond line\n\n00:01:00\.000 --> 00:01:02\.500\nMinute rollover cue\n$/);

  // Validator flags all Netflix violations
  const badCues = [
    { start: 0.0, end: 0.4, text: 'Too short' }, // < 0.833s
    { start: 0.3, end: 8.5, text: 'Line one is definitely much longer than forty-two characters\nLine two\nLine three' }, // overlap + >7s + >42 chars + >2 lines
  ];
  const badCheck = validateCaptionCues(badCues);
  assert.equal(badCheck.ok, false);
  const rulesTriggered = new Set(badCheck.violations.map((v) => v.rule));
  assert.ok(rulesTriggered.has('min-duration'));
  assert.ok(rulesTriggered.has('overlap'));
  assert.ok(rulesTriggered.has('max-duration'));
  assert.ok(rulesTriggered.has('max-lines'));
  assert.ok(rulesTriggered.has('max-line-length'));
});

test('buildNarrationTracks creates multi-language audio, SRT/VTT files, and valid timeline.json tracks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-narr-tracks-'));
  try {
    const baseTimeline = makeBaseTimeline({ video: join(dir, 'take.mp4'), duration: 7 });

    const built = await buildNarrationTracks({
      steps: [
        {
          index: 0,
          label: 'Open editor',
          actionDuration: 1.5,
          say: {
            en: 'Open the scenario editor to view active nodes.',
            ru: 'Откройте редактор сценариев для просмотра узлов.',
          },
        },
        {
          index: 1,
          label: 'Drag node',
          actionDuration: 2.0,
          say: {
            en: 'Drag the HTTP node onto the canvas and release.',
            ru: 'Перетащите узел HTTP на холст и отпустите.',
          },
        },
      ],
      languages: ['en', 'ru'],
      provider: 'kokoro',
      providerOptions: {
        runner: async ({ outputFile, language }) => {
          const dur = language.startsWith('ru') ? 2.4 : 2.1;
          await runFfmpeg([
            '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}:sample_rate=24000`,
            '-af', 'volume=0.25',
            '-c:a', 'pcm_s16le',
            outputFile,
          ]);
        },
      },
      outDir: dir,
      timeline: baseTimeline,
    });

    assert.equal(built.languages.length, 2);
    assert.equal(built.steps.length, 2);
    // Step duration uses max speech duration across languages: max(1.5, 0.2 + 2.4 + 0.4) = 3.0
    assert.equal(built.steps[0].duration, 3.0);
    assert.equal(built.steps[1].start, 3.0);
    assert.equal(built.steps[1].duration, 3.0);
    assert.equal(built.totalDuration, 6.0);

    // Validated timeline populated with audio tracks and multi-language caption tracks
    assert.ok(built.timeline);
    const tlValidation = validateTimeline(built.timeline);
    assert.equal(tlValidation.ok, true, JSON.stringify(tlValidation.errors, null, 2));
    assert.equal(built.timeline.overlays.captions.enabled, true);
    assert.equal(built.timeline.overlays.captions.tracks.length, 2);
    assert.equal(built.timeline.audio.tracks.length, 2);
    assert.equal(built.timeline.audio.tracks[0].kind, 'narration');
    assert.equal(built.timeline.audio.tracks[0].start, 0.2);
    assert.equal(built.timeline.audio.tracks[1].start, 3.2);

    // SRT & VTT written per language
    for (const lang of ['en', 'ru']) {
      await access(built.subtitles[lang].srtFile);
      await access(built.subtitles[lang].vttFile);
      const srtText = await readFile(built.subtitles[lang].srtFile, 'utf8');
      const vttText = await readFile(built.subtitles[lang].vttFile, 'utf8');
      assert.ok(srtText.includes('-->'));
      assert.ok(vttText.startsWith('WEBVTT'));
      assert.equal(validateCaptionCues(built.subtitles[lang].cues).ok, true);
    }

    // Step speech fit passes for all generated segments
    const fit = verifyStepSpeechFit({
      steps: built.steps,
      segments: built.segments,
      totalDuration: built.totalDuration,
    });
    assert.equal(fit.ok, true, JSON.stringify(fit.violations, null, 2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('measureLoudness and reviewNarration distinguish normal speech-level audio, silence, clipping, and step overflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-narr-review-'));
  try {
    const normalWav = join(dir, 'normal.wav');
    const silentWav = join(dir, 'silent.wav');
    const clippedWav = join(dir, 'clipped.wav');

    await Promise.all([
      // Normal speech-level tone (ffmpeg sine defaults to -21.7 LUFS; +6dB -> ~ -15.7 LUFS, peak ~ -12.1 dBFS)
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.0:sample_rate=24000',
        '-af', 'volume=+6dB',
        '-c:a', 'pcm_s16le', normalWav,
      ]),
      // Pure silence (-70 LUFS, -inf dBFS peak)
      runFfmpeg([
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=24000:duration=2.0',
        '-c:a', 'pcm_s16le', silentWav,
      ]),
      // Extremely loud clipped audio (+18dB -> ~ -3.7 LUFS, peak >= -0.5 dBFS)
      runFfmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.0:sample_rate=24000',
        '-af', 'volume=+18dB',
        '-c:a', 'pcm_s16le', clippedWav,
      ]),
    ]);

    const normalLoudness = await measureLoudness(normalWav);
    assert.equal(normalLoudness.hasAudio, true);
    assert.equal(normalLoudness.isSilent, false);
    assert.ok(normalLoudness.integratedLufs > -25 && normalLoudness.integratedLufs < -10, `got ${normalLoudness.integratedLufs}`);
    assert.ok(normalLoudness.truePeakDbfs < -5);

    const silentLoudness = await measureLoudness(silentWav);
    assert.equal(silentLoudness.hasAudio, true);
    assert.equal(silentLoudness.isSilent, true);

    const clippedLoudness = await measureLoudness(clippedWav);
    assert.equal(clippedLoudness.hasAudio, true);
    assert.equal(clippedLoudness.isSilent, false);
    assert.ok(clippedLoudness.integratedLufs > -6 || clippedLoudness.truePeakDbfs > -0.5);

    const validSteps = [
      { index: 0, label: 'Intro', start: 0.0, end: 2.6 },
      { index: 1, label: 'Outro', start: 2.6, end: 5.2 },
    ];
    const validCues = [
      { start: 0.2, end: 2.2, text: 'Welcome to screen-kit narration.' },
      { start: 2.8, end: 4.8, text: 'Captions stay crisp and aligned.' },
    ];

    // 1. Passing reviewNarration
    const passReport = await reviewNarration({
      audioFiles: [normalWav],
      cues: validCues,
      steps: validSteps,
      segments: [
        { stepIndex: 0, start: 0.2, end: 2.2 },
        { stepIndex: 1, start: 2.8, end: 4.8 },
      ],
    });
    assert.equal(passReport.ok, true, JSON.stringify(passReport.findings, null, 2));
    assert.equal(passReport.checks.find((c) => c.name === 'audio-loudness')?.ok, true);
    assert.equal(passReport.checks.find((c) => c.name === 'caption-rules')?.ok, true);
    assert.equal(passReport.checks.find((c) => c.name === 'step-speech-fit')?.ok, true);

    // 2. Silent audio + overflowing speech segment fails
    const failReport = await reviewNarration({
      audioFiles: [silentWav, clippedWav],
      cues: validCues,
      steps: validSteps,
      segments: [{ stepIndex: 0, start: 0.2, end: 3.1 }], // overflows step 0 end (2.6s)
    });
    assert.equal(failReport.ok, false);
    assert.equal(failReport.checks.find((c) => c.name === 'audio-loudness')?.ok, false);
    assert.equal(failReport.checks.find((c) => c.name === 'step-speech-fit')?.ok, false);
    assert.ok(failReport.findings.some((f) => f.category === 'audio-loudness' && /silent/i.test(f.message)));
    assert.ok(failReport.findings.some((f) => f.category === 'audio-loudness' && /too loud|clipping/i.test(f.message)));
    assert.ok(failReport.findings.some((f) => f.category === 'step-speech-fit' && /after step 0/i.test(f.message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reviewVideo runs narration checks when timeline captions/audio are enabled and skips them for silent timelines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-rv-narr-'));
  try {
    const narratedMp4 = join(dir, 'narrated.mp4');
    const silentAudioMp4 = join(dir, 'silent-audio.mp4');

    await Promise.all([
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000',
        '-af', 'volume=+6dB',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest',
        narratedMp4,
      ]),
      runFfmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:duration=4',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest',
        silentAudioMp4,
      ]),
    ]);

    const stepAudio = join(dir, 'step-0.wav');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5:sample_rate=24000',
      '-af', 'volume=+6dB',
      '-c:a', 'pcm_s16le', stepAudio,
    ]);

    const baseTimeline = makeBaseTimeline({ video: narratedMp4, duration: 4 });
    baseTimeline.steps = [
      { t: 0.0, index: 0, label: 'Step one' },
      { t: 2.2, index: 1, label: 'Step two' },
    ];
    baseTimeline.audio.tracks = [
      { id: 'narr-0', kind: 'narration', src: stepAudio, start: 0.2, volume: 1 },
    ];
    baseTimeline.overlays.captions = {
      enabled: true,
      tracks: [
        {
          language: 'en',
          cues: [
            { start: 0.2, end: 1.8, text: 'Click the button to begin.' },
            { start: 2.4, end: 3.8, text: 'Check the updated output.' },
          ],
        },
      ],
    };
    assert.equal(validateTimeline(baseTimeline).ok, true);

    // 1. Valid narrated MP4 passes reviewVideo with narration checks included
    const passReview = await reviewVideo({
      video: narratedMp4,
      timeline: baseTimeline,
      outDir: join(dir, 'out-pass'),
    });
    assert.equal(passReview.ok, true, JSON.stringify(passReview.findings, null, 2));
    assert.equal(passReview.checks.find((c) => c.name === 'audio-loudness')?.ok, true);
    assert.equal(passReview.checks.find((c) => c.name === 'caption-rules')?.ok, true);
    assert.equal(passReview.checks.find((c) => c.name === 'step-speech-fit')?.ok, true);
    assert.equal(passReview.metrics.narration.loudness.checked, true);
    assert.equal(passReview.metrics.narration.captions.checked, true);

    // 2. Narrated MP4 with silent audio stream fails reviewVideo
    const silentReview = await reviewVideo({
      video: silentAudioMp4,
      timeline: baseTimeline,
      outDir: join(dir, 'out-silent'),
    });
    assert.equal(silentReview.ok, false);
    assert.equal(silentReview.checks.find((c) => c.name === 'audio-loudness')?.ok, false);
    assert.ok(silentReview.findings.some((f) => f.category === 'audio-loudness'));

    // 3. Narrated MP4 with bad Netflix captions fails reviewVideo
    const badCaptionTimeline = structuredClone(baseTimeline);
    badCaptionTimeline.overlays.captions.tracks[0].cues[0].text =
      'This single caption line is way over forty-two characters long and breaks Netflix rules';
    const badCaptionReview = await reviewVideo({
      video: narratedMp4,
      timeline: badCaptionTimeline,
      outDir: join(dir, 'out-bad-caption'),
    });
    assert.equal(badCaptionReview.ok, false);
    assert.equal(badCaptionReview.checks.find((c) => c.name === 'caption-rules')?.ok, false);
    assert.ok(badCaptionReview.findings.some((f) => f.category === 'caption-rules'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
