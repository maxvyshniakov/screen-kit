# Edited-video pipeline benchmarks

Increment 1 validates the full edited-video pipeline (`captureBrowserTake` → `compileTimeline` → `renderTimeline` → `reviewVideo`) across two product benchmarks in order:

1. **Smoke benchmark — Data Grid horizontal rubber-band:** `overflow-x: auto` table with pinned left columns, horizontal trackpad scroll, and left-edge elastic rubber-band overscroll inside a `browser` window frame on a gradient `stage`.
2. **Final acceptance benchmark — Straylight Desktop scenario editor:** node-graph scenario canvas driving palette drag-to-insert, two-finger canvas pan, trackpad pinch-zoom, marquee + `Shift` / `⌘` multi-selection, and `⌘A` / `⇧⌘L` shortcuts inside a `macos` traffic-light window frame on an image wallpaper `stage` where camera keyframes leave the window to reveal the frame.

## Self-contained benchmark suite

`bun run verify` runs a fast non-browser compile → Remotion render → `reviewVideo` integration test so CI never depends on sibling repositories or running dev servers.

Run the full real-browser + Remotion end-to-end benchmark suite behind `slotfather`:

```sh
slotfather run -n 1 -- env SCREEN_KIT_BROWSER_TESTS=1 node --test test/benchmark-pipeline.test.mjs
```

To run the browser takes in `quality` mode (headful 2× Retina at 60 fps behind foreground windows with macOS JXA focus handback per [retina-spike.md](research/retina-spike.md)):

```sh
slotfather run -n 1 -- env SCREEN_KIT_BROWSER_TESTS=1 SCREEN_KIT_CAPTURE_MODE=quality node --test test/benchmark-pipeline.test.mjs
```

Fixtures and reusable recipe/timeline builders live under `test/fixtures/benchmarks/`:

- `test/fixtures/benchmarks/data-grid-fixture.mjs` — local Data Grid surface (`#grid-scroller`, sticky pinned columns, horizontal scroll & spring rubber-band overscroll).
- `test/fixtures/benchmarks/straylight-fixture.mjs` — local Straylight Scenario Editor surface (draggable action palette, pan/pinch-zoom canvas, marquee + `Shift`/`⌘` selection, `⌘A` and `⇧⌘L` shortcuts, deterministic wallpaper generator).
- `test/fixtures/benchmarks/recipes.mjs` — recipe and `timeline.json` builders for both benchmarks.

## Running against consumer repositories

Both consumer repositories own their live Storybook/dev servers and keep capture artifacts outside `screen-kit`. Ready-to-copy configurations ship in `examples/` without coupling `screen-kit` to sibling checkouts:

### 1. Data Grid (`examples/data-grid.screen-kit.mjs`)

1. Start Data Grid Storybook (`http://127.0.0.1:6010`, story `data-grid-regression-datagrid--playground`):
   ```sh
   bun run storybook
   ```
2. Capture the clean 2× 60 fps take and `event-track.json`:
   ```sh
   slotfather run -n 1 -- screen-kit capture --config examples/data-grid.screen-kit.mjs --out out/data-grid
   ```
3. Compile `timeline.json` (using `compileTimeline` + `timelinePresentation` from `examples/data-grid.screen-kit.mjs`), render `web-loop`, and verify:
   ```sh
   slotfather run -n 1 -- screen-kit render --input out/data-grid/timeline.json --out out/data-grid/renders --profiles web-loop
   slotfather run -n 1 -- screen-kit review --video out/data-grid/renders/web-loop.mp4 --timeline out/data-grid/timeline.json --event-track out/data-grid/takes/rubber-band-smoke/event-track.json --out-dir out/data-grid/review
   ```

### 2. Straylight Desktop (`examples/straylight.screen-kit.mjs`)

1. Start Straylight Desktop Storybook (`http://127.0.0.1:6011`, story `straylight-scenarios--linear`):
   ```sh
   bun run --cwd desktop storybook
   ```
2. Capture the clean scenario editor take (`quality` mode, 2× Retina 60 fps):
   ```sh
   slotfather run -n 1 -- screen-kit capture --config examples/straylight.screen-kit.mjs --out out/straylight
   ```
3. Compile `timeline.json` with a wallpaper stage (`wallpaper.png`), render `web-loop` (or `web-loop,youtube-master`), and run deterministic + optional multimodal review:
   ```sh
   slotfather run -n 1 -- screen-kit render --input out/straylight/timeline.json --out out/straylight/renders --profiles web-loop
   slotfather run -n 1 -- screen-kit review --video out/straylight/renders/web-loop.mp4 --timeline out/straylight/timeline.json --event-track out/straylight/takes/scenario-editor-acceptance/event-track.json --out-dir out/straylight/review
   ```
   Pass `--multimodal` when `GEMINI_API_KEY` is configured to append semantic visual review findings alongside the deterministic report, per-step stills, and `contact-sheet.png`.
