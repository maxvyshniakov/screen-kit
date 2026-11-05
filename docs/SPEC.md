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
- Send real keys/mouse escape sequences at recipe times. Save the original ANSI stream and
  input event track as a reusable asciicast take. Assertions inspect a real terminal emulator.
- Export static PNG, lossless animated WebP, and video from saved takes. Frame rate and pause
  duration are explicit. Fonts, terminal palette and line height are fixed capture settings.
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

The implemented foundation is real browser recording plus silent MP4/WebM export and reusable
browser/terminal takes. Edited videos remain a subsequent product increment: a renderer-neutral
timeline, camera/stage/window composition, cursor/gesture overlays, captions and narration.
Existing decisions remain: Remotion 4 behind a replaceable renderer, source recipes beside
consumers, and Straylight's scenario editor as the edited-video benchmark. No hosted publishing,
YouTube upload, TTS or paid-service activation is implied by a capture command.

Retina timing and P3 video are separate acceptance requirements: the existing research found
headless 2× capture slower than real background-window capture. Video P3 preservation remains
unverified. Read the dated research before asserting either property for a new recording.
