# screen-kit

Reproducible browser and terminal screenshots, animations and recordings. Recipes live with
products; screen-kit owns capture, saved takes, export and verification. Private package.

## Local setup

```sh
bun install
bun link
brew install agg webp ffmpeg   # terminal exports and video; Python 3 is also required
screen-kit --help
```

Browser capture needs `agent-browser` on PATH. Every capture, browser integration test and
encoder runs through `slotfather run -n 1 -- ...`; timing benchmarks require all slots.
Bundled JetBrains Mono and Noto Sans Symbols 2 include their licenses in `fonts/`.

## Capture

A JavaScript module (or JSON file) contains named recipes. Paths resolve relative to the config
file, or its `cwd` setting. Browser steps use agent-browser argument arrays or trusted preparation
JavaScript. Terminal steps send real input to the application in a PTY.

```js
export default {
  cwd: '.',
  recipes: {
    navigation: {
      source: 'terminal', command: ['python3', 'demo.py'],
      columns: 120, rows: 36, duration: 12, fps: 1, format: 'webp',
      steps: [
        { at: 3, input: 'j', expect: 'selected: beta' },
        { at: 8, input: 'k', expect: 'selected: alpha' },
      ],
    },
    page: {
      source: 'browser', url: 'http://localhost:3000',
      viewport: [1440, 810], themes: ['dark'], format: 'webp',
      steps: [['click', '[data-demo-open]']],
    },
  },
};
```

```sh
slotfather run -n 1 -- screen-kit capture --config screens.mjs --out out/screens
screen-kit status --config screens.mjs --manifest out/screens/run.json
screen-kit review --manifest out/screens/run.json
```

`--only name,name` selects recipes. `run.json` records source revision/dirty state, recipe and
artifact hashes, dimensions, frames, duration, original take hashes and checkpoints. Failures
leave a failed manifest. `status` is read-only; `review` detects replaced files and failed checks.
Terminal expectations read the rendered screen through xterm, not a grep of the ANSI stream.

Terminal defaults use Ghostty's built-in palette, bundled JetBrains Mono and a symbol fallback.
This is actual application output rendered headlessly, not a capture of the Ghostty window.
Font family/size, line height, font directory and theme are recipe settings. `format: 'png'`
captures a still; `webp` is animated, lossless and looping. Identical frames may share a longer
delay, so a 1 fps recording can store fewer than one distinct frame per second.

Browser stills support Storybook stories, args, themes, crops, bands and composites, retaining
Display P3. Browser recording uses `format: 'webm' | 'mp4'`, a viewport, `duration`, `fps`,
optional `setup` steps and timed `steps: [{at: 1, click: 'selector'}]`. Recording
currently rejects crop/composite/multitheme recipes. Measured frame counts and duration come
from the encoded result; requested fps is not a performance guarantee.

## Reuse a take

```sh
slotfather run -n 1 -- screen-kit render --input out/screens/takes/navigation.cast --out demo.webp
slotfather run -n 1 -- screen-kit render --input out/screens/takes/navigation.cast --out still.png --at 4
slotfather run -n 1 -- screen-kit render --input out/screens/takes/navigation.cast --out demo.mp4
slotfather run -n 1 -- screen-kit render --input take.webm --out demo.mp4
```

Terminal takes preserve ANSI output and input events. Video export accepts actual captured
video, GIF takes and numbered PNG sequences. It exports silent MP4/WebM without starting an
application. Cropping/stacking, catalog resolution and comparison images also have package
exports; see the integration in the personal site's `scripts/screens.mjs`.

## Consumers and verification

- Slotfather owns its historical fixture, demo application mode and navigation recipe.
- The personal site owns its case recipes and import/pin workflow. A private vendored package
  tarball lets its CI install from a standalone checkout; the package is not published.
- `bun run verify` is the repo-kit gate. Real browser tests are opt-in as documented in
  [checks](docs/agents/checks.md), with local fixture servers and cleanup.

The [specification](docs/SPEC.md) describes scope and ownership. Current video support is real
recording and export. Edited camera/stage composition, cursor overlays, captions, narration,
Retina cadence acceptance and P3 video acceptance remain future work.
