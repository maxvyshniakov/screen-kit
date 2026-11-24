# screen-kit Changelog

## Unreleased

- Terminal export draws frames straight from the replayed `.cast` cells in 24-bit colour: no `agg`, no `gif2webp`, no intermediate `.gif`. Truecolor tints and gradients are exact (no 256-colour GIF palette); every cell sits on whole pixels, and box drawing, block elements and eighths blocks (U+2500–U+259F, U+1FB82–U+1FB8B) are geometry that joins without seams or dashed borders at any `lineHeight`. Text uses the bundled fonts on every platform, bold, dim, reverse, SGR 4 underline and strikethrough are drawn, and two-cell emoji (🆗, ⏸️) use the system colour emoji font. Widths follow a modern terminal (emoji and VS16 clusters take two cells). MP4/WebM stream from the cells to FFmpeg; `videoInput` names the `.cast` take. Terminal recipes may now set `format: 'mp4' | 'webm'` directly. An animation begins when the application first draws (its blank start-up screen is dropped), or at an output's `start`. System requirements drop `agg` and `webp`.
- Terminal scenarios are sequential steps, replacing `at`-timed steps (`at`, `expect`, `settle` and recipe `duration` are gone): `waitFor` (screen text, with `timeout`) watches a live headless terminal fed the very output the take records, `startCapture` starts the animation at the moment it is met, `hold` pauses, and the take ends with the last step. Actions are declarative: `key` (`'Enter'`, `'Shift+Tab'`, `'Up'`, `'Ctrl+C'`, `'Alt+x'`, characters; arrows follow application cursor mode), `wheel` and `click` (SGR 1006), or raw `input`. Replay re-checks each `waitFor` at its moment.
- One terminal take renders several `outputs` (`{ format, name | suffix, at, start, fps }`), each hashed in `run.json` and checked by `review`; the application runs once.
- A terminal command may print and exit before its steps end: its output is kept and later `waitFor` and `hold` steps see its last screen, while an input step after the exit or a nonzero exit status fails the capture. A `startCapture` step without `waitFor` starts the animation the moment it is reached. A terminal output named like another recipe is refused before anything is captured. An animation's first frame is the screen at its start; frames whose pixels match the previous one are merged, so the manifest's frame count is the WebP's own.
- Terminal `theme` accepts the presets `'ghostty'`, `'seti'` and `'prolight'`. The default frame rate is 4 fps.

## 0.2.2 - 2026-11-23

- Add npm badge and `bun add -D screen-kit` / `npm install -D screen-kit` install instructions to `README.md`, and validate npmjs.org OIDC trusted publishing with provenance.

## 0.2.1 - 2026-11-23

- Rename package from `@maxvyshniakov/screen-kit` to unscoped `screen-kit` for npmjs.org publication.
- Migrate from vendored `@maxvyshniakov/repo-kit` `0.2.2` to `@maxvyshniakov/package-kit` `1.0.1` on npmjs.org (removing `bunfig.toml` / `GITHUB_TOKEN` install requirement), rename `repo-kit.config.mjs` to `package-kit.config.mjs`, sync git hooks, and add changelog checks.
- Configure npmjs.org OIDC trusted publishing with provenance (`publish: { registry: "npm", access: "public" }`, `packedConsumer` probes, and `.github/workflows/release-npm.yml`), replacing the GitHub Packages publish workflow.

## 0.2.0 - 2026-11-23

- Migrate browser still capture (`src/browser.mjs`) to built-in `playwright-core` with Display P3, crops, multi-theme stacking, and semantic DOM locators (removing the external `agent-browser` CLI requirement).
- Add managed `config.server` lifecycle, incremental `--changed` refresh, and still `--baseline` visual diffs with `--update-baselines`.
- Harden architecture: `O(log N)` hot-path sampling and memoized scene geometry, renderer-neutral `src/timeline-scene.mjs`, unified `withRemotionSession` with ephemeral free-port allocation and Display P3 preview/still parity, explicit browser capture state machine with symmetric teardown, and shared internal media/fs/Google GenAI foundations.
- Configure GitHub Packages publishing (`https://npm.pkg.github.com`) and release workflow.

## 0.1.0 - 2026-11-23

- Initial release: 60 fps Retina browser & POSIX PTY terminal capture, renderer-neutral `timeline.json` v1, headless Remotion 4 rendering (`web-loop`, `youtube-master`, `shorts` 9:16), Display P3 wide-gamut pipeline, `macos-inset` Tahoe chrome, Gemini 2.5 Pro TTS / Kokoro narration, Whisper forced word alignment, procedural UI SFX + voice-ducked music beds, automated video review (`--verify-cursor`, `ebur128`), and opt-in publishing/asset generation.
