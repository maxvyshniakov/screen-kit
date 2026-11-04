# Scripted demo videos: references, overlays, renderers, narration, YouTube (2026-11-04)

Companion to `capture.md` in the same folder, which covers capture and is not repeated here.

**Tags**

- **[read]**: taken from a primary source opened today: docs, repository source, a registry, the GitHub API, or response headers.
- **[probe]**: measured today on this Mac: `ffprobe` on a public clip URL (metadata only, nothing saved), `curl` of page HTML, or an image viewed.
- **[inferred]**: my conclusion, not verified.
- **[2nd]**: from secondary sources only.

**How this was gathered**

- Sections 6–8 and parts of 5 come from three delegated readers who opened the sources; I spot-checked some of them.
- I did **not watch** any clip. Downloading video files needs the owner's OK, and the slotfather queue was blocked, so the headless page probe (`../refprobe/probe-videos.mjs`) never ran. I stopped it.
- What a clip shows, beyond its page, codec, size, length and fps, is therefore marked [inferred] or "not watched".

---

## 1. Recommendation

### Renderer

Use **Remotion 4 as the renderer**, driven by our own renderer-neutral timeline JSON. Keep a small custom Canvas renderer as the exit path.

**Why Remotion** [inferred, from the facts below]:

- **Fully headless.** It renders headless from a CLI or the Node API (`npx remotion render`, `npx remotion still --frame=N`), and needs no Studio app. The agent loop is: write `timeline.json`, render, render stills, assert, re-render. A person only approves.
- **Covers the later requirements.**
  - It mixes audio: one narration track per language from the same timeline, and audio-only renders.
  - It already has captions tooling (`@remotion/captions`, `createTikTokStyleCaptions`) and ElevenLabs/Whisper adapters.
  - `calculateMetadata` sets the duration from the audio.
  - The same composition renders the web loop, the YouTube 1440p60 master and a 9:16 Shorts reframe by changing props.
- **Camera and overlays.** The camera is a CSS/Canvas transform of a stage larger than the frame: wallpaper, then drawn chrome, then the clip. Overlays (cursor, ripples, wheel, finger dots, keycaps, captions) are a second layer drawn after the camera from the event track, so they stay crisp at any zoom. Remotion does not care how we draw them.
- **Licence** [read, [remotion.pro/license](https://www.remotion.pro/license)].
  - Free for individuals and for companies of up to 3 people. Max qualifies for personal libraries and his site [inferred].
  - Otherwise a Company License:
    - Creators: $25 per seat per month.
    - Automators: $0.01 per render, with a $100 per month minimum.
    - Enterprise: from $500 per month.
  - The source licence is "SEE LICENSE IN LICENSE.md", not OSS. Latest version 4.0.540, 2026-11-02 [read, npm].
- **Against Motion Canvas and Revideo.**
  - Motion Canvas: last stable 3.17.2, last tag v3.18.0-alpha.0 on 2025-02-16 [read].
  - Revideo: 0.11.0 on 2026-07-10, last push 2026-07-15 [read].
  - Both are MIT, but neither has Remotion's audio and caption tooling, and both are slowing down.
- **Against a custom renderer.** A custom Canvas2D/WebGL page in headless Chromium, decoding with WebCodecs/[mediabunny](https://www.npmjs.com/package/mediabunny) (MPL-2.0, 1.65.1, 2026-11-03) and piping frames to ffmpeg, is maybe 600–1000 lines. It is licence-free, but we would rebuild the audio mixing, captions and frame-accurate decoding ourselves.
  - Build it only if the licence becomes a problem: if the work moves to a company of 4 or more people, or Automators pricing starts to matter.
  - Keeping our own timeline format makes the switch cheap [inferred].

### Retina caveat

Zooming the camera into a 1× capture blurs it. Remotion cannot fix that. The capture has to reach 2× first.

- capture.md: screencast is capped at the CSS viewport size.
- Screenwright's virtual clock (one screenshot per frame, at any DPR) is one route [read, [guidupuy/screenwright](https://github.com/guidupuy/screenwright)].
- Whether the CDP rubber-band gesture survives under virtual time is **unknown**.

### Agent review loop

After each render the agent asserts the following, with no watching needed [inferred]:

1. **Container.** ffprobe: duration equals the timeline duration ±1 frame; fps is 60 (constant frame rate); resolution and codecs match each output profile; size is within budget (web ≤1.5 MB per retina source).
2. **Capture health.** The recorder log shows no frame gap above 1.5 intervals inside step windows (see `windows.py`). ffmpeg `freezedetect` finds no freeze inside an action window, and `blackdetect` finds no black frames.
3. **Stills at each step's key frame** (`remotion still --frame`):
   - a contact sheet (`ffmpeg … tile=4x3`) is checked by eye or vision;
   - the target element's box from the event track lies inside the camera's view;
   - the cursor overlay sits at the event-track position ±2 px, checked with a render of the overlay layer alone on transparent;
   - the camera rectangle stays inside the stage bounds.
4. **Captions.** No overlap. ≤17 characters per second, ≤42 characters per line, ≤2 lines. Each cue lasts at least 0.83 s and stays inside its step. Every step's speech is shorter than or equal to the step duration.
5. **Audio.** Loudness via `ebur128`: about −16 LUFS for web, about −14 for YouTube [inferred common targets]. Narration is not clipped at the end of a step.
6. **Regression.** SSIM per step against the last approved render. Only changed steps go back to the human.

### Flow-builder benchmark

- **What to record.** Record it with React Flow defaults in mind [read via reader, xyflow source]:
  - `panOnScroll=false` (the wheel zooms);
  - `zoomOnPinch=true`;
  - `panActivationKeyCode='Space'`;
  - `selectionKeyCode='Shift'` (marquee);
  - the multi-select key is Meta on Mac.
- **Pan gesture.** For a two-finger trackpad pan the demo must set `panOnScroll`, or use space-drag [inferred].
- **Event track.** It needs explicit `drag` sessions (source, drop target), `pinch` (scale and centre), `pan` deltas and key down/up events with modifiers. No existing format models all of these (§8).

### Narration

- **Engine.** Kokoro-82M (Apache-2.0) runs locally for drafts and publishing. ElevenLabs on a paid plan is for when quality matters: it has native timestamps and a forced-alignment API.
- **Apple voices** (`say`, AVSpeech) are forbidden for public or commercial use by the macOS Tahoe licence (§2.F).
- **OpenAI TTS** models shut down on 2027-01-06 [read via reader].
- **Timing model.** Generate TTS first. Then each step lasts `max(actionMs, 200 + speechMs + 400)`, using Argo's lead-in and lead-out defaults. Captions come from forced alignment of the known script, not from transcription (§7).

### YouTube

- **Audio tracks.** Multi-language tracks can be added **only in Studio**. No API exists.
- **Captions.** Captions are uploaded per language with `captions.insert` (400 units each). Auto-timing (`sync`) has been dead since 2024-04-12, so we write the timed SRT/VTT from TTS word times.
- **Upload.** The upload can be scripted end to end. Since 2026-11-02, unverified API projects can upload public videos [read via reader] (§9).

---

## 2. Reference clips

None of these was watched; see "How this was gathered". The format column is [probe] (ffprobe and HEAD). Descriptions are [inferred] unless the hosting page says otherwise.

### 2a. Trackpad gestures

| Link | What to take from it | Format |
|---|---|---|
| [Apple: Use Multi-Touch gestures on your Mac](https://support.apple.com/en-us/102482) | Apple's canonical visual language. A **photographed hand over a light trackpad slab, with blue double-headed arrows** for motion, not dots. 15 trackpad and 6 Magic Mouse gestures, each a still PNG. [read + probe: viewed `trackpad2-two-finger.png`, 1960×616] | PNG stills, no video [read] |
| [apple.com/macos](https://www.apple.com/macos/) (macOS 27) and [apple.com/ipados](https://www.apple.com/ipados/) (iPadOS 27) | Feature clips load through Apple's JS `inline-media` (`/media/us/os/shared/2026/…/anim/`), so static HTML cannot list them [probe]. Apple feature films usually show UI in a device frame on a plain stage with slow camera pushes [inferred] | JS-loaded, not measured |
| [shaunlebron/macos-trackpad-demo](https://github.com/shaunlebron/macos-trackpad-demo) | Swift sample that draws the raw trackpad touch points. A reference for what real finger-contact data looks like, for a "dots on a trackpad inset" overlay [read] | code, last push 2025-10-13 |

There is **no good public reference for "trackpad gesture drawn as finger dots over a screen recording"** [inferred, after search].

- The closest conventions are Apple's arrows-on-trackpad illustrations and iOS-style touch circles.
- Proposal for a two-finger scroll or pinch: two 22–28 px translucent circles in a small trackpad inset, or near the cursor, moving with the gesture deltas. The cursor stays still, as on a real Mac (capture.md).

### 2b. Touch gestures on a phone

| Link | What to take from it | Format [probe] |
|---|---|---|
| [benji.org/family-values](https://benji.org/family-values) (Benji Taylor, 2024-07-08) | 8+ phone-UI clips of swipe, drag-reorder, scrub and tap trays, each with a 1×/0.5× speed toggle [read: page text]. A reference for pacing and for full-bleed portrait clips. The text does not mention touch dots [read] | 01.mp4: H.264 1180×2556, 60 fps, 4.5 s, 845 KB. 04.mp4: 14.4 s, 2.8 MB |
| [emilkowal.ski: Building a drawer component](https://emilkowal.ski/ui/building-a-drawer-component) | Vaul drawer: snap points, velocity, damping, scroll. Short single-idea clips inside prose [read: file list] | apple-maps.mp4: H.264 2800×2300, 30 fps, 4.6 s, 2.9 MB |
| [emilkowal.ski: Building a toast component](https://emilkowal.ski/ui/building-a-toast-component) | `drag-on-mobile.mp4` and `velocity.mp4`: swipe-to-dismiss on a phone [read: file names] | drag-on-mobile: H.264 1800×1300, 60 fps, 13.7 s, 5.6 MB |
| [RocketSim recordings docs](https://www.rocketsim.app/docs/features/capturing/recordings) (updated 2026-10-09) | Simulator recordings with **touch indicators, an optional stroke, size and colour settings**, a "Touch Attention Mode" that keeps one indicator on screen following the pointer, and **real device bezels** with a shadow [read] | MP4/GIF |
| [Screen Studio: recording iPhone/iPad](https://screen.studio/guide/recording-iphone-ipad) | Says finger taps cannot be captured like clicks, so auto-zoom does not work; a Bluetooth mouse gives a circular cursor. Its "Touch" cursor type is for these recordings [read] | — |

### 2c. Cursor, clicks, camera zoom and pan

| Link | What to take from it | Format [probe] |
|---|---|---|
| [screen.studio](https://screen.studio/) hero | The genre benchmark: smoothed cursor, auto-zoom on clicks, wallpaper and padding [read: feature list] | `hero-demo.mp4`: H.264 1280×720, 60 fps, 6.3 s, 1.22 MB. `hero-recording.mp4`: 1920×1080, about 59.8 fps, 5.55 s, 3.19 MB |
| [cleanshot.com](https://cleanshot.com/) | Feature loops: `<video playsinline muted loop autoplay>` with no controls, one feature per loop. CleanShot X 5.0 (2026-09-01) added Studio Mode: smart zooms that follow the cursor, smooth cursor, backgrounds [2nd] | `zoom.mp4`: H.264 1168×840, 60 fps, 6.7 s, 532 KB. `videoeditor.mp4`: 2384×1100, 60 fps, 15 s, 2.18 MB |
| [linear.app/changelog](https://linear.app/changelog) | Muted feature loops embedded in changelog prose; the prose is the caption | H.264 1920×1440, 30 fps, 17.2 s, 6.8 MB; and 1920×1080, 60 fps, 29.7 s, 4.7 MB |
| [framer.com](https://www.framer.com/) | Canvas or editor loops | H.264 2320×1300, 30 fps, 21 s, 3.9 MB |
| [zapier.com/canvas](https://zapier.com/canvas) | One short loop per feature (build, diagram, iterate, share); `loop muted playsinline controls preload="none"`, radius 12 px [read via reader] | 1080p H.264, 1.2–2.9 MB |
| [devouringdetails.com](https://devouringdetails.com/) (Rauno Freiberg) | Tiny single-interaction loops | `line-minimap.mp4`: H.264 1602×1058, about 57 fps, 2.6 s, **45 KB** |
| [interfacecraft.online](https://interfacecraft.online/) | Ships `-1x.mp4` and `-2x.mp4` per clip, a pattern for DPR-aware sources | 2x: 256×256, 30 fps, 8.7 s, 116 KB |
| [diabrowser.com](https://diabrowser.com/) | Ships `low/medium/high/highest.mp4` quality ladders [probe: HTML] | not measured |
| [v0.app](https://v0.app/) | Pairs each clip as `.mp4` + `.webm` `<source>` [read via reader] | — |

### 2d. Canvas and node editors (flow-builder benchmark)

From the delegated reader [read: page HTML and HEAD; not watched].

| Link | What it offers | Format |
|---|---|---|
| [reactflow.dev drag-and-drop example](https://reactflow.dev/examples/interaction/drag-and-drop) | Live example, not a clip: a sidebar palette using HTML5 `dataTransfer` and `onDrop` on the canvas. The closest match to "drag a card from the palette" | live |
| [zapier.com/canvas](https://zapier.com/canvas) | `Canvas_build_1080p…mp4` and `Canvas_diagram_1080p…mp4` | H.264 1080p, 2.9 / 1.2 MB |
| [n8n.io](https://n8n.io/) | Node-editor loops: `see_and_understand_expand…mp4` (uploaded 2026-10-26), `highlight.mp4`, `expand.mp4` | 3.4 MB |
| [figma.com/figjam](https://www.figma.com/figjam/) | Small inline loop with `playbackControls:"minimal"`, plus Vimeo pieces | 668 KB |
| [plus.excalidraw.com](https://plus.excalidraw.com/) | `Collaborate_video.mp4`, `excalidraw_mcp_swimlane_diagram.mp4` | about 500–630 KB |
| [flowiseai.com](https://flowiseai.com/) | `/videos/agentflow.mp4` at 1.6 MB, while the README's GIF of the same thing is **14.7 MB**: an argument for video over GIF | |
| [rive.app](https://rive.app/), [miro.com](https://miro.com/), [dify.ai](https://dify.ai/) | Editor and canvas marketing loops (Dify's intro is 11.5 MB) | |

No clip was found in the static HTML of reactflow.dev, xyflow.com, tldraw.dev, tldraw.com, langflow.org or Retool Workflows: they render client-side [read via reader].

### Five best to imitate [inferred, from metadata and the pages' own descriptions]

1. **Screen Studio hero** ([screen.studio](https://screen.studio/)): cursor, auto-zoom and wallpaper, 1280×720 at 60 fps, 6.3 s, 1.2 MB. Matches our target length and size.
2. **CleanShot feature loops** ([cleanshot.com](https://cleanshot.com/)): one feature per 6–7 s muted 60 fps loop, about 0.5 MB. The best model for a catalog story.
3. **Apple trackpad help illustrations** ([support.apple.com/102482](https://support.apple.com/en-us/102482)): the platform's own gesture language (hand and blue arrows) for trackpad insets.
4. **RocketSim touch and bezel recordings** ([docs](https://www.rocketsim.app/docs/features/capturing/recordings)): touch dots, stroke, attention mode and real device bezels. The touch-on-phone-frame convention.
5. **Zapier Canvas** ([zapier.com/canvas](https://zapier.com/canvas)): node-canvas build and diagram loops at 1080p, 1–3 MB. Closest to the flow-builder benchmark.

---

## 3. Gesture overlay conventions and parameters

| Source | Visual | Parameters |
|---|---|---|
| **Android "Show taps"** (AOSP `TouchSpotController`) | Pale blue ring sprite, one per pointer; hover and touch icons differ | `pointer_spot_touch.png`: **24 dp** (24 px mdpi, 48 px xhdpi), hotspot at its centre (12 dp). **Fade-out 200 ms** (`SPOT_FADE_DURATION`) [read: [TouchSpotController.cpp](https://github.com/aosp-mirror/platform_frameworks_base/blob/main/libs/input/TouchSpotController.cpp), [pointer_spot_touch_icon.xml](https://github.com/aosp-mirror/platform_frameworks_base/blob/main/core/res/res/drawable/pointer_spot_touch_icon.xml); probe: viewed PNG] |
| **Android "Pointer location"** | Crosshair, trails and a coordinate bar at the top: a debug look, not for demos | [2nd] |
| **iOS Simulator** | `defaults write com.apple.iphonesimulator ShowSingleTouches 1` shows touches, but they are **not in Simulator recordings** | [2nd: [Maestro, 2025-08-29](https://maestro.dev/blog/showing-tap-indicators-on-ios-recordings)] |
| **ShowTime** (injected by Maestro) | Ring with fill | **44×44 pt**, stroke **3 pt** in rgb(0.21, 0.61, 0.92), fill = stroke at **50 % alpha**, **disappear delay 0.2 s**, optional force and tap count [read: [ShowTime.swift](https://github.com/KaneCheshire/ShowTime/blob/main/Sources/ShowTime/ShowTime.swift)]. MIT, last push 2023-04 |
| **LNTouchVisualizer** (based on COSTouchVisualizer) | Contact circle plus ripple | Image 50 pt, circle **radius 22 pt** (44 pt diameter), line 3 pt. Contact alpha **0.5**, fade **0.3 s**. Ripple alpha **0.2** in systemBlue, fade **0.2 s** [read: [LNTouchConfig.m](https://github.com/LeoNatan/LNTouchVisualizer/blob/master/LNTouchVisualizer/LNTouchVisualizer/Private/LNTouchConfig.m), LNTouchImageFactory.m]. MIT, 1.0.6 on 2026-10-27 |
| **RocketSim** | Indicator with optional stroke; size slider; plain colours; attention mode | No numbers published [read] |
| **Apple trackpad help** | Photographed hand plus blue double arrows on a light trackpad slab | [probe: image] |
| **macOS Accessibility** | Pointer size, fill and outline colours; "Shake mouse pointer to locate". No click ring | [2nd: [Apple guide](https://support.apple.com/en-gb/guide/mac-help/make-the-pointer-easier-to-see-mchlp2920/12.0/mac)] |
| **Cap click ripple** (GPU layer) | Ring around the cursor tip | Default colour **[71, 133, 255]**, strength 0.7 (0–1), size 1.0 (0.25–3), **duration 0.6 s** (0.2–1.5). Ring radius = 1.25 × cursor height. At most 6 live ripples. **Off by default** [read: [configuration.rs](https://github.com/CapSoftware/Cap/blob/main/crates/project/src/configuration.rs) `CursorRippleConfig`, [click_ripple.rs](https://github.com/CapSoftware/Cap/blob/main/crates/rendering/src/layers/click_ripple.rs)] |
| **Cap cursor press** | Cursor shrinks to **0.8×** on press and springs back (tension 530, mass 1, friction 40) | Motion springs: Mellow (default) 470/3/70, Slow 200/2.25/40, Smooth 80/2.5/28, Fast 380/1/30. Rotation while moving 0.15. Idle hide after 2 s, fade 400 ms [read: cursor.rs, configuration.rs] |
| **Screen Studio** | Size, hide when idle, loop position, rotate while moving, stop at end, remove shakes; cursor types macOS or Touch | Click-effect parameters not documented [read: [guide/cursor](https://screen.studio/guide/cursor)] |
| **KeyCastr** | Can also show mouse clicks | See §6 |

**Proposed defaults for our overlay layer** [inferred]. All are screen-space and constant size; sizes are at 1× output, so double them at 2×.

- **Cursor:** macOS arrow, 22–24 px tall; press shrink 0.8× with a spring.
- **Click ripple:** ring from 0 to about 30 px radius over 0.45–0.6 s, starting at alpha 0.35–0.5, accent blue around rgb(71,133,255).
- **Touch dot:** 44 px circle, white or blue fill at 0.5 alpha with a 3 px stroke; fades 0.2–0.3 s after lift; a fading trail for swipes.
- **Trackpad fingers:** two dots of the same style, drawn in an inset trackpad glyph or near the cursor.
- **Wheel indicator:** a small capsule with a chevron in the scroll direction, shown for the length of the wheel burst plus 0.3 s.

---

## 4. Editors and renderers

Legend: **Cursor track** = the cursor is stored separately and re-rendered, so it stays crisp under zoom. **Off-viewport camera** = the camera can show the background beyond the capture. **Agent-writable** = an API, CLI or project file an agent can edit.

| Tool | Cursor track | Off-viewport camera | Agent-writable | Licence, latest | Machine-checkable artifacts |
|---|---|---|---|---|---|
| **Cap** ([CapSoftware/Cap](https://github.com/CapSoftware/Cap)) | **Yes**: `cursor.json` moves and clicks, re-rasterised from SVG. Size follows the zoomed display, so not constant [read: cursor.rs tests] | **Yes**: padding plus background, and `camera3dSegments` with keyframed zoom below 1, tilt, pan and Bézier easing [read: configuration.rs, cap-demo `treat.py` uses zoom 0.74–1.6] | **Yes**: `cap` CLI (JSON/NDJSON, `record`, `export`, `project config get/set`, `guide --json`, MCP server); `.cap` folder with `project-config.json`. Plus a **`cap-demo` agent skill**: Playwright CDP virtual input, then a synthetic cursor track, then 3D camera shots [read: [apps/cli/README.md](https://github.com/CapSoftware/Cap/blob/main/apps/cli/README.md), [cap-demo/SKILL.md](https://github.com/CapSoftware/Cap/blob/main/apps/cli/skill/cap-demo/SKILL.md)] | **AGPL-3.0** (MIT only for `cap-camera*` and `scap-*` crates); cap-v0.6.2 on 2026-10-28 [read] | `project validate --json`, NDJSON export events. Frame QA in the skill is by ffmpeg stills [read] |
| **OpenScreen** ([getopenscreen/openscreen](https://github.com/getopenscreen/openscreen); the original [siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) is archived) | Yes: `<video>.cursor.json` sidecar v2 with samples `{timeMs,cx,cy,interactionType,cursorType}` | Zoom regions with wallpaper [read] | `.openscreen` project JSON v2 (`zoomRegions`, `autoZoomEnabled`, cursor smoothing…) [read via reader] | MIT; successor pushed 2026-11-03; original v1.5.0 on 2026-06-06 [read] | none known |
| **Screen Studio** | Yes: cursor re-styled after recording [read: guide] | Yes, backgrounds and padding | **No API or CLI**; deeplinks only; unofficial CDP CLI (capture.md) | Proprietary subscription; no lifetime licence for new buyers since 2025-10-01 [2nd]; latest version unknown | — |
| **CleanShot X 5 (Studio Mode)** | Smooth cursor after recording; whether it keeps the raw path is unknown [2nd] | Backgrounds, margins, shadow | No API found | Proprietary, $35 one-time; 5.0 on 2026-09-01 [2nd] | — |
| **Cursorful** | Auto-zoom follows clicks [2nd] | Backgrounds [2nd] | No API found | Free for non-commercial use; Pro one-time [2nd: [cursorful.com](https://cursorful.com/)] | — |
| **FocuSee** | Auto-zoom and cursor effects [2nd] | yes [2nd] | No API found | Proprietary; 2.0 on 2026-04-23 [2nd] | — |
| **Rapidemo**, **Tella**, **ScreenFlow** | Auto-zoom and cursor smoothing (Rapidemo, Tella) [2nd] | yes [2nd] | No public API found | Proprietary | — |
| **Kap** ([wulkano/Kap](https://github.com/wulkano/Kap)) | No (real cursor) | No | Plugins only | MIT; v3.6.0 on **2022-10-27**, stale [read] | — |
| **Argo** ([shreyaskarnik/argo](https://github.com/shreyaskarnik/argo), `@argo-video/cli`) | DOM-injected cursor, baked into the capture | ffmpeg `zoompan` | **Yes**: Playwright scripts plus a scene manifest; Kokoro and other TTS; SRT/VTT | MIT; 0.42.1, last push 2026-10-27. capture.md cited the fork `lordrip/argo` (0 stars); the original is this repo [read] | per-scene SRT/VTT, Whisper word timings |
| **Screenwright** ([guidupuy/screenwright](https://github.com/guidupuy/screenwright)) | Overlay in Remotion | Remotion | Yes: script, then **virtual-clock screenshots**, then a Remotion composition | MIT; last push 2026-08-06 [read] | frame manifest |
| **Remotion** | Whatever we draw | Whatever we draw | **Yes**: React composition plus `--props` JSON, CLI or Node API, `still`, Lambda or Cloud Run | Remotion licence (above); 4.0.540 on 2026-11-02 | `renderStill`, `getVideoMetadata`, captions JSON |
| **Revideo** | same | same | Yes: headless `renderVideo()` | MIT; 0.11.0 on 2026-07-10 [read] | — |
| **Motion Canvas** | same | same | Editor-first; headless exporter is weaker [inferred] | MIT; 3.17.2 stable, alpha 2025-02 [read] | — |
| **Custom Canvas/WebGL + ffmpeg** | yes | yes | ours | ours (skia-canvas 4.0.0 MIT 2026-10-14; @napi-rs/canvas 1.1.0 MIT 2026-10-30; mediabunny MPL-2.0) [read: npm] | whatever we emit |

**Device and browser frames**

- **Cap's `FrameStyle`** has `MacOS` (traffic lights), `Windows`, `Browser` (traffic lights plus a centred URL pill; `url` and `title` are fields) and `Macbook` bezel, each with a dark or light theme. They are drawn as SVG in [frame_chrome.rs](https://github.com/CapSoftware/Cap/blob/main/crates/rendering/src/frame_chrome.rs) [read]. This is the closest ready reference for our drawn chrome.
- **Other kits:**
  - [devices.css](https://github.com/picturepan2/devices.css): MIT, last push 2023.
  - [react-device-frameset](https://www.npmjs.com/package/react-device-frameset): MIT, 1.3.4, 2023.
  - [mockup-device-frames](https://github.com/jamesjingyi/mockup-device-frames): no licence, pushed 2026-10-12.
  - Apple Design Resources' official bezels at [developer.apple.com/design/resources](https://developer.apple.com/design/resources/) [inferred, not opened]: check their terms before publishing.

**What to reuse** [inferred]

- **Cap's project schema is the best design reference.** Copying its code is AGPL, so reimplement the ideas, do not copy.
  - `ZoomSegment`, `ScreenMovementSpring` (stiffness 200, damping 40, mass 2.25), `Camera3DKeyframe` (split Bézier handles; default ease-in-out P1 [0.65,0], P2 [0.35,1]).
  - `CursorConfiguration` springs, `CursorRippleConfig`, `FrameConfiguration`.
  - `KeyboardSettings`/segments, and `zoom_spring.rs` (auto-follow with a dead zone).
- **OpenScreen (MIT)** can be read and copied freely: [projectPersistence.ts](https://github.com/getopenscreen/openscreen/blob/main/src/components/video-editor/projectPersistence.ts), [types.ts](https://github.com/getopenscreen/openscreen/blob/main/src/components/video-editor/types.ts), [cursorSidecar.ts](https://github.com/getopenscreen/openscreen/blob/main/electron/media/cursorSidecar.ts).
- **Argo and Screenwright (MIT)** show the narration-timing code (§7).

---

## 5. Keystroke overlays

From the delegated reader [read: source].

**Cap**: post-render, screen-space, because `prepare()` takes `output_size`.

- **Settings** (`KeyboardSettings`):
  - size 50 × (output height / 1080);
  - white text on black at **95 %** opacity;
  - pill radius 0.5 × font, padding 0.45 × font;
  - position bottom-centre at y = 0.85 (top rows at 0.08; above captions at 0.75, with a 15 px gap);
  - **fade 0.15 s**, **linger 0.8 s**, plus a 6 px vertical ease during each fade;
  - **grouping 500 ms**: typed characters build one word, backspace pops a character;
  - off by default.
- **Combos:** a ⌘ combo is its own segment, shown as one label with modifiers ordered **⌃⌥⇧⌘** and the key in capitals: `⌘⇧Z`.
- **Special keys:** ⏎ ⇥ ⌫ ⌦ ⎋ ␣ and the arrows.
- **Segments** are editable: `{start, end, displayText, keys[{key,timeOffset}]}` plus overrides.
- **Sources:** [keyboard.rs (project)](https://github.com/CapSoftware/Cap/blob/main/crates/project/src/keyboard.rs), [keyboard.rs (layer)](https://github.com/CapSoftware/Cap/blob/main/crates/rendering/src/layers/keyboard.rs).

**KeyCastr** ([keycastr/keycastr](https://github.com/keycastr/keycastr), BSD-3, v0.11.1 on 2026-09-07): a live window, so it is baked into the capture and scales with the camera.

- **Default visualizer:**
  - stays 2.0 s, then fades over 0.2 s;
  - 16 pt system font;
  - black bezel at 0.8 alpha, radius 16;
  - keys within 0.5 s join one line;
  - command keys only by default;
  - a mouse-down breaks the line.
- **Svelte visualizer:** a fixed strip ⇧ ⌃ ⌥ ⌘ that lights up while a key is held (0.5 alpha when idle), with the last 6 characters below at up to 48 pt. This is the best "held modifier" idea, useful for space-drag and shift-click.

**Screen Studio** ([guide/shortcuts](https://screen.studio/guide/shortcuts)): show shortcuts on or off, a size slider, an optional "single key shortcuts" toggle, and a shortcut timeline where you can disable items. No timings are published.

**CleanShot X**: "Capture Keystrokes" with a position option. It is a live overlay; Studio Mode lets you change it after recording [2nd].

**Proposed convention** [inferred]:

- Screen-space, drawn after the camera, like the cursor.
- A dark pill at about 92 % opacity, bottom-centre, about 4.5 % of output height.
- Combos as one label ordered ⌃⌥⇧⌘ + KEY.
- Linger 0.8 s, fade 0.15–0.2 s.
- Typed text grouped within 500 ms.
- A **held-modifier chip** stays up while Space, Shift or ⌘ is down during a drag.

---

## 6. Event-track formats to learn from

| Format | Keys and modifiers | Drag | Wheel / pinch | Camera follow | Source |
|---|---|---|---|---|---|
| Cap `.cap` | `keyboard.bin` (`CPKB01`) / `keyboard.json`: `presses[{key,keyCode,timeMs,down}]`; `active_modifiers[]` on every cursor event | implicit: down, then moves, then up | none | `ZoomMode::Auto`: spring every 8 ms, dead zone 50 % × 70 % of the view, deterministic | [meta.rs](https://github.com/CapSoftware/Cap/blob/main/crates/project/src/meta.rs), [cursor.rs](https://github.com/CapSoftware/Cap/blob/main/crates/project/src/cursor.rs), [zoom_spring.rs](https://github.com/CapSoftware/Cap/blob/main/crates/rendering/src/zoom_spring.rs) |
| OpenScreen cursor sidecar v2 | none | none | none | zoom regions `focusMode auto` | above |
| rrweb | none | `Drag` as a move batch | `Scroll {id,x,y}`; Touch start/end; `pointerType` | — | [types/index.ts](https://github.com/rrweb-io/rrweb/blob/main/packages/types/src/index.ts) |
| Chrome Recorder / @puppeteer/replay | `keyDown`/`keyUp {key}` | none | `scroll {x,y}` | — | [Schema.ts](https://github.com/puppeteer/replay/blob/main/src/Schema.ts) |
| mineo71/showTime (Playwright + Remotion) | — | — | `scroll` | `click{zoom}` | [events.ts](https://github.com/mineo71/showTime/blob/main/src/runner/events.ts) |

**Additions our track needs** [inferred]. The cursor stays in CSS px of the viewport; window metadata maps it to the stage.

```jsonc
{ "t": 1234.5, "type": "key", "phase": "down", "key": "z", "code": "KeyZ", "mods": ["meta","shift"] }
{ "t": 1300, "type": "drag", "phase": "start", "id": "d1", "x": 40, "y": 220, "source": "[data-palette=http]" }
{ "t": 1316, "type": "drag", "phase": "move",  "id": "d1", "x": 52, "y": 226 }
{ "t": 1900, "type": "drag", "phase": "end",   "id": "d1", "x": 640, "y": 380, "target": ".react-flow__pane", "result": "node:n7" }
{ "t": 2400, "type": "gesture", "kind": "pan",   "device": "trackpad", "phase": "begin|change|end", "dx": -12, "dy": 0, "fingers": 2, "x": 700, "y": 400 }
{ "t": 3100, "type": "gesture", "kind": "pinch", "device": "trackpad", "phase": "change", "scale": 1.08, "cx": 700, "cy": 400 }
{ "t": 3500, "type": "marquee", "phase": "start|move|end", "x0": 300, "y0": 200, "x1": 520, "y1": 360, "selected": ["n2","n3"] }
{ "t": 0,    "type": "viewport", "canvas": { "x": 0, "y": 0, "zoom": 1 } }
```

- The `viewport` event is the app's own canvas transform, sampled per frame. It lets the camera-follow logic tell the *app's* pan from the *video* camera, and keep the video camera still while the canvas pans.

---

## 7. Narration: references, TTS, timing, captions

From the delegated reader unless marked otherwise.

### Pacing references

- Silent landing loops (Linear changelog, CleanShot, Zapier) carry no captions in the video; the text next to the clip explains it [probe + inferred].
- [Argo's README demo](https://github.com/shreyaskarnik/argo): one Kokoro-voiced caption per scene, held for its audio [read].
- [Apple Support](https://www.youtube.com/@AppleSupport) how-tos: one step title per action, music, no voice [inferred].
- [Arcade](https://docs.arcade.software/kb/build/interactive-demo/edit/hotspots-callouts-and-spotlights): callouts next to the hotspot [2nd].
- Navattic: top demos use 100–199 characters per box and 8–15 steps [2nd].
- Speech rate: about 150 wpm (2.5 words/s) for explainers, 130–140 for complex demos [2nd].

### Caption timing rules

- **Netflix** [read: [TTSG](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977), [timing](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394)]:
  - 42 characters per line, 2 lines;
  - 20 cps for adults, 17 for children;
  - minimum cue 20 frames (about 0.83 s);
  - gap 2 frames, or at least 0.5 s;
  - keep the cue about 0.5 s after the audio ends.
- **BBC:** 160–180 wpm [2nd; primary page not reachable].

### TTS options

| Engine | Quality | Cost / licence | Interface | Word timing | Pauses | Public site / monetised YouTube |
|---|---|---|---|---|---|---|
| **ElevenLabs** | top tier [inferred] | paid plans include a commercial licence; the **free plan is non-commercial** and needs attribution [read] | REST | `/with-timestamps` gives **character** times; `/v1/forced-alignment` gives word times for any audio [read] | `<break time>` up to 3 s; v3/v4 use audio tags instead of SSML [read] | yes on a paid plan |
| **OpenAI** `gpt-4o-mini-tts` | good, steerable through `instructions` | about $0.015/min [2nd]; must disclose that the voice is AI [read] | REST | none, so align | punctuation and instructions | yes with disclosure; **models shut down 2027-01-06** [read] |
| **Apple** `say` / AVSpeech / Premium / Personal Voice | decent | **macOS Tahoe SLA §2.F: personal, non-commercial; no public sharing** [read: [SLA PDF](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)] | `say -o`, AVSpeech word-range callbacks | live callbacks only | `[[slnc 500]]` | **no**; drafts only |
| **Kokoro-82M** | good for 82M | **Apache-2.0** weights; 54 voices, 8 languages [read: [HF](https://huggingface.co/hexgrad/Kokoro-82M)] | `kokoro` (Py), `kokoro-js` (Node or browser), `kokoro-onnx` (MIT), Kokoro-FastAPI `/dev/captioned_speech` with word times [2nd] | via FastAPI or alignment | punctuation, chunking | yes [inferred from Apache-2.0] |
| **Piper** (`OHF-Voice/piper1-gpl`) | below Kokoro | GPL-3.0 code; **licence varies per voice** (ryan-high is CC BY-NC-SA) [read] | CLI | none | `--sentence-silence` | only with a voice whose dataset allows it |
| **Qwen3-TTS**, **Chatterbox** (MIT; Perth watermark on every output), **KittenTTS 2** (Stellon community licence) | promising [2nd] | check the weight licences | Py | none | tags | check first |

**Alignment** for the script we already know:

- ElevenLabs forced alignment;
- [WhisperX](https://github.com/m-bain/whisperX) (BSD-2);
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT; Remotion's `@remotion/install-whisper-cpp` `toCaptions()`);
- aeneas (AGPL).

Aligning the known script avoids Argo's pitfall: matching words as Whisper misspelled them [read: Argo `src/narration.ts`].

### Timing models in the wild

- **Argo** [read]:
  - TTS runs before recording.
  - `narration.durationFor(scene)` = clip × multiplier + 200 ms lead-in + 400 ms lead-out, clamped to 2.2–30 s. The action waits for the speech.
  - `atWord()` fires effects on a given word.
  - `schedulePlacements()` pushes overlapping clips back with a 100 ms gap.
  - Sources: [narration.ts](https://github.com/shreyaskarnik/argo/blob/main/src/narration.ts), [tts/align.ts](https://github.com/shreyaskarnik/argo/blob/main/src/tts/align.ts), [subtitles.ts](https://github.com/shreyaskarnik/argo/blob/main/src/subtitles.ts).
- **Screenwright** [read]:
  - `sleepRemainingNarration()` is our `max(action, speech)`.
  - Slides use `Math.max(slide, narration)`.
  - A virtual clock runs at 1000/30 ms per screenshot.
  - Rendered with Remotion.
  - Source: [action-helpers.ts](https://github.com/guidupuy/screenwright/blob/main/cli/src/runtime/action-helpers.ts).
- **demos-not-memos**: `doWhileNarrating(text, action)` waits for both [read: [repo](https://github.com/markng/demos-not-memos)].
- **Remotion** [read]:
  - `template-prompt-to-video` `cli/timeline.ts`: each segment lasts until the last ElevenLabs character end time; caption chunks are at most 14 characters.
  - `@remotion/captions` `Caption {text,startMs,endMs,timestampMs,confidence}` and `createTikTokStyleCaptions({combineTokensWithinMilliseconds, breakOnSilenceAfterMilliseconds})`.
- **Synthesia** [read: [docs](https://docs.synthesia.io/docs/record)]:
  - scene modes Once (pause added), Stretch (video retimed to the voice), Loop/Cut;
  - Play/Pause effects at chosen words.
- **Descript**: `/` scene boundaries follow the script; visuals trim to fit [read].
- **Cap `cap-demo` skill**: "tail-anchored" alignment of the beat log to the video [read]. The narration reader missed this skill; it exists at `apps/cli/skill/cap-demo`.

### Our model [inferred]

1. The script lists steps; each step has an action and a `say` line.
2. Run TTS per line, then force-align it against the known text to get word times.
3. `step.ms = max(action.ms, 200 + speech.ms + 400)`. Long actions run under the speech; short actions wait.
4. Mid-step effects such as a zoom key off word times, for example "now drag **the HTTP node**".
5. Captions are built from word times: ≤42 characters per line, ≤2 lines, ≤17 cps, at least 0.83 s per cue, 0.5 s tail, never crossing a step boundary.
6. Silent web loops use the same steps with `say` turned into step titles, held for `max(0.83 s, chars/17)` + 0.5–1 s.

### Captions on silent autoplay [read via reader]

- `<track kind="captions" default>` loads only when it is `default` or enabled, and needs `crossorigin` if it lives on another origin.
- Native cue styling is up to the browser and the OS, so it varies [inferred]. For the site, either **burn in** step titles, or draw a DOM overlay from VTT via `cuechange` with `mode="hidden"`.
- **WCAG:**
  - a silent loop is video-only, so **1.2.1** asks for a text alternative: publish the step script next to it;
  - **2.2.2** requires pause, stop or hide for autoplay longer than 5 s;
  - YouTube versions need **1.2.2** captions.
- **`prefers-reduced-motion: reduce`:** do not autoplay; show the poster and a play button [inferred].

---

## 8. YouTube delivery

From the delegated reader, YouTube Help Center and Data API docs [read].

### Multi-language audio tracks

- **Eligibility:** creators with Advanced features, rolling out gradually ([13338784](https://support.google.com/youtube/answer/13338784)).
- **Adding a track:** Studio, then Languages, then "Dub". The file must be audio-only and "roughly the same length" as the video; no format is specified.
- **No API:** the `videos` resource has no audio-track write; only `snippet.defaultAudioLanguage`.
- **Labels:** YouTube's own auto-dubs are labelled "auto-dubbed" ([15569972](https://support.google.com/youtube/answer/15569972)). An existing auto-dub must be deleted before you upload your own.
- **For us** [inferred]: we can render one video plus N WAV tracks, each exactly the video's length (48 kHz WAV/FLAC). **The upload of extra tracks is a manual Studio step.** The alternative is one video per language, which is fully scriptable but risks "inauthentic content" at scale.

### Captions

- **Formats:** SRT, SBV, WebVTT, TTML, SCC and others ([2734698](https://support.google.com/youtube/answer/2734698)).
- **API:** `captions.insert` costs **400 units**, with scope `youtube.force-ssl`. **`sync` (auto-timing) has been unsupported since 2024-04-12**, so files must carry their own timing.
- **Auto-timing in Studio:** transcript plus auto-timing still works by hand ([2734796](https://support.google.com/youtube/answer/2734796)).
- **Chapters** ([9884579](https://support.google.com/youtube/answer/9884579)): first at 00:00, at least 3, ascending, each at least 10 s. Generate them from the timeline's scene starts.
- **From TTS** [inferred]: TTS word times can be written straight to SRT/VTT.

### Quota

([determine_quota_cost](https://developers.google.com/youtube/v3/determine_quota_cost), [revision history](https://developers.google.com/youtube/v3/revision_history))

- 10,000 units a day.
- `videos.insert` now draws from a separate bucket of 100 calls a day at about 1 unit each (changed 2025-12 and 2026-06).
- `thumbnails.set` 50, `videos.update` 50, `videos.list` 1.

### Encoding ([1722171](https://support.google.com/youtube/answer/1722171))

| Output | Spec |
|---|---|
| **YouTube master** | MP4 with moov at the front; H.264 High, 2 B-frames, closed GOP of half the frame rate, 4:2:0, BT.709; **1440p60 ≈ 24 Mbps** (1080p60 12, 2160p60 53–68); AAC-LC or Opus, 48 kHz, 384 kbps stereo. Upload 1440p, so YouTube serves its higher-quality encode [inferred] |
| **Web loop** | silent; AV1 or VP9 WebM, then H.264 fallback; ≤1.5 MB at retina (capture.md) |
| **Shorts** | ≤3 min, square or vertical ([15424877](https://support.google.com/youtube/answer/15424877)). Same timeline, reframed: a 9:16 stage and a camera that follows the cursor or focus with a tighter dead zone [inferred]. Custom Shorts thumbnails via API since 2026-11-03 |

### Automation

- **Scopes:** `youtube.upload` + `youtube.force-ssl`.
- **Upload:** resumable `videos.insert` (`localizations`, `defaultAudioLanguage`, `status.containsSyntheticMedia`).
- **Processing:** poll `videos.list` `processingDetails`.
- **Then:** `thumbnails.set`, and `captions.insert` per language.
- **Unverified projects:** since **2026-11-02** they can upload public videos (the 2020 restriction is reversed). Always set `privacyStatus` explicitly.

### Synthetic-voice policy

- **Disclosure** ([14328491](https://support.google.com/youtube/answer/14328491)): required for realistic altered or synthetic depictions. Cloning *your own* voice for voice-over is exempt. Generic TTS is not addressed. Setting `containsSyntheticMedia=true` has no reach penalty, so it is an owner decision.
- **Monetisation** ([1311392](https://support.google.com/youtube/answer/1311392)): "inauthentic content" (since 2025-07-15) targets mass-produced templated videos. TTS is not named.
- **TTS licences:** Kokoro (Apache) and paid ElevenLabs are fine; the ElevenLabs free plan and Apple voices are not.

---

## 9. Unknowns

- **What the reference clips look like.** Cursor size, ripple style, camera easing. No clip was watched, and frame grabs need an OK to download.
  - The headless page probe (`../refprobe/probe-videos.mjs`) never got a slot. Every slot was free, but the queue was stuck behind a 6-slot waiter, which itself waited on a Firefox lease (`realb`) held since 00:34Z. I stopped my probe; it never ran.
- **Apple's JS-loaded clips** on macOS 27 and iPadOS 27 pages: formats and sizes are unknown.
- **Retina capture under virtual time**, the Screenwright pattern, combined with the CDP scroll-gesture rubber band.
- **Screen Studio** current version and click-effect parameters (the changelog page renders empty); whether CleanShot keeps raw cursor paths.
- **No public reference draws trackpad fingers over a desktop recording.** Our style would be new.
- **YouTube:** the audio-track file tolerance (vendor claims of ±0.5–1 s are unverified), and whether Advanced features reach Max's channel.
- **Apple Design Resources bezel terms** for public use.
- **Cap rendering:** whether Cap's cursor keeps a constant size on screen during zoom. Its tests suggest the size follows the zoomed display.
