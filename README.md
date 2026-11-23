# screen-kit

[![CI](https://github.com/maxvyshniakov/screen-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/maxvyshniakov/screen-kit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/maxvyshniakov/screen-kit)](https://github.com/maxvyshniakov/screen-kit/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey)](#setup)

**Programmatic, agent-operated product demo videos, screenshots, and terminal recordings.**

`screen-kit` turns declarative JavaScript recipes into polished, verified product demos — driving **real browser and PTY terminal input** (never synthesized UI), compiling into a renderer-neutral `timeline.json`, and rendering headlessly via **Remotion 4** in **Display P3 wide-gamut** across **16:9 YouTube**, **web loops**, and **9:16 Shorts** — complete with **Gemini 2.5 Pro TTS / Kokoro narration**, **Whisper forced word alignment**, **procedural UI SFX**, **voice-ducked music beds**, and **automated pixel-level QA**.

> Recipes live in your product repository. `screen-kit` owns capture, reusable takes, timeline choreography, rendering, narration, audio mixing, and machine-checkable review.

---

## Why screen-kit?

- **Living docs & website screenshots that never go stale** — keeping screenshots and feature clips up to date on a product site or docs portal is a notorious chore every time the UI changes. With `screen-kit`, you drop a declarative capture recipe into the consumer repository **once** and forget about manual screenshotting. Whenever the app evolves, run `screen-kit` (or let an agent run it in CI) to regenerate every screenshot, dark/light theme composite, cropped callout, and demo clip with verifiable provenance (`run.json`) and `--baseline` visual diffs.
- **Built for AI agents and CI from day one** — every step has a CLI and JSON contract (`capture` → `timeline` → `preview` → `narrate` → `audio-mix` → `render` → `review` → `publish`). No GUI editor required.
- **100% real UI, reusable takes** — capture once at Retina 2× / 60 fps (`quality` mode behind windows on macOS or headless on Linux/CI), then re-edit camera choreography, overlays, narration languages, or aspect ratios without relaunching your app.
- **Cinematic motion without manual keyframing** — semantic DOM locators (`selector`, `role`, `text`, `label`), minimum-jerk pointer trajectories, 60 Hz eased wheel/pinch sub-steps, and smooth `sine-in-out` per-step camera glides (`clampToWindow` prevents dark stage edges).
- **Display P3 wide-gamut end-to-end** — preserves `smpte432` / `iec61966-2-1` color from Chromium capture through frame-hold padding and Remotion 4 MP4/WebM export.
- **Multi-format & multi-language from one take** — export 16:9 `youtube-master`, `web-loop`, and `shorts` (9:16 `1080×1920 @ 60 fps` with smart-follow camera & safe HUD zones) in any language (`en`, `uk`, etc.).
- **Native macOS & browser chrome** — `macos-inset` (macOS Tahoe `hiddenInset` overlay traffic lights, zero extra bar), `macos`, `browser`, `device`, or `none`.
- **Automated quality gates** — contact sheets, baseline pixel diffs, freeze/black/gap detection, `ebur128` loudness checks, Netflix caption rule validation, `--verify-cursor` (`<= 2 px` pixel-marker verification), and optional Gemini multimodal visual review.

---

## Living Docs & Marketing Media (Write Once, Refresh Anytime)

Instead of manually retaking, cropping, and re-framing dozens of screenshots every release:

1. **Define recipes alongside your app or docs** (`screens.mjs` / `screen-kit.config.mjs`) — one entry per docs screenshot, dark/light theme stack, terminal animation, or feature demo video.
2. **After any UI change, let an agent or script refresh everything in one command:**

```sh
screen-kit capture --config docs/screens.mjs --out docs/public/media
screen-kit review --manifest docs/public/media/run.json --baseline docs/baselines
```

3. **Review what changed without clicking through every page** — `run.json` records the exact source git revision, SHA-256 hashes, dimensions, and checkpoints, while `review` generates side-by-side diffs and contact sheets so you only inspect real visual changes.

---

## Pipeline Overview

```text
recipe.mjs (in consumer repo)
   │
   ▼  screen-kit capture
raw take (take.mp4 / take.cast) + event-track.json + run.json
   │
   ▼  screen-kit timeline
timeline.json v1  (stage, window chrome, camera keyframes, overlays, outputs)
   │
   ├──▶ screen-kit preview      → fast contact sheet of key step frames
   ├──▶ screen-kit narrate      → Gemini 2.5 Pro TTS / Kokoro + Whisper alignment + SRT/VTT
   ├──▶ screen-kit audio-mix    → voice + procedural UI SFX + -30 LUFS music with voice ducking
   │
   ▼  screen-kit render (Remotion 4, Display P3)
youtube-master.mp4 (16:9) · web-loop.webm · shorts.mp4 (9:16) · poster.png
   │
   ▼  screen-kit review
review.json (provenance, --verify-cursor <= 2px, ebur128, Netflix captions, contact sheet)
   │
   ▼  screen-kit publish (opt-in)
web bundle (VP9/AV1 + H.264 + WebP poster + embed.html) · YouTube upload (--dry-run supported)
```

---

## Setup

### macOS

```sh
bun install
bun link
brew install agg webp ffmpeg   # Python 3 is also required for PTY terminal capture
screen-kit --help
```

### Linux (Debian / Ubuntu)

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg webp python3
# Install agg >= 1.9 from https://github.com/asciinema/agg/releases into /usr/local/bin/agg
bun install
bun link
screen-kit --help
```

### Optional Capabilities

| Capability | Requirement |
|---|---|
| **Gemini 2.5 Pro TTS**, multimodal review, Imagen assets, Lyria music | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) sent via `x-goog-api-key` header |
| **Offline TTS fallback** | `kokoro` / `kokoro-tts` on `PATH` (or Python `kokoro` package) |
| **Local forced word alignment** | `mlx_whisper` (Apple Silicon) or `whisper-cli` (`whisper.cpp`) on `PATH` |
| **Opt-in YouTube upload** | `YOUTUBE_ACCESS_TOKEN` OAuth Bearer token (never called without explicit invocation) |

Bundled terminal fonts (JetBrains Mono & Noto Sans Symbols 2) include their licenses in [`fonts/`](fonts/).

---

## Quickstart

Write a standalone recipe in your project (see [`examples/`](examples/) for full real-world configs):

```js
// demo.screen-kit.mjs
export default {
  cwd: '.',
  defaults: {
    source: 'browser',
    url: 'http://127.0.0.1:3000',
    captureMode: 'quality', // 'quality' (Retina 2x 60fps) or 'headless' (CI)
    colorSpace: 'p3',       // 'p3' (Display P3) or 'srgb'
    viewport: [1440, 810],
    fps: 60,
    themes: ['dark'],
  },
  recipes: {
    showcase: {
      ready: '[data-testid="canvas"]',
      setup: ["document.querySelector('.app-shell')?.setAttribute('data-native-titlebar', 'true')"],
      presentation: {
        stage: { width: 1920, height: 1080, padding: 88, background: { type: 'image', src: 'wallpaper.jpg', fit: 'cover' } },
        window: { frame: 'macos-inset', width: 1440, height: 810 },
        camera: { outputWidth: 1920, outputHeight: 1080 },
        overlays: { cursor: { enabled: true }, ripples: { enabled: true }, keystrokes: { enabled: true } },
        outputs: ['youtube-master', 'shorts'],
      },
      steps: [
        {
          type: 'click',
          target: { role: 'button', name: 'New Workflow' },
          camera: { zoom: 1.25, focus: 'target', clampToWindow: true },
          narration: {
            en: 'Click any action card to inspect and configure its parameters.',
            uk: 'Натисніть на будь-яку картку дії, щоб налаштувати її параметри.',
          },
        },
        {
          type: 'key',
          key: 'l',
          modifiers: ['Shift', 'Meta'],
          camera: 'wide',
          narration: {
            en: 'And tidy the entire workflow with a single keyboard shortcut.',
            uk: 'І впорядкуйте весь сценарій одним клавіатурним скороченням.',
          },
        },
      ],
    },
  },
};
```

Run the unified pipeline end-to-end:

```sh
# Fast contact-sheet preview of key step frames (seconds, before full encode)
screen-kit run --config demo.screen-kit.mjs --out out/demo --preview-only

# Full capture -> timeline -> narrate -> Remotion 4 render (16:9 + 9:16 Shorts) -> review
screen-kit run --config demo.screen-kit.mjs --out out/demo \
  --profiles youtube-master,shorts --color-space p3 \
  --narration en --aligner whisper --verify-cursor

# Re-render in another language reusing the exact same captured take
screen-kit run --config demo.screen-kit.mjs --out out/demo-uk \
  --reuse-take --profiles youtube-master,shorts --color-space p3 \
  --narration uk --aligner whisper
```

---

## CLI Reference

| Command | Purpose |
|---|---|
| `screen-kit run` | Unified pipeline: `capture` → `timeline` → (`narrate`) → `preview` / `render` → `review`. Supports `--preview-only`, `--reuse-take`, `--profiles`, `--color-space`, `--narration`, `--burn-captions`, `--verify-cursor`. |
| `screen-kit capture` | Record browser (`quality` / `headless`) or PTY terminal takes with provenance manifest (`run.json`) and `event-track.json`. |
| `screen-kit timeline` | Compile `event-track.json` + recipe into validated, renderer-neutral `timeline.json` v1. |
| `screen-kit preview` | Render key step frames of `timeline.json` into a fast contact sheet. |
| `screen-kit narrate` | Synthesize per-step speech (Gemini 2.5 Pro TTS or Kokoro), apply frame-hold video padding, run forced word alignment (`whisper` / `gemini` / `proportional`), and emit Netflix-validated `.srt`/`.vtt`. |
| `screen-kit audio-mix` | Mix narration, procedural UI SFX (synced to ripples/keystrokes), and local or opt-in Lyria music beds with automatic voice ducking (`envelope` / `sidechain`) and `ebur128` verification. |
| `screen-kit render` | Headlessly render `timeline.json` via Remotion 4 (`web-loop`, `youtube-master`, `shorts`, `--color-space p3`), or re-export `.cast`/`.gif`/video takes. |
| `screen-kit review` | Verify provenance hashes, dimensions, cadence, freeze/black frames, `ebur128` loudness, Netflix caption rules, pixel-level cursor accuracy (`--verify-cursor`), baseline diffs, and optional `--multimodal` review. |
| `screen-kit publish` | Export self-contained `--target web` bundles (VP9/AV1 WebM + H.264 MP4 + WebP poster + `embed.html` + `bundle.json`) or opt-in `--target youtube` uploads (`--dry-run` supported). |
| `screen-kit asset` | Opt-in Imagen / Gemini Image API generator for non-UI assets only (stage wallpapers, YouTube thumbnails). Never synthesizes UI frames. |
| `screen-kit status` | Read-only inspection of config and manifest provenance. |

---

## Terminal Recordings & Stills

`screen-kit` also records real PTY terminal sessions (`.cast` asciicast v2) verified against rendered screen state via `@xterm/headless`, and exports lossless animated WebP, PNG stills, or silent MP4/WebM via `agg` 1.9+ and FFmpeg:

```sh
screen-kit render --input out/screens/takes/navigation.cast --out demo.webp --fps 1
screen-kit render --input out/screens/takes/navigation.cast --out still.png --at 4
screen-kit render --input out/screens/takes/navigation.cast --out demo.mp4 --fps 30
```

---

## Documentation & Verification

- **Architecture & Contracts:** [`docs/SPEC.md`](docs/SPEC.md)
- **End-to-End Benchmarks:** [`docs/benchmarks.md`](docs/benchmarks.md)
- **Example Recipes:** [`examples/straylight.screen-kit.mjs`](examples/straylight.screen-kit.mjs), [`examples/data-grid.screen-kit.mjs`](examples/data-grid.screen-kit.mjs)
- **Verification Gate:** `bun run verify` runs `package-kit check`, syntax checks, and the full test suite (`127` tests) on both macOS and Linux CI. Real browser tests are opt-in (`SCREEN_KIT_BROWSER_TESTS=1`).

## License

[MIT](LICENSE)
