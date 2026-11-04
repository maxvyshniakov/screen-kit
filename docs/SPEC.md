# screen-kit v0: design draft

Status: draft for the owner, 2026-11-04. Sources: [capture](research/capture.md),
[references](research/references.md), [market](research/market.md).

## Problem

Demo videos of a UI go stale with every change, and nobody wants to re-record them by hand.
Agents now change UIs faster than people can re-record the videos. Existing tools either need a
person in a GUI (Screen Studio, Cap, Tella's editor) or stop at a raw recording with a cursor
painted in (Playwright 1.64 `screencast`, Argo, demowright). No tool lets an agent prove that a
render is correct and re-render it from the same take.

## Principles

1. **Agent-operated.** Every stage is a CLI or file an agent writes and reads. A human only
   approves.
2. **The script is the source of truth.** Timing comes from the script: a step lasts as long as
   its action or its narration, whichever is longer.
3. **Record once, render many.** The take holds no overlays. Zoom, pan, cursor style, captions,
   voice and output format change without re-recording.
4. **Every render reviews itself.** Assertions replace watching; only steps that changed since
   the last approved render go back to the owner.
5. **Real engines.** Gestures come from the engine's own input path, so hover states, rubber
   band and momentum are real.

## Pipeline

1. **Script** (TypeScript or JSON). Steps such as `hover`, `click`, `drag`, `wheel`, `trackpad`
   (scroll, pinch), `touch` (tap, swipe, long press, pinch), `keys` and `pause`. Each step has a
   target (selector or point), narration per language and an optional camera hint.
2. **Take** (Playwright, Chromium first).
   - The real Playwright mouse moves along minimum-jerk paths, so `:hover` and press states
     happen in the page.
   - Trackpad gestures come from CDP `Input.synthesizeScrollGesture`, which rubber-bands in
     headless Chrome.
   - Outputs: a clean viewport video, the event track and the window metadata.
3. **Timeline** (JSON, renderer-neutral).
   - Stage, window frame and camera keyframes.
   - Overlay layers: cursor, click ripple, wheel indicator, finger dots, keystroke pills,
     captions.
   - Audio tracks per language.
   - Cap's `.cap` project (AGPL) is the schema to learn from, not to copy.
4. **Narration.**
   - TTS: local Kokoro by default; ElevenLabs with the user's own key when quality matters.
     Apple's voices are licensed for personal use only.
   - Forced alignment of the known text gives word timestamps, and captions follow Netflix
     timing rules.
   - Step duration: `max(action, 0.2 s + speech + 0.4 s)`.
5. **Render.**
   - Remotion 4 from the CLI, headless. It is free for the owner (companies of up to 3 people).
   - The renderer reads only the timeline, so a small canvas + ffmpeg renderer can replace it
     if screen-kit is sold to larger companies, which would otherwise also owe Remotion a
     licence.
6. **Outputs.**
   - Web loop: AV1 or VP9 WebM, H.264 MP4 and a poster, `autoplay muted loop playsinline`.
   - YouTube master: 1440p60 H.264, with SRT or VTT per language.
   - Shorts: a 9:16 reframe from the same timeline.
7. **Review.** Each render is checked against these assertions:
   - duration, fps and size;
   - capture gaps and freeze/black detection;
   - a still per step and a contact sheet;
   - the cursor within 2 px of the event track;
   - the camera inside the stage;
   - caption rules and speech within its step;
   - loudness;
   - a per-step diff against the last approved render.
8. **Publish.**
   - The web clip is written to a target folder.
   - YouTube: upload, captions and the thumbnail by API. Extra audio-language tracks have no
     API and are added by hand in YouTube Studio.

## Decisions (owner, 2026-11-04)

1. **Renderer:** Remotion 4, read through our own timeline only, so the renderer can be
   swapped.
2. **Licence:** MIT. The repository and packages stay private until the owner authorizes
   publishing.
3. **Flow-builder benchmark:** the Straylight Desktop scenario editor, recorded as the real
   interface, not an imitation.
   - The interface is Electron + React (`@xyflow/react`, Sid-Kit) and runs in a browser: the
     desktop's web mode, its test host without device access, or its `Straylight/Scenarios`
     stories. Its action-creation tests already drive palette drags in Playwright Chromium.
   - The render draws the macOS window frame (traffic lights) on a wallpaper stage. The camera
     can therefore leave the window to show the frame.
   - Scenario:
     - drag an action card from the palette onto the canvas;
     - pan and pinch-zoom the canvas;
     - select cards (marquee, Shift/⌘);
     - show the shortcuts used.
4. **Where scripts live:** next to their use.
   - The personal site (`maxvyshniakov`) keeps its video recipes beside its screenshot recipes
     (`config/case-shots.json`, the `case-shots` skill).
   - screen-kit is the tool, not the place for scripts.
5. **Picture format follows the site** (`docs/screenshots.md` there):
   - a 16:9 frame of 1440 × 810 CSS px;
   - demo data only;
   - Display P3 (`--force-color-profile=display-p3-d65`).

## Retina: recommendation, pending a spike

The site shoots stills at 3× (4320 × 2430). Headless screencast on macOS stops at 1×.
Recommended order:

1. **Per-frame capture on a virtual clock** at device scale 2 (or 3), in headless Chromium.
   - It stays agent-operated, never touches the owner's screen and gives any scale, in P3, as
     the stills do.
   - Unknown: whether the CDP trackpad gesture and the rubber band still play under a virtual
     clock. The first spike answers this.
2. **Fallback: record a real window** with ScreenCaptureKit at the display's 2× scale.
   - This needs the Screen Recording permission and a quiet screen: a virtual display, or a
     time the owner is away.
   - It is the only path for Safari and Firefox gestures, and for native windows.

Video size: a 2× master (2880 × 1620) encodes the web loop. 3× stills stay stills.

## v0 milestone

- **Spike:** per-frame capture at 2× with the trackpad gesture, as above.
- **One end-to-end path:**
  - Chromium, a Storybook story or any URL;
  - a silent web loop with captions;
  - the review assertions.
- **Scenarios:**
  - the Data Grid sideways rubber band, after Data Grid #51 lands;
  - the Straylight scenario editor flow.
- **Out of v0:** Safari and Firefox capture, native windows, voice, YouTube upload and Shorts.
