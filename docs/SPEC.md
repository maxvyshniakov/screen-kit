# Screen-kit: capture and reproducible media

Owner-approved direction, 2026-11-05. Browser screenshots and terminal screenshots/animations
are the first product. Actual browser recordings and reusable takes provide the foundation
for later edited demo videos. This replaces the earlier video-first v0 ordering.

## Ownership and interface

Consumer repositories own recipes, data fixtures and application setup. Screen-kit owns
capture, reusable takes, export, comparisons and machine-readable evidence. The website owns
media import, demo pins, release retention, alt text, provenance notes and deployment.

A configuration module exports `{ cwd?, defaults?, recipes: { name: recipe } }`. Names identify
artifacts, not application internals. Each recipe selects `source: 'browser' | 'terminal'`.
`capture` writes a run manifest, original takes and exports; `status` checks recipe/source drift;
`review` verifies saved artifacts; `render` reuses saved takes without running the application.
The public API and CLI cross the same modules. Browser and terminal input remain source-specific.

All external commands receive argument arrays. Recipes are trusted local executable configuration;
page JavaScript is an explicit preparation step. They are not a sandbox for untrusted recipes.
Capture work runs through the consumer's machine-slot wrapper and closes its own processes.

## Browser capture

- A fresh isolated agent-browser session, with fonts/images and app readiness checked.
- URL or Storybook source pinned to catalog revision; verify build identity and story existence.
- Theme, story args, viewport, pixel scale, real input and optional preparation code.
- Whole viewport, crop, multiple bands, multiple themes and desktop/phone composites.
- Keep Display P3 profiles and encoded colour values through crop, stacking and WebP export.
- Record actual browser interaction for MP4/WebM takes. Report measured duration/frame counts;
  requested timing is not evidence of achieved frame rate.

The website's existing recipes are the migration acceptance set, including composites, bands,
open controls and two-theme captures. A local private tarball makes its checkout self-contained;
consumer CI must not depend on a sibling developer checkout.

## Terminal capture

- Execute the real application in a PTY with explicit rows/columns and environment.
- Run the recipe's steps in order against a live terminal emulator fed the recorded output:
  wait for screen text (`waitFor`), send real keys and SGR mouse input, pause (`hold`). No step
  depends on a guessed delay. Save the original ANSI stream and input event track as a reusable
  asciicast take; replay re-checks each wait at the moment it was met.
- Export static PNG, lossless animated WebP, and video from saved takes, several from one take.
  Frame rate is explicit; an animation starts at the step that marks it. Fonts, terminal palette and line height are fixed capture settings.
- Ghostty's built-in default palette and JetBrains Mono are the default terminal presentation;
  symbol fallback fonts and licenses ship with the tool. Rendering is headless terminal
  emulation, not a screenshot of the Ghostty window.
- Fixture mode is application-owned and must not touch the live queue or other production data.
  Provenance describes recorded data, redactions and unavailable measurements.

Slotfather acceptance: a frozen real historical scene; navigate active and waiting lanes with
actual key input; dwell long enough to read details; return to the original selection. No
invented completion storm or synthetic CPU waveform. Static frames and animations share the
same application and fixture. Historical aggregate metrics must be identified as such.

## Evidence and refresh

A run records source revision/dirty state, recipe hash, tool version, output hashes and sizes,
dimensions, frame count/duration, take hashes, events and assertion results. Failure leaves an
inspectable failed manifest, never an apparently successful partial run. Pixel comparisons and
before/after previews support human review; they do not automatically approve changed content.

Changing a recipe, source revision or saved artifact invalidates its prior evidence. Consumers
can add product-specific checks before importing results. A screenshot is not proof of smooth
motion or achieved video cadence.

## Video beyond raw capture

Owner-approved direction, 2026-11-21. Raw browser recording and reusable takes are in place.
Edited product videos ship in explicit increments behind a replaceable renderer boundary:

### Increment 1: silent edited demo engine

- **Dual capture modes:** `quality` (headful Chromium behind the owner's windows on a Retina
  display, 2× at 60 fps, with focus handback per [retina-spike.md](research/retina-spike.md))
  and `headless` (CI and fast checks). Both capture mode and measured duration/frame count/fps
  are recorded in `run.json`.
- **Clean takes and event track:** capture the viewport without a baked-in cursor alongside a
  structured event track (minimum-jerk pointer samples, presses, wheel, CDP trackpad gestures,
  drag sessions, keys with modifiers, window metadata).
- **Renderer-neutral timeline:** a versioned JSON timeline describing `stage`, `window` frame
  (browser chrome, macOS window, device bezel), camera keyframes, screen-space overlay layers
  (cursor, click ripple, wheel/gesture indicator, finger dots, keystroke pills, captions) and
  audio track slots.
- **Renderer:** Remotion 4 invoked headlessly via CLI, reading only the timeline JSON so the
  renderer can be swapped later without changing recipes or takes. Outputs: web loop
  (VP9/AV1 WebM, H.264 MP4, poster) and 1440p60 YouTube master.
- **Automated video review:** deterministic assertions (duration, fps, size, capture gaps,
  freeze/black detection, cursor within 2 px of event track, camera inside stage, per-step
  stills, contact sheet and diff against last approved render), plus optional multimodal
  agent review (Gemini inspecting rendered video and contact sheets for visual/semantic defects).
- **Benchmarks:** Data Grid (Storybook horizontal rubber-band) as the fast smoke benchmark,
  followed by Straylight Desktop's scenario editor (palette drag, pan/pinch-zoom, marquee and
  Shift/⌘ selection, shortcuts, macOS window on stage) as final acceptance.

### Separate and subsequent tracks

- **Display P3 video preservation:** optional `colorSpace: 'srgb' | 'p3'` across browser takes,
  `timeline.json` (`take.colorSpace` / `outputs[].colorSpace`), headless Remotion rendering,
  and web publishing; Increment 1 defaults to sRGB/BT.709 when omitted.
- **Increment 2 — narration and captions:** Gemini TTS via CLI/API as the primary cloud voice
  provider (`gemini-2.5-pro-preview-tts` default, `speed: 1.1`) with local Kokoro as the offline
  fallback; forced word alignment, Netflix-style sidecar captions (burned-in captions opt-in via
  `--burn-captions`), `max(action, 0.12 s + speech + 0.22 s)` step timing, and audio/caption
  review checks.
- **Non-UI generated assets:** image generation may be used for stage wallpapers, covers and
  thumbnails. Generative video (e.g., Veo) is excluded from core UI capture; UI footage always
  comes from real engines.
- **Publishing:** source recipes stay beside consumers. No hosted publishing, YouTube upload,
  or paid-service activation is implied by a capture command.
