# Glossary

Terms of screen-kit's domain. A term used in code, docs and tickets means what it says here.

## Recipes and takes

- **Recipe**: one named capture in a consumer's `screen-kit.config.mjs`: its source (`browser` or `terminal`), its
  script and its outputs.
- **Script**: the source of truth. An ordered list of steps; each has an action, its target, and narration per language.
- **Step**: one action (hover, click, drag, wheel, trackpad gesture, touch gesture, keystroke, pause) with its narration
  line and optional camera hint. A terminal step also waits (`waitFor`, `hold`) and may mark the capture start.
- **Take**: one recording of a script in one engine. A browser take yields the clean viewport video (no cursor drawn into
  it), the event track and the window metadata; a terminal take is an asciicast (`.cast`) of the application's output
  with its actions file. Outputs are rendered from a take without running the application again.
- **Event track**: what happened, when and where: pointer samples, presses, wheel and gesture phases, touch points, keys
  with modifiers, drag sessions, pinch scale, the app's own canvas viewport.
- **Checkpoint**: a screen expectation (a terminal `waitFor`) checked again on the saved take at the moment it was met.

## Terminal

- **Scenario**: a terminal recipe's steps, run in order against a live headless terminal fed the output the take records.
- **Capture start**: the moment a step with `startCapture` was met; an output's `at` and `start` count from it, and an
  animation begins there.
- **Output**: one render of a take: a PNG still at `at`, or an animated WebP, MP4 or WebM from `start` at `fps`.
- **Cell**: one character position of the terminal grid, drawn at whole-pixel edges; a wide glyph (emoji, CJK) takes two.
- **Theme**: a terminal's background, foreground and 16-colour palette; presets `ghostty`, `seti` and `prolight`.

## Video

- **Timeline**: the renderer-neutral description of the final video: stage, window, camera keyframes, overlay layers and
  audio tracks. Edits after recording are edits here.
- **Stage**: the canvas behind the window (wallpaper or gradient), larger than the frame, so the camera can leave the
  viewport.
- **Window**: the take placed on the stage inside a frame: browser chrome, macOS window or device bezel.
- **Overlay**: anything drawn after the camera in screen space at constant size: cursor, click ripple, wheel indicator,
  finger dots, keystroke pill, caption.
- **Render**: one output from a timeline: web loop, YouTube master, Shorts.
- **Review**: the assertions an agent runs on a render instead of watching it.

## Work

- **Lane**: Lanefather's unit of parallel work: a task branch with its worktree, path claims and a verification receipt
  ([orchestration](docs/agents/orchestration.md)).
- **Receipt**: the record of a lane check's results for one committed tree.
