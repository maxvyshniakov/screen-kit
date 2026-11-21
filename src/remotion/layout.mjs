import {
  sampleCamera,
  sampleCursor,
  projectViewportToScreen,
} from '../timeline.mjs';

const EXTERNAL_URL_RE = /^(?:https?:|data:|blob:)/i;

/** Resolve a timeline media path via an asset mapper unless it is already an external/data URL. */
export function resolveAssetUrl(src, mapAsset) {
  if (typeof src !== 'string' || src.length === 0) return '';
  if (EXTERNAL_URL_RE.test(src)) return src;
  return typeof mapAsset === 'function' ? mapAsset(src) : src;
}

/**
 * Compute stage-space geometry for the window frame and viewport content rectangle.
 * `window.{x, y, width, height}` ALWAYS locates the take's viewport content rectangle on the stage;
 * decorative frame chrome (`macos`, `browser`, `device`) wraps around it inside stage padding so
 * `projectViewportToStage` and `projectViewportToScreen` remain exact for every frame style.
 */
export function computeWindowChrome(win) {
  const borderRadius = win.borderRadius ?? (win.frame === 'none' ? 0 : 12);
  const shadow = win.shadow ?? win.frame !== 'none';

  switch (win.frame) {
    case 'macos': {
      const topBarHeight = 36;
      return {
        frame: 'macos',
        title: win.title ?? '',
        borderRadius,
        shadow,
        topBarHeight,
        bottomBarHeight: 0,
        sideBorder: 0,
        outerRect: {
          x: win.x,
          y: win.y - topBarHeight,
          width: win.width,
          height: win.height + topBarHeight,
        },
        contentOffset: { left: 0, top: topBarHeight },
        contentRect: {
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
        },
      };
    }
    case 'browser': {
      const topBarHeight = 44;
      return {
        frame: 'browser',
        title: win.title ?? '',
        borderRadius,
        shadow,
        topBarHeight,
        bottomBarHeight: 0,
        sideBorder: 0,
        outerRect: {
          x: win.x,
          y: win.y - topBarHeight,
          width: win.width,
          height: win.height + topBarHeight,
        },
        contentOffset: { left: 0, top: topBarHeight },
        contentRect: {
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
        },
      };
    }
    case 'device': {
      const sideBorder = 14;
      const topBarHeight = 28;
      const bottomBarHeight = 18;
      return {
        frame: 'device',
        title: win.title ?? '',
        borderRadius: win.borderRadius ?? 28,
        shadow,
        topBarHeight,
        bottomBarHeight,
        sideBorder,
        outerRect: {
          x: win.x - sideBorder,
          y: win.y - topBarHeight,
          width: win.width + sideBorder * 2,
          height: win.height + topBarHeight + bottomBarHeight,
        },
        contentOffset: { left: sideBorder, top: topBarHeight },
        contentRect: {
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
        },
      };
    }
    case 'none':
    default:
      return {
        frame: 'none',
        title: win.title ?? '',
        borderRadius,
        shadow,
        topBarHeight: 0,
        bottomBarHeight: 0,
        sideBorder: 0,
        outerRect: {
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
        },
        contentOffset: { left: 0, top: 0 },
        contentRect: {
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
        },
      };
  }
}

/** Resolve stage background presentation descriptor for `solid`, `gradient`, and `image`. */
export function computeStageBackground(background, mapAsset) {
  if (!background || background.type === 'solid') {
    const color = background?.color ?? '#0f172a';
    return {
      type: 'solid',
      style: { backgroundColor: color },
      fallbackColor: color,
      imageSrc: null,
      imageFit: null,
    };
  }

  if (background.type === 'gradient') {
    const angle = background.angle ?? 135;
    const stops = background.stops
      .map((stop) => `${stop.color} ${(stop.offset * 100).toFixed(2)}%`)
      .join(', ');
    return {
      type: 'gradient',
      style: { backgroundImage: `linear-gradient(${angle}deg, ${stops})` },
      fallbackColor: background.stops[0]?.color ?? '#0f172a',
      imageSrc: null,
      imageFit: null,
    };
  }

  if (background.type === 'image') {
    return {
      type: 'image',
      style: { backgroundColor: '#0f172a' },
      fallbackColor: '#0f172a',
      imageSrc: resolveAssetUrl(background.src, mapAsset),
      imageFit: background.fit ?? 'cover',
    };
  }

  return {
    type: 'solid',
    style: { backgroundColor: '#0f172a' },
    fallbackColor: '#0f172a',
    imageSrc: null,
    imageFit: null,
  };
}

/**
 * Map a point `(x, y)` in logical camera output space (`cameraOutputWidth x cameraOutputHeight`)
 * into rendered frame pixel coordinates (`renderWidth x renderHeight`) using uniform aspect-ratio
 * scaling and centered pillarbox/letterbox offsets.
 */
export function screenToRender(
  x,
  y,
  cameraOutputWidth,
  cameraOutputHeight,
  renderWidth,
  renderHeight
) {
  const hasCameraDims =
    Number.isFinite(cameraOutputWidth) &&
    cameraOutputWidth > 0 &&
    Number.isFinite(cameraOutputHeight) &&
    cameraOutputHeight > 0;
  if (!hasCameraDims) {
    return {
      x,
      y,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      logicalWidth: renderWidth ?? 0,
      logicalHeight: renderHeight ?? 0,
    };
  }
  const outW =
    Number.isFinite(renderWidth) && renderWidth > 0 ? renderWidth : cameraOutputWidth;
  const outH =
    Number.isFinite(renderHeight) && renderHeight > 0 ? renderHeight : cameraOutputHeight;
  const scale = Math.min(outW / cameraOutputWidth, outH / cameraOutputHeight);
  const logicalWidth = cameraOutputWidth * scale;
  const logicalHeight = cameraOutputHeight * scale;
  const offsetX = (outW - logicalWidth) / 2;
  const offsetY = (outH - logicalHeight) / 2;
  return {
    x: offsetX + x * scale,
    y: offsetY + y * scale,
    scale,
    offsetX,
    offsetY,
    logicalWidth,
    logicalHeight,
  };
}

/**
 * Compute camera sample and stage-to-render-frame affine transform at timestamp `t`.
 * Supports output profiles (`renderWidth x renderHeight`) that scale relative to
 * `camera.outputWidth x camera.outputHeight` (e.g. 2560x1440 YouTube master).
 */
export function computeCameraTransform(camera, t, renderWidth, renderHeight) {
  const sample = sampleCamera(camera, t);
  const frameMap = screenToRender(
    0,
    0,
    camera.outputWidth,
    camera.outputHeight,
    renderWidth,
    renderHeight
  );
  const { scale: outputScale, offsetX, offsetY, logicalWidth, logicalHeight } = frameMap;
  const effectiveScale = sample.zoom * outputScale;
  const translateX = offsetX + logicalWidth / 2 - sample.x * effectiveScale;
  const translateY = offsetY + logicalHeight / 2 - sample.y * effectiveScale;

  return {
    sample,
    outputScale,
    offsetX,
    offsetY,
    logicalWidth,
    logicalHeight,
    effectiveScale,
    translateX,
    translateY,
    cssTransform: `translate(${translateX}px, ${translateY}px) scale(${effectiveScale})`,
  };
}

function envelopeOpacity(progress, fadeInEnd = 0.15, fadeOutSpan = 0.3) {
  const clamped = Math.min(1, Math.max(0, progress));
  const fadeIn = fadeInEnd > 0 ? 0.85 + 0.15 * Math.min(1, clamped / fadeInEnd) : 1;
  const fadeOut = fadeOutSpan > 0 ? Math.min(1, (1 - clamped) / fadeOutSpan) : 1;
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

const RIPPLE_COLORS = {
  left: 'rgba(56, 189, 248, 0.92)',
  right: 'rgba(251, 191, 36, 0.92)',
  middle: 'rgba(167, 139, 250, 0.92)',
};

const GESTURE_LABELS = {
  wheel: 'Scroll',
  scroll: 'Trackpad',
  pinch: 'Pinch',
  pan: 'Pan',
  swipe: 'Swipe',
  drag: 'Drag',
  touch: 'Touch',
};

/**
 * Compute all screen-space overlays at timestamp `t`.
 * Overlays are projected AFTER the camera via `projectViewportToScreen` so their anchor points
 * track zoomed/panned targets accurately while their visual scale stays constant (`outputScale`),
 * independent of `camera.zoom`.
 */
export function computeOverlaysAtTime(timeline, t, renderWidth, renderHeight) {
  const cameraState = computeCameraTransform(timeline.camera, t, renderWidth, renderHeight);
  const { outputScale, offsetX, offsetY, logicalWidth, logicalHeight } = cameraState;

  const toRenderPoint = (screenPoint) => {
    const pt = screenToRender(
      screenPoint.x,
      screenPoint.y,
      timeline.camera.outputWidth,
      timeline.camera.outputHeight,
      renderWidth,
      renderHeight
    );
    return { x: pt.x, y: pt.y };
  };

  // 1. Cursor overlay
  let cursor = null;
  const rawCursor = sampleCursor(timeline.overlays?.cursor, t);
  if (rawCursor && rawCursor.visible) {
    const screenPoint = projectViewportToScreen(rawCursor.x, rawCursor.y, timeline, t);
    const renderPoint = toRenderPoint(screenPoint);
    cursor = {
      style: timeline.overlays.cursor.style ?? 'macos',
      viewportX: rawCursor.x,
      viewportY: rawCursor.y,
      screenX: screenPoint.x,
      screenY: screenPoint.y,
      x: renderPoint.x,
      y: renderPoint.y,
      pressed: rawCursor.pressed,
      scale: outputScale,
      pressScale: rawCursor.pressed ? 0.88 : 1,
    };
  }

  // 2. Click ripples
  const ripples = [];
  for (const [index, ripple] of (timeline.overlays?.ripples ?? []).entries()) {
    if (t < ripple.t || t > ripple.t + ripple.duration) continue;
    const progress = Math.min(1, Math.max(0, (t - ripple.t) / ripple.duration));
    const eased = 1 - (1 - progress) ** 3;
    const screenPoint = projectViewportToScreen(ripple.x, ripple.y, timeline, t);
    const renderPoint = toRenderPoint(screenPoint);
    ripples.push({
      key: `ripple-${index}-${ripple.t}`,
      button: ripple.button,
      progress,
      screenX: screenPoint.x,
      screenY: screenPoint.y,
      x: renderPoint.x,
      y: renderPoint.y,
      scale: outputScale,
      radius: (8 + 28 * eased) * outputScale,
      strokeWidth: Math.max(1.5, 2.5 * (1 - progress * 0.4) * outputScale),
      opacity: Math.max(0, (1 - progress) ** 1.4 * 0.9),
      color: RIPPLE_COLORS[ripple.button] ?? RIPPLE_COLORS.left,
    });
  }

  // 3. Wheel / trackpad / drag gesture indicators
  const gestures = [];
  for (const [index, gesture] of (timeline.overlays?.gestures ?? []).entries()) {
    if (t < gesture.t || t > gesture.t + gesture.duration) continue;
    const progress = Math.min(1, Math.max(0, (t - gesture.t) / gesture.duration));
    const screenPoint = projectViewportToScreen(gesture.x, gesture.y, timeline, t);
    const renderPoint = toRenderPoint(screenPoint);
    const magnitude = Math.hypot(gesture.deltaX, gesture.deltaY);
    const angleDeg = magnitude > 0 ? (Math.atan2(gesture.deltaY, gesture.deltaX) * 180) / Math.PI : 90;
    gestures.push({
      key: `gesture-${index}-${gesture.t}`,
      kind: gesture.kind,
      label: GESTURE_LABELS[gesture.kind] ?? gesture.kind,
      progress,
      screenX: screenPoint.x,
      screenY: screenPoint.y,
      x: renderPoint.x,
      y: renderPoint.y,
      deltaX: gesture.deltaX,
      deltaY: gesture.deltaY,
      magnitude,
      angleDeg,
      scale: outputScale,
      opacity: envelopeOpacity(progress, 0.14, 0.28) * 0.94,
    });
  }

  // 4. Keystroke pills
  const keystrokes = [];
  for (const [index, ks] of (timeline.overlays?.keystrokes ?? []).entries()) {
    if (t < ks.t || t > ks.t + ks.duration) continue;
    const progress = Math.min(1, Math.max(0, (t - ks.t) / ks.duration));
    const opacity = envelopeOpacity(progress, 0.1, 0.22);
    const liftPx = (1 - Math.min(1, progress / 0.12)) * 8 * outputScale;
    keystrokes.push({
      key: `keystroke-${index}-${ks.t}`,
      label: ks.label,
      keys: ks.keys,
      progress,
      opacity,
      liftPx,
      scale: outputScale,
    });
  }

  // 5. Captions (when enabled in timeline.overlays.captions)
  const captions = [];
  if (timeline.overlays?.captions?.enabled) {
    const primaryTrack = timeline.overlays.captions.tracks?.[0];
    for (const [index, cue] of (primaryTrack?.cues ?? []).entries()) {
      if (t >= cue.start && t <= cue.end && cue.text.trim().length > 0) {
        captions.push({
          key: `caption-${index}-${cue.start}`,
          text: cue.text,
          scale: outputScale,
        });
      }
    }
  }

  return {
    scale: outputScale,
    hudAnchor: {
      centerX: offsetX + logicalWidth / 2,
      bottomY: offsetY + logicalHeight - 40 * outputScale,
    },
    cursor,
    ripples,
    gestures,
    keystrokes,
    captions,
  };
}

/**
 * Compute the complete deterministic visual scene for `(frame, fps, width, height)`
 * strictly from `timeline` data.
 */
export function computeFrameScene(timeline, { frame = 0, fps, width, height, mapAsset } = {}) {
  const effectiveFps = fps ?? timeline.take.fps;
  const renderWidth = width ?? timeline.camera.outputWidth;
  const renderHeight = height ?? timeline.camera.outputHeight;
  const t = Math.max(0, frame / effectiveFps);

  const stageBackground = computeStageBackground(timeline.stage.background, mapAsset);
  const windowChrome = computeWindowChrome(timeline.window);
  const camera = computeCameraTransform(timeline.camera, t, renderWidth, renderHeight);
  const overlays = computeOverlaysAtTime(timeline, t, renderWidth, renderHeight);
  const videoSrc = resolveAssetUrl(timeline.take.video, mapAsset);
  const audioTracks = (timeline.audio?.tracks ?? []).map((track) => ({
    ...track,
    resolvedSrc: resolveAssetUrl(track.src, mapAsset),
    startFrame: Math.max(0, Math.round(track.start * effectiveFps)),
  }));

  return {
    frame,
    fps: effectiveFps,
    t,
    renderWidth,
    renderHeight,
    stage: {
      width: timeline.stage.width,
      height: timeline.stage.height,
      padding: timeline.stage.padding,
      background: stageBackground,
    },
    windowChrome,
    videoSrc,
    camera,
    overlays,
    audioTracks,
  };
}
