import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { renderVideo, probeVideo } from '../src/video.mjs';
import {
  publishWebBundle,
  publishYouTube,
  buildWebEmbedHtml,
  YOUTUBE_MULTI_AUDIO_NOTE,
} from '../src/publish.mjs';
import {
  generateAsset,
  computeAssetCacheKey,
  DEFAULT_IMAGE_MODEL,
  ASSET_NON_UI_POLICY,
} from '../src/assets.mjs';
import * as rootApi from '../src/index.mjs';

const exec = promisify(execFile);
const CLI_PATH = resolve('src/cli.mjs');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function createSampleMp4(dir, { width = 96, height = 64, fps = 2 } = {}) {
  for (const [index, background] of ['#d946ef', '#0ea5e9'].entries()) {
    await sharp({
      create: { width, height, channels: 3, background },
    })
      .png()
      .toFile(join(dir, `frame-${index}.png`));
  }
  const mp4Path = join(dir, 'source.mp4');
  await renderVideo({
    input: join(dir, 'frame-%d.png'),
    output: mp4Path,
    fps,
  });
  return mp4Path;
}

async function createSamplePngBuffer(width = 64, height = 36, background = '#1e293b') {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

test('root index re-exports publish and assets APIs', () => {
  assert.equal(typeof rootApi.publishWebBundle, 'function');
  assert.equal(typeof rootApi.publishYouTube, 'function');
  assert.equal(typeof rootApi.buildWebEmbedHtml, 'function');
  assert.equal(typeof rootApi.generateAsset, 'function');
  assert.equal(typeof rootApi.computeAssetCacheKey, 'function');
  assert.equal(rootApi.YOUTUBE_MULTI_AUDIO_NOTE, YOUTUBE_MULTI_AUDIO_NOTE);
  assert.equal(rootApi.ASSET_NON_UI_POLICY, ASSET_NON_UI_POLICY);
});

test('publishWebBundle exports VP9 WebM + H.264 MP4 + WebP poster + embed.html + bundle.json end-to-end', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-publish-web-'));
  try {
    const input = await createSampleMp4(work, { width: 96, height: 64, fps: 2 });
    const outDir = join(work, 'web-bundle');

    const result = await publishWebBundle({
      input,
      outDir,
      name: 'hero-demo',
    });

    assert.equal(result.ok, true);
    assert.equal(result.target, 'web');
    assert.equal(result.name, 'hero-demo');
    assert.equal(result.videos.length, 2);

    const webmEntry = result.videos.find((v) => v.format === 'webm');
    const mp4Entry = result.videos.find((v) => v.format === 'mp4');
    assert.ok(webmEntry, 'includes WebM video');
    assert.ok(mp4Entry, 'includes MP4 video');
    assert.equal(webmEntry.file, 'hero-demo.webm');
    assert.equal(mp4Entry.file, 'hero-demo.mp4');
    assert.equal(webmEntry.codec, 'vp9');
    assert.equal(mp4Entry.codec, 'h264');

    // Probe real generated video files
    const webmProbe = await probeVideo(join(outDir, 'hero-demo.webm'));
    const mp4Probe = await probeVideo(join(outDir, 'hero-demo.mp4'));
    assert.equal(webmProbe.width, 96);
    assert.equal(webmProbe.height, 64);
    assert.equal(webmProbe.codec, 'vp9');
    assert.equal(webmProbe.audio, false);
    assert.ok(webmProbe.duration > 0);
    assert.equal(mp4Probe.width, 96);
    assert.equal(mp4Probe.height, 64);
    assert.equal(mp4Probe.codec, 'h264');
    assert.equal(mp4Probe.audio, false);
    assert.ok(mp4Probe.duration > 0);

    // Inspect WebP poster
    const posterBytes = await readFile(join(outDir, 'hero-demo.webp'));
    const posterMeta = await sharp(posterBytes).metadata();
    assert.equal(posterMeta.format, 'webp');
    assert.equal(posterMeta.width, 96);
    assert.equal(posterMeta.height, 64);
    assert.equal(result.poster.source, 'extracted');

    // Inspect embed.html
    const embedHtml = await readFile(join(outDir, 'embed.html'), 'utf8');
    assert.match(embedHtml, /<video\b[^>]*autoplay\b[^>]*muted\b[^>]*loop\b[^>]*playsinline\b/);
    assert.match(embedHtml, /poster="hero-demo\.webp"/);
    assert.match(embedHtml, /width="96"/);
    assert.match(embedHtml, /height="64"/);
    assert.match(embedHtml, /<source src="hero-demo\.webm" type="video\/webm; codecs=&quot;vp9&quot;">/);
    assert.match(embedHtml, /<source src="hero-demo\.mp4" type="video\/mp4">/);
    assert.ok(
      embedHtml.indexOf('hero-demo.webm') < embedHtml.indexOf('hero-demo.mp4'),
      'WebM source appears before MP4 fallback'
    );

    // Inspect bundle.json provenance manifest and verify every SHA-256 hash & byte length
    const manifest = JSON.parse(await readFile(join(outDir, 'bundle.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.target, 'web');
    assert.equal(manifest.name, 'hero-demo');
    assert.equal(manifest.colorSpace, 'srgb');
    assert.equal(manifest.source.sha256, sha256(await readFile(input)));
    assert.equal(manifest.source.width, 96);
    assert.equal(manifest.source.height, 64);

    assert.equal(manifest.assets.videos.length, 2);
    for (const entry of manifest.assets.videos) {
      const bytes = await readFile(join(outDir, entry.file));
      assert.equal(entry.bytes, bytes.length);
      assert.equal(entry.sha256, sha256(bytes));
      assert.equal(entry.width, 96);
      assert.equal(entry.height, 64);
    }

    assert.equal(manifest.assets.poster.file, 'hero-demo.webp');
    assert.equal(manifest.assets.poster.bytes, posterBytes.length);
    assert.equal(manifest.assets.poster.sha256, sha256(posterBytes));
    assert.equal(manifest.assets.poster.width, 96);
    assert.equal(manifest.assets.poster.height, 64);

    const embedBuf = await readFile(join(outDir, 'embed.html'));
    assert.equal(manifest.assets.embed.file, 'embed.html');
    assert.equal(manifest.assets.embed.bytes, embedBuf.length);
    assert.equal(manifest.assets.embed.sha256, sha256(embedBuf));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('publishWebBundle supports AV1 + VP9 + H.264 formats and a provided poster image', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-publish-av1-'));
  try {
    const input = await createSampleMp4(work, { width: 96, height: 64, fps: 2 });
    const customPoster = join(work, 'custom-poster.png');
    await writeFile(customPoster, await createSamplePngBuffer(120, 80, '#10b981'));

    const outDir = join(work, 'out-av1');
    const result = await publishWebBundle({
      input,
      outDir,
      name: 'clip',
      poster: customPoster,
      formats: ['h264', 'vp9', 'av1'],
    });

    assert.equal(result.videos.length, 3);
    assert.deepEqual(
      result.videos.map((v) => v.file),
      ['clip.av1.webm', 'clip.vp9.webm', 'clip.mp4']
    );
    assert.deepEqual(
      result.videos.map((v) => v.codec),
      ['av1', 'vp9', 'h264']
    );
    assert.equal(result.poster.source, 'provided');
    assert.equal(result.poster.width, 120);
    assert.equal(result.poster.height, 80);

    const av1Probe = await probeVideo(join(outDir, 'clip.av1.webm'));
    assert.equal(av1Probe.codec, 'av1');
    assert.equal(av1Probe.width, 96);
    assert.equal(av1Probe.height, 64);

    const embed = await readFile(join(outDir, 'embed.html'), 'utf8');
    const av1Idx = embed.indexOf('clip.av1.webm');
    const vp9Idx = embed.indexOf('clip.vp9.webm');
    const mp4Idx = embed.indexOf('clip.mp4');
    assert.ok(av1Idx >= 0 && vp9Idx > av1Idx && mp4Idx > vp9Idx, 'AV1 -> VP9 -> MP4 source order');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('publishWebBundle rejects invalid names, colorSpace, and unknown formats', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-publish-web-err-'));
  try {
    const input = await createSampleMp4(work);
    await assert.rejects(
      publishWebBundle({ input, outDir: join(work, 'out'), name: '../escape' }),
      /safe base filename/
    );
    await assert.rejects(
      publishWebBundle({ input, outDir: join(work, 'out'), formats: ['prores'] }),
      /Unsupported web bundle format/
    );
    await assert.rejects(
      publishWebBundle({ input, outDir: join(work, 'out'), colorSpace: 'rec2020' }),
      /unsupported colorSpace/
    );
    assert.throws(() => buildWebEmbedHtml({ videos: [] }), /at least one video/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('publishYouTube dry-run validates video, metadata, captions, and thumbnail with zero network calls', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-yt-dry-'));
  try {
    const video = await createSampleMp4(work);
    const srtFile = join(work, 'en.srt');
    const vttFile = join(work, 'uk.vtt');
    const thumbFile = join(work, 'thumb.png');
    await writeFile(srtFile, '1\n00:00:00,000 --> 00:00:01,500\nHello screen-kit\n');
    await writeFile(vttFile, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nПривіт screen-kit\n');
    await writeFile(thumbFile, await createSamplePngBuffer(128, 72, '#0f172a'));

    let fetchCalls = 0;
    const forbiddenFetch = async () => {
      fetchCalls += 1;
      throw Error('dryRun must never call fetch');
    };

    const result = await publishYouTube({
      video,
      title: 'Screen-kit Demo Walkthrough',
      description: 'Automated product walkthrough captured with real input.',
      privacy: 'unlisted',
      captions: [
        { file: srtFile, language: 'en', name: 'English' },
        { file: vttFile, language: 'uk', name: 'Ukrainian' },
      ],
      thumbnail: thumbFile,
      fetchImpl: forbiddenFetch,
      dryRun: true,
    });

    assert.equal(fetchCalls, 0);
    assert.equal(result.ok, true);
    assert.equal(result.target, 'youtube');
    assert.equal(result.dryRun, true);
    assert.equal(result.uploaded, false);
    assert.equal(result.privacy, 'unlisted');
    assert.equal(result.video.mimeType, 'video/mp4');
    assert.equal(result.video.sha256, sha256(await readFile(video)));
    assert.equal(result.captions.length, 2);
    assert.equal(result.captions[0].format, 'srt');
    assert.equal(result.captions[0].mimeType, 'application/x-subrip');
    assert.equal(result.captions[1].format, 'vtt');
    assert.equal(result.captions[1].mimeType, 'text/vtt');
    assert.equal(result.thumbnail.mimeType, 'image/png');
    assert.ok(
      result.notes.some((note) => /YouTube Studio/i.test(note) && /audio-language/i.test(note)),
      'includes YouTube Studio audio-language note'
    );

    // Validation rejections in dryRun
    await assert.rejects(
      publishYouTube({ video, title: 'x'.repeat(101), dryRun: true, fetchImpl: forbiddenFetch }),
      /exceeds 100 characters/
    );
    await assert.rejects(
      publishYouTube({ video, title: 'Valid', privacy: 'friends', dryRun: true, fetchImpl: forbiddenFetch }),
      /privacy must be one of/
    );
    await assert.rejects(
      publishYouTube({
        video,
        title: 'Valid',
        captions: [{ file: join(work, 'missing.srt'), language: 'en' }],
        dryRun: true,
        fetchImpl: forbiddenFetch,
      }),
      /not found/
    );
    const bigThumb = join(work, 'too-big.png');
    await writeFile(bigThumb, Buffer.alloc(2 * 1024 * 1024 + 1, 0x42));
    await assert.rejects(
      publishYouTube({ video, title: 'Valid', thumbnail: bigThumb, dryRun: true, fetchImpl: forbiddenFetch }),
      /2 MiB limit/
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('publishYouTube rejects missing OAuth token without making network calls', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-yt-notoken-'));
  try {
    const video = await createSampleMp4(work);
    let fetchCalls = 0;
    await assert.rejects(
      publishYouTube({
        video,
        title: 'Needs token',
        accessToken: '',
        dryRun: false,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response('{}', { status: 200 });
        },
      }),
      /OAuth access token/i
    );
    assert.equal(fetchCalls, 0);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('publishYouTube uploads video, SRT/VTT captions, and thumbnail via mocked YouTube Data API v3', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-yt-upload-'));
  try {
    const video = await createSampleMp4(work);
    const videoBytes = await readFile(video);
    const srtFile = join(work, 'en.srt');
    const srtContent = '1\n00:00:00,000 --> 00:00:01,500\nHello world\n';
    await writeFile(srtFile, srtContent);
    const thumbFile = join(work, 'thumb.png');
    const thumbBytes = await createSamplePngBuffer(128, 72, '#3b82f6');
    await writeFile(thumbFile, thumbBytes);

    const requests = [];
    const mockFetch = async (url, init) => {
      const bodyBuffer = Buffer.isBuffer(init.body)
        ? init.body
        : Buffer.from(init.body ?? '');
      requests.push({
        url: String(url),
        method: init.method,
        headers: init.headers,
        body: bodyBuffer,
      });

      if (String(url).includes('/upload/youtube/v3/videos')) {
        return new Response(JSON.stringify({ id: 'yt_abc123XYZ' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/upload/youtube/v3/captions')) {
        return new Response(JSON.stringify({ id: 'cap_en_001' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/upload/youtube/v3/thumbnails/set')) {
        return new Response(
          JSON.stringify({ items: [{ default: { url: 'https://i.ytimg.com/vi/yt_abc123XYZ/default.jpg' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw Error(`Unexpected URL: ${url}`);
    };

    const result = await publishYouTube({
      video,
      title: 'Scenario Editor Demo',
      description: 'Real browser interaction demo.',
      privacy: 'unlisted',
      captions: [{ file: srtFile, language: 'en', name: 'English' }],
      thumbnail: thumbFile,
      accessToken: 'ya29.test-oauth-token',
      fetchImpl: mockFetch,
      dryRun: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.uploaded, true);
    assert.equal(result.videoId, 'yt_abc123XYZ');
    assert.equal(result.url, 'https://youtu.be/yt_abc123XYZ');
    assert.equal(result.captions.length, 1);
    assert.equal(result.captions[0].id, 'cap_en_001');
    assert.equal(result.captions[0].language, 'en');
    assert.equal(result.thumbnail.uploaded, true);
    assert.ok(result.notes.includes(YOUTUBE_MULTI_AUDIO_NOTE));

    // Verify exact 3 API requests: video -> caption -> thumbnail
    assert.equal(requests.length, 3);

    // 1. Video multipart upload
    const [videoReq, captionReq, thumbReq] = requests;
    assert.match(videoReq.url, /\/upload\/youtube\/v3\/videos\?uploadType=multipart&part=snippet,status$/);
    assert.equal(videoReq.method, 'POST');
    assert.equal(videoReq.headers.authorization, 'Bearer ya29.test-oauth-token');
    assert.match(videoReq.headers['content-type'], /^multipart\/related; boundary=screen_kit_/);
    const videoBodyText = videoReq.body.toString('latin1');
    assert.ok(videoBodyText.includes('"title":"Scenario Editor Demo"'));
    assert.ok(videoBodyText.includes('"privacyStatus":"unlisted"'));
    assert.ok(videoBodyText.includes('Content-Type: video/mp4'));
    assert.ok(videoReq.body.includes(videoBytes), 'multipart body embeds exact video bytes');

    // 2. Caption multipart upload
    assert.match(captionReq.url, /\/upload\/youtube\/v3\/captions\?uploadType=multipart&part=snippet$/);
    assert.equal(captionReq.headers.authorization, 'Bearer ya29.test-oauth-token');
    assert.match(captionReq.headers['content-type'], /^multipart\/related; boundary=screen_kit_/);
    const captionText = captionReq.body.toString('utf8');
    assert.ok(captionText.includes('"videoId":"yt_abc123XYZ"'));
    assert.ok(captionText.includes('"language":"en"'));
    assert.ok(captionText.includes('Content-Type: application/x-subrip'));
    assert.ok(captionText.includes('Hello world'));

    // 3. Thumbnail media upload
    assert.match(
      thumbReq.url,
      /\/upload\/youtube\/v3\/thumbnails\/set\?videoId=yt_abc123XYZ&uploadType=media$/
    );
    assert.equal(thumbReq.headers.authorization, 'Bearer ya29.test-oauth-token');
    assert.equal(thumbReq.headers['content-type'], 'image/png');
    assert.deepEqual(thumbReq.body, thumbBytes);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('generateAsset sends x-goog-api-key header (never in URL), caches by prompt hash, and replays offline', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-asset-'));
  try {
    const cacheDir = join(work, 'cache');
    const pngBytes = await createSamplePngBuffer(64, 36, '#6366f1');
    const secretKey = 'test-secret-api-key-999';
    const prompt = 'Minimalist dark slate gradient stage wallpaper with soft studio light';

    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          predictions: [
            {
              bytesBase64Encoded: pngBytes.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const out1 = join(work, 'wall-1.png');
    const first = await generateAsset({
      kind: 'wallpaper',
      prompt,
      out: out1,
      aspectRatio: '16:9',
      apiKey: secretKey,
      fetchImpl: mockFetch,
      cacheDir,
    });

    assert.equal(calls.length, 1);
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(first.kind, 'wallpaper');
    assert.equal(first.model, DEFAULT_IMAGE_MODEL);
    assert.equal(first.width, 64);
    assert.equal(first.height, 36);
    assert.equal(first.nonUiOnly, true);
    assert.equal(first.cacheKey, computeAssetCacheKey({ kind: 'wallpaper', prompt }));

    // Verify API key is ONLY in x-goog-api-key header, NEVER in URL query string
    assert.equal(calls[0].init.headers['x-goog-api-key'], secretKey);
    assert.ok(!calls[0].url.includes(secretKey), 'URL must never include API key');
    assert.ok(!calls[0].url.includes('?key='), 'URL must never have ?key= query param');
    assert.match(calls[0].url, /:predict$/);

    const saved1 = await readFile(out1);
    assert.deepEqual(saved1, pngBytes);
    assert.equal(first.sha256, sha256(pngBytes));

    // Second call with identical (kind, model, aspectRatio, prompt) hits cache without calling fetch
    const out2 = join(work, 'wall-2.png');
    const second = await generateAsset({
      kind: 'wallpaper',
      prompt,
      out: out2,
      aspectRatio: '16:9',
      apiKey: secretKey,
      fetchImpl: mockFetch,
      cacheDir,
    });

    assert.equal(calls.length, 1, 'second call must not hit the network');
    assert.equal(second.cached, true);
    assert.equal(second.cacheKey, first.cacheKey);
    assert.equal(second.sha256, first.sha256);
    assert.deepEqual(await readFile(out2), pngBytes);

    // Cache hit converting cached PNG to WebP without hitting the network
    const outWebp = join(work, 'wall-2.webp');
    const third = await generateAsset({
      kind: 'wallpaper',
      prompt,
      out: outWebp,
      aspectRatio: '16:9',
      apiKey: '',
      fetchImpl: mockFetch,
      cacheDir,
    });
    assert.equal(calls.length, 1, 'format conversion from cache must not hit network');
    assert.equal(third.cached, true);
    assert.equal(third.format, 'webp');
    const webpMeta = await sharp(outWebp).metadata();
    assert.equal(webpMeta.format, 'webp');
    assert.equal(webpMeta.width, 64);

    // Changing kind or prompt produces a distinct cache key
    assert.notEqual(
      computeAssetCacheKey({ kind: 'thumbnail', prompt }),
      computeAssetCacheKey({ kind: 'wallpaper', prompt })
    );
    assert.notEqual(
      computeAssetCacheKey({ kind: 'wallpaper', prompt: `${prompt} v2` }),
      computeAssetCacheKey({ kind: 'wallpaper', prompt })
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('generateAsset supports Gemini Image generateContent models and fails cleanly without API key', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-asset-gemini-'));
  try {
    const cacheDir = join(work, 'cache');
    const pngBytes = await createSamplePngBuffer(80, 45, '#f59e0b');
    let calls = 0;

    // Clean failure without key and zero network calls
    await assert.rejects(
      generateAsset({
        kind: 'thumbnail',
        prompt: 'Bold geometric product launch cover background',
        out: join(work, 'no-key.png'),
        apiKey: '',
        cacheDir,
        fetchImpl: async () => {
          calls += 1;
          return new Response('{}', { status: 200 });
        },
      }),
      /requires API credentials/i
    );
    assert.equal(calls, 0);

    // Gemini Image model (:generateContent with inlineData)
    let capturedUrl = '';
    let capturedHeaders = null;
    const res = await generateAsset({
      kind: 'thumbnail',
      prompt: 'Bold geometric product launch cover background',
      out: join(work, 'thumb.jpg'),
      model: 'gemini-2.5-flash-image',
      aspectRatio: '16:9',
      apiKey: 'gemini-key-123',
      cacheDir,
      fetchImpl: async (url, init) => {
        calls += 1;
        capturedUrl = String(url);
        capturedHeaders = init.headers;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: pngBytes.toString('base64'),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    assert.equal(calls, 1);
    assert.match(capturedUrl, /models\/gemini-2\.5-flash-image:generateContent$/);
    assert.ok(!capturedUrl.includes('gemini-key-123'));
    assert.equal(capturedHeaders['x-goog-api-key'], 'gemini-key-123');
    assert.equal(res.format, 'jpeg');
    assert.equal(res.mimeType, 'image/jpeg');
    const jpgMeta = await sharp(res.file).metadata();
    assert.equal(jpgMeta.format, 'jpeg');
    assert.equal(jpgMeta.width, 80);

    // Invalid inputs rejected cleanly
    await assert.rejects(
      generateAsset({ kind: 'ui-screen', prompt: 'nope', out: join(work, 'x.png'), apiKey: 'k' }),
      /asset kind must be one of/
    );
    await assert.rejects(
      generateAsset({ kind: 'thumbnail', prompt: 'ok', out: join(work, 'x.gif'), apiKey: 'k' }),
      /Unsupported asset output extension/
    );
    await assert.rejects(
      generateAsset({ kind: 'thumbnail', prompt: 'ok', out: join(work, 'x.png'), aspectRatio: 'wide', apiKey: 'k' }),
      /aspectRatio must match/
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('CLI supports publish (web + youtube --dry-run) and asset commands', async () => {
  const work = await mkdtemp(join(tmpdir(), 'screen-kit-cli-publish-'));
  try {
    const input = await createSampleMp4(work, { width: 80, height: 60, fps: 2 });
    const webOut = join(work, 'cli-web');

    // 1. CLI publish --target web
    const { stdout: webStdout } = await exec(process.execPath, [
      CLI_PATH,
      'publish',
      '--target',
      'web',
      '--input',
      input,
      '--out',
      webOut,
      '--name',
      'cli-demo',
    ]);
    const webResult = JSON.parse(webStdout);
    assert.equal(webResult.ok, true);
    assert.equal(webResult.target, 'web');
    assert.equal(webResult.name, 'cli-demo');
    assert.ok(await readFile(join(webOut, 'bundle.json'), 'utf8'));
    assert.ok(await readFile(join(webOut, 'embed.html'), 'utf8'));

    // 2. CLI publish --target youtube --dry-run
    const srtFile = join(work, 'en.srt');
    await writeFile(srtFile, '1\n00:00:00,000 --> 00:00:01,000\nCLI test\n');
    const thumbFile = join(work, 'thumb.png');
    await writeFile(thumbFile, await createSamplePngBuffer(64, 36));
    const reportFile = join(work, 'yt-report.json');

    const { stdout: ytStdout } = await exec(process.execPath, [
      CLI_PATH,
      'publish',
      '--target',
      'youtube',
      '--input',
      input,
      '--title',
      'CLI Dry Run Title',
      '--privacy',
      'unlisted',
      '--captions',
      `en:${srtFile}`,
      '--thumbnail',
      thumbFile,
      '--dry-run',
      '--out',
      reportFile,
    ]);
    const ytResult = JSON.parse(ytStdout);
    assert.equal(ytResult.ok, true);
    assert.equal(ytResult.dryRun, true);
    assert.equal(ytResult.captions.length, 1);
    assert.equal(ytResult.captions[0].language, 'en');
    assert.ok(ytResult.notes.includes(YOUTUBE_MULTI_AUDIO_NOTE));
    assert.deepEqual(JSON.parse(await readFile(reportFile, 'utf8')), ytResult);

    // 3. CLI asset without credentials fails cleanly with non-zero exit
    const cleanEnv = { ...process.env };
    delete cleanEnv.GEMINI_API_KEY;
    delete cleanEnv.GOOGLE_API_KEY;
    await assert.rejects(
      exec(
        process.execPath,
        [
          CLI_PATH,
          'asset',
          '--kind',
          'thumbnail',
          '--prompt',
          'Abstract dark backdrop',
          '--out',
          join(work, 'asset.png'),
        ],
        { env: cleanEnv }
      ),
      (error) => error.code === 1 && /API credentials/i.test(error.stderr)
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
