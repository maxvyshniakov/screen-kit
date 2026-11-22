import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { compileTimeline, validateEventTrack, validateStepNarration, validateTimeline } from '../src/timeline.mjs';
import { captureBrowserTake } from '../src/take-browser.mjs';
import { renderTimeline } from '../src/render-timeline.mjs';
import { runPipeline } from '../src/run.mjs';
import { probeVideo, renderVideo } from '../src/video.mjs';
import { reviewVideo } from '../src/review-video.mjs';
import * as rootApi from '../src/index.mjs';
import {
  DEFAULT_GEMINI_ALIGN_MODEL,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_VOICE,
  DEFAULT_KOKORO_VOICE,
  NETFLIX_CAPTION_RULES,
  WORD_ALIGNERS,
  alignAudioWords,
  alignWithGemini,
  alignWithWhisper,
  alignWords,
  buildNarrationTracks,
  computeStepDuration,
  detectLocalWhisper,
  encodePcm16Wav,
  formatNetflixCues,
  formatSrt,
  formatVtt,
  measureLoudness,
  narrateTimeline,
  parseWhisperWordTimings,
  probeAudio,
  reviewNarration,
  synthesizeSpeech,
  synthesizeWithGemini,
  synthesizeWithKokoro,
  validateCaptionCues,
  verifyStepSpeechFit,
} from '../src/narration.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.mjs');

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
  assert.equal(rootApi.WORD_ALIGNERS, WORD_ALIGNERS);
  assert.equal(rootApi.synthesizeWithGemini, synthesizeWithGemini);
  assert.equal(rootApi.synthesizeWithKokoro, synthesizeWithKokoro);
  assert.equal(rootApi.synthesizeSpeech, synthesizeSpeech);
  assert.equal(rootApi.computeStepDuration, computeStepDuration);
  assert.equal(rootApi.detectLocalWhisper, detectLocalWhisper);
  assert.equal(rootApi.parseWhisperWordTimings, parseWhisperWordTimings);
  assert.equal(rootApi.alignWithWhisper, alignWithWhisper);
  assert.equal(rootApi.alignWithGemini, alignWithGemini);
  assert.equal(rootApi.alignAudioWords, alignAudioWords);
  assert.equal(rootApi.alignWords, alignWords);
  assert.equal(rootApi.formatNetflixCues, formatNetflixCues);
  assert.equal(rootApi.formatSrt, formatSrt);
  assert.equal(rootApi.formatVtt, formatVtt);
  assert.equal(rootApi.buildNarrationTracks, buildNarrationTracks);
  assert.equal(rootApi.narrateTimeline, narrateTimeline);
  assert.equal(rootApi.measureLoudness, measureLoudness);
  assert.equal(rootApi.validateCaptionCues, validateCaptionCues);
  assert.equal(rootApi.verifyStepSpeechFit, verifyStepSpeechFit);
  assert.equal(rootApi.reviewNarration, reviewNarration);
  assert.equal(rootApi.validateStepNarration, validateStepNarration);
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
    let capturedHeaders = null;
    let capturedBody = null;

    const outputFile = join(dir, 'ru-step-0.wav');
    const result = await synthesizeWithGemini({
      text: 'Откройте редактор сценариев и перетащите узел.',
      outputFile,
      apiKey: 'fake-test-key',
      language: 'ru',
      voice: 'Aoede',
      stylePrompt: 'product explainer',
      tone: 'calm and clear',
      pacing: 'measured',
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init.headers;
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

    assert.match(capturedUrl, new RegExp(`${DEFAULT_GEMINI_TTS_MODEL}:generateContent$`));
    assert.doesNotMatch(capturedUrl, /key=/);
    assert.equal(capturedHeaders['x-goog-api-key'], 'fake-test-key');
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

test('recipe step narration (string & localized map) is preserved in event-track.json and timeline.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-step-narr-'));
  try {
    assert.equal(validateStepNarration('Scroll through 10k rows.').ok, true);
    assert.equal(validateStepNarration({ en: 'Scroll fast.', ru: 'Быстро прокрутите.' }).ok, true);
    assert.equal(validateStepNarration(42).ok, false);
    assert.equal(validateStepNarration({ en: 123 }).ok, false);

    const dummyFrame = (
      await sharp({ create: { width: 32, height: 24, channels: 3, background: '#1e293b' } }).jpeg().toBuffer()
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
                    mouse: { async move() {}, async down() {}, async up() {}, async wheel() {} },
                    keyboard: { async press() {}, async down() {}, async up() {}, async type() {} },
                  };
                },
                async newCDPSession() {
                  let listener = null;
                  return {
                    on(ev, fn) { if (ev === 'Page.screencastFrame') listener = fn; },
                    async send(method) {
                      if (method === 'Page.captureScreenshot') return { data: dummyFrame };
                      if (method === 'Page.startScreencast' && listener) {
                        listener({ data: dummyFrame, metadata: { timestamp: 1.0 }, sessionId: 1 });
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

    const take = await captureBrowserTake({
      out: join(dir, 'take'),
      captureMode: 'headless',
      playwright: mockPw,
      encodeFrames: async ({ outputFile, targetDuration }) => {
        await writeFile(outputFile, Buffer.from('mp4'));
        return {
          width: 320,
          height: 180,
          fps: 30,
          duration: Math.max(0.5, targetDuration),
          frames: Math.max(15, Math.round(targetDuration * 30)),
          measuredFps: 30,
          capturedFrames: 2,
          codec: 'h264',
          audio: false,
        };
      },
      recipe: {
        url: 'https://example.test/grid',
        viewport: [320, 180],
        fps: 30,
        tail: 0.02,
        steps: [
          {
            type: 'click',
            target: [80, 90],
            moveDuration: 0.02,
            hold: 0.01,
            narration: 'Scroll through 10k rows.',
          },
          {
            type: 'key',
            key: 'Escape',
            label: 'Close modal',
            narration: {
              en: 'Dismiss the inspector cleanly.',
              ru: 'Закройте инспектор клавишей Escape.',
            },
          },
        ],
      },
    });

    const checkTrack = validateEventTrack(take.eventTrackData);
    assert.equal(checkTrack.ok, true, checkTrack.errors.join('; '));

    const stepEvents = take.eventTrackData.events.filter((e) => e.type === 'step');
    assert.equal(stepEvents.length, 2);
    assert.equal(stepEvents[0].narration, 'Scroll through 10k rows.');
    assert.deepEqual(stepEvents[1].narration, {
      en: 'Dismiss the inspector cleanly.',
      ru: 'Закройте инспектор клавишей Escape.',
    });

    const compiled = compileTimeline({ eventTrack: take.eventTrackData });
    assert.equal(validateTimeline(compiled).ok, true);
    assert.equal(compiled.steps.length, 2);
    assert.equal(compiled.steps[0].narration, 'Scroll through 10k rows.');
    assert.equal(compiled.steps[1].narration.ru, 'Закройте инспектор клавишей Escape.');

    // Invalid step narration fails fast before browser choreography
    await assert.rejects(
      captureBrowserTake({
        out: join(dir, 'bad-narr'),
        captureMode: 'headless',
        playwright: mockPw,
        recipe: {
          url: 'https://example.test/grid',
          viewport: [320, 180],
          steps: [{ type: 'click', target: [50, 50], narration: ['not-valid'] }],
        },
      }),
      /Invalid step narration/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('alignAudioWords: whisper JSON parsing (mlx_whisper + whisper.cpp), script spelling preservation, argument-array safety, gemini x-goog-api-key aligner, and auto fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-kit-aligners-'));
  try {
    const sampleWav = join(dir, 'sample.wav');
    await writeFile(
      sampleWav,
      encodePcm16Wav(makeSinePcm16Buffer({ duration: 2.2, sampleRate: 24000, amplitude: 0.25 }), {
        sampleRate: 24000,
        channels: 1,
      })
    );

    // 1. Whisper (mlx_whisper JSON shape via mock runner): preserves exact script spelling, numbers, hyphens, punctuation
    const whisperMlx = await alignAudioWords({
      audioFile: sampleWav,
      text: 'Scroll through 10,000 rows in real-time.',
      duration: 2.2,
      startOffset: 0.2,
      aligner: 'whisper',
      language: 'en',
      runner: async () => ({
        backend: 'mlx-whisper',
        segments: [
          {
            id: 0,
            start: 0.05,
            end: 2.05,
            text: ' scroll through ten thousand rows in real time',
            words: [
              { word: ' scroll', start: 0.05, end: 0.35 },
              { word: ' through', start: 0.35, end: 0.55 },
              { word: ' ten', start: 0.55, end: 0.75 },
              { word: ' thousand', start: 0.75, end: 1.05 },
              { word: ' rows', start: 1.05, end: 1.35 },
              { word: ' in', start: 1.35, end: 1.50 },
              { word: ' real', start: 1.50, end: 1.72 },
              { word: ' time', start: 1.72, end: 2.05 },
            ],
          },
        ],
      }),
    });

    assert.equal(whisperMlx.aligner, 'whisper');
    assert.equal(whisperMlx.backend, 'mlx-whisper');
    assert.deepEqual(
      whisperMlx.words.map((w) => w.word),
      ['Scroll', 'through', '10,000', 'rows', 'in', 'real-time.']
    );
    assert.ok(whisperMlx.words.every((w) => w.method === 'forced'));
    // '10,000' spans 'ten' + 'thousand' (0.2 + 0.55 = 0.75 .. 0.2 + 1.05 = 1.25)
    assert.equal(whisperMlx.words[2].start, 0.75);
    assert.equal(whisperMlx.words[2].end, 1.25);
    // 'real-time.' merges 'real' + 'time' (0.2 + 1.50 = 1.70 .. 0.2 + 2.05 = 2.25)
    assert.equal(whisperMlx.words[5].start, 1.70);
    assert.equal(whisperMlx.words[5].end, 2.25);

    // 2. whisper.cpp (-ojf subword token array) parsing & argument-array execution (no shell injection!)
    const fakeWhisperCli = join(dir, 'whisper-cli');
    const markerFile = join(dir, 'pwned-marker');
    const capturedArgvFile = join(dir, 'argv.json');
    const fakeWhisperScript = [
      `#!${process.execPath}`,
      `import { writeFileSync } from 'node:fs';`,
      `const args = process.argv.slice(2);`,
      `writeFileSync(${JSON.stringify(capturedArgvFile)}, JSON.stringify(args));`,
      `const ofIdx = args.indexOf('-of');`,
      `const outBase = args[ofIdx + 1];`,
      `writeFileSync(outBase + '.json', JSON.stringify({`,
      `  transcription: [{`,
      `    offsets: { from: 0, to: 1600 },`,
      `    text: ' Откройте палитру команд.',`,
      `    tokens: [`,
      `      { text: '[_BEG_]', offsets: { from: 0, to: 0 } },`,
      `      { text: ' Откр', offsets: { from: 40, to: 250 } },`,
      `      { text: 'ойте', offsets: { from: 250, to: 520 } },`,
      `      { text: ' палитру', offsets: { from: 540, to: 1020 } },`,
      `      { text: ' команд', offsets: { from: 1040, to: 1500 } },`,
      `      { text: '.', offsets: { from: 1500, to: 1540 } }`,
      `    ]`,
      `  }]`,
      `}));`,
    ].join('\n');
    await writeFile(fakeWhisperCli, fakeWhisperScript, 'utf8');
    await chmod(fakeWhisperCli, 0o755);

    const dangerousPromptText = `Откройте "$(touch ${markerFile})" команд.`;
    const cppRes = await alignWithWhisper({
      audioFile: sampleWav,
      text: dangerousPromptText,
      duration: 2.2,
      language: 'ru-RU',
      executable: fakeWhisperCli,
    });

    await assert.rejects(() => access(markerFile), { code: 'ENOENT' });
    const argvPassed = JSON.parse(await readFile(capturedArgvFile, 'utf8'));
    assert.ok(argvPassed.includes('--prompt'));
    assert.equal(argvPassed[argvPassed.indexOf('--prompt') + 1], dangerousPromptText);
    assert.equal(cppRes.backend, 'whisper-cpp');
    assert.deepEqual(
      cppRes.words.map((w) => w.word),
      ['Откройте', `"$(touch`, `${markerFile})"`, 'команд.']
    );
    assert.equal(cppRes.words[0].start, 0.04);
    assert.equal(cppRes.words[0].end, 0.52);

    // 3. Gemini audio aligner: zero network calls without key, and x-goog-api-key header with key
    let geminiFetched = false;
    await assert.rejects(
      () =>
        alignAudioWords({
          audioFile: sampleWav,
          text: 'Click the filter button.',
          duration: 2.2,
          aligner: 'gemini',
          env: {},
          fetchImpl: async () => {
            geminiFetched = true;
            throw Error('must never call fetch without credentials');
          },
        }),
      /GEMINI_API_KEY/i
    );
    assert.equal(geminiFetched, false);

    let geminiUrl = '';
    let geminiHeaders = null;
    let geminiPayload = null;
    const geminiAligned = await alignAudioWords({
      audioFile: sampleWav,
      text: 'Click the HTTP button!',
      duration: 2.2,
      startOffset: 0.2,
      aligner: 'gemini',
      language: 'en',
      apiKey: 'test-ultra-key',
      env: {},
      fetchImpl: async (url, init) => {
        geminiUrl = url;
        geminiHeaders = init.headers;
        geminiPayload = JSON.parse(init.body);
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
                        words: [
                          { word: 'click', start: 0.08, end: 0.42 },
                          { word: 'the', start: 0.42, end: 0.60 },
                          { word: 'http', start: 0.62, end: 1.18 },
                          { word: 'button', start: 1.20, end: 1.78 },
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
    });

    assert.equal(geminiAligned.aligner, 'gemini');
    assert.equal(geminiAligned.backend, DEFAULT_GEMINI_ALIGN_MODEL);
    assert.match(geminiUrl, new RegExp(`${DEFAULT_GEMINI_ALIGN_MODEL}:generateContent$`));
    assert.doesNotMatch(geminiUrl, /key=/);
    assert.equal(geminiHeaders['x-goog-api-key'], 'test-ultra-key');
    assert.equal(geminiPayload.contents[0].parts[1].inline_data.mime_type, 'audio/wav');
    assert.deepEqual(
      geminiAligned.words.map((w) => w.word),
      ['Click', 'the', 'HTTP', 'button!']
    );
    assert.equal(geminiAligned.words[0].start, 0.28);
    assert.equal(geminiAligned.words[3].end, 1.98);

    // 4. Auto aligner fallback chain: whisper -> gemini -> proportional (zero network calls without key)
    let autoFetchedWithoutKey = false;
    const autoFallback = await alignAudioWords({
      audioFile: sampleWav,
      text: 'Deterministic offline fallback alignment.',
      duration: 2.2,
      aligner: 'auto',
      executable: false,
      env: { PATH: '' },
      fetchImpl: async () => {
        autoFetchedWithoutKey = true;
        throw Error('auto must not hit network without API key');
      },
    });
    assert.equal(autoFetchedWithoutKey, false);
    assert.equal(autoFallback.aligner, 'proportional');
    assert.ok(autoFallback.words.every((w) => w.method === 'proportional'));

    const autoGemini = await alignAudioWords({
      audioFile: sampleWav,
      text: 'Cloud auto alignment.',
      duration: 2.2,
      aligner: 'auto',
      executable: false,
      apiKey: 'auto-gemini-key',
      env: { PATH: '' },
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
                        { word: 'cloud', start: 0.1, end: 0.6 },
                        { word: 'auto', start: 0.6, end: 1.1 },
                        { word: 'alignment', start: 1.1, end: 1.9 },
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
    assert.equal(autoGemini.aligner, 'gemini');
    assert.deepEqual(autoGemini.words.map((w) => w.word), ['Cloud', 'auto', 'alignment.']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('screen-kit narrate CLI and screen-kit run --narration en render muxed-audio MP4 via Remotion and pass ffprobe + reviewVideo ebur128 loudness checks', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'screen-kit-narrate-e2e-'));
  const scratchDir = join(workDir, 'scratch');
  try {
    // 1. Create a real animated 1.0s 320x180 @ 10fps take video (animated gradient shift so freezedetect sees live frames)
    for (let i = 0; i < 10; i += 1) {
      const accent = await sharp({
        create: { width: 160, height: 180, channels: 3, background: { r: 20, g: 160 + i * 3, b: 120 + i * 2 } },
      })
        .png()
        .toBuffer();
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 28 + i * 3, g: 85 + i * 2, b: 220 } },
      })
        .composite([{ input: accent, left: 0, top: 0 }])
        .png()
        .toFile(join(workDir, `frame-${i}.png`));
    }

    const sourceTakeDir = join(workDir, 'source-take');
    const baseTakeVideo = join(sourceTakeDir, 'take.mp4');
    await renderVideo({ input: join(workDir, 'frame-%d.png'), output: baseTakeVideo, fps: 10 });
    const baseTakeBytes = await readFile(baseTakeVideo);

    // Offline synthetic Kokoro CLI script for subprocess tests (writes speech-level -15 LUFS PCM16 WAV)
    const fakeKokoroBin = join(workDir, 'fake-kokoro-tts.mjs');
    const fakeKokoroCode = [
      `#!${process.execPath}`,
      `import { mkdirSync, writeFileSync } from 'node:fs';`,
      `import { dirname } from 'node:path';`,
      `const args = process.argv.slice(2);`,
      `const outFile = args[args.indexOf('--output') + 1];`,
      `const lang = args[args.indexOf('--lang') + 1] ?? 'a';`,
      `const duration = lang === 'a' ? 1.0 : 1.1;`,
      `const sampleRate = 24000;`,
      `const count = Math.round(duration * sampleRate);`,
      `const pcm = Buffer.alloc(count * 2);`,
      `for (let i = 0; i < count; i++) {`,
      `  const s = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.25;`,
      `  pcm.writeInt16LE(Math.round(s * 32767), i * 2);`,
      `}`,
      `const hdr = Buffer.alloc(44);`,
      `hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);`,
      `hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);`,
      `hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(sampleRate, 24);`,
      `hdr.writeUInt32LE(sampleRate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);`,
      `hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);`,
      `mkdirSync(dirname(outFile), { recursive: true });`,
      `writeFileSync(outFile, Buffer.concat([hdr, pcm]));`,
    ].join('\n');
    await writeFile(fakeKokoroBin, fakeKokoroCode, 'utf8');
    await chmod(fakeKokoroBin, 0o755);

    const cliEnv = {
      ...process.env,
      SCREEN_KIT_KOKORO_BIN: fakeKokoroBin,
      SCREEN_KIT_WHISPER_BIN: 'none',
    };
    delete cliEnv.GEMINI_API_KEY;
    delete cliEnv.GOOGLE_API_KEY;

    // 2. Test `screen-kit narrate --input timeline.json --out out/narrated --lang en,ru --provider kokoro`
    // Original take is 1.0s (two 0.5s steps), while speech needs max(0.5, 0.2 + 1.1 + 0.4) = 1.7s per step -> 3.4s total!
    const eventTrack = {
      version: 1,
      captureMode: 'headless',
      startedAt: '2026-11-22T00:00:00.000Z',
      viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
      video: { file: 'take.mp4', width: 320, height: 180, fps: 10, duration: 1.0, frames: 10 },
      events: [
        { t: 0.0, type: 'pointermove', x: 80, y: 90 },
        {
          t: 0.0,
          type: 'step',
          index: 0,
          label: 'Focus Card',
          target: [80, 90],
          camera: { zoom: 1.5, focus: 'target', lead: 0.1, hold: 0.2 },
          narration: {
            en: 'Click the primary metric card.',
            ru: 'Нажмите на карточку метрики.',
          },
        },
        { t: 0.1, type: 'pointerdown', x: 80, y: 90, button: 'left' },
        { t: 0.2, type: 'pointerup', x: 80, y: 90, button: 'left' },
        {
          t: 0.5,
          type: 'step',
          index: 1,
          label: 'Inspect Overview',
          camera: 'wide',
          narration: {
            en: 'Review the updated dashboard stage.',
            ru: 'Проверьте обновлённую панель обзора.',
          },
        },
        { t: 0.6, type: 'pointermove', x: 220, y: 90 },
      ],
    };
    const sourceEventTrackPath = join(sourceTakeDir, 'event-track.json');
    await writeFile(sourceEventTrackPath, JSON.stringify(eventTrack, null, 2) + '\n');

    const inputTimelinePath = join(sourceTakeDir, 'timeline.json');
    const baseCompiled = compileTimeline({
      take: { video: 'take.mp4', eventTrack: 'event-track.json' },
      eventTrack,
      recipe: {
        stage: { width: 480, height: 270, padding: 45, background: { type: 'solid', color: '#0f172a' } },
        window: { frame: 'macos', title: 'Narrate CLI Check', width: 320, height: 180 },
        camera: { outputWidth: 480, outputHeight: 270 },
        outputs: ['web-loop'],
      },
    });
    await writeFile(inputTimelinePath, JSON.stringify(baseCompiled, null, 2) + '\n');

    const narratedDir = join(workDir, 'out-narrated');
    const { stdout: narrateStdout } = await exec(
      process.execPath,
      [
        CLI_PATH,
        'narrate',
        '--input', inputTimelinePath,
        '--out', narratedDir,
        '--lang', 'en,ru',
        '--provider', 'kokoro',
        '--aligner', 'auto',
        '--voice', 'af_heart',
        '--style', 'crisp product walkthrough',
      ],
      { cwd: REPO_ROOT, env: cliEnv, timeout: 60000, maxBuffer: 10e6 }
    );
    const narrateSummary = JSON.parse(narrateStdout);
    assert.equal(narrateSummary.ok, true);
    assert.equal(narrateSummary.provider, 'kokoro');
    assert.equal(narrateSummary.aligner, 'proportional'); // auto fell back cleanly with no whisper/key
    assert.deepEqual(narrateSummary.languages, ['en', 'ru']);
    assert.ok(narrateSummary.paddedSeconds >= 2.2, `expected padded timeline, got ${narrateSummary.paddedSeconds}`);
    assert.ok(narrateSummary.totalDuration >= 3.2);
    await access(narrateSummary.timelineFile);
    await access(narrateSummary.paddedVideoFile);
    await access(narrateSummary.subtitles.en.srtFile);
    await access(narrateSummary.subtitles.en.vttFile);
    await access(narrateSummary.subtitles.ru.srtFile);
    await access(narrateSummary.subtitles.ru.vttFile);

    // Render the narrated timeline via Remotion into a muxed-audio MP4 and verify with ffprobe + reviewVideo
    const narratedMp4Out = join(narratedDir, 'narrated-demo.mp4');
    const renderNarrated = await renderTimeline({
      timeline: narrateSummary.timelineFile,
      out: narratedMp4Out,
      scratchDir,
    });
    assert.equal(renderNarrated.outputs.length, 1);
    assert.equal(renderNarrated.outputs[0].audio, true);

    const probedMp4 = await probeVideo(narratedMp4Out);
    const probedMp4Audio = await probeAudio(narratedMp4Out);
    assert.equal(probedMp4.audio, true);
    assert.equal(probedMp4Audio.hasAudio, true);
    assert.ok(probedMp4.duration >= 3.2);

    const narratedReview = await reviewVideo({
      video: narratedMp4Out,
      timeline: narrateSummary.timelineFile,
      eventTrack: narrateSummary.eventTrackFile,
      outDir: join(narratedDir, 'review'),
    });
    assert.equal(narratedReview.ok, true, JSON.stringify(narratedReview.checks, null, 2));
    assert.equal(narratedReview.checks.find((c) => c.name === 'audio-loudness')?.ok, true);
    assert.equal(narratedReview.checks.find((c) => c.name === 'caption-rules')?.ok, true);
    assert.equal(narratedReview.checks.find((c) => c.name === 'step-speech-fit')?.ok, true);
    assert.equal(narratedReview.checks.find((c) => c.name === 'black-frames')?.ok, true);
    assert.equal(narratedReview.checks.find((c) => c.name === 'cursor-accuracy')?.ok, true);

    // 3. Test unified `screen-kit run --narration en` (programmatic capture + CLI --reuse-take --narration en)
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

    const runOutDir = join(workDir, 'out-run-narrated');
    const runConfig = {
      recipes: {
        walkthrough: {
          source: 'browser',
          captureMode: 'headless',
          url: 'https://example.test/walkthrough',
          viewport: [320, 180],
          fps: 10,
          tail: 0.05,
          steps: [
            {
              type: 'click',
              target: [90, 90],
              moveDuration: 0.04,
              hold: 0.02,
              label: 'Select Node',
              camera: { zoom: 1.6, focus: 'target', lead: 0.1, hold: 0.15 },
              narration: 'Select the active node on stage.',
            },
            {
              type: 'key',
              key: 'Escape',
              label: 'Wide View',
              camera: 'wide',
              narration: 'Zoom back out to the full workspace.',
            },
          ],
          presentation: {
            stage: { width: 480, height: 270, padding: 45, background: { type: 'solid', color: '#0f172a' } },
            window: { frame: 'macos', title: 'Unified Narrated Run', width: 320, height: 180 },
            camera: { outputWidth: 480, outputHeight: 270 },
            outputs: ['web-loop'],
          },
        },
      },
    };

    // Programmatic runPipeline with synthetic WAV TTS runner (captures clean take + narrates + renders + reviews)
    const apiRun = await runPipeline({
      config: runConfig,
      cwd: workDir,
      out: runOutDir,
      profiles: ['web-loop'],
      narration: 'en',
      ttsProvider: 'kokoro',
      aligner: 'proportional',
      narrationOptions: {
        ttsRunner: async ({ outputFile }) => {
          const wav = encodePcm16Wav(makeSinePcm16Buffer({ duration: 0.9, sampleRate: 24000, amplitude: 0.25 }), {
            sampleRate: 24000,
            channels: 1,
          });
          await writeFile(outputFile, wav);
        },
      },
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

    assert.equal(apiRun.ok, true, JSON.stringify(apiRun.review?.checks, null, 2));
    assert.equal(apiRun.narration.language, 'en');
    assert.equal(apiRun.narration.provider, 'kokoro');
    const apiMp4 = apiRun.render.outputs.find((o) => o.format === 'mp4');
    assert.ok(apiMp4);
    assert.equal((await probeVideo(apiMp4.file)).audio, true);
    assert.equal(apiRun.review.checks.find((c) => c.name === 'audio-loudness')?.ok, true);

    // Real CLI `screen-kit run --config ... --reuse-take --profiles web-loop --narration en --tts-provider kokoro`
    const runConfigPath = join(workDir, 'walkthrough.config.mjs');
    await writeFile(runConfigPath, `export default ${JSON.stringify(runConfig, null, 2)};\n`, 'utf8');

    const { stdout: cliRunStdout } = await exec(
      process.execPath,
      [
        CLI_PATH,
        'run',
        '--config', runConfigPath,
        '--out', runOutDir,
        '--reuse-take',
        '--profiles', 'web-loop',
        '--narration', 'en',
        '--tts-provider', 'kokoro',
        '--aligner', 'proportional',
      ],
      { cwd: REPO_ROOT, env: cliEnv, timeout: 120000, maxBuffer: 10e6 }
    );
    const cliRunResult = JSON.parse(cliRunStdout);
    assert.equal(cliRunResult.ok, true, JSON.stringify(cliRunResult.review?.checks, null, 2));
    assert.equal(cliRunResult.take.reused, true);
    assert.equal(cliRunResult.narration.provider, 'kokoro');
    const cliMp4 = cliRunResult.render.outputs.find((o) => o.format === 'mp4');
    assert.ok(cliMp4);
    assert.equal((await probeVideo(cliMp4.file)).audio, true);
    assert.equal(cliRunResult.review.ok, true);
    assert.equal(cliRunResult.review.checks.find((c) => c.name === 'audio-loudness')?.ok, true);
    assert.equal(cliRunResult.review.checks.find((c) => c.name === 'caption-rules')?.ok, true);
    assert.equal(cliRunResult.review.checks.find((c) => c.name === 'step-speech-fit')?.ok, true);
    await access(cliRunResult.narration.subtitles.en.srtFile);
    await access(cliRunResult.narration.subtitles.en.vttFile);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
