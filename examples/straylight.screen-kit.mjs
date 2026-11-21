/**
 * Consumer recipe example for Straylight Desktop (`bun run storybook` -> port 6011).
 * Targets the production React Flow scenario editor (`Straylight/Scenarios` -> `straylight-scenarios--linear`).
 * Standalone configuration: no runtime or build dependency on a sibling Straylight checkout.
 */
const base = process.env.STRAYLIGHT_STORYBOOK_URL ?? 'http://127.0.0.1:6011';
const captureMode = process.env.SCREEN_KIT_CAPTURE_MODE ?? 'quality';

export const timelinePresentation = {
  stage: {
    width: 2048,
    height: 1200,
    padding: 160,
    background: {
      type: 'image',
      src: 'wallpaper.png',
      fit: 'cover',
    },
  },
  window: {
    frame: 'macos',
    title: 'Straylight — Scenario Editor',
    width: 1440,
    height: 810,
  },
  camera: {
    outputWidth: 1680,
    outputHeight: 945,
    keyframes: [
      { t: 0, x: 1024, y: 582, zoom: 1.0, easing: 'linear' },
      { t: 1.1, x: 860, y: 510, zoom: 1.15, easing: 'ease-in-out' },
      { t: 2.8, x: 1090, y: 625, zoom: 1.2, easing: 'ease-in-out' },
      { t: 4.6, x: 1024, y: 582, zoom: 0.96, easing: 'ease-in-out' },
    ],
  },
  overlays: {
    cursor: { enabled: true, style: 'macos' },
    ripples: { enabled: true },
    gestures: { enabled: true },
    keystrokes: { enabled: true },
  },
  outputs: ['web-loop', 'youtube-master'],
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
    'scenario-editor-acceptance': {
      story: 'straylight-scenarios--linear',
      ready: '[data-testid="canvas"]',
      initialPointer: [720, 380],
      tail: 0.35,
      steps: [
        {
          type: 'drag',
          from: '[role="toolbar"] button',
          to: [860, 520],
          moveDuration: 0.26,
          duration: 0.45,
          label: 'Drag action card from palette',
        },
        {
          type: 'gesture',
          kind: 'scroll',
          target: '[data-testid="canvas"]',
          move: true,
          moveDuration: 0.2,
          deltaX: -160,
          deltaY: -80,
          duration: 0.3,
          settle: 0.1,
          label: 'Pan scenario canvas',
        },
        {
          type: 'gesture',
          kind: 'pinch',
          target: '[data-testid="canvas"]',
          scaleFactor: 1.22,
          steps: 8,
          duration: 0.3,
          settle: 0.1,
          label: 'Pinch-zoom canvas',
        },
        {
          type: 'drag',
          from: [420, 220],
          to: [980, 620],
          moveDuration: 0.22,
          duration: 0.38,
          label: 'Marquee select cards',
        },
        {
          type: 'click',
          target: '.react-flow__node-action',
          modifiers: ['Shift'],
          moveDuration: 0.22,
          hold: 0.06,
          label: 'Shift-select card',
        },
        {
          type: 'click',
          target: '.react-flow__node-action',
          modifiers: ['Meta'],
          moveDuration: 0.22,
          hold: 0.06,
          label: 'Command-toggle card',
        },
        {
          type: 'key',
          key: 'a',
          modifiers: ['Meta'],
          label: 'Select all cards',
        },
        { type: 'pause', duration: 0.25 },
        {
          type: 'key',
          key: 'l',
          modifiers: ['Shift', 'Meta'],
          label: 'Tidy up layout',
        },
        { type: 'pause', duration: 0.3 },
      ],
    },
  },
};
