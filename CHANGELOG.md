# @maxvyshniakov/screen-kit Changelog

## Unreleased

- Migrate from vendored `@maxvyshniakov/repo-kit` `0.2.2` to `@maxvyshniakov/package-kit` `1.0.1` on npmjs.org (removing `bunfig.toml` / `GITHUB_TOKEN` install requirement), rename `repo-kit.config.mjs` to `package-kit.config.mjs`, sync git hooks, and add changelog checks.

## 0.2.0 - 2026-11-23

- Migrate browser still capture (`src/browser.mjs`) to built-in `playwright-core` with Display P3, crops, multi-theme stacking, and semantic DOM locators (removing the external `agent-browser` CLI requirement).
- Add managed `config.server` lifecycle, incremental `--changed` refresh, and still `--baseline` visual diffs with `--update-baselines`.
- Harden architecture: `O(log N)` hot-path sampling and memoized scene geometry, renderer-neutral `src/timeline-scene.mjs`, unified `withRemotionSession` with ephemeral free-port allocation and Display P3 preview/still parity, explicit browser capture state machine with symmetric teardown, and shared internal media/fs/Google GenAI foundations.
- Configure GitHub Packages publishing (`https://npm.pkg.github.com`) and release workflow.

## 0.1.0 - 2026-11-23

- Initial release: 60 fps Retina browser & POSIX PTY terminal capture, renderer-neutral `timeline.json` v1, headless Remotion 4 rendering (`web-loop`, `youtube-master`, `shorts` 9:16), Display P3 wide-gamut pipeline, `macos-inset` Tahoe chrome, Gemini 2.5 Pro TTS / Kokoro narration, Whisper forced word alignment, procedural UI SFX + voice-ducked music beds, automated video review (`--verify-cursor`, `ebur128`), and opt-in publishing/asset generation.
