import { compileTimeline } from '../../../src/timeline.mjs';

const roundTime = (value) => Math.max(0, Number(value.toFixed(4)));

/**
 * Smoke benchmark recipe: Data Grid horizontal scroll + trackpad rubber-band bounce.
 */
export function buildDataGridSmokeRecipe({
  url,
  captureMode = 'headless',
  fps = captureMode === 'quality' ? 60 : 30,
  viewport = [960, 540],
} = {}) {
  return {
    source: 'browser',
    captureMode,
    format: 'mp4',
    url,
    ready: '#grid-scroller',
    viewport,
    fps,
    initialPointer: [320, 220],
    tail: 0.25,
    steps: [
      {
        type: 'click',
        target: '[data-row-id="row-03"] [data-col="status"]',
        moveDuration: 0.24,
        hold: 0.06,
        label: 'Select catalog row',
      },
      {
        type: 'gesture',
        kind: 'scroll',
        target: '#grid-scroller',
        move: true,
        moveDuration: 0.2,
        deltaX: -460,
        deltaY: 0,
        duration: 0.34,
        settle: 0.12,
        label: 'Pan wide columns',
      },
      {
        type: 'gesture',
        kind: 'scroll',
        deltaX: 500,
        deltaY: 0,
        duration: 0.32,
        settle: 0.1,
        label: 'Return to pinned edge',
      },
      {
        type: 'gesture',
        kind: 'scroll',
        deltaX: 360,
        deltaY: 0,
        duration: 0.34,
        settle: 0.26,
        label: 'Horizontal rubber-band bounce',
      },
      {
        type: 'eval',
        eval: `
          const s = window.__gridBenchmark;
          if (!s) throw Error('Data Grid benchmark state missing');
          if (s.selectedRow !== 'row-03') throw Error('Expected row-03 selected, got ' + s.selectedRow);
          if (s.maxScrollLeft < 180) throw Error('Expected horizontal scroll >= 180px, got ' + s.maxScrollLeft);
          if (s.maxRubberOffsetPx < 10 || s.overscrollBounces < 1) {
            throw Error('Expected horizontal rubber-band bounce, got ' + JSON.stringify(s));
          }
          if (document.querySelector('[data-overlay="cursor"], #__demo_cursor')) {
            throw Error('Clean take must not contain a DOM cursor');
          }
        `,
      },
    ],
  };
}

/**
 * Compile the Data Grid smoke timeline: gradient stage + browser window chrome + subtle zoom + overlays.
 */
export function buildDataGridSmokeTimeline({ take, eventTrack } = {}) {
  const duration = take?.duration ?? eventTrack?.video?.duration ?? 2.4;
  return compileTimeline({
    take,
    eventTrack,
    recipe: {
      stage: {
        width: 1280,
        height: 760,
        padding: 100,
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
        title: 'localhost:6010 · Data Grid / Horizontal Rubber-Band',
        width: 960,
        height: 540,
      },
      camera: {
        outputWidth: 1120,
        outputHeight: 630,
        keyframes: [
          { t: 0, x: 640, y: 365, zoom: 1.0, easing: 'linear' },
          { t: roundTime(duration * 0.42), x: 560, y: 376, zoom: 1.12, easing: 'ease-in-out' },
          { t: roundTime(duration * 0.76), x: 520, y: 380, zoom: 1.18, easing: 'ease-in-out' },
          { t: roundTime(duration), x: 640, y: 365, zoom: 1.0, easing: 'ease-in-out' },
        ],
      },
      overlays: {
        cursor: { enabled: true, style: 'macos' },
        ripples: { enabled: true },
        gestures: { enabled: true },
        keystrokes: { enabled: true },
      },
      outputs: ['web-loop'],
    },
  });
}

/**
 * Final acceptance benchmark recipe: Straylight Desktop scenario editor flow
 * (palette drag -> pan & pinch-zoom -> marquee + Shift/Meta multi-select -> keyboard shortcuts).
 */
export function buildStraylightAcceptanceRecipe({
  url,
  captureMode = 'headless',
  fps = captureMode === 'quality' ? 60 : 30,
  viewport = [1024, 576],
} = {}) {
  return {
    source: 'browser',
    captureMode,
    format: 'mp4',
    url,
    ready: '#scenario-canvas',
    viewport,
    fps,
    initialPointer: [512, 260],
    tail: 0.28,
    steps: [
      {
        type: 'drag',
        from: '[data-palette-kind="systemVolume"]',
        to: [825, 355],
        moveDuration: 0.22,
        duration: 0.38,
        label: 'Drag action card from palette',
      },
      {
        type: 'gesture',
        kind: 'scroll',
        x: 560,
        y: 300,
        move: true,
        moveDuration: 0.18,
        deltaX: 60,
        deltaY: 24,
        duration: 0.26,
        settle: 0.08,
        label: 'Pan scenario canvas',
      },
      {
        type: 'gesture',
        kind: 'pinch',
        x: 560,
        y: 300,
        scaleFactor: 1.18,
        steps: 8,
        duration: 0.28,
        settle: 0.08,
        label: 'Pinch-zoom canvas',
      },
      {
        type: 'drag',
        from: [232, 112],
        to: [650, 465],
        moveDuration: 0.2,
        duration: 0.34,
        label: 'Marquee select cards',
      },
      {
        type: 'click',
        target: '[data-card-id="card-volume"]',
        modifiers: ['Shift'],
        moveDuration: 0.2,
        hold: 0.06,
        label: 'Shift-select dropped card',
      },
      {
        type: 'click',
        target: '[data-card-id="card-wake"]',
        modifiers: ['Meta'],
        moveDuration: 0.2,
        hold: 0.06,
        label: 'Command-toggle primary card',
      },
      {
        type: 'key',
        key: 'a',
        modifiers: ['Meta'],
        label: 'Select all shortcut',
      },
      {
        type: 'pause',
        duration: 0.22,
      },
      {
        type: 'key',
        key: 'l',
        modifiers: ['Shift', 'Meta'],
        label: 'Tidy up layout shortcut',
      },
      {
        type: 'pause',
        duration: 0.24,
      },
      {
        type: 'eval',
        eval: `
          const s = window.__scenarioBenchmark;
          if (!s) throw Error('Straylight benchmark state missing');
          if (s.paletteDrops < 1 || s.cardsCount < 3) {
            throw Error('Palette drag did not insert card: ' + JSON.stringify(s));
          }
          if (s.panCount < 1) throw Error('Canvas pan did not fire: ' + JSON.stringify(s));
          if (s.pinchCount < 1 || s.maxZoom <= 1.08) {
            throw Error('Canvas pinch-zoom did not scale viewport: ' + JSON.stringify(s));
          }
          if (s.marqueeSelections < 1) throw Error('Marquee selection did not complete');
          if (s.shiftClickSelections < 1) throw Error('Shift-click multi-selection did not fire');
          if (s.metaClickSelections < 1) throw Error('Meta-click toggle selection did not fire');
          if (!s.shortcuts.includes('Meta+a') || !s.shortcuts.includes('Shift+Meta+l') || !s.tidied) {
            throw Error('Expected Meta+a and Shift+Meta+l shortcuts to run: ' + JSON.stringify(s));
          }
          if (document.querySelector('[data-overlay="cursor"], #__demo_cursor')) {
            throw Error('Clean take must not contain a DOM cursor');
          }
        `,
      },
    ],
  };
}

/**
 * Compile Straylight acceptance timeline: macOS traffic-light window on wallpaper stage where
 * camera keyframes leave the window bounds (`[288..1312, 156..768]`) to reveal the frame & wallpaper,
 * while remaining strictly inside stage `[0..1600, 0..960]`.
 */
export function buildStraylightAcceptanceTimeline({ take, eventTrack, wallpaperSrc = 'wallpaper.png' } = {}) {
  const duration = take?.duration ?? eventTrack?.video?.duration ?? 4.0;
  return compileTimeline({
    take,
    eventTrack,
    recipe: {
      stage: {
        width: 1600,
        height: 960,
        padding: 140,
        background: {
          type: 'image',
          src: wallpaperSrc,
          fit: 'cover',
        },
      },
      window: {
        frame: 'macos',
        title: 'Straylight — Living Room Arrival',
        width: 1024,
        height: 576,
      },
      camera: {
        outputWidth: 1280,
        outputHeight: 720,
        keyframes: [
          { t: 0, x: 800, y: 462, zoom: 1.0, easing: 'linear' },
          { t: roundTime(duration * 0.22), x: 650, y: 405, zoom: 1.16, easing: 'ease-in-out' },
          { t: roundTime(duration * 0.58), x: 855, y: 495, zoom: 1.22, easing: 'ease-in-out' },
          { t: roundTime(duration), x: 800, y: 462, zoom: 0.96, easing: 'ease-in-out' },
        ],
      },
      overlays: {
        cursor: { enabled: true, style: 'macos' },
        ripples: { enabled: true },
        gestures: { enabled: true },
        keystrokes: { enabled: true },
      },
      outputs: ['web-loop'],
    },
  });
}
