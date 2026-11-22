/**
 * Renderer-neutral timeline.json v1 schema, validator, compiler, and projection helpers.
 *
 * Coordinate spaces:
 * - Viewport space: CSS pixels of the recorded take (`[0..take.viewport.width, 0..take.viewport.height]`).
 *   Overlay anchor points (`cursor.samples`, `ripples`, `gestures`) stay in viewport space so
 *   post-capture edits to `camera` or `window` in `timeline.json` keep overlays aligned automatically.
 * - Stage space: logical composition canvas (`[0..stage.width, 0..stage.height]`).
 *   `window.{x, y, width, height}` locates the take's viewport content rectangle on the stage;
 *   frame chrome (`macos`, `browser`, `device`) renders around the content rectangle within stage padding.
 *   `camera.keyframes[].{x, y}` is the camera center in stage space.
 * - Screen space: output frame pixels (`[0..camera.outputWidth, 0..camera.outputHeight]`).
 *   Overlays are projected via `projectViewportToScreen(x, y, timeline, t)` and drawn at constant size.
 */

export const TIMELINE_VERSION = 1;
export const EVENT_TRACK_VERSION = 1;

export const CAPTURE_MODES = ['quality', 'headless'];
export const WINDOW_FRAMES = ['none', 'macos', 'browser', 'device'];
export const BACKGROUND_TYPES = ['solid', 'gradient', 'image'];
export const IMAGE_FITS = ['cover', 'contain', 'fill'];
export const CAMERA_EASINGS = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'quint-in-out',
  'expo-out',
  'smoothstep',
  'hold',
];
export const CURSOR_STYLES = ['macos', 'pointer', 'dot', 'ring'];
export const MOUSE_BUTTONS = ['left', 'right', 'middle'];
export const GESTURE_KINDS = ['wheel', 'scroll', 'pinch', 'pan', 'swipe', 'drag', 'touch'];
export const OUTPUT_FORMATS = ['mp4', 'webm', 'png', 'webp'];
export const AUDIO_TRACK_KINDS = ['narration', 'sfx', 'music'];
export const STEP_CAMERA_FOCUSES = ['target', 'pointer', 'window'];
export const DEFAULT_STEP_CAMERA_LEAD = 0.85;
export const DEFAULT_STEP_CAMERA_HOLD = 0.35;

const EVENT_TYPES = new Set([
  'pointermove',
  'pointerdown',
  'pointerup',
  'wheel',
  'gesture',
  'drag',
  'key',
  'step',
]);
const WHEEL_PHASES = new Set([
  'began',
  'changed',
  'stationary',
  'ended',
  'cancelled',
  'mayBegin',
  'maybegin',
  'none',
]);
const KEY_ACTIONS = new Set(['press', 'down', 'up']);
const VALID_MODIFIERS = new Set(['Meta', 'Control', 'Alt', 'Shift']);
const EASING_ALIASES = {
  linear: 'linear',
  'ease-in': 'ease-in',
  easeIn: 'ease-in',
  'ease-out': 'ease-out',
  easeOut: 'ease-out',
  'ease-in-out': 'ease-in-out',
  easeInOut: 'ease-in-out',
  smoothstep: 'smoothstep',
  hold: 'hold',
  step: 'hold',
};

const MODIFIER_SYMBOLS = {
  Meta: '⌘',
  Command: '⌘',
  Cmd: '⌘',
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
};

const KEY_LABELS = {
  Enter: '↩',
  Return: '↩',
  Escape: 'Esc',
  Esc: 'Esc',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
  Space: 'Space',
};

const EPS = 1e-6;
const BOUND_SAMPLE_SUBDIVISIONS = 16;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPositiveNumber = (value) => isFiniteNumber(value) && value > 0;
const isNonNegativeNumber = (value) => isFiniteNumber(value) && value >= 0;
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const normalizeZero = (value) => (Object.is(value, -0) ? 0 : value);
const roundTime = (value) => normalizeZero(Math.round(value * 1e6) / 1e6);

/** Evaluate a named camera easing curve at progress `u` in `[0, 1]`. */
export function applyEasing(easing, u) {
  const clamped = u <= 0 ? 0 : u >= 1 ? 1 : u;
  switch (easing) {
    case 'linear':
      return clamped;
    case 'ease-in':
      return clamped * clamped * clamped;
    case 'ease-out':
      return 1 - (1 - clamped) ** 3;
    case 'ease-in-out':
      return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - ((-2 * clamped + 2) ** 3) / 2;
    case 'quint-in-out':
      return clamped < 0.5 ? 16 * clamped ** 5 : 1 - ((-2 * clamped + 2) ** 5) / 2;
    case 'expo-out':
      return clamped >= 1 ? 1 : 1 - 2 ** (-10 * clamped);
    case 'smoothstep':
      return clamped * clamped * (3 - 2 * clamped);
    case 'hold':
      return clamped < 1 ? 0 : 1;
    default:
      throw Error(`Unsupported camera easing: ${String(easing)}`);
  }
}

/**
 * Sample the camera state `{ x, y, zoom }` at timestamp `t` (seconds).
 * For segment `[keyframes[i], keyframes[i + 1]]`, `keyframes[i + 1].easing` governs the
 * transition arriving at `keyframes[i + 1]`. Coincident timestamps act as right-continuous cuts.
 */
export function sampleCamera(camera, t) {
  if (!isObject(camera) || !Array.isArray(camera.keyframes) || camera.keyframes.length === 0) {
    throw Error('camera must have at least one keyframe');
  }
  if (!isFiniteNumber(t)) throw Error('sampleCamera requires a finite timestamp t');

  const { keyframes } = camera;
  if (t < keyframes[0].t) {
    return {
      x: normalizeZero(keyframes[0].x),
      y: normalizeZero(keyframes[0].y),
      zoom: keyframes[0].zoom,
    };
  }
  const last = keyframes[keyframes.length - 1];
  if (t >= last.t) {
    return {
      x: normalizeZero(last.x),
      y: normalizeZero(last.y),
      zoom: last.zoom,
    };
  }

  let index = 0;
  while (index + 1 < keyframes.length && keyframes[index + 1].t <= t) {
    index += 1;
  }

  const from = keyframes[index];
  const to = keyframes[index + 1];
  if (!to || from.t === t || to.t === from.t) {
    return {
      x: normalizeZero(from.x),
      y: normalizeZero(from.y),
      zoom: from.zoom,
    };
  }

  const progress = (t - from.t) / (to.t - from.t);
  const factor = applyEasing(to.easing, progress);
  return {
    x: normalizeZero(from.x + (to.x - from.x) * factor),
    y: normalizeZero(from.y + (to.y - from.y) * factor),
    zoom: normalizeZero(from.zoom + (to.zoom - from.zoom) * factor),
  };
}

/** Compute the visible camera rectangle in stage coordinates at a sample or timestamp `t`. */
export function cameraViewportRect(camera, sampleOrTime) {
  const sample = typeof sampleOrTime === 'number' ? sampleCamera(camera, sampleOrTime) : sampleOrTime;
  const width = camera.outputWidth / sample.zoom;
  const height = camera.outputHeight / sample.zoom;
  const left = normalizeZero(sample.x - width / 2);
  const top = normalizeZero(sample.y - height / 2);
  return {
    left,
    top,
    right: normalizeZero(left + width),
    bottom: normalizeZero(top + height),
    width: normalizeZero(width),
    height: normalizeZero(height),
  };
}

/** Sample the cursor overlay in viewport coordinates at timestamp `t`, or `null` if unavailable. */
export function sampleCursor(cursor, t) {
  if (!isObject(cursor) || !cursor.enabled || !Array.isArray(cursor.samples) || cursor.samples.length === 0) {
    return null;
  }
  if (!isFiniteNumber(t)) throw Error('sampleCursor requires a finite timestamp t');

  const { samples } = cursor;
  if (t < samples[0].t) {
    const first = samples[0];
    return { x: normalizeZero(first.x), y: normalizeZero(first.y), pressed: first.pressed, visible: first.visible };
  }
  const last = samples[samples.length - 1];
  if (t >= last.t) {
    return { x: normalizeZero(last.x), y: normalizeZero(last.y), pressed: last.pressed, visible: last.visible };
  }

  let index = 0;
  while (index + 1 < samples.length && samples[index + 1].t <= t) {
    index += 1;
  }

  const from = samples[index];
  const to = samples[index + 1];
  if (!to || from.t === t || to.t === from.t) {
    return { x: normalizeZero(from.x), y: normalizeZero(from.y), pressed: from.pressed, visible: from.visible };
  }

  const u = (t - from.t) / (to.t - from.t);
  return {
    x: normalizeZero(from.x + (to.x - from.x) * u),
    y: normalizeZero(from.y + (to.y - from.y) * u),
    pressed: from.pressed,
    visible: from.visible,
  };
}

/** Project a point in take viewport space into stage coordinates. */
export function projectViewportToStage(x, y, timeline) {
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    throw Error('projectViewportToStage requires finite x and y coordinates');
  }
  const viewport = timeline?.take?.viewport;
  const win = timeline?.window;
  if (!viewport || !isPositiveNumber(viewport.width) || !isPositiveNumber(viewport.height)) {
    throw Error('timeline.take.viewport must have positive width and height');
  }
  if (!win || !isFiniteNumber(win.x) || !isFiniteNumber(win.y) || !isPositiveNumber(win.width) || !isPositiveNumber(win.height)) {
    throw Error('timeline.window must have valid x, y, width, and height');
  }
  return {
    x: normalizeZero(win.x + (x / viewport.width) * win.width),
    y: normalizeZero(win.y + (y / viewport.height) * win.height),
  };
}

/**
 * Project a point in take viewport space into screen (output frame) coordinates at time `t`.
 * Shared by the Remotion renderer and automated video review cursor checks.
 */
export function projectViewportToScreen(x, y, timeline, t) {
  const stagePoint = projectViewportToStage(x, y, timeline);
  const camera = timeline?.camera;
  if (!camera || !isPositiveNumber(camera.outputWidth) || !isPositiveNumber(camera.outputHeight)) {
    throw Error('timeline.camera must have positive outputWidth and outputHeight');
  }
  const sample = sampleCamera(camera, t);
  return {
    x: normalizeZero((stagePoint.x - sample.x) * sample.zoom + camera.outputWidth / 2),
    y: normalizeZero((stagePoint.y - sample.y) * sample.zoom + camera.outputHeight / 2),
  };
}

function checkCameraBounds(errors, label, camera, stage, sample) {
  const rect = cameraViewportRect(camera, sample);
  if (
    rect.left < -EPS ||
    rect.top < -EPS ||
    rect.right > stage.width + EPS ||
    rect.bottom > stage.height + EPS
  ) {
    errors.push(
      `${label}: visible camera rect [${rect.left.toFixed(2)}..${rect.right.toFixed(2)}, ${rect.top.toFixed(2)}..${rect.bottom.toFixed(2)}] leaves stage [0..${stage.width}, 0..${stage.height}]`
    );
  }
}

function isValidCameraFocusSpec(focus) {
  if (STEP_CAMERA_FOCUSES.includes(focus)) return true;
  if (Array.isArray(focus) && focus.length === 2 && focus.every(isFiniteNumber)) return true;
  if (isObject(focus) && isFiniteNumber(focus.x) && isFiniteNumber(focus.y)) return true;
  return false;
}

/** Validate a per-step declarative `camera` hint (`'wide'` or `{ zoom, focus?, easing?, lead?, hold?, clampToWindow? }`). */
export function validateStepCameraHint(camera, label = 'camera') {
  const errors = [];
  if (camera === 'wide') {
    return { ok: true, errors };
  }
  if (!isObject(camera)) {
    errors.push(`${label} must be "wide" or an object`);
    return { ok: false, errors };
  }
  const focusVal = camera.focus ?? camera.target;
  if (camera.zoom === undefined) {
    if (focusVal !== 'window') {
      errors.push(`${label}.zoom must be a positive finite number`);
    }
  } else if (!isPositiveNumber(camera.zoom)) {
    errors.push(`${label}.zoom must be a positive finite number`);
  }
  if (camera.focus !== undefined && !isValidCameraFocusSpec(camera.focus)) {
    errors.push(`${label}.focus must be "target", "pointer", "window", or [vx, vy]`);
  }
  if (camera.target !== undefined && !isValidCameraFocusSpec(camera.target)) {
    errors.push(`${label}.target must be "target", "pointer", "window", or [vx, vy]`);
  }
  if (camera.easing !== undefined) {
    const normalized = EASING_ALIASES[camera.easing] ?? camera.easing;
    if (!CAMERA_EASINGS.includes(normalized)) {
      errors.push(`${label}.easing must be one of ${CAMERA_EASINGS.join(', ')}`);
    }
  }
  if (camera.lead !== undefined && !isNonNegativeNumber(camera.lead)) {
    errors.push(`${label}.lead must be a non-negative finite number`);
  }
  if (camera.hold !== undefined && !isNonNegativeNumber(camera.hold)) {
    errors.push(`${label}.hold must be a non-negative finite number`);
  }
  if (camera.clampToWindow !== undefined && typeof camera.clampToWindow !== 'boolean') {
    errors.push(`${label}.clampToWindow must be a boolean`);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate an Event Track v1 object and return `{ ok, errors }`. */
export function validateEventTrack(eventTrack) {
  const errors = [];
  if (!isObject(eventTrack)) {
    return { ok: false, errors: ['eventTrack must be an object'] };
  }
  if (eventTrack.version !== EVENT_TRACK_VERSION) {
    errors.push(`eventTrack.version must be ${EVENT_TRACK_VERSION}`);
  }
  if (eventTrack.captureMode !== undefined && !CAPTURE_MODES.includes(eventTrack.captureMode)) {
    errors.push(`Invalid capture mode: eventTrack.captureMode must be one of ${CAPTURE_MODES.join(', ')}`);
  }
  if (
    eventTrack.startedAt !== undefined &&
    (typeof eventTrack.startedAt !== 'string' || Number.isNaN(Date.parse(eventTrack.startedAt)))
  ) {
    errors.push('eventTrack.startedAt must be a valid ISO timestamp');
  }
  if (eventTrack.viewport !== undefined) {
    if (!isObject(eventTrack.viewport)) {
      errors.push('eventTrack.viewport must be an object');
    } else {
      if (!isPositiveNumber(eventTrack.viewport.width)) errors.push('eventTrack.viewport.width must be a positive number');
      if (!isPositiveNumber(eventTrack.viewport.height)) errors.push('eventTrack.viewport.height must be a positive number');
      if (!isPositiveNumber(eventTrack.viewport.deviceScaleFactor)) {
        errors.push('eventTrack.viewport.deviceScaleFactor must be a positive number');
      }
    }
  }
  if (eventTrack.video !== undefined) {
    if (!isObject(eventTrack.video)) {
      errors.push('eventTrack.video must be an object');
    } else {
      if (eventTrack.video.file !== undefined && !isNonEmptyString(eventTrack.video.file)) {
        errors.push('eventTrack.video.file must be a non-empty string');
      }
      if (eventTrack.video.width !== undefined && !isPositiveInteger(eventTrack.video.width)) {
        errors.push('eventTrack.video.width must be a positive integer');
      }
      if (eventTrack.video.height !== undefined && !isPositiveInteger(eventTrack.video.height)) {
        errors.push('eventTrack.video.height must be a positive integer');
      }
      if (eventTrack.video.fps !== undefined && !isPositiveNumber(eventTrack.video.fps)) {
        errors.push('eventTrack.video.fps must be a positive number');
      }
      if (eventTrack.video.encodedFps !== undefined && !isPositiveNumber(eventTrack.video.encodedFps)) {
        errors.push('eventTrack.video.encodedFps must be a positive number');
      }
      if (eventTrack.video.duration !== undefined && !isPositiveNumber(eventTrack.video.duration)) {
        errors.push('eventTrack.video.duration must be a positive number');
      }
      if (eventTrack.video.frames !== undefined && !isPositiveInteger(eventTrack.video.frames)) {
        errors.push('eventTrack.video.frames must be a positive integer');
      }
      if (eventTrack.video.capture !== undefined) {
        const cap = eventTrack.video.capture;
        if (!isObject(cap)) {
          errors.push('eventTrack.video.capture must be an object');
        } else {
          if (cap.rawFrames !== undefined && !isNonNegativeInteger(cap.rawFrames)) {
            errors.push('eventTrack.video.capture.rawFrames must be a non-negative integer');
          }
          if (cap.firstFrameAt !== undefined && cap.firstFrameAt !== null && !isNonNegativeNumber(cap.firstFrameAt)) {
            errors.push('eventTrack.video.capture.firstFrameAt must be null or a non-negative number');
          }
          if (cap.lastFrameAt !== undefined && cap.lastFrameAt !== null && !isNonNegativeNumber(cap.lastFrameAt)) {
            errors.push('eventTrack.video.capture.lastFrameAt must be null or a non-negative number');
          }
          if (cap.elapsedDuration !== undefined && !isNonNegativeNumber(cap.elapsedDuration)) {
            errors.push('eventTrack.video.capture.elapsedDuration must be a non-negative number');
          }
          if (cap.rawFps !== undefined && !isNonNegativeNumber(cap.rawFps)) {
            errors.push('eventTrack.video.capture.rawFps must be a non-negative number');
          }
          if (cap.maxGapMs !== undefined && !isNonNegativeNumber(cap.maxGapMs)) {
            errors.push('eventTrack.video.capture.maxGapMs must be a non-negative number');
          }
          if (cap.gapsOver2Frames !== undefined && !isNonNegativeInteger(cap.gapsOver2Frames)) {
            errors.push('eventTrack.video.capture.gapsOver2Frames must be a non-negative integer');
          }
          if (
            cap.activeMotionGapsOver2Frames !== undefined &&
            !isNonNegativeInteger(cap.activeMotionGapsOver2Frames)
          ) {
            errors.push(
              'eventTrack.video.capture.activeMotionGapsOver2Frames must be a non-negative integer'
            );
          }
          if (cap.activeMotionMaxGapMs !== undefined && !isNonNegativeNumber(cap.activeMotionMaxGapMs)) {
            errors.push('eventTrack.video.capture.activeMotionMaxGapMs must be a non-negative number');
          }
          if (cap.activeMotionWindows !== undefined) {
            if (!Array.isArray(cap.activeMotionWindows)) {
              errors.push('eventTrack.video.capture.activeMotionWindows must be an array');
            } else {
              cap.activeMotionWindows.forEach((win, wi) => {
                const validTuple =
                  Array.isArray(win) &&
                  win.length === 2 &&
                  isNonNegativeNumber(win[0]) &&
                  isNonNegativeNumber(win[1]) &&
                  win[1] >= win[0];
                const validObj =
                  isObject(win) &&
                  isNonNegativeNumber(win.start) &&
                  isNonNegativeNumber(win.end) &&
                  win.end >= win.start;
                if (!validTuple && !validObj) {
                  errors.push(
                    `eventTrack.video.capture.activeMotionWindows[${wi}] must be { start, end } with 0 <= start <= end`
                  );
                }
              });
            }
          }
          if (cap.truncated !== undefined && typeof cap.truncated !== 'boolean') {
            errors.push('eventTrack.video.capture.truncated must be a boolean');
          }
          if (cap.durationExceeded !== undefined && typeof cap.durationExceeded !== 'boolean') {
            errors.push('eventTrack.video.capture.durationExceeded must be a boolean');
          }
        }
      }
    }
  }

  if (!Array.isArray(eventTrack.events)) {
    errors.push('eventTrack.events must be an array');
    return { ok: errors.length === 0, errors };
  }

  let prevT = 0;
  eventTrack.events.forEach((event, index) => {
    const prefix = `eventTrack.events[${index}]`;
    if (!isObject(event)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!isNonNegativeNumber(event.t)) {
      errors.push(`${prefix}.t must be a finite number >= 0`);
    } else {
      if (index > 0 && event.t < prevT) {
        errors.push(`${prefix}.t (${event.t}) must be monotonically non-decreasing (previous ${prevT})`);
      }
      prevT = event.t;
    }
    if (!EVENT_TYPES.has(event.type)) {
      errors.push(`${prefix}.type must be one of ${[...EVENT_TYPES].join(', ')}`);
      return;
    }

    switch (event.type) {
      case 'pointermove':
      case 'pointerdown':
      case 'pointerup':
        if (!isFiniteNumber(event.x) || !isFiniteNumber(event.y)) {
          errors.push(`${prefix} (${event.type}) requires finite x and y`);
        }
        if (event.button !== undefined && !MOUSE_BUTTONS.includes(event.button)) {
          errors.push(`${prefix}.button must be a valid button (${MOUSE_BUTTONS.join(', ')})`);
        }
        if (
          (event.type === 'pointerdown' || event.type === 'pointerup') &&
          event.modifiers !== undefined
        ) {
          if (
            !Array.isArray(event.modifiers) ||
            event.modifiers.some((mod) => !VALID_MODIFIERS.has(mod))
          ) {
            errors.push(
              `${prefix}.modifiers must be an array of canonical modifiers (${[...VALID_MODIFIERS].join(', ')})`
            );
          }
        }
        break;
      case 'wheel':
        if (!isFiniteNumber(event.x) || !isFiniteNumber(event.y)) {
          errors.push(`${prefix} (wheel) requires finite x and y`);
        }
        if (!isFiniteNumber(event.deltaX) || !isFiniteNumber(event.deltaY)) {
          errors.push(`${prefix} (wheel) requires finite deltaX and deltaY`);
        }
        if (event.phase !== undefined && !WHEEL_PHASES.has(event.phase)) {
          errors.push(`${prefix}.phase must be one of ${[...WHEEL_PHASES].join(', ')}`);
        }
        if (event.duration !== undefined && !isNonNegativeNumber(event.duration)) {
          errors.push(`${prefix}.duration must be a non-negative number`);
        }
        break;
      case 'gesture':
        if (!GESTURE_KINDS.includes(event.kind)) {
          errors.push(`${prefix}.kind must be one of ${GESTURE_KINDS.join(', ')}`);
        }
        if (!isFiniteNumber(event.x) || !isFiniteNumber(event.y)) {
          errors.push(`${prefix} (gesture) requires finite x and y`);
        }
        if (event.deltaX !== undefined && !isFiniteNumber(event.deltaX)) {
          errors.push(`${prefix}.deltaX must be a finite number`);
        }
        if (event.deltaY !== undefined && !isFiniteNumber(event.deltaY)) {
          errors.push(`${prefix}.deltaY must be a finite number`);
        }
        if (event.duration !== undefined && !isNonNegativeNumber(event.duration)) {
          errors.push(`${prefix}.duration must be a non-negative number`);
        }
        break;
      case 'drag':
        if (!Array.isArray(event.from) || event.from.length !== 2 || !event.from.every(isFiniteNumber)) {
          errors.push(`${prefix} (drag) .from must be a [x, y] pair of finite numbers`);
        }
        if (!Array.isArray(event.to) || event.to.length !== 2 || !event.to.every(isFiniteNumber)) {
          errors.push(`${prefix} (drag) .to must be a [x, y] pair of finite numbers`);
        }
        if (!isNonNegativeNumber(event.duration)) {
          errors.push(`${prefix} (drag) .duration must be a non-negative finite number`);
        }
        if (event.button !== undefined && !MOUSE_BUTTONS.includes(event.button)) {
          errors.push(`${prefix} (drag) .button must be a valid button (${MOUSE_BUTTONS.join(', ')})`);
        }
        break;
      case 'key':
        if (
          typeof event.key !== 'string' ||
          event.key.length === 0 ||
          (event.key !== ' ' && event.key.trim().length === 0)
        ) {
          errors.push(`${prefix}.key must be a non-empty string`);
        }
        if (event.modifiers !== undefined) {
          if (
            !Array.isArray(event.modifiers) ||
            event.modifiers.some((mod) => !VALID_MODIFIERS.has(mod))
          ) {
            errors.push(
              `${prefix}.modifiers must be an array of canonical modifiers (${[...VALID_MODIFIERS].join(', ')})`
            );
          }
        }
        if (event.action !== undefined && !KEY_ACTIONS.has(event.action)) {
          errors.push(`${prefix}.action must be one of ${[...KEY_ACTIONS].join(', ')}`);
        }
        if (event.duration !== undefined && !isNonNegativeNumber(event.duration)) {
          errors.push(`${prefix}.duration must be a non-negative number`);
        }
        if (event.typing !== undefined && typeof event.typing !== 'boolean') {
          errors.push(`${prefix}.typing must be a boolean`);
        }
        break;
      case 'step':
        if (!isNonNegativeInteger(event.index)) {
          errors.push(`${prefix}.index must be a non-negative integer`);
        }
        if (event.label !== undefined && typeof event.label !== 'string') {
          errors.push(`${prefix}.label must be a string when provided`);
        }
        if (event.target !== undefined) {
          if (
            !Array.isArray(event.target) ||
            event.target.length !== 2 ||
            !event.target.every(isFiniteNumber)
          ) {
            errors.push(`${prefix}.target must be a [vx, vy] pair of finite numbers`);
          }
        }
        if (event.camera !== undefined) {
          const camCheck = validateStepCameraHint(event.camera, `${prefix}.camera`);
          for (const err of camCheck.errors) errors.push(err);
        }
        break;
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a `timeline.json` v1 structure, timestamps, dimensions, frame types, and strict
 * camera bounds inside the stage across both keyframes and interpolated samples.
 * Never throws; returns `{ ok, errors }`.
 */
export function validateTimeline(timeline) {
  const errors = [];
  if (!isObject(timeline)) {
    return { ok: false, errors: ['timeline must be an object'] };
  }
  if (timeline.version !== TIMELINE_VERSION) {
    errors.push(`timeline.version must be ${TIMELINE_VERSION}`);
  }

  // take
  if (!isObject(timeline.take)) {
    errors.push('timeline.take must be an object');
  } else {
    const { take } = timeline;
    if (!isNonEmptyString(take.video)) errors.push('timeline.take.video must be a non-empty string');
    if (!isNonEmptyString(take.eventTrack)) errors.push('timeline.take.eventTrack must be a non-empty string');
    if (!isPositiveInteger(take.width)) errors.push('timeline.take.width must be a positive integer');
    if (!isPositiveInteger(take.height)) errors.push('timeline.take.height must be a positive integer');
    if (!isPositiveNumber(take.fps)) errors.push('timeline.take.fps must be a positive number');
    if (!isPositiveNumber(take.duration)) errors.push('timeline.take.duration must be a positive number');
    if (!isPositiveInteger(take.frames)) errors.push('timeline.take.frames must be a positive integer');
    if (!CAPTURE_MODES.includes(take.captureMode)) {
      errors.push(`timeline.take.captureMode must be one of ${CAPTURE_MODES.join(', ')}`);
    }
    if (!isObject(take.viewport)) {
      errors.push('timeline.take.viewport must be an object');
    } else {
      if (!isPositiveNumber(take.viewport.width)) errors.push('timeline.take.viewport.width must be a positive number');
      if (!isPositiveNumber(take.viewport.height)) errors.push('timeline.take.viewport.height must be a positive number');
      if (!isPositiveNumber(take.viewport.deviceScaleFactor)) {
        errors.push('timeline.take.viewport.deviceScaleFactor must be a positive number');
      }
    }
  }

  // stage
  let stageValidDimensions = false;
  if (!isObject(timeline.stage)) {
    errors.push('timeline.stage must be an object');
  } else {
    const { stage } = timeline;
    const widthOk = isPositiveNumber(stage.width);
    const heightOk = isPositiveNumber(stage.height);
    if (!widthOk) errors.push('timeline.stage.width must be a positive number');
    if (!heightOk) errors.push('timeline.stage.height must be a positive number');
    stageValidDimensions = widthOk && heightOk;

    if (!isNonNegativeNumber(stage.padding)) {
      errors.push('timeline.stage.padding must be a non-negative number');
    }
    if (!isObject(stage.background)) {
      errors.push('timeline.stage.background must be an object');
    } else {
      const bg = stage.background;
      if (!BACKGROUND_TYPES.includes(bg.type)) {
        errors.push(`timeline.stage.background.type must be one of ${BACKGROUND_TYPES.join(', ')}`);
      } else if (bg.type === 'solid') {
        if (!isNonEmptyString(bg.color)) errors.push('timeline.stage.background.color must be a non-empty string');
      } else if (bg.type === 'gradient') {
        if (bg.angle !== undefined && !isFiniteNumber(bg.angle)) {
          errors.push('timeline.stage.background.angle must be a finite number');
        }
        if (!Array.isArray(bg.stops) || bg.stops.length < 2) {
          errors.push('timeline.stage.background.stops must be an array of at least 2 color stops');
        } else {
          let prevOffset = 0;
          bg.stops.forEach((stop, i) => {
            if (!isObject(stop)) {
              errors.push(`timeline.stage.background.stops[${i}] must be an object`);
              return;
            }
            if (!isNonEmptyString(stop.color)) {
              errors.push(`timeline.stage.background.stops[${i}].color must be a non-empty string`);
            }
            if (!isFiniteNumber(stop.offset) || stop.offset < 0 || stop.offset > 1) {
              errors.push(`timeline.stage.background.stops[${i}].offset must be between 0 and 1`);
            } else {
              if (i > 0 && stop.offset < prevOffset) {
                errors.push(`timeline.stage.background.stops[${i}].offset must be monotonically non-decreasing`);
              }
              prevOffset = stop.offset;
            }
          });
        }
      } else if (bg.type === 'image') {
        if (!isNonEmptyString(bg.src)) errors.push('timeline.stage.background.src must be a non-empty string');
        if (bg.fit !== undefined && !IMAGE_FITS.includes(bg.fit)) {
          errors.push(`timeline.stage.background.fit must be one of ${IMAGE_FITS.join(', ')}`);
        }
      }
    }
  }

  // window
  if (!isObject(timeline.window)) {
    errors.push('timeline.window must be an object');
  } else {
    const win = timeline.window;
    if (!WINDOW_FRAMES.includes(win.frame)) {
      errors.push(`timeline.window.frame must be one of ${WINDOW_FRAMES.join(', ')}`);
    }
    if (win.title !== undefined && typeof win.title !== 'string') {
      errors.push('timeline.window.title must be a string');
    }
    const xOk = isNonNegativeNumber(win.x);
    const yOk = isNonNegativeNumber(win.y);
    const wOk = isPositiveNumber(win.width);
    const hOk = isPositiveNumber(win.height);
    if (!xOk) errors.push('timeline.window.x must be a non-negative number');
    if (!yOk) errors.push('timeline.window.y must be a non-negative number');
    if (!wOk) errors.push('timeline.window.width must be a positive number');
    if (!hOk) errors.push('timeline.window.height must be a positive number');
    if (stageValidDimensions && xOk && yOk && wOk && hOk) {
      if (win.x + win.width > timeline.stage.width + EPS || win.y + win.height > timeline.stage.height + EPS) {
        errors.push(
          `timeline.window [${win.x}..${win.x + win.width}, ${win.y}..${win.y + win.height}] exceeds stage [0..${timeline.stage.width}, 0..${timeline.stage.height}]`
        );
      }
    }
    if (win.borderRadius !== undefined && !isNonNegativeNumber(win.borderRadius)) {
      errors.push('timeline.window.borderRadius must be a non-negative number');
    }
    if (win.shadow !== undefined && typeof win.shadow !== 'boolean') {
      errors.push('timeline.window.shadow must be a boolean');
    }
  }

  // camera
  if (!isObject(timeline.camera)) {
    errors.push('timeline.camera must be an object');
  } else {
    const { camera } = timeline;
    const outWOk = isPositiveNumber(camera.outputWidth);
    const outHOk = isPositiveNumber(camera.outputHeight);
    if (!outWOk) errors.push('timeline.camera.outputWidth must be a positive number');
    if (!outHOk) errors.push('timeline.camera.outputHeight must be a positive number');
    if (stageValidDimensions && outWOk && outHOk) {
      if (timeline.stage.width + EPS < camera.outputWidth || timeline.stage.height + EPS < camera.outputHeight) {
        errors.push(
          `timeline.stage (${timeline.stage.width}x${timeline.stage.height}) must be larger than or equal to camera output (${camera.outputWidth}x${camera.outputHeight})`
        );
      }
    }

    if (!Array.isArray(camera.keyframes) || camera.keyframes.length === 0) {
      errors.push('timeline.camera.keyframes must be a non-empty array');
    } else {
      let keyframesStructurallyValid = true;
      let prevT = 0;
      camera.keyframes.forEach((kf, index) => {
        const prefix = `timeline.camera.keyframes[${index}]`;
        if (!isObject(kf)) {
          errors.push(`${prefix} must be an object`);
          keyframesStructurallyValid = false;
          return;
        }
        const tOk = isNonNegativeNumber(kf.t);
        const xOk = isFiniteNumber(kf.x);
        const yOk = isFiniteNumber(kf.y);
        const zoomOk = isPositiveNumber(kf.zoom);
        const easingOk = CAMERA_EASINGS.includes(kf.easing);

        if (!tOk) errors.push(`${prefix}.t must be a non-negative finite number`);
        else {
          if (index > 0 && kf.t < prevT) {
            errors.push(`${prefix}.t (${kf.t}) must be monotonically non-decreasing (previous ${prevT})`);
            keyframesStructurallyValid = false;
          }
          prevT = kf.t;
        }
        if (!xOk) errors.push(`${prefix}.x must be a finite number`);
        if (!yOk) errors.push(`${prefix}.y must be a finite number`);
        if (!zoomOk) errors.push(`${prefix}.zoom must be a positive finite number`);
        if (!easingOk) errors.push(`${prefix}.easing must be one of ${CAMERA_EASINGS.join(', ')}`);

        if (!(tOk && xOk && yOk && zoomOk && easingOk)) {
          keyframesStructurallyValid = false;
          return;
        }

        if (stageValidDimensions && outWOk && outHOk) {
          checkCameraBounds(errors, `${prefix} (t=${kf.t})`, camera, timeline.stage, kf);
        }
      });

      if (keyframesStructurallyValid && stageValidDimensions && outWOk && outHOk) {
        for (let i = 0; i + 1 < camera.keyframes.length; i += 1) {
          const from = camera.keyframes[i];
          const to = camera.keyframes[i + 1];
          if (to.t <= from.t) continue;
          for (let step = 1; step < BOUND_SAMPLE_SUBDIVISIONS; step += 1) {
            const t = from.t + ((to.t - from.t) * step) / BOUND_SAMPLE_SUBDIVISIONS;
            const sample = sampleCamera(camera, t);
            checkCameraBounds(
              errors,
              `timeline.camera segment ${i}->${i + 1} (t=${t.toFixed(4)})`,
              camera,
              timeline.stage,
              sample
            );
          }
        }
      }
    }
  }

  // overlays
  if (!isObject(timeline.overlays)) {
    errors.push('timeline.overlays must be an object');
  } else {
    const { overlays } = timeline;

    // cursor
    if (!isObject(overlays.cursor)) {
      errors.push('timeline.overlays.cursor must be an object');
    } else {
      const { cursor } = overlays;
      if (typeof cursor.enabled !== 'boolean') errors.push('timeline.overlays.cursor.enabled must be a boolean');
      if (!CURSOR_STYLES.includes(cursor.style)) {
        errors.push(`timeline.overlays.cursor.style must be one of ${CURSOR_STYLES.join(', ')}`);
      }
      if (!Array.isArray(cursor.samples)) {
        errors.push('timeline.overlays.cursor.samples must be an array');
      } else {
        let prevT = 0;
        cursor.samples.forEach((sample, i) => {
          const prefix = `timeline.overlays.cursor.samples[${i}]`;
          if (!isObject(sample)) {
            errors.push(`${prefix} must be an object`);
            return;
          }
          if (!isNonNegativeNumber(sample.t)) errors.push(`${prefix}.t must be a non-negative finite number`);
          else {
            if (i > 0 && sample.t < prevT) {
              errors.push(`${prefix}.t (${sample.t}) must be monotonically non-decreasing (previous ${prevT})`);
            }
            prevT = sample.t;
          }
          if (!isFiniteNumber(sample.x) || !isFiniteNumber(sample.y)) {
            errors.push(`${prefix} requires finite x and y`);
          }
          if (typeof sample.pressed !== 'boolean') errors.push(`${prefix}.pressed must be a boolean`);
          if (typeof sample.visible !== 'boolean') errors.push(`${prefix}.visible must be a boolean`);
        });
      }
    }

    // ripples
    if (!Array.isArray(overlays.ripples)) {
      errors.push('timeline.overlays.ripples must be an array');
    } else {
      let prevT = 0;
      overlays.ripples.forEach((ripple, i) => {
        const prefix = `timeline.overlays.ripples[${i}]`;
        if (!isObject(ripple)) {
          errors.push(`${prefix} must be an object`);
          return;
        }
        if (!isNonNegativeNumber(ripple.t)) errors.push(`${prefix}.t must be a non-negative finite number`);
        else {
          if (i > 0 && ripple.t < prevT) {
            errors.push(`${prefix}.t (${ripple.t}) must be monotonically non-decreasing (previous ${prevT})`);
          }
          prevT = ripple.t;
        }
        if (!isFiniteNumber(ripple.x) || !isFiniteNumber(ripple.y)) {
          errors.push(`${prefix} requires finite x and y`);
        }
        if (!MOUSE_BUTTONS.includes(ripple.button)) {
          errors.push(`${prefix}.button must be one of ${MOUSE_BUTTONS.join(', ')}`);
        }
        if (!isPositiveNumber(ripple.duration)) errors.push(`${prefix}.duration must be a positive number`);
      });
    }

    // gestures
    if (!Array.isArray(overlays.gestures)) {
      errors.push('timeline.overlays.gestures must be an array');
    } else {
      let prevT = 0;
      overlays.gestures.forEach((gesture, i) => {
        const prefix = `timeline.overlays.gestures[${i}]`;
        if (!isObject(gesture)) {
          errors.push(`${prefix} must be an object`);
          return;
        }
        if (!isNonNegativeNumber(gesture.t)) errors.push(`${prefix}.t must be a non-negative finite number`);
        else {
          if (i > 0 && gesture.t < prevT) {
            errors.push(`${prefix}.t (${gesture.t}) must be monotonically non-decreasing (previous ${prevT})`);
          }
          prevT = gesture.t;
        }
        if (!GESTURE_KINDS.includes(gesture.kind)) {
          errors.push(`${prefix}.kind must be one of ${GESTURE_KINDS.join(', ')}`);
        }
        if (!isFiniteNumber(gesture.x) || !isFiniteNumber(gesture.y)) {
          errors.push(`${prefix} requires finite x and y`);
        }
        if (!isFiniteNumber(gesture.deltaX) || !isFiniteNumber(gesture.deltaY)) {
          errors.push(`${prefix} requires finite deltaX and deltaY`);
        }
        if (!isPositiveNumber(gesture.duration)) errors.push(`${prefix}.duration must be a positive number`);
      });
    }

    // keystrokes
    if (!Array.isArray(overlays.keystrokes)) {
      errors.push('timeline.overlays.keystrokes must be an array');
    } else {
      let prevT = 0;
      overlays.keystrokes.forEach((ks, i) => {
        const prefix = `timeline.overlays.keystrokes[${i}]`;
        if (!isObject(ks)) {
          errors.push(`${prefix} must be an object`);
          return;
        }
        if (!isNonNegativeNumber(ks.t)) errors.push(`${prefix}.t must be a non-negative finite number`);
        else {
          if (i > 0 && ks.t < prevT) {
            errors.push(`${prefix}.t (${ks.t}) must be monotonically non-decreasing (previous ${prevT})`);
          }
          prevT = ks.t;
        }
        if (!isNonEmptyString(ks.label)) errors.push(`${prefix}.label must be a non-empty string`);
        if (!Array.isArray(ks.keys) || ks.keys.length === 0 || !ks.keys.every(isNonEmptyString)) {
          errors.push(`${prefix}.keys must be a non-empty array of non-empty strings`);
        }
        if (!isPositiveNumber(ks.duration)) errors.push(`${prefix}.duration must be a positive number`);
      });
    }

    // captions
    if (!isObject(overlays.captions)) {
      errors.push('timeline.overlays.captions must be an object');
    } else {
      if (typeof overlays.captions.enabled !== 'boolean') {
        errors.push('timeline.overlays.captions.enabled must be a boolean');
      }
      if (!Array.isArray(overlays.captions.tracks)) {
        errors.push('timeline.overlays.captions.tracks must be an array');
      } else {
        overlays.captions.tracks.forEach((track, i) => {
          const prefix = `timeline.overlays.captions.tracks[${i}]`;
          if (!isObject(track)) {
            errors.push(`${prefix} must be an object`);
            return;
          }
          if (!isNonEmptyString(track.language)) errors.push(`${prefix}.language must be a non-empty string`);
          if (!Array.isArray(track.cues)) {
            errors.push(`${prefix}.cues must be an array`);
          } else {
            let prevStart = 0;
            track.cues.forEach((cue, j) => {
              const cuePrefix = `${prefix}.cues[${j}]`;
              if (!isObject(cue)) {
                errors.push(`${cuePrefix} must be an object`);
                return;
              }
              if (!isNonNegativeNumber(cue.start)) errors.push(`${cuePrefix}.start must be a non-negative number`);
              else {
                if (j > 0 && cue.start < prevStart) {
                  errors.push(`${cuePrefix}.start must be monotonically non-decreasing`);
                }
                prevStart = cue.start;
              }
              if (!isNonNegativeNumber(cue.end) || (isNonNegativeNumber(cue.start) && cue.end < cue.start)) {
                errors.push(`${cuePrefix}.end must be >= start`);
              }
              if (typeof cue.text !== 'string') errors.push(`${cuePrefix}.text must be a string`);
            });
          }
        });
      }
    }
  }

  // audio
  if (!isObject(timeline.audio)) {
    errors.push('timeline.audio must be an object');
  } else if (!Array.isArray(timeline.audio.tracks)) {
    errors.push('timeline.audio.tracks must be an array');
  } else {
    timeline.audio.tracks.forEach((track, i) => {
      const prefix = `timeline.audio.tracks[${i}]`;
      if (!isObject(track)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!isNonEmptyString(track.id)) errors.push(`${prefix}.id must be a non-empty string`);
      if (!AUDIO_TRACK_KINDS.includes(track.kind)) {
        errors.push(`${prefix}.kind must be one of ${AUDIO_TRACK_KINDS.join(', ')}`);
      }
      if (!isNonEmptyString(track.src)) errors.push(`${prefix}.src must be a non-empty string`);
      if (!isNonNegativeNumber(track.start)) errors.push(`${prefix}.start must be a non-negative number`);
      if (track.volume !== undefined && (!isNonNegativeNumber(track.volume) || track.volume > 2)) {
        errors.push(`${prefix}.volume must be between 0 and 2`);
      }
    });
  }

  // outputs
  if (!Array.isArray(timeline.outputs) || timeline.outputs.length === 0) {
    errors.push('timeline.outputs must be a non-empty array');
  } else {
    const seenIds = new Set();
    timeline.outputs.forEach((output, i) => {
      const prefix = `timeline.outputs[${i}]`;
      if (!isObject(output)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!isNonEmptyString(output.id)) {
        errors.push(`${prefix}.id must be a non-empty string`);
      } else if (seenIds.has(output.id)) {
        errors.push(`${prefix}.id (${output.id}) must be unique`);
      } else {
        seenIds.add(output.id);
      }
      if (!OUTPUT_FORMATS.includes(output.format)) {
        errors.push(`${prefix}.format must be one of ${OUTPUT_FORMATS.join(', ')}`);
      }
      if (!isPositiveInteger(output.width)) errors.push(`${prefix}.width must be a positive integer`);
      if (!isPositiveInteger(output.height)) errors.push(`${prefix}.height must be a positive integer`);
      if (!isPositiveNumber(output.fps)) errors.push(`${prefix}.fps must be a positive number`);
      if (output.codec !== undefined && !isNonEmptyString(output.codec)) {
        errors.push(`${prefix}.codec must be a non-empty string`);
      }
      if (output.loop !== undefined && typeof output.loop !== 'boolean') {
        errors.push(`${prefix}.loop must be a boolean`);
      }
      if (output.poster !== undefined && typeof output.poster !== 'boolean') {
        errors.push(`${prefix}.poster must be a boolean`);
      }
    });
  }

  // optional steps
  if (timeline.steps !== undefined) {
    if (!Array.isArray(timeline.steps)) {
      errors.push('timeline.steps must be an array');
    } else {
      let prevT = 0;
      timeline.steps.forEach((step, i) => {
        const prefix = `timeline.steps[${i}]`;
        if (!isObject(step)) {
          errors.push(`${prefix} must be an object`);
          return;
        }
        if (!isNonNegativeNumber(step.t)) errors.push(`${prefix}.t must be a non-negative finite number`);
        else {
          if (i > 0 && step.t < prevT) {
            errors.push(`${prefix}.t (${step.t}) must be monotonically non-decreasing (previous ${prevT})`);
          }
          prevT = step.t;
        }
        if (!isNonNegativeInteger(step.index)) errors.push(`${prefix}.index must be a non-negative integer`);
        if (!isNonEmptyString(step.label)) errors.push(`${prefix}.label must be a non-empty string`);
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Assert that `timeline` passes `validateTimeline`; throws a clear Error listing all violations. */
export function assertValidTimeline(timeline) {
  const result = validateTimeline(timeline);
  if (!result.ok) {
    throw Error(`Invalid timeline:\n- ${result.errors.join('\n- ')}`);
  }
  return timeline;
}

function formatKeystrokeLabel(modifiers, key) {
  const formattedKey =
    KEY_LABELS[key] ?? (key.length === 1 && /[a-z]/.test(key) ? key.toUpperCase() : key);
  if (modifiers.length === 0) return formattedKey;
  const parts = modifiers.map((mod) => MODIFIER_SYMBOLS[mod] ?? mod);
  const allSymbols = parts.every((part) => Object.values(MODIFIER_SYMBOLS).includes(part));
  return allSymbols ? `${parts.join('')}${formattedKey}` : `${parts.join('+')}+${formattedKey}`;
}

function formatModifiedClickLabel(modifiers) {
  const parts = modifiers.map((mod) => MODIFIER_SYMBOLS[mod] ?? mod);
  const allSymbols = parts.every((part) => Object.values(MODIFIER_SYMBOLS).includes(part));
  return allSymbols ? `${parts.join('')} Click` : `${parts.join('+')}+Click`;
}

function isSuppressedTypingKey(event) {
  if (event.typing === true) return true;
  const modifiers = event.modifiers ?? [];
  if (modifiers.length > 0) return false;
  const key = event.key;
  if (typeof key !== 'string' || Object.hasOwn(KEY_LABELS, key)) return false;
  const codePoints = [...key];
  return codePoints.length === 1 && !/^\p{Cc}$/u.test(key);
}

function normalizeBackground(background) {
  if (!background) {
    return { type: 'solid', color: '#0f172a' };
  }
  if (!isObject(background)) {
    throw Error('recipe.stage.background must be an object');
  }
  if (background.type === 'solid') {
    return { type: 'solid', color: background.color };
  }
  if (background.type === 'gradient') {
    return {
      type: 'gradient',
      angle: background.angle ?? 135,
      stops: Array.isArray(background.stops)
        ? background.stops.map((stop) => ({ color: stop?.color, offset: stop?.offset }))
        : background.stops,
    };
  }
  if (background.type === 'image') {
    return {
      type: 'image',
      src: background.src,
      fit: background.fit ?? 'cover',
    };
  }
  return { ...background };
}

function normalizeEasing(easing, fallback) {
  if (easing === undefined) return fallback;
  return EASING_ALIASES[easing] ?? easing;
}

function buildOutputProfiles(recipeOutputs, camera, take) {
  const presets = {
    'web-loop': {
      id: 'web-loop',
      format: 'webm',
      codec: 'vp9',
      width: Math.round(camera.outputWidth),
      height: Math.round(camera.outputHeight),
      fps: take.fps,
      loop: true,
      poster: true,
    },
    'youtube-master': {
      id: 'youtube-master',
      format: 'mp4',
      codec: 'h264',
      width: 2560,
      height: 1440,
      fps: Math.max(take.fps, 60),
      loop: false,
      poster: false,
    },
  };

  const requested = recipeOutputs ?? ['web-loop', 'youtube-master'];
  if (!Array.isArray(requested)) {
    throw Error('recipe.outputs must be an array of profile names or output specs');
  }
  return requested.map((entry) => {
    if (typeof entry === 'string') {
      const preset = presets[entry];
      if (!preset) throw Error(`Unknown output profile preset: ${entry}`);
      return { ...preset };
    }
    if (!isObject(entry)) {
      throw Error('Each entry in recipe.outputs must be a preset name or object');
    }
    const base = entry.preset && presets[entry.preset] ? presets[entry.preset] : {};
    const profile = {
      ...base,
      id: entry.id ?? base.id,
      format: entry.format ?? base.format,
      ...(entry.codec !== undefined || base.codec !== undefined ? { codec: entry.codec ?? base.codec } : {}),
      width: entry.width ?? base.width ?? Math.round(camera.outputWidth),
      height: entry.height ?? base.height ?? Math.round(camera.outputHeight),
      fps: entry.fps ?? base.fps ?? take.fps,
      ...(entry.loop !== undefined || base.loop !== undefined ? { loop: entry.loop ?? base.loop } : {}),
      ...(entry.poster !== undefined || base.poster !== undefined ? { poster: entry.poster ?? base.poster } : {}),
    };
    return profile;
  });
}

function hasTrackedDragRelease(events, dragIndex, dragStartT, dragEndT, pointerAlreadyDown) {
  let sawDragDown = pointerAlreadyDown;
  for (let j = dragIndex + 1; j < events.length; j += 1) {
    const other = events[j];
    if (!isObject(other) || !isFiniteNumber(other.t)) continue;
    if (other.type === 'drag') return false;
    if (other.type === 'pointerdown') {
      if (!sawDragDown && other.t <= dragStartT + 0.05) {
        sawDragDown = true;
        continue;
      }
      return false;
    }
    if (other.type === 'pointerup') {
      return sawDragDown || other.t <= dragEndT + 0.1;
    }
  }
  return false;
}

/**
 * Compile viewport-space cursor samples from Event Track v1 events with consistent
 * drag `pressed` state tracking and drag end-sample parity across compiler and reviewer.
 */
export function compileCursorSamples(events, duration = 0) {
  if (!Array.isArray(events)) return [];
  const cursorSamples = [];
  let pointerDown = false;
  let activeDragEndT = null;
  let pendingDragRelease = null;

  const pushCursorSample = (t, x, y, nextPressed, visible = true) => {
    const sample = {
      t: roundTime(t),
      x: normalizeZero(x),
      y: normalizeZero(y),
      pressed: nextPressed,
      visible,
    };
    const prev = cursorSamples[cursorSamples.length - 1];
    if (
      prev &&
      prev.t === sample.t &&
      prev.x === sample.x &&
      prev.y === sample.y &&
      prev.pressed === sample.pressed &&
      prev.visible === sample.visible
    ) {
      return;
    }
    cursorSamples.push(sample);
  };

  const flushPendingDragBefore = (nextT) => {
    if (!pendingDragRelease) return;
    if (nextT > pendingDragRelease.t) {
      pushCursorSample(pendingDragRelease.t, pendingDragRelease.x, pendingDragRelease.y, false, true);
      pendingDragRelease = null;
      if (!pointerDown) activeDragEndT = null;
    }
  };

  const currentPressed = (t) => pointerDown || (activeDragEndT !== null && t < activeDragEndT);

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!isObject(event) || !isFiniteNumber(event.t)) continue;
    flushPendingDragBefore(event.t);
    if (activeDragEndT !== null && event.t >= activeDragEndT && !pointerDown) {
      activeDragEndT = null;
    }

    switch (event.type) {
      case 'pointermove': {
        if (!isFiniteNumber(event.x) || !isFiniteNumber(event.y)) break;
        if (pendingDragRelease && roundTime(event.t) === pendingDragRelease.t) {
          pushCursorSample(event.t, event.x, event.y, false, true);
          pendingDragRelease = null;
          activeDragEndT = null;
        } else {
          pushCursorSample(event.t, event.x, event.y, currentPressed(event.t), true);
        }
        break;
      }
      case 'pointerdown': {
        pointerDown = true;
        if (isFiniteNumber(event.x) && isFiniteNumber(event.y)) {
          pushCursorSample(event.t, event.x, event.y, true, true);
        }
        break;
      }
      case 'pointerup': {
        pointerDown = false;
        activeDragEndT = null;
        pendingDragRelease = null;
        if (isFiniteNumber(event.x) && isFiniteNumber(event.y)) {
          pushCursorSample(event.t, event.x, event.y, false, true);
        }
        break;
      }
      case 'wheel':
      case 'gesture': {
        if (isFiniteNumber(event.x) && isFiniteNumber(event.y)) {
          pushCursorSample(event.t, event.x, event.y, currentPressed(event.t), true);
        }
        break;
      }
      case 'drag': {
        if (
          !Array.isArray(event.from) ||
          event.from.length !== 2 ||
          !Array.isArray(event.to) ||
          event.to.length !== 2
        ) {
          break;
        }
        const [fromX, fromY] = event.from;
        const [toX, toY] = event.to;
        const dragDur = isNonNegativeNumber(event.duration) ? event.duration : 0;
        const rawEndT = event.t + dragDur;
        const endT = roundTime(
          duration > 0 ? Math.min(rawEndT, Math.max(duration, event.t)) : rawEndT
        );
        const trackedByPointerUp = hasTrackedDragRelease(
          events,
          i,
          event.t,
          endT,
          pointerDown
        );
        pushCursorSample(event.t, fromX, fromY, true, true);
        activeDragEndT = endT;
        if (!trackedByPointerUp) {
          pendingDragRelease = { t: endT, x: toX, y: toY };
        }
        break;
      }
    }
  }

  if (pendingDragRelease) {
    pushCursorSample(pendingDragRelease.t, pendingDragRelease.x, pendingDragRelease.y, false, true);
  }

  cursorSamples.sort((a, b) => a.t - b.t);
  return cursorSamples;
}

function compileOverlays(events, recipeOverlays, duration) {
  const cursorCfg = recipeOverlays?.cursor ?? {};
  const rippleCfg = recipeOverlays?.ripples ?? {};
  const gestureCfg = recipeOverlays?.gestures ?? {};
  const keystrokeCfg = recipeOverlays?.keystrokes ?? {};
  const captionCfg = recipeOverlays?.captions ?? {};

  const rippleEnabled = rippleCfg.enabled !== false;
  const rippleDuration = rippleCfg.duration ?? 0.45;
  const gestureEnabled = gestureCfg.enabled !== false;
  const wheelDuration = gestureCfg.wheelDuration ?? 0.25;
  const gestureDefaultDuration = gestureCfg.duration ?? 0.35;
  const keystrokeEnabled = keystrokeCfg.enabled !== false;
  const keystrokeDuration = keystrokeCfg.duration ?? 1.2;
  const includeTyping = keystrokeCfg.includeTyping === true;

  const cursorSamples = compileCursorSamples(events, duration);
  const ripples = [];
  const gestures = [];
  const keystrokes = [];
  const steps = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    switch (event.type) {
      case 'pointerdown': {
        if (rippleEnabled) {
          ripples.push({
            t: roundTime(event.t),
            x: normalizeZero(event.x),
            y: normalizeZero(event.y),
            button: event.button ?? 'left',
            duration: rippleDuration,
          });
        }
        const clickModifiers = Array.isArray(event.modifiers) ? event.modifiers : [];
        if (keystrokeEnabled && clickModifiers.length > 0) {
          keystrokes.push({
            t: roundTime(event.t),
            label: formatModifiedClickLabel(clickModifiers),
            keys: [...clickModifiers, 'Click'],
            duration: keystrokeDuration,
          });
        }
        break;
      }
      case 'wheel':
        if (gestureEnabled) {
          gestures.push({
            t: roundTime(event.t),
            kind: 'wheel',
            x: normalizeZero(event.x),
            y: normalizeZero(event.y),
            deltaX: normalizeZero(event.deltaX),
            deltaY: normalizeZero(event.deltaY),
            duration: isPositiveNumber(event.duration) ? event.duration : wheelDuration,
          });
        }
        break;
      case 'gesture':
        if (gestureEnabled) {
          gestures.push({
            t: roundTime(event.t),
            kind: event.kind,
            x: normalizeZero(event.x),
            y: normalizeZero(event.y),
            deltaX: normalizeZero(event.deltaX ?? 0),
            deltaY: normalizeZero(event.deltaY ?? 0),
            duration: isPositiveNumber(event.duration) ? event.duration : gestureDefaultDuration,
          });
        }
        break;
      case 'drag': {
        const [fromX, fromY] = event.from;
        const [toX, toY] = event.to;
        if (rippleEnabled) {
          const duplicateRipple = ripples.some(
            (r) => r.t === roundTime(event.t) && r.x === normalizeZero(fromX) && r.y === normalizeZero(fromY)
          );
          if (!duplicateRipple) {
            ripples.push({
              t: roundTime(event.t),
              x: normalizeZero(fromX),
              y: normalizeZero(fromY),
              button: event.button ?? 'left',
              duration: rippleDuration,
            });
          }
        }
        if (gestureEnabled) {
          gestures.push({
            t: roundTime(event.t),
            kind: 'drag',
            x: normalizeZero(fromX),
            y: normalizeZero(fromY),
            deltaX: normalizeZero(toX - fromX),
            deltaY: normalizeZero(toY - fromY),
            duration: isPositiveNumber(event.duration) ? event.duration : gestureDefaultDuration,
          });
        }
        break;
      }
      case 'key': {
        const action = event.action ?? 'press';
        if (keystrokeEnabled && action !== 'up' && (includeTyping || !isSuppressedTypingKey(event))) {
          const modifiers = event.modifiers ?? [];
          const normalizedKeyToken = event.key === ' ' ? 'Space' : event.key;
          keystrokes.push({
            t: roundTime(event.t),
            label: formatKeystrokeLabel(modifiers, event.key),
            keys: [...modifiers, normalizedKeyToken],
            duration: isPositiveNumber(event.duration) ? event.duration : keystrokeDuration,
          });
        }
        break;
      }
      case 'step': {
        const label = isNonEmptyString(event.label) ? event.label.trim() : `step-${event.index}`;
        steps.push({
          t: roundTime(event.t),
          index: event.index,
          label,
        });
        break;
      }
    }
  }

  return {
    overlays: {
      cursor: {
        enabled: cursorCfg.enabled !== false,
        style: cursorCfg.style ?? 'macos',
        samples: cursorSamples,
      },
      ripples,
      gestures,
      keystrokes,
      captions: {
        enabled: Boolean(captionCfg.enabled),
        tracks: Array.isArray(captionCfg.tracks) ? structuredClone(captionCfg.tracks) : [],
      },
    },
    steps,
  };
}

function clampCameraAxisToBox(center, halfSpan, minBound, maxBound) {
  const low = minBound + halfSpan;
  const high = maxBound - halfSpan;
  if (low <= high) {
    return Math.min(high, Math.max(low, center));
  }
  const coverLow = maxBound - halfSpan;
  const coverHigh = minBound + halfSpan;
  return Math.min(coverHigh, Math.max(coverLow, center));
}

function clampCameraAxisToStage(center, halfSpan, stageSpan) {
  const low = halfSpan;
  const high = stageSpan - halfSpan;
  return low <= high ? Math.min(high, Math.max(low, center)) : stageSpan / 2;
}

function inferStepTargetViewportPoint(events, stepEventIndex, cursor, viewportWidth, viewportHeight) {
  const stepEvent = events[stepEventIndex];
  if (
    Array.isArray(stepEvent?.target) &&
    stepEvent.target.length === 2 &&
    stepEvent.target.every(isFiniteNumber)
  ) {
    return [stepEvent.target[0], stepEvent.target[1]];
  }
  for (let j = stepEventIndex + 1; j < events.length; j += 1) {
    const next = events[j];
    if (!isObject(next)) continue;
    if (next.type === 'step') break;
    if (
      (next.type === 'pointerdown' || next.type === 'wheel' || next.type === 'gesture') &&
      isFiniteNumber(next.x) &&
      isFiniteNumber(next.y)
    ) {
      return [next.x, next.y];
    }
    if (
      next.type === 'drag' &&
      Array.isArray(next.from) &&
      next.from.length === 2 &&
      Array.isArray(next.to) &&
      next.to.length === 2
    ) {
      return [(next.from[0] + next.to[0]) / 2, (next.from[1] + next.to[1]) / 2];
    }
  }
  if (isFiniteNumber(stepEvent?.t) && cursor?.samples?.length > 0) {
    const sampled = sampleCursor(cursor, stepEvent.t);
    if (sampled) return [sampled.x, sampled.y];
  }
  return [viewportWidth / 2, viewportHeight / 2];
}

/**
 * Compile smooth, stage- and window-clamped camera keyframes locked to real captured `step`
 * timestamps when `eventTrack.events` contains per-step `camera` hints.
 */
export function compileStepCameraKeyframes({
  events,
  viewportWidth,
  viewportHeight,
  stage,
  window: win,
  outputWidth,
  outputHeight,
  cursor,
} = {}) {
  if (!Array.isArray(events)) return null;
  const stepHints = [];
  events.forEach((event, eventIndex) => {
    if (isObject(event) && event.type === 'step' && event.camera !== undefined && isFiniteNumber(event.t)) {
      stepHints.push({ event, eventIndex });
    }
  });
  if (stepHints.length === 0) return null;

  const clampPose = (vx, vy, zoom, clampToWindowFlag) => {
    let x = win.x + (vx / viewportWidth) * win.width;
    let y = win.y + (vy / viewportHeight) * win.height;
    const shouldClampToWindow = clampToWindowFlag ?? (isPositiveNumber(zoom) && zoom > 1);
    if (
      isFiniteNumber(x) &&
      isFiniteNumber(y) &&
      isPositiveNumber(zoom) &&
      isPositiveNumber(outputWidth) &&
      isPositiveNumber(outputHeight) &&
      isPositiveNumber(stage.width) &&
      isPositiveNumber(stage.height)
    ) {
      const halfW = outputWidth / (2 * zoom);
      const halfH = outputHeight / (2 * zoom);
      if (shouldClampToWindow && isPositiveNumber(win.width) && isPositiveNumber(win.height)) {
        x = clampCameraAxisToBox(x, halfW, win.x, win.x + win.width);
        y = clampCameraAxisToBox(y, halfH, win.y, win.y + win.height);
      }
      x = clampCameraAxisToStage(x, halfW, stage.width);
      y = clampCameraAxisToStage(y, halfH, stage.height);
    }
    return {
      x: normalizeZero(x),
      y: normalizeZero(y),
      zoom,
    };
  };

  const resolvedSteps = stepHints.map(({ event, eventIndex }) => {
    const check = validateStepCameraHint(event.camera, `eventTrack.events[${eventIndex}].camera`);
    if (!check.ok) {
      throw Error(`Invalid step camera hint:\n- ${check.errors.join('\n- ')}`);
    }
    if (event.camera === 'wide') {
      const pose = clampPose(viewportWidth / 2, viewportHeight / 2, 1, false);
      return {
        t: roundTime(event.t),
        ...pose,
        easing: 'quint-in-out',
        lead: DEFAULT_STEP_CAMERA_LEAD,
        hold: DEFAULT_STEP_CAMERA_HOLD,
      };
    }

    const hint = event.camera;
    const zoom = hint.zoom ?? 1;
    const focusSpec =
      hint.focus ??
      hint.target ??
      (zoom <= 1
        ? 'window'
        : Array.isArray(event.target)
          ? 'target'
          : cursor?.samples?.length > 0
            ? 'pointer'
            : 'window');

    let vx;
    let vy;
    if (focusSpec === 'window') {
      [vx, vy] = [viewportWidth / 2, viewportHeight / 2];
    } else if (focusSpec === 'target') {
      [vx, vy] = inferStepTargetViewportPoint(events, eventIndex, cursor, viewportWidth, viewportHeight);
    } else if (focusSpec === 'pointer') {
      if (cursor?.samples?.length > 0) {
        const sampled = sampleCursor(cursor, event.t);
        [vx, vy] = sampled ? [sampled.x, sampled.y] : [viewportWidth / 2, viewportHeight / 2];
      } else {
        [vx, vy] = [viewportWidth / 2, viewportHeight / 2];
      }
    } else if (Array.isArray(focusSpec)) {
      [vx, vy] = focusSpec;
    } else {
      [vx, vy] = [focusSpec.x, focusSpec.y];
    }

    const pose = clampPose(vx, vy, zoom, hint.clampToWindow);
    return {
      t: roundTime(event.t),
      ...pose,
      easing: normalizeEasing(hint.easing, 'quint-in-out'),
      lead: hint.lead ?? DEFAULT_STEP_CAMERA_LEAD,
      hold: hint.hold ?? DEFAULT_STEP_CAMERA_HOLD,
    };
  });

  const samePose = (a, b) =>
    Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.zoom - b.zoom) < EPS;

  const widePose = clampPose(viewportWidth / 2, viewportHeight / 2, 1, false);
  const keyframes = [];
  const first = resolvedSteps[0];

  if (first.t <= EPS) {
    keyframes.push({
      t: 0,
      x: first.x,
      y: first.y,
      zoom: first.zoom,
      easing: 'linear',
    });
  } else {
    keyframes.push({
      t: 0,
      x: widePose.x,
      y: widePose.y,
      zoom: widePose.zoom,
      easing: 'linear',
    });
    if (!samePose(widePose, first)) {
      const leadStart = roundTime(Math.max(0, first.t - first.lead));
      if (leadStart > EPS) {
        keyframes.push({
          t: leadStart,
          x: widePose.x,
          y: widePose.y,
          zoom: widePose.zoom,
          easing: 'linear',
        });
      }
      keyframes.push({
        t: first.t,
        x: first.x,
        y: first.y,
        zoom: first.zoom,
        easing: first.easing,
      });
    }
  }

  for (let k = 1; k < resolvedSteps.length; k += 1) {
    const prev = resolvedSteps[k - 1];
    const curr = resolvedSteps[k];
    const lastKf = keyframes[keyframes.length - 1];
    if (samePose(lastKf, curr)) continue;

    const anchorT = Math.max(lastKf.t, prev.t);
    const currT = Math.max(anchorT, curr.t);
    const gap = currT - anchorT;

    if (gap <= EPS) {
      if (curr.lead === 0) {
        if (lastKf.t < currT) {
          keyframes.push({
            t: currT,
            x: lastKf.x,
            y: lastKf.y,
            zoom: lastKf.zoom,
            easing: 'linear',
          });
        }
        keyframes.push({
          t: currT,
          x: curr.x,
          y: curr.y,
          zoom: curr.zoom,
          easing: curr.easing,
        });
      } else {
        keyframes[keyframes.length - 1] = {
          t: currT,
          x: curr.x,
          y: curr.y,
          zoom: curr.zoom,
          easing: keyframes.length === 1 ? 'linear' : curr.easing,
        };
      }
      continue;
    }

    const requestedSpan = prev.hold + curr.lead;
    let departT;
    if (requestedSpan <= 0) {
      departT = currT;
    } else if (gap >= requestedSpan) {
      departT = roundTime(currT - curr.lead);
    } else {
      departT = roundTime(anchorT + prev.hold * (gap / requestedSpan));
    }
    departT = Math.min(currT, Math.max(anchorT, departT));

    if (departT > lastKf.t + EPS) {
      keyframes.push({
        t: departT,
        x: lastKf.x,
        y: lastKf.y,
        zoom: lastKf.zoom,
        easing: 'linear',
      });
    } else if (curr.lead === 0 && departT === currT && lastKf.t < currT) {
      keyframes.push({
        t: currT,
        x: lastKf.x,
        y: lastKf.y,
        zoom: lastKf.zoom,
        easing: 'linear',
      });
    }

    keyframes.push({
      t: currT,
      x: curr.x,
      y: curr.y,
      zoom: curr.zoom,
      easing: curr.easing,
    });
  }

  return keyframes;
}

/**
 * Compile a take reference, Event Track v1 payload, and recipe presentation options into a
 * deterministic, schema-validated `timeline.json` v1 object.
 */
export function compileTimeline({ take, eventTrack, recipe = {} } = {}) {
  const trackCheck = validateEventTrack(eventTrack);
  if (!trackCheck.ok) {
    throw Error(`Invalid event track:\n- ${trackCheck.errors.join('\n- ')}`);
  }
  if (!isObject(recipe)) {
    throw Error('recipe must be an object');
  }
  const effectiveRecipe = isObject(recipe.presentation)
    ? { ...recipe, ...recipe.presentation }
    : recipe;

  const resolvedTake = {
    video: take?.video ?? eventTrack.video?.file,
    eventTrack: take?.eventTrack ?? (typeof eventTrack.file === 'string' ? eventTrack.file : 'event-track.json'),
    width: take?.width ?? eventTrack.video?.width,
    height: take?.height ?? eventTrack.video?.height,
    fps: take?.fps ?? eventTrack.video?.fps,
    duration: take?.duration ?? eventTrack.video?.duration,
    frames: take?.frames ?? eventTrack.video?.frames,
    captureMode: take?.captureMode ?? eventTrack.captureMode,
    viewport: {
      width: take?.viewport?.width ?? eventTrack.viewport?.width,
      height: take?.viewport?.height ?? eventTrack.viewport?.height,
      deviceScaleFactor: take?.viewport?.deviceScaleFactor ?? eventTrack.viewport?.deviceScaleFactor,
    },
  };

  const viewportWidth = resolvedTake.viewport.width;
  const viewportHeight = resolvedTake.viewport.height;
  if (!isPositiveNumber(viewportWidth) || !isPositiveNumber(viewportHeight)) {
    throw Error('take/eventTrack must specify positive viewport width and height');
  }

  const recipeStage = effectiveRecipe.stage ?? {};
  const recipeWindow = effectiveRecipe.window ?? {};
  const recipeCamera = effectiveRecipe.camera ?? {};
  if (recipeCamera.fromSteps !== undefined && typeof recipeCamera.fromSteps !== 'boolean') {
    throw Error('recipe.camera.fromSteps must be a boolean');
  }

  const padding = recipeStage.padding ?? 120;
  const frame = recipeWindow.frame ?? 'none';
  const windowWidth = recipeWindow.width ?? viewportWidth;
  const windowHeight = recipeWindow.height ?? viewportHeight;
  const outputWidth = recipeCamera.outputWidth ?? viewportWidth;
  const outputHeight = recipeCamera.outputHeight ?? viewportHeight;

  const stageWidth = recipeStage.width ?? Math.max(outputWidth, windowWidth + padding * 2);
  const stageHeight = recipeStage.height ?? Math.max(outputHeight, windowHeight + padding * 2);

  const stage = {
    width: normalizeZero(stageWidth),
    height: normalizeZero(stageHeight),
    background: normalizeBackground(recipeStage.background),
    padding: normalizeZero(padding),
  };

  const windowX = recipeWindow.x ?? (stage.width - windowWidth) / 2;
  const windowY = recipeWindow.y ?? (stage.height - windowHeight) / 2;
  const win = {
    frame,
    ...(recipeWindow.title !== undefined ? { title: recipeWindow.title } : {}),
    x: normalizeZero(windowX),
    y: normalizeZero(windowY),
    width: normalizeZero(windowWidth),
    height: normalizeZero(windowHeight),
    borderRadius: normalizeZero(recipeWindow.borderRadius ?? (frame === 'none' ? 0 : 12)),
    shadow: recipeWindow.shadow ?? frame !== 'none',
  };

  const { overlays, steps } = compileOverlays(eventTrack.events, effectiveRecipe.overlays, resolvedTake.duration ?? 0);
  const cursorTrackForCamera = {
    enabled: true,
    style: 'macos',
    samples: overlays.cursor.samples,
  };

  const resolveTargetViewportPoint = (target, kfTime, index) => {
    if (target === 'window') {
      return [viewportWidth / 2, viewportHeight / 2];
    }
    if (target === 'pointer') {
      if (isFiniteNumber(kfTime) && cursorTrackForCamera.samples.length > 0) {
        const sampled = sampleCursor(cursorTrackForCamera, kfTime);
        if (sampled) return [sampled.x, sampled.y];
      }
      return [viewportWidth / 2, viewportHeight / 2];
    }
    if (Array.isArray(target) && target.length === 2 && target.every(isFiniteNumber)) {
      return [target[0], target[1]];
    }
    if (isObject(target) && isFiniteNumber(target.x) && isFiniteNumber(target.y)) {
      return [target.x, target.y];
    }
    throw Error(
      `Invalid camera keyframe target at timeline.camera.keyframes[${index}]: expected "pointer", "window", or [vx, vy]`
    );
  };

  const rawKeyframes = recipeCamera.keyframes;
  let keyframes = null;

  if (Array.isArray(rawKeyframes) && rawKeyframes.length > 0) {
    keyframes = rawKeyframes.map((kf, index) => {
      if (!isObject(kf)) return kf;
      if (kf.clampToWindow !== undefined && typeof kf.clampToWindow !== 'boolean') {
        throw Error(`timeline.camera.keyframes[${index}].clampToWindow must be a boolean`);
      }
      const zoom = kf.zoom ?? 1;
      const rawTarget = kf.target ?? kf.focus;
      const hasDeclarativeTarget = rawTarget !== undefined;
      const usesViewportTarget = kf.viewportX !== undefined || kf.viewportY !== undefined;

      let targetX;
      let targetY;
      if (hasDeclarativeTarget) {
        const [vx, vy] = resolveTargetViewportPoint(rawTarget, kf.t, index);
        targetX = win.x + (vx / viewportWidth) * win.width;
        targetY = win.y + (vy / viewportHeight) * win.height;
      } else if (usesViewportTarget) {
        targetX = win.x + ((kf.viewportX ?? viewportWidth / 2) / viewportWidth) * win.width;
        targetY = win.y + ((kf.viewportY ?? viewportHeight / 2) / viewportHeight) * win.height;
      } else {
        targetX = kf.x ?? stage.width / 2;
        targetY = kf.y ?? stage.height / 2;
      }

      const shouldClampToWindow = kf.clampToWindow ?? (hasDeclarativeTarget && isPositiveNumber(zoom) && zoom > 1);
      const shouldClampToStage = shouldClampToWindow || hasDeclarativeTarget;

      if (
        (shouldClampToWindow || shouldClampToStage) &&
        isFiniteNumber(targetX) &&
        isFiniteNumber(targetY) &&
        isPositiveNumber(zoom) &&
        isPositiveNumber(outputWidth) &&
        isPositiveNumber(outputHeight) &&
        isPositiveNumber(stage.width) &&
        isPositiveNumber(stage.height)
      ) {
        const halfW = outputWidth / (2 * zoom);
        const halfH = outputHeight / (2 * zoom);
        if (shouldClampToWindow && isPositiveNumber(win.width) && isPositiveNumber(win.height)) {
          targetX = clampCameraAxisToBox(targetX, halfW, win.x, win.x + win.width);
          targetY = clampCameraAxisToBox(targetY, halfH, win.y, win.y + win.height);
        }
        targetX = clampCameraAxisToStage(targetX, halfW, stage.width);
        targetY = clampCameraAxisToStage(targetY, halfH, stage.height);
      }

      return {
        t: isFiniteNumber(kf.t) ? roundTime(kf.t) : kf.t,
        x: isFiniteNumber(targetX) ? normalizeZero(targetX) : targetX,
        y: isFiniteNumber(targetY) ? normalizeZero(targetY) : targetY,
        zoom,
        easing: normalizeEasing(kf.easing, index === 0 ? 'linear' : 'ease-in-out'),
      };
    });
  } else if (recipeCamera.fromSteps !== false) {
    keyframes = compileStepCameraKeyframes({
      events: eventTrack.events,
      viewportWidth,
      viewportHeight,
      stage,
      window: win,
      outputWidth,
      outputHeight,
      cursor: cursorTrackForCamera,
    });
  }

  if (!keyframes) {
    keyframes = [
      {
        t: 0,
        x: normalizeZero(stage.width / 2),
        y: normalizeZero(stage.height / 2),
        zoom: 1,
        easing: 'linear',
      },
    ];
  }

  const camera = {
    outputWidth: normalizeZero(outputWidth),
    outputHeight: normalizeZero(outputHeight),
    keyframes,
  };

  const audio = {
    tracks: Array.isArray(effectiveRecipe.audio?.tracks) ? structuredClone(effectiveRecipe.audio.tracks) : [],
  };
  const outputs = buildOutputProfiles(effectiveRecipe.outputs, camera, resolvedTake);

  const timeline = {
    version: TIMELINE_VERSION,
    take: resolvedTake,
    stage,
    window: win,
    camera,
    overlays,
    audio,
    outputs,
    steps,
  };

  return assertValidTimeline(timeline);
}
