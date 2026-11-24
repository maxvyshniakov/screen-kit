// The test suite split into verify steps of similar weight (package-kit.config.mjs). Seconds: the files' tests on the
// owner's Mac, four files at a time, 2026-11-24 (docs/agents/checks.md, "Gate times"). Every test file is in exactly
// one group (test/verify-steps.test.mjs). `heavy` groups drive Chromium, Remotion or the encoders and hold a slot of the
// lease each; `memory` is a group's measured peak in GiB, rounded up by about a tenth.
export const TEST_GROUPS = {
  // Its own tests first and alone in the cheap tier: a broken gate fails in a second.
  'gate tests': { files: ['verify-steps'], seconds: 1, cheap: true, memory: 0.2 },
  'terminal tests': { files: ['terminal', 'terminal-render', 'symbol-font', 'core-rerender', 'core', 'video'], seconds: 10, memory: 0.5 },
  'browser tests': { files: ['browser', 'take-browser'], seconds: 3, memory: 0.3 },
  'pipeline tests': {
    files: ['benchmark-pipeline', 'living-docs', 'architecture-foundation', 'architecture-seams', 'wave7-regressions',
      'core-review', 'publish', 'timeline', 'catalog', 'images'],
    seconds: 70,
    heavy: true,
    memory: 3.5,
  },
  'narration tests': { files: ['narration'], seconds: 40, heavy: true, memory: 2.4 },
  'review tests': { files: ['review-video', 'audio-mix'], seconds: 60, heavy: true, memory: 1.3 },
  'render tests': { files: ['render-timeline'], seconds: 69, heavy: true, memory: 3.5 },
};

export const testFile = name => `test/${name}.test.mjs`;
