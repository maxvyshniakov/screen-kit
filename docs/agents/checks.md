# Checks

## Focused
- One test file: `node --test test/<name>.test.mjs`; one test: add `--test-name-pattern "<title>"`.
- One gate step: `node scripts/run-tests.mjs "<step>"` (steps in [scripts/test-groups.mjs](../../scripts/test-groups.mjs)).
- Lint: `bun run lint` (oxlint, [.oxlintrc.json](../../.oxlintrc.json): the correctness rules of the eslint, unicorn,
  oxc, node, promise and import plugins; test files may reach a module namespace by a computed name).
- Changelog: `bun run check:changelogs` (format and versions); each commit's entry or `Changelog: none` trailer:
  `bunx package-kit check-changelog-entries origin/dev..HEAD` (the commit-msg hook, and CI on Linux for the pushed range). Kit drift (managed hooks, workflow pins): `bun run check:kit`.
- Terminal tests run real PTY applications and verify screen expectations and cleanup. Video tests encode and decode
  real files.

## Full gate
- `bun run verify` (package-kit, [package-kit.config.mjs](../../package-kit.config.mjs)): first the cheap tier
  (changelogs, kit, lint, gate tests), then six test steps under a two-slot lease: terminal and browser tests
  beside the rest, and the four heavy ones (pipeline, narration, review, render: Chromium, Remotion, encoders) two at
  a time, each holding a slot. Four heavy steps at once starve Chromium until a Remotion page load times out. A CI
  runner without Slotfather runs the heavy ones one at a time. The pre-push hook runs it on each pushed commit in a clean worktree;
  run it by hand only to reproduce a hook failure.
- A lane check (`lanefather check <id>`, through `.githooks/lane-check`) runs the steps whose inputs the lane's diff
  touches. A test step's inputs are its test files and everything they reach in the code
  ([scripts/step-inputs.mjs](../../scripts/step-inputs.mjs)): imports, dynamic imports, `new URL(...)` and path
  segments such as `join(REPO_ROOT, 'src', 'cli.mjs')`. Most of `src/` reaches most of the rest through `run.mjs`, so a
  source change still runs most steps; a test, fixture, example or doc change runs its own. `package.json`,
  `bun.lock` and `scripts/run-tests.mjs` run everything; a tracked path no step owns and no `INERT` glob names runs
  everything too. [test/verify-steps.test.mjs](../../test/verify-steps.test.mjs) keeps that true: a new file either
  belongs to a step or is named inert.

### Gate times
Measured on the owner's Mac, 2026-11-24: `bun run verify` 129 s under a two-slot lease; all files four at a time, 92 s. Per file: render-timeline 69 s,
review-video 51 s, narration 40 s, benchmark-pipeline 30 s, living-docs 27 s, audio-mix 9 s, terminal 7 s, the rest
under 5 s each. `.lanefather.toml` gives the render and pipeline steps (over a minute) a two-slot floor. Re-measure
with `node --test --test-concurrency=4 --test-reporter=tap test/*.test.mjs` after adding a slow test, and move files
between groups to keep them even.

## Heavy checks
- Captures, encoders and Remotion renders take a machine slot: `slotfather run -n 1 --label "<task or ticket> <what it
  does>" -- <command>` (two slots for `bun run verify`). The label is required.
- Never wrap `lanefather check`, `land` or `promote`, nor the pre-push hook, in `slotfather run --`: they lease their
  own slots.
- Performance measurements take every slot.

## Browser and visual
- Real browser acceptance: `slotfather run -n 1 --label "<task> browser acceptance" -- env SCREEN_KIT_BROWSER_TESTS=1
  node --test test/browser.test.mjs`. The tests own a local fixture server and isolated browser sessions. Production
  browser acceptance also includes all of the personal site's `config/screens.json` recipes, with comparison
  artifacts retained outside the repository. P3 still verification checks actual encoded primaries and ICC profiles,
  not just a metadata tag. P3 video is unverified in the gate: the P3 `<video>` still check of `test/architecture-seams.test.mjs` ("S3 unified
  Remotion session") runs only with `SCREEN_KIT_BROWSER_TESTS=1`, because CI runners often render that frame black.
- Terminal pictures: capture the recipe (`screen-kit capture --config <file> --out <dir>`) and look at the PNG and a
  contact sheet of the WebP's frames; pictures go to a scratch directory, never into the repository. The
  `browser-verify` skill covers engine behaviour on this Mac.

## Pins
- `@maxvyshniakov/package-kit` 1.0.1 and `oxlint` 1.94.0, exact: the managed hooks and workflow references must match
  the kit, and a lint upgrade may add findings. Upgrade each on its own, with its findings fixed in the same commit.
- `@xterm/headless` 6.0.0: terminal rendering reads its cell API and two internals (an OSC 8 link's underline flag,
  `src/internal/terminal-raster.mjs`); check both after an upgrade.

## Review
- Review checks fixture isolation, take provenance, process cleanup, source/version guards and packed consumer
  parity. Consumers own import, pins and publication; capture alone does not approve a changed picture or publish it.
- A terminal rendering change is reviewed with the pictures: before and after, at a fractional cell size.
