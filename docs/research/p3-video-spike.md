# Display P3 video preservation spike (2026-11-22)

Question: does Chromium's CDP `Page.startScreencast` preserve Display P3 pixels or clamp them to
sRGB, and what exact `ffmpeg` flags preserve Display P3 primaries and pixel values in H.264 MP4
and VP9 WebM through actual browser playback?

Answer: **yes — CDP `Page.startScreencast` preserves raw Display P3 RGB pixel values (both PNG and
JPEG, headless and headful), but strips the ICC profile.** Encoding those frames to H.264 MP4 or
VP9 WebM preserves Display P3 end-to-end **only** when the `ffmpeg` filtergraph explicitly sets
both the YUV matrix (`scale=out_color_matrix=bt709:out_range=tv`) **and** frame-level CICP
parameters (`setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv`).
Passing CLI `-color_primaries` / `-color_trc` flags alone without `setparams` silently drops
primaries and transfer to `unspecified` in FFmpeg 9.0.2, causing Chromium to desaturate the video
back to sRGB on playback.

Setup:
- Chromium `Chrome/156.0.8078.4` (`Google Chrome for Testing`, Playwright cache `chromium-1248`)
  launched with `--force-color-profile=display-p3-d65`.
- `ffmpeg 9.0.2` (`libx264`, `libvpx-vp9`), `ffprobe 9.0.2`, `sharp 0.35.5`.
- Test page (640 × 360): left half `color(display-p3 1 0 0)`, right half `rgb(255, 0, 0)`, plus an
  8 × 8 px corner `requestAnimationFrame` ticker so screencast emits continuous frames.
  In Display P3 D65 (sRGB transfer), pure P3 red encodes to `(255, 0, 0)` while sRGB red encodes
  to `(234, 51, 35)` (Euclidean distance `65.3`). Clamping to sRGB collapses both halves to
  `(255, 0, 0)` (`dist = 0`).
- Script: [p3-video-spike-2026-11-22/probe.mjs](p3-video-spike-2026-11-22/probe.mjs), run under
  `slotfather run -n 1 -- node docs/research/p3-video-spike-2026-11-22/probe.mjs`.
- Raw pixel values below are decoded via `ffmpeg -f rawvideo -pix_fmt rgb24` (no ICC color
  management). **[probe]** for every row in both tables.

## Capture: still vs CDP `Page.startScreencast`

Both headless (`--headless=new`) and headful Chromium reported `matchMedia('(color-gamut: p3)') === true`
and produced identical results:

| Capture | Mode | ICC profile | `p3Red` RGB | `srgbRed` RGB | Delta / Dist |
| --- | --- | --- | --- | --- | --- |
| `Page.captureScreenshot` (PNG) | headless & headful | 520 B (`Display P3 Gamut with sRGB Transfer`) | `255, 0, 0` | `234, 51, 35` | `+21, -51, -35` (`65.3`) |
| `Page.startScreencast` (PNG) | headless & headful | **none** (`0 B`) | `255, 0, 0` | `234, 51, 35` | `+21, -51, -35` (`65.3`) |
| `Page.startScreencast` (JPEG q95) | headless & headful | **none** (`0 B`) | `254, 0, 0` | `234, 51, 35` | `+20, -51, -35` (`65.0`) |

## Encode: FFmpeg metadata, decoded pixels, and Chromium `<video>` playback

Encoded from the P3 still PNG (and verified identically from the untagged screencast PNG) at 30 fps
(1 s, 30 frames), then probed with `ffprobe`, decoded with `ffmpeg`, and played back in a `<video>`
element in `--force-color-profile=display-p3-d65` Chromium:

| Variant | `ffprobe` (`primaries / trc / space / range`) | Decoded `p3Red` / `srgbRed` | Chromium `<video>` `p3Red` / `srgbRed` | Verdict |
| --- | --- | --- | --- | --- |
| `mp4_current` (`src/video.mjs`, no tags) | `unspec / unspec / unspec / unspec` | `254,0,0` / `234,50,35` | `228,62,34` / `213,80,52` | **Wrong:** BT.601 matrix mismatch + sRGB gamut clamp |
| `mp4_p3_cli_only` (CLI tags, no `setparams`) | `unspec / unspec / bt709 / tv` | `255,0,0` / `233,50,35` | `234,51,35` / `218,74,54` | **Wrong:** primaries dropped; P3 red desaturated to sRGB red |
| `mp4_p3_setparams_iec61966_8bit` | `smpte432 / iec61966-2-1 / bt709 / tv` | `255,0,0` / `233,50,35` | `255,1,0` / `234,51,36` | **Pass** (±1 LSB end-to-end) |
| `mp4_p3_setparams_bt709trc_8bit` | `smpte432 / bt709 / bt709 / tv` | `255,0,0` / `233,50,35` | `255,0,0` / `237,58,40` | Slight transfer shift on mid-tones (`srgbRed` +3/+7/+5) |
| `mp4_p3_setparams_iec61966_10bit` (`High 10`) | `smpte432 / iec61966-2-1 / bt709 / tv` | `253,0,0` / `231,49,33` | `253,0,0` / `232,51,34` | Pass, but no accuracy gain for 8-bit input and worse decoder support |
| `mp4_p3_from_screencast_png` | `smpte432 / iec61966-2-1 / bt709 / tv` | `255,0,0` / `233,50,35` | `255,1,0` / `234,51,36` | **Pass** (identical to still-PNG input) |
| `webm_current` (`src/video.mjs`, no tags) | `unspec / unspec / unspec / tv` | `254,0,0` / `234,50,35` | `234,58,36` / `232,90,54` | **Wrong:** matrix mismatch + sRGB gamut clamp |
| `webm_p3_cli_only` (CLI tags, no `setparams`) | `unspec / unspec / bt709 / tv` | `255,0,0` / `233,50,35` | `234,51,35` / `218,74,54` | **Wrong:** primaries dropped; desaturated to sRGB |
| `webm_p3_setparams_iec61966_8bit` | `smpte432 / iec61966-2-1 / bt709 / tv` | `255,0,0` / `233,50,35` | `255,1,0` / `234,51,36` | **Pass** (±1 LSB end-to-end) |
| `webm_p3_setparams_bt709trc_8bit` | `smpte432 / bt709 / bt709 / tv` | `255,0,0` / `233,50,35` | `255,0,0` / `237,58,40` | Slight transfer shift on mid-tones (`srgbRed` +3/+7/+5) |
| `webm_p3_setparams_iec61966_10bit` (`Profile 2`) | `smpte432 / iec61966-2-1 / bt709 / tv` | `253,0,0` / `231,49,33` | `253,0,0` / `232,51,34` | Pass, no accuracy gain for 8-bit input |
| `webm_p3_from_screencast_png` | `smpte432 / iec61966-2-1 / bt709 / tv` | `255,0,0` / `233,50,35` | `255,1,0` / `234,51,36` | **Pass** (identical to still-PNG input) |

## Findings

- **CDP screencast preserves P3 pixels but strips ICC:** both PNG and JPEG (`q=95`) frames from
  `Page.startScreencast` carry the exact Display P3 RGB channel values (`255,0,0` vs `234,51,35`),
  in both headless and headful Chromium, but contain no `iCCP`/`cICP`/`APP2` profile. Any downstream
  encoder must therefore know the take was captured under `--force-color-profile=display-p3-d65`
  and tag the output explicitly. **[probe]**
- **FFmpeg 9.0.2 requires `setparams` inside `-vf`:** `scale=out_color_matrix=bt709:out_range=tv`
  performs the RGB → YUV conversion with the BT.709 matrix (avoiding FFmpeg's default BT.601
  matrix), while `setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv`
  attaches CICP metadata to the frames so `libx264` and `libvpx-vp9` write both bitstream VUI and
  container color atoms. Passing `-color_primaries` / `-color_trc` only as CLI output options is
  silently overridden by the untagged filtergraph frames. **[probe]**
- **Use `iec61966-2-1` (sRGB transfer), not `bt709`:** Chromium renders Display P3 with the sRGB
  transfer curve (`Display P3 Gamut with sRGB Transfer`). Tagging `color_trc=iec61966-2-1` rounds
  back through Chromium `<video>` within ±1 LSB; tagging `bt709` shifts `srgbRed` by `+3/+7/+5`.
  **[probe]**
- **Stick to 8-bit `yuv420p`:** 10-bit (`yuv420p10le`, H.264 High 10 / VP9 Profile 2) offered no
  color fidelity advantage for 8-bit screencast inputs and reduces hardware-decoder compatibility.
  **[probe]** / **[inferred]**
- **`sharp(buf).raw()` gotcha for tests:** on an ICC-tagged Display P3 PNG, `sharp(buf).raw()`
  in `sharp 0.35.5` transformed the pixels to sRGB (collapsing both reds to `255,0,0`), whereas on
  an untagged screencast PNG it returned the raw P3 bytes. Always read raw encoded pixels via
  `ffmpeg -f rawvideo -pix_fmt rgb24` (no ICC conversion) when verifying P3 channel values. **[probe]**
- **Metadata-only or decode-only checks are insufficient:** `mp4_p3_cli_only` passed a raw
  `ffmpeg` decode check (`dist = 64.9`) because raw YUV→RGB decoding ignores primaries, yet
  Chromium desaturated its playback to sRGB (`234,51,35` / `218,74,54`). An end-to-end gate must
  assert `ffprobe` CICP tags **and** decoded pixels (and ideally Chromium playback). **[probe]**

## Recommended implementation & acceptance test

1. **Exact FFmpeg flags for Display P3 in `src/video.mjs`:**
   Add an explicit `colorSpace: 'srgb' | 'p3'` option to `renderVideo()` (default `'srgb'` for
   Increment 1; `'p3'` when encoding `--force-color-profile=display-p3-d65` screencast takes):
   ```text
   -vf pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=tv
   -pix_fmt yuv420p
   -color_primaries smpte432 -color_trc iec61966-2-1 -colorspace bt709 -color_range tv
   ```
   Apply to both H.264 MP4 (`libx264`) and VP9 WebM (`libvpx-vp9`). Note that `src/browser.mjs`'s
   current `agent-browser record start` path delegates encoding to Playwright's internal VP9
   recorder, which does not emit P3 CICP tags **[inferred]**; P3 video capture should encode saved
   CDP screencast frames through `renderVideo({ colorSpace: 'p3' })`.
2. **Metadata in `probeVideo()` (`src/video.mjs`):**
   Expose `colorPrimaries`, `colorTransfer`, `colorSpace`, and `colorRange` from `ffprobe` so
   `run.json` records actual probed color metadata rather than requested flags.
3. **Acceptance test (deterministic, runnable under `slotfather run -n 1`):**
   - Capture the two-half P3-red / sRGB-red fixture via CDP `Page.startScreencast` under
     `--force-color-profile=display-p3-d65`.
   - Encode to `.mp4` and `.webm` with `renderVideo({ colorSpace: 'p3' })`.
   - Assert `ffprobe`: `color_primaries === 'smpte432'`, `color_transfer === 'iec61966-2-1'`,
     `color_space === 'bt709'`, `color_range === 'tv'`.
   - Assert raw decoded RGB24 (`scale=in_color_matrix=bt709`): `p3Red` within ±3 of `(255, 0, 0)`,
     `srgbRed` within ±3 of `(234, 51, 35)`, Euclidean distance `>= 55`.
   - Assert Chromium `<video>` playback screenshot (raw RGB24) also keeps `p3Red` within ±3 of
     `(255, 0, 0)` and `srgbRed` within ±3 of `(234, 51, 35)` (preventing silent sRGB clamping).
