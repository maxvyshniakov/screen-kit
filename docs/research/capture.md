# Scripted UI demo videos: research and proof (2026-11-04)

Tags: **[read]** = taken from a cited primary source (docs, repository, registry, source code);
**[probe]** = measured on this Mac today; **[inferred]** = my conclusion, not verified.

## Recommendation

Read this first: **the shipped Data Grid never bounces sideways.** `overscroll-behavior-x: none` is set
on its horizontal scrollers, on purpose ("The table never bounces sideways", `## Unreleased` in
`packages/data-grid/CHANGELOG.md`; issue #51). No capture path can record that bounce until #51 lands.
With `overscroll-behavior-x: contain` forced into the page, the rows bounce but the header and fades stay
where they are. That is the #51 artifact, and the proof clip shows it. **[read] [probe]**

The pipeline (one script an agent can write and re-run):

1. **Driver:** Playwright 1.64 drives headless Chromium. It loads the story with `globals=a11y.manual:!true`,
   so Storybook's axe-core run does not freeze the page for about 0.5 s in the middle of a take.
   **[probe]**
2. **Input:** CDP `Input.synthesizeScrollGesture` with `gestureSourceType: 'mouse'` (or `'touch'`).
   Either one rubber-bands in headless Chromium on macOS. Phase-less `Input.dispatchMouseEvent`
   wheel events do not. **[probe]**
3. **Cursor:** a DOM SVG arrow, injected into the page and moved by `requestAnimationFrame` along a
   minimum-jerk path (a quadratic arc with a 10t³−15t⁴+6t⁵ profile). It moves on the page's own frame
   clock, so it never steps or teleports. A trackpad swipe leaves the cursor still, as it does on a real
   Mac. **[probe]**
4. **Capture:** CDP `Page.startScreencast` frames, saved with their capture timestamps. They arrive out
   of order and must be sorted by timestamp. An ffmpeg concat list then turns them into a constant
   60 fps stream, so a dropped frame shows up as a repeat, never as a speed-up. **[probe]**
5. **Delivery:** `<video autoplay muted loop playsinline poster=…>` with an AV1 or VP9 WebM source,
   then an H.264 MP4 fallback. **[read]**
6. **Retina (2560×1600):** the headless path on macOS cannot capture it (see the proof).
   - For true 2× you need a real window captured at backing resolution: ScreenCaptureKit or OBS
     capturing a headful Chrome window. That needs Screen Recording permission and the owner's
     consent. **[inferred]**
   - Or a Linux container with `HeadlessExperimental.beginFrame`, which captures frame-exact at any DPR.
     But Chrome's elastic overscroll there is unverified. **[inferred]**

The ready-made tools are worth reading, not adopting as they stand:

- **Argo** (`@argo-video/cli` 0.42.1, MIT, 2026-10-27) captures through Playwright's screencast
  (`jpeg-stitch` mode), supersamples 2× and uses x264 at CRF 16. **[read]**
- **demowright** (2.8.0, MIT, 2026-04-27) records through Playwright's video recording, with a synthetic
  cursor and zoom done by CSS transforms. **[read]**

Neither one gives control of the scroll gesture, which is the subject of this clip. A ~150-line script
does. **[inferred]**

## Tools and findings

### Recorders

| Tool | Scriptable | Quality / fps | Cursor | License, latest | Notes |
|---|---|---|---|---|---|
| Playwright `recordVideo` / `page.screencast.start({ path })` | yes | VP9 WebM. ffmpeg args in playwright-core 1.64.1: `libvpx-vp9 -crf 8 -deadline realtime -cpu-used 8`, bitrate scaled from pixel rate, default fps 25 (`kDefaultFps = 25`), with an `fps` option. Frames come from CDP screencast, so the same limits as the next row apply. **[read: node_modules/playwright-core/lib/coreBundle.js]** | `page.screencast.showActions({ cursor: 'pointer' })` animates a pointer between action points; `showChapter`, `showOverlay` **[read: types.d.ts 1.64.1]** | Apache-2.0, 1.64.1 on 2026-11-03 **[read: npm]** | The older VP8 1 Mbit/s cap ([#31424](https://github.com/microsoft/playwright/issues/31424)) has been replaced by VP9 CRF 8 in 1.64. PR [#41007](https://github.com/microsoft/playwright/pull/41007) (ffmpeg override) was closed unmerged on 2026-06-05. **[read]** |
| CDP `Page.startScreencast` | yes | JPEG or PNG frames, with `maxFramesInFlight` and `sendLastFrame` params **[read: devtools-protocol browser_protocol.json]**. Frames are **capped at the CSS viewport size**: 1280×800 at deviceScaleFactor 2, in both headless-shell and new headless, and with `Emulation.setDeviceMetricsOverride({ scale: 2 })` too. **[probe]** At 1280×800 it delivers 60 fps when the page renders 60 fps. **[probe]** | none | part of Chromium | The workhorse for headless capture. |
| CDP `HeadlessExperimental.beginFrame` | yes | Frame-exact: one screenshot per synthetic BeginFrame. **[read]** | none | — | **Fails on macOS:** "BeginFrameControl is not supported on MacOS yet" (chrome-headless-shell 156.0.8078.4). **[probe]** Linux only in practice. |
| puppeteer-screen-recorder | yes | CDP screencast to ffmpeg | none | MIT, 3.0.6 on 2024-10-27 **[read: npm]** | Stale. Playwright's own API covers it now. |
| macOS ScreenCaptureKit CLIs | yes, as CLIs | backing-store resolution, up to the display refresh rate **[inferred]** | the real system cursor | `aperture` 7.0.0 (MIT, 2024-03-27) **[read: npm]**; Go `tmc/apple` SCK examples (MIT, May 2026); `sck-record` **[read: search result]** | Needs the Screen Recording (TCC) permission. Captures a real window, so it also needs a real input source for overscroll. |
| `ffmpeg -f avfoundation` | yes | full display only, no window filter **[inferred]** | the real cursor | LGPL/GPL | Same TCC permission. |
| OBS + obs-websocket | yes, over WebSocket v5, port 4455; bundled since OBS 28 **[read: [repo](https://github.com/obsproject/obs-websocket)]** | up to 60 fps or more at any resolution | the real cursor | GPL-2.0; OBS 33.0.1 on 2026-10-29 **[read: GitHub API]**; `obs-websocket-js` 5.0.8 (2026-03-14) | Heavy, but the most controllable real-screen recorder. |

### Composers (code-driven video)

- **Remotion** 4.0.540 (2026-11-02). Free for individuals and for-profit companies with up to 3
  employees; a Company License otherwise ([LICENSE.md](https://cdn.jsdelivr.net/npm/remotion@4.0.540/LICENSE.md)).
  **[read]** Good for wrapping a recorded clip with titles, zooms and an end card. Max qualifies for the
  free tier as an individual. **[inferred]**
- **Revideo** `@revideo/core` 0.11.0 (MIT, 2026-07-10). **[read: npm]**
- **Motion Canvas** 3.17.2 (MIT, 2024-12-14): no release for almost 2 years. **[read: npm, GitHub]**
- None of these is needed for a 6 s loop. ffmpeg `zoompan` or crop covers a simple camera move.
  **[inferred]**

### Cursor

- **ghost-cursor** 1.4.2 (ISC on npm, 2026-01-12; last commit 2026-08-04). It draws Bézier paths with
  random control points and uses Fitts's law to choose the point count. It is Puppeteer-first and moves
  the real mouse, so it is not an overlay. **[read: [repo](https://github.com/Xetera/ghost-cursor), npm]**
- In headless capture there is no OS cursor, so an injected DOM overlay is the standard approach.
  Argo (`createHumanCursor`, seeded curves, click circles), demowright ("smooth synthetic cursor") and
  Playwright `showActions` all do this. **[read]**
- The proof uses a minimum-jerk speed profile (Flash & Hogan 1985), which matches the speed curve of
  human point-to-point arm movement, along a slight arc. Click ripples are a 10-line CSS keyframe and
  were not needed here. **[inferred]**

### Auto-zoom recorders

- **Screen Studio:** no official API or CLI. It has deeplinks (`screen-studio://record-window`,
  `record-display`, `finish-recording`) without target parameters. A feature request asking for a CLI or
  API was merged into another request, with no reply.
  **[read: [hub.screen.studio](https://hub.screen.studio/p/more-automation-and-agent-friendly)]**
- An unofficial `screenstudio-cli` (v0.1.0) drives the Electron app over CDP, and can break on any
  update. **[read: [repo](https://github.com/ShawnPana/screenstudio-cli)]**
- **Cursorful, FocuSee:** no scripting API found. **[read: search found none; unverified]**

### "Demo video from code" projects

- **Argo** ([lordrip/argo](https://github.com/lordrip/argo); `@argo-video/cli` 0.42.1, MIT, last commit
  2026-10-27). **[read]**
  - Playwright scripts are captured through `page.screencast`.
  - `deviceScaleFactor: 2` is captured and lanczos-downscaled.
  - Defaults: 1920×1080 at 30 fps.
  - Zoom is done by ffmpeg `zoompan`; voiceover by local Kokoro TTS.
- **demowright** ([matte97p/demowright](https://github.com/matte97p/demowright); 2.8.0, MIT, last commit
  2026-10-02). **[read]**
  - Playwright video, converted to H.264.
  - Captions, a synthetic cursor and CSS-transform zoom.
  - 1280×720 landscape; fps not stated.
- Vercel, Linear, Raycast: no primary-source write-up of their demo-video pipeline was found.
  **[unknown]**

### Overscroll: which capture paths can show it

- **Headless Chromium 156 on macOS** (both chrome-headless-shell and new headless):
  - `Input.synthesizeScrollGesture`, `gestureSourceType: 'mouse'`, 400 px past the left edge: 21 px of
    rubber band. It peaks after ~0.3 s and springs back over ~0.6 s. Captured at 60 fps.
  - `'touch'` source: 26 px.
  - `Input.dispatchMouseEvent` mouseWheel (it has no phase field): ≤1 px, so no bounce.
  - All measured with `overscroll-behavior-x: contain` forced on the grid. As shipped (`none`): 0 px.
  - With `auto`, the gesture chains to the document and the whole page bounces (19 px), title included.
  - **[probe]**
- **Real browsers driven by CGEvent scroll events** with phase and momentum fields, captured with
  ScreenCaptureKit: should rubber-band in Chrome, Safari and Firefox. Chromium's elasticity controller
  branches on phase and momentum phase
  ([source](https://android.googlesource.com/platform/external/chromium_org/+/31cddfd4ec55fcfc2129f5fbb6b805caa05239e6/content/renderer/input/input_scroll_elasticity_controller.cc)).
  **[read]** Not tried: it would take over the owner's screen, and the brief forbids that without
  consent. **[inferred]**
- **Permissions** (none tested today):
  - Screen Recording (TCC) for any ScreenCaptureKit, avfoundation or OBS capture. **[inferred]**
  - Accessibility, or a posting-events grant, for CGEventPost. **[inferred]**
  - Headless CDP needs neither. **[probe]**
- **Not taking over the screen:**
  - CGVirtualDisplay (a private API; DeskPad, VirtualDisplayKit and go-macos/virtualdisplay use it)
    creates a display that ScreenCaptureKit can record. Apple can break it in any release.
    **[read: [go-macos/virtualdisplay](https://pkg.go.dev/github.com/go-macos/virtualdisplay)]**
  - Whether CGEvents posted to a window on that display, or on another Space, reach the window without
    moving the owner's cursor: **unverified**. CGEventPost moves the global cursor, while
    `CGEventPostToPid` targets one process. **[inferred]**
  - A separate login session with Fast User Switching is **unverified**.

### Web delivery

- **Markup:** `<video autoplay muted loop playsinline preload="metadata" poster="…">`, with WebM first,
  MP4 second ([web.dev](https://web.dev/articles/replace-gifs-with-videos)). **[read]**
  - iOS lets muted video autoplay inline with `playsinline`, and pauses it off-screen
    ([WebKit, 2016](https://webkit.org/blog/6784/new-video-policies-for-ios/)). **[read]**
- **Support** (caniuse data, fetched today) **[read]**:
  - H.264 MP4: 97.5 % global, every browser.
  - WebM: 96.4 %. Safari and iOS have full WebM in current versions, without alpha.
  - AV1: 79 % full + 17 % partial. In Safari 17+ and iOS 17+ it needs a hardware decoder (M3 or
    A17 Pro and later), so a source list must keep a VP9 or H.264 fallback.
- **Why not GIF:** 256 colours, no inter-frame compression. WebKit cites up to ~12× the bandwidth and
  about twice the energy of H.264. web.dev's example: GIF 3.7 MB → MP4 551 KB → WebM 341 KB.
  **[read]**
- **Size budget** for a 5–8 s, 60 fps loop:
  - 1280×800: ~0.3–0.5 MB. **[probe: this clip]**
  - 2560×1600: ~0.75 MB AV1, ~1.2–1.3 MB H.264 or VP9 for 7.4 s. **[probe: the 2× zoom take, whose
    layout broke but whose content is the same kind]**
  - Aim for ≤1.5 MB per retina source and a poster under ~150 KB (WebP or AVIF, not PNG). **[inferred]**

## Proof

### Files

All in `proof-2026-11-04/`:

- `record.mjs`: the take (Playwright, CDP gesture, DOM cursor, screencast, rAF log, long-animation-frame log).
- `encode.py`: sorts frames by timestamp, builds a CFR 60 fps clip and encodes H.264, VP9 and AV1, plus the poster.
- `windows.py` and `stats.py`: dropped-frame counts.
- `analyze.mjs`: measures the bounce in pixels from the frames.
- `probe.mjs`: the input and overscroll matrix.
- `bf.mjs`: the BeginFrame attempt, which fails on macOS.

### Run

```sh
# Storybook from ~/data-grid: bun run storybook  (port 6010)
cd proof-2026-11-04
STORY_URL='http://localhost:6010/iframe.html?id=data-grid-showcase--default&viewMode=story&globals=a11y.manual:!true' \
  slotfather run -n 1 -- node record.mjs final          # OB=contain by default; OB= for the story as shipped
slotfather run -n 1 -- python3 -I encode.py final out/data-grid-overscroll
python3 -I windows.py final
```

The `final` take was recorded before one later edit: `record.mjs` now keeps the screencast running through
the warm-up instead of restarting it. Both versions measured the same 267 ms gap. **[probe]**

### What it showed

**The take** **[probe]**: 6.0 s, 1280×800 at 60 fps. The page renders at deviceScaleFactor 2 and the
screencast downscales it to CSS size.

| Time | What happens |
|---|---|
| 0.5–1.6 s | The cursor glides in. |
| 1.9 s | Swipe right by 300 px (the scroll range is 251 px). |
| 3.0 s | Swipe left by 560 px: it slides back to the left edge and passes it. |
| 3.0–3.9 s | The rows rubber-band about 21 px and spring back. |
| 4.5–5.5 s | The cursor glides out. |

The loop is seamless: scrollLeft 0 and no cursor at both ends.

**Dropped frames** in motion windows, against 60 fps **[probe]**:

| Window | Frames captured / expected at 60 fps |
|---|---|
| Cursor in | 66 / 66 |
| First swipe | 15 / 30 |
| Overshoot and spring-back | 54 / 54 |
| Cursor out | 60 / 60 |
| **Total** | **15 missing of 210** (one 267 ms gap, on the first swipe) |

What I learned about the drops:

- **Without the a11y fix:** 23–40 frames missing. Long-animation-frame attribution blames
  `axe-core.js` (481 ms and 306 ms tasks). **[probe]**
- **The 267 ms gap:** during it, the page's rAF kept ticking and scrollLeft advanced every 16.7 ms
  (0→251), but the screencast sent no frames. It happens on the first in-range swipe of every take:
  - warming up first did not remove it;
  - a 1 px keep-alive repaint, a primer gesture, scroll nudges, and new headless with Metal GPU did not
    remove it either.
- **Not the recorder alone:** a plain control page with the same script captured 0 missing of 210.
  So it is specific to the grid in this capture path. Cause unknown. **[probe]**
- **In the clip:** the first swipe shows as a jump. The overshoot and bounce, the subject, are complete.

**Bounce check** **[probe]**: `analyze.mjs` measured the rows' horizontal offset frame by frame:
9, 11, 12, 13, 16, 19, 21, 21, 20, 18 … 1, 0 px. Header and title: 0 px. The header standing still
while the rows move is the #51 misalignment.

**Retina attempts** **[probe]**:

- `html { zoom: 2 }` on a 2560×1600 DPR 1 viewport gave 2560×1600 frames, but:
  - it broke the grid's layout (rows painted over the header, even at rest);
  - the page managed only ~30–40 fps at that size.
- BeginFrame control is not supported on macOS.
- So the clip is 1× (1280×800).

### Outputs

In `proof-2026-11-04/out/`:

| File | Size | Format |
|---|---|---|
| `data-grid-overscroll.mp4` | 517,106 B | H.264 High, yuv420p BT.709 limited range, faststart, 1280×800, 60 fps, 6.03 s, CRF 22 slow |
| `data-grid-overscroll.webm` | 418,641 B | VP9, CRF 34 |
| `data-grid-overscroll.av1.webm` | 286,636 B | AV1, SVT-AV1 CRF 38 |
| `data-grid-overscroll.poster.png` | 446,425 B | first frame, PNG; a WebP or AVIF poster would be ~10× smaller [inferred] |

**This clip is a pipeline proof, not a publishable demo.** It forces `overscroll-behavior-x: contain`,
which the package deliberately does not ship, and it shows the header misalignment of #51.

### Cleanup

- I started Storybook on 6010 (none was running) and stopped it.
- Every Chromium launched by these scripts was closed (each script closes its browser in `finally`).
- No repository was edited.
- Still running and not mine, left alone:
  - two Chrome for Testing processes (pids 95246 and 95496) started on 2026-11-03 07:07;
  - a Storybook on port 6021 from `data-grid-wt-51-proto`.

## Still unknown

- **The 267 ms screencast gap** on the grid's first in-range swipe: the cause, and whether a real
  headful Chrome shows any matching jank.
- **Whether Safari or WebKit and Firefox rubber-band** under Playwright's synthetic wheel in headless
  mode. Not tried.
- **Hands-off real-window capture:** whether CGEvents (with phases) can be delivered to a Chrome window
  on a CGVirtualDisplay or on another Space without moving the owner's cursor.
- **True 2× capture on this Mac** without taking over the screen. The candidates: a headful Chrome
  window on a virtual display with ScreenCaptureKit, or Linux BeginFrame (where elastic overscroll may
  not exist).
- **Remotion Company License price:** the official page did not load. Third-party figures conflict.
- **Vercel, Linear and Raycast** demo-video pipelines: no primary source found.
- **Cursorful and FocuSee** scripting: nothing found.
