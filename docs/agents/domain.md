# Domain

- Research notes: [docs/research](../research), one cited file per question, dated.

## Glossary

- **Script**: the source of truth. An ordered list of steps; each has an action, its target,
  and narration per language.
- **Step**: one action (hover, click, drag, wheel, trackpad gesture, touch gesture, keystroke,
  pause) with its narration line and optional camera hint.
- **Take**: one recording of a script in one engine. It yields the clean viewport video (no
  cursor drawn into it), the event track and the window metadata.
- **Event track**: what happened, when and where: pointer samples, presses, wheel and gesture
  phases, touch points, keys with modifiers, drag sessions, pinch scale, the app's own canvas
  viewport.
- **Timeline**: the renderer-neutral description of the final video: stage, window, camera
  keyframes, overlay layers and audio tracks. Edits after recording are edits here.
- **Stage**: the canvas behind the window (wallpaper or gradient), larger than the frame, so
  the camera can leave the viewport.
- **Window**: the take placed on the stage inside a frame: browser chrome, macOS window or
  device bezel.
- **Overlay**: anything drawn after the camera in screen space at constant size: cursor, click
  ripple, wheel indicator, finger dots, keystroke pill, caption.
- **Render**: one output from a timeline: web loop, YouTube master, Shorts.
- **Review**: the assertions an agent runs on a render instead of watching it.
