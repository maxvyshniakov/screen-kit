/**
 * Consumer recipe example for `@maxvyshniakov/data-grid` Storybook (`bun run storybook` -> port 6010).
 * Copy into the Data Grid checkout or pass `--config examples/data-grid.screen-kit.mjs` while Storybook runs.
 * Does not import or depend on a sibling Data Grid checkout.
 */
const base = process.env.DATA_GRID_STORYBOOK_URL ?? 'http://127.0.0.1:6010';
const captureMode = process.env.SCREEN_KIT_CAPTURE_MODE ?? 'quality';

export const timelinePresentation = {
  stage: {
    width: 1920,
    height: 1140,
    padding: 140,
    background: {
      type: 'gradient',
      angle: 135,
      stops: [
        { color: '#0b1120', offset: 0 },
        { color: '#1e293b', offset: 0.55 },
        { color: '#0f172a', offset: 1 },
      ],
    },
  },
  window: {
    frame: 'browser',
    title: 'Data Grid · Playground',
    width: 1440,
    height: 810,
  },
  camera: {
    outputWidth: 1680,
    outputHeight: 945,
    keyframes: [
      { t: 0, x: 960, y: 550, zoom: 1.0, easing: 'linear' },
      { t: 1.2, x: 830, y: 565, zoom: 1.14, easing: 'ease-in-out' },
      { t: 2.3, x: 780, y: 570, zoom: 1.18, easing: 'ease-in-out' },
      { t: 3.4, x: 960, y: 550, zoom: 1.0, easing: 'ease-in-out' },
    ],
  },
  overlays: {
    cursor: { enabled: true, style: 'macos' },
    ripples: { enabled: true },
    gestures: { enabled: true },
    keystrokes: { enabled: true },
  },
  outputs: ['web-loop'],
};

export default {
  cwd: '.',
  defaults: {
    source: 'browser',
    base,
    captureMode,
    format: 'mp4',
    viewport: [1440, 810],
    fps: 60,
    themes: ['dark'],
  },
  recipes: {
    'rubber-band-smoke': {
      story: 'data-grid-regression-datagrid--playground',
      args: { scrollOwner: 'element', showHeader: true },
      initialPointer: [480, 340],
      tail: 0.3,
      steps: [
        { type: 'move', x: 520, y: 360, duration: 0.25, label: 'Focus grid body' },
        {
          type: 'gesture',
          kind: 'scroll',
          x: 520,
          y: 360,
          deltaX: -520,
          deltaY: 0,
          duration: 0.38,
          settle: 0.14,
          label: 'Scroll columns right',
        },
        {
          type: 'gesture',
          kind: 'scroll',
          x: 520,
          y: 360,
          deltaX: 560,
          deltaY: 0,
          duration: 0.34,
          settle: 0.12,
          label: 'Return to left edge',
        },
        {
          type: 'gesture',
          kind: 'scroll',
          x: 520,
          y: 360,
          deltaX: 320,
          deltaY: 0,
          duration: 0.36,
          settle: 0.3,
          label: 'Horizontal rubber-band overscroll',
        },
      ],
    },
  },
};
