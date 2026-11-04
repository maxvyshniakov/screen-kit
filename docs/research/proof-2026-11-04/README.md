# Proof take, 2026-11-04

What [capture.md](../capture.md) measured: a 6 s Data Grid Showcase clip in headless Chromium, with
a drawn cursor on a minimum-jerk path, a CDP trackpad gesture and a 60 fps rebuild of the CDP
screencast.

- `record.mjs` takes the clip. It loads Playwright from the Data Grid checkout
  (`createRequire` at the top), because screen-kit has no dependencies yet. It expects a
  Storybook with Data Grid's stories on port 6010.
- `encode.py` rebuilds a steady 60 fps sequence from the screencast timestamps and encodes AV1,
  VP9, H.264 and a poster.
- The clips are not kept here; rerun the two scripts to get them. The Data Grid at that date
  disabled the sideways bounce, so the take forced `overscroll-behavior-x: contain` into the
  page.
