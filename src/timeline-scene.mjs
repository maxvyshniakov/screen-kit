import {
  cameraViewportRect,
  portraitBaseDimensions,
  projectViewportToStage,
  sampleCamera,
  sampleCursor,
} from './timeline.mjs';

const EXTERNAL_URL_RE = /^(?:https?:|data:|blob:)/i;

const SQUIRCLE_CACHE_MAX = 64;
const SQUIRCLE_CACHE = new Map();

const WINDOW_CHROME_CACHE = new WeakMap();
const STAGE_BACKGROUND_CACHE = new WeakMap();
const NULL_STAGE_BACKGROUND_KEY = {};
const RANGE_INDEX_CACHE = new WeakMap();

/** Resolve a timeline media path via an asset mapper unless it is already an external/data URL. */
export function resolveAssetUrl(src, mapAsset) {
  if (typeof src !== 'string' || src.length === 0) return '';
  if (EXTERNAL_URL_RE.test(src)) return src;
  return typeof mapAsset === 'function' ? mapAsset(src) : src;
}

/**
 * Build a mathematically C∞-smooth continuous-corner (superellipse / macOS squircle) SVG path
 * for a rectangle of size `width x height`.
 *
 * Each corner follows the exact Lamé superellipse `(1 - u)^n + (1 - v)^n = 1` over shoulder
 * length `s = r * (1 + smoothness * 0.45)`, which meets every straight edge with zero curvature
 * jump (G2 continuity) and has zero cusps at the 45° diagonal.
 *
 * Memoized via a small bounded LRU cache keyed by `(width, height, radius, smoothness)`.
 */
export function buildSquirclePath(width, height, radius, smoothness = 0.6) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const r = Math.max(0, Math.min(Number(radius) || 0, w / 2, h / 2));
  if (r <= 0.01) {
    return `M 0 0 H ${w} V ${h} H 0 Z`;
  }

  const sm = Math.max(0, Math.min(1, Number(smoothness) || 0));
  const cacheKey = `${w}:${h}:${r}:${sm}`;
  const cached = SQUIRCLE_CACHE.get(cacheKey);
  if (cached !== undefined) {
    SQUIRCLE_CACHE.delete(cacheKey);
    SQUIRCLE_CACHE.set(cacheKey, cached);
    return cached;
  }

  // n = 2 is a circle; n ≈ 4.2 matches Apple continuous corners (squircle)
  const n = 2 + sm * 3.6;
  const exp = 2 / n;
  // Shoulder length extends slightly past r so visual inset matches radius r
  const s = Math.min(r * (1 + sm * 0.42), w / 2, h / 2);
  const steps = 24;
  const f = (v) => Number(v.toFixed(3));

  const points = [];
  // Top-right corner: from (w - s, 0) to (w, s), angle θ: 0 -> π/2
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * (Math.PI / 2);
    const x = w - s + s * Math.pow(Math.sin(theta), exp);
    const y = s - s * Math.pow(Math.cos(theta), exp);
    points.push([x, y]);
  }
  // Bottom-right corner: from (w, h - s) to (w - s, h)
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * (Math.PI / 2);
    const x = w - s + s * Math.pow(Math.cos(theta), exp);
    const y = h - s + s * Math.pow(Math.sin(theta), exp);
    points.push([x, y]);
  }
  // Bottom-left corner: from (s, h) to (0, h - s)
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * (Math.PI / 2);
    const x = s - s * Math.pow(Math.sin(theta), exp);
    const y = h - s + s * Math.pow(Math.cos(theta), exp);
    points.push([x, y]);
  }
  // Top-left corner: from (0, s) to (s, 0)
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * (Math.PI / 2);
    const x = s - s * Math.pow(Math.cos(theta), exp);
    const y = s - s * Math.pow(Math.sin(theta), exp);
    points.push([x, y]);
  }

  const path =
    `M ${f(points[0][0])} ${f(points[0][1])} ` +
    points
      .slice(1)
      .map(([x, y]) => `L ${f(x)} ${f(y)}`)
      .join(' ') +
    ' Z';

  if (SQUIRCLE_CACHE.size >= SQUIRCLE_CACHE_MAX) {
    const oldestKey = SQUIRCLE_CACHE.keys().next().value;
    SQUIRCLE_CACHE.delete(oldestKey);
  }
  SQUIRCLE_CACHE.set(cacheKey, path);
  return path;
}

function windowChromeSignature(win) {
  const tl = win.trafficLights;
  const tlSig =
    tl === false
      ? 'false'
      : tl && typeof tl === 'object'
        ? `${tl.x ?? ''},${tl.y ?? ''}`
        : 'default';
  return `${win.frame ?? ''}|${win.title ?? ''}|${win.borderRadius ?? ''}|${win.shadow ?? ''}|${win.x}|${win.y}|${win.width}|${win.height}|${tlSig}`;
}

/**
 * Compute stage-space geometry for the window frame and viewport content rectangle.
 * `window.{x, y, width, height}` ALWAYS locates the take's viewport content rectangle on the stage;
 * decorative frame chrome (`macos`, `browser`, `device`) wraps around it inside stage padding so
 * `projectViewportToStage` and `projectViewportToScreen` remain exact for every frame style.
 */
export function computeWindowChrome(win) {
  const canCache = Boolean(win) && typeof win === 'object';
  const sig = canCache ? windowChromeSignature(win) : '';
  if (canCache) {
    const hit = WINDOW_CHROME_CACHE.get(win);
    if (hit && hit.sig === sig) {
      return hit.value;
    }
  }

  const borderRadius = win.borderRadius ?? (win.frame === 'none' ? 0 : 26);
  const shadow = win.shadow ?? win.frame !== 'none';

  let result;
  switch (win.frame) {
    case 'macos-inset': {
      const tl =
        win.trafficLights === false
          ? null
          : {
              x:
                win.trafficLights && typeof win.trafficLights === 'object' && Number.isFinite(win.trafficLights.x)
                  ? win.trafficLights.x
                  : 14,
              y:
                win.trafficLights && typeof win.trafficLights === 'object' && Number.isFinite(win.trafficLights.y)
                  ? win.trafficLights.y
                  : 15,
            };
      result = {
        frame: 'macos-inset',
        title: win.title ?? '',
        borderRadius: win.borderRadius ?? 20,
        shadow,
        topBarHeight: 0,
        bottomBarHeight: 0,
        sideBorder: 0,
        trafficLights: tl,
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
      break;
    }
    case 'macos': {
      const topBarHeight = 38;
      result = {
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
      break;
    }
    case 'browser': {
      const topBarHeight = 50;
      result = {
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
      break;
    }
    case 'device': {
      const sideBorder = 14;
      const topBarHeight = 28;
      const bottomBarHeight = 18;
      result = {
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
      break;
    }
    case 'none':
    default:
      result = {
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
      break;
  }

  if (canCache) {
    WINDOW_CHROME_CACHE.set(win, { sig, value: result });
  }
  return result;
}

/** Resolve stage background presentation descriptor for `solid`, `gradient`, and `image`. */
export function computeStageBackground(background, mapAsset) {
  if (!background) {
    let hit = STAGE_BACKGROUND_CACHE.get(NULL_STAGE_BACKGROUND_KEY);
    if (!hit) {
      hit = {
        type: 'solid',
        style: { backgroundColor: '#0f172a' },
        fallbackColor: '#0f172a',
        imageSrc: null,
        imageFit: null,
      };
      STAGE_BACKGROUND_CACHE.set(NULL_STAGE_BACKGROUND_KEY, hit);
    }
    return hit;
  }

  if (typeof background === 'object') {
    const hit = STAGE_BACKGROUND_CACHE.get(background);
    if (hit && hit.type === background.type) {
      if (background.type === 'solid' && hit.color === (background.color ?? '#0f172a')) {
        return hit.value;
      }
      if (
        background.type === 'gradient' &&
        Array.isArray(background.stops) &&
        hit.angle === (background.angle ?? 135) &&
        hit.stopsRef === background.stops &&
        hit.stopsLen === background.stops.length &&
        hit.firstColor === background.stops[0]?.color &&
        hit.firstOffset === background.stops[0]?.offset &&
        hit.lastColor === background.stops[background.stops.length - 1]?.color &&
        hit.lastOffset === background.stops[background.stops.length - 1]?.offset
      ) {
        return hit.value;
      }
      if (background.type === 'image') {
        const resolvedSrc = resolveAssetUrl(background.src, mapAsset);
        const imageFit = background.fit ?? 'cover';
        if (hit.resolvedSrc === resolvedSrc && hit.imageFit === imageFit) {
          return hit.value;
        }
      }
    }
  }

  if (background.type === 'solid') {
    const color = background.color ?? '#0f172a';
    const value = {
      type: 'solid',
      style: { backgroundColor: color },
      fallbackColor: color,
      imageSrc: null,
      imageFit: null,
    };
    if (typeof background === 'object') {
      STAGE_BACKGROUND_CACHE.set(background, { type: 'solid', color, value });
    }
    return value;
  }

  if (background.type === 'gradient') {
    const angle = background.angle ?? 135;
    const stops = background.stops
      .map((stop) => `${stop.color} ${(stop.offset * 100).toFixed(2)}%`)
      .join(', ');
    const value = {
      type: 'gradient',
      style: { backgroundImage: `linear-gradient(${angle}deg, ${stops})` },
      fallbackColor: background.stops[0]?.color ?? '#0f172a',
      imageSrc: null,
      imageFit: null,
    };
    if (typeof background === 'object' && Array.isArray(background.stops)) {
      const len = background.stops.length;
      STAGE_BACKGROUND_CACHE.set(background, {
        type: 'gradient',
        angle,
        stopsRef: background.stops,
        stopsLen: len,
        firstColor: background.stops[0]?.color,
        firstOffset: background.stops[0]?.offset,
        lastColor: background.stops[len - 1]?.color,
        lastOffset: background.stops[len - 1]?.offset,
        value,
      });
    }
    return value;
  }

  if (background.type === 'image') {
    const resolvedSrc = resolveAssetUrl(background.src, mapAsset);
    const imageFit = background.fit ?? 'cover';
    const value = {
      type: 'image',
      style: { backgroundColor: '#0f172a' },
      fallbackColor: '#0f172a',
      imageSrc: resolvedSrc,
      imageFit,
    };
    if (typeof background === 'object') {
      STAGE_BACKGROUND_CACHE.set(background, {
        type: 'image',
        resolvedSrc,
        imageFit,
        value,
      });
    }
    return value;
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

const PORTRAIT_SMOOTH_HALF_WINDOW = 0.25;
const PORTRAIT_SMOOTH_OFFSETS = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];

/** Return true when the render target is portrait (`renderHeight > renderWidth`, e.g. 9:16 Shorts). */
export function isPortraitOutput(renderWidth, renderHeight) {
  return (
    Number.isFinite(renderWidth) &&
    Number.isFinite(renderHeight) &&
    renderWidth > 0 &&
    renderHeight > 0 &&
    renderHeight > renderWidth
  );
}

function shouldUsePortraitReframe(camera, renderWidth, renderHeight) {
  if (!isPortraitOutput(renderWidth, renderHeight)) return false;
  if (!camera) return false;
  if (Array.isArray(camera.verticalKeyframes) && camera.verticalKeyframes.length > 0) {
    return true;
  }
  return (
    Number.isFinite(camera.outputWidth) &&
    Number.isFinite(camera.outputHeight) &&
    camera.outputWidth >= camera.outputHeight
  );
}

function clampPortraitSampleToStage(sample, baseWidth, baseHeight, stage) {
  const zoom = Number.isFinite(sample.zoom) && sample.zoom > 0 ? Math.max(1, sample.zoom) : 1;
  const visW = baseWidth / zoom;
  const visH = baseHeight / zoom;
  const halfW = visW / 2;
  const halfH = visH / 2;

  const minX = halfW;
  const maxX = stage.width - halfW;
  const minY = halfH;
  const maxY = stage.height - halfH;

  const x = minX <= maxX ? Math.min(maxX, Math.max(minX, sample.x)) : stage.width / 2;
  const y = minY <= maxY ? Math.min(maxY, Math.max(minY, sample.y)) : stage.height / 2;
  return {
    x: Object.is(x, -0) ? 0 : x,
    y: Object.is(y, -0) ? 0 : y,
    zoom,
  };
}

function samplePortraitSmartFollow(timeline, camera, t, baseWidth, baseHeight, stage) {
  const rawFocusAt = (tau) => {
    const camSample = sampleCamera(camera, tau);
    const camRect = cameraViewportRect(camera, camSample);
    let focusX = camSample.x;
    let focusY = camSample.y;
    let cursorStage = null;

    if (timeline?.overlays?.cursor && timeline?.take?.viewport && timeline?.window) {
      const rawCursor = sampleCursor(timeline.overlays.cursor, tau);
      if (rawCursor && rawCursor.visible) {
        cursorStage = projectViewportToStage(rawCursor.x, rawCursor.y, timeline);
        const marginX = Math.max(1, camRect.width * 0.15);
        const marginY = Math.max(1, camRect.height * 0.15);
        const distOutX = Math.max(0, camRect.left - cursorStage.x, cursorStage.x - camRect.right);
        const distOutY = Math.max(0, camRect.top - cursorStage.y, cursorStage.y - camRect.bottom);
        const outsideRatio = Math.max(distOutX / marginX, distOutY / marginY);
        const cursorWeight = Math.max(0, Math.min(1, 1 - outsideRatio));

        const weight = camSample.zoom <= 1.05 ? cursorWeight : cursorWeight * 0.7;
        focusX = camSample.x + (cursorStage.x - camSample.x) * weight;
        focusY = camSample.y + (cursorStage.y - camSample.y) * weight;
      }
    }

    const portraitZoom = camSample.zoom > 1 ? 1 + (camSample.zoom - 1) * 0.5 : 1;
    return { x: focusX, y: focusY, zoom: portraitZoom, cursorStage, camSample, camRect };
  };

  const duration =
    Number.isFinite(timeline?.take?.duration) && timeline.take.duration > 0
      ? timeline.take.duration
      : 0;

  let sumW = 0;
  let smoothX = 0;
  let smoothY = 0;
  let smoothZoom = 0;

  for (const u of PORTRAIT_SMOOTH_OFFSETS) {
    const w = 0.5 * (1 + Math.cos(Math.PI * u * 0.85));
    const shifted = t + u * PORTRAIT_SMOOTH_HALF_WINDOW;
    const tau = duration > 0 ? Math.max(0, Math.min(duration, shifted)) : Math.max(0, shifted);
    const pt = rawFocusAt(tau);
    smoothX += pt.x * w;
    smoothY += pt.y * w;
    smoothZoom += pt.zoom * w;
    sumW += w;
  }

  let x = smoothX / sumW;
  let y = smoothY / sumW;
  const zoom = Math.max(1, smoothZoom / sumW);

  // Keep instantaneous visible cursor within the inner 70% of the portrait crop when in landscape view
  const now = rawFocusAt(t);
  if (now.cursorStage) {
    const { camRect } = now;
    const inLandscapeView =
      now.cursorStage.x >= camRect.left &&
      now.cursorStage.x <= camRect.right &&
      now.cursorStage.y >= camRect.top &&
      now.cursorStage.y <= camRect.bottom;
    if (inLandscapeView) {
      const visW = baseWidth / zoom;
      const visH = baseHeight / zoom;
      const maxLeadX = visW * 0.35;
      const maxLeadY = visH * 0.35;
      if (now.cursorStage.x - x > maxLeadX) x = now.cursorStage.x - maxLeadX;
      else if (x - now.cursorStage.x > maxLeadX) x = now.cursorStage.x + maxLeadX;
      if (now.cursorStage.y - y > maxLeadY) y = now.cursorStage.y - maxLeadY;
      else if (y - now.cursorStage.y > maxLeadY) y = now.cursorStage.y + maxLeadY;
    }
  }

  return clampPortraitSampleToStage({ x, y, zoom }, baseWidth, baseHeight, stage);
}

/**
 * Compute camera sample and stage-to-render-frame affine transform at timestamp `t`.
 * Supports output profiles (`renderWidth x renderHeight`) that scale relative to
 * `camera.outputWidth x camera.outputHeight` (e.g. 2560x1440 YouTube master),
 * as well as portrait 9:16 vertical reframing (e.g. 1080x1920 Shorts) via optional
 * `camera.verticalKeyframes` or automatic smart-follow clamped inside stage bounds.
 */
export function computeCameraTransform(camera, t, renderWidth, renderHeight, timeline = null) {
  const portrait = isPortraitOutput(renderWidth, renderHeight);
  const reframed = shouldUsePortraitReframe(camera, renderWidth, renderHeight);

  let effectiveOutputWidth = camera.outputWidth;
  let effectiveOutputHeight = camera.outputHeight;
  let sample;
  let mode = 'standard';

  if (reframed) {
    const stage =
      timeline?.stage &&
      Number.isFinite(timeline.stage.width) &&
      timeline.stage.width > 0 &&
      Number.isFinite(timeline.stage.height) &&
      timeline.stage.height > 0
        ? timeline.stage
        : { width: camera.outputWidth, height: camera.outputHeight };
    const renderAspect = renderWidth / renderHeight;
    const base = portraitBaseDimensions(stage, renderAspect);
    effectiveOutputWidth = base.width;
    effectiveOutputHeight = base.height;

    if (Array.isArray(camera.verticalKeyframes) && camera.verticalKeyframes.length > 0) {
      const rawVertical = sampleCamera({ keyframes: camera.verticalKeyframes }, t);
      sample = clampPortraitSampleToStage(rawVertical, base.width, base.height, stage);
      mode = 'portrait-vertical-keyframes';
    } else {
      sample = samplePortraitSmartFollow(timeline, camera, t, base.width, base.height, stage);
      mode = 'portrait-smart-follow';
    }
  } else {
    sample = sampleCamera(camera, t);
  }

  const frameMap = screenToRender(
    0,
    0,
    effectiveOutputWidth,
    effectiveOutputHeight,
    renderWidth,
    renderHeight
  );
  const { scale: outputScale, offsetX, offsetY, logicalWidth, logicalHeight } = frameMap;
  const effectiveScale = sample.zoom * outputScale;
  const translateX = offsetX + logicalWidth / 2 - sample.x * effectiveScale;
  const translateY = offsetY + logicalHeight / 2 - sample.y * effectiveScale;

  const visW = effectiveOutputWidth / sample.zoom;
  const visH = effectiveOutputHeight / sample.zoom;
  const visibleRect = {
    left: Object.is(sample.x - visW / 2, -0) ? 0 : sample.x - visW / 2,
    top: Object.is(sample.y - visH / 2, -0) ? 0 : sample.y - visH / 2,
    right: Object.is(sample.x + visW / 2, -0) ? 0 : sample.x + visW / 2,
    bottom: Object.is(sample.y + visH / 2, -0) ? 0 : sample.y + visH / 2,
    width: visW,
    height: visH,
  };

  return {
    mode,
    portrait,
    reframed,
    outputWidth: effectiveOutputWidth,
    outputHeight: effectiveOutputHeight,
    visibleRect,
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

/**
 * Project a viewport-space point `(vx, vy)` directly into rendered frame coordinates
 * `(renderWidth x renderHeight)` at timestamp `t`, honoring both landscape scaling and
 * portrait 9:16 vertical reframing.
 */
export function projectViewportToRender(
  vx,
  vy,
  timeline,
  t,
  renderWidth,
  renderHeight,
  cameraStateOverride = null
) {
  const cameraState =
    cameraStateOverride ??
    computeCameraTransform(timeline.camera, t, renderWidth, renderHeight, timeline);
  const stagePoint = projectViewportToStage(vx, vy, timeline);
  const screenX =
    (stagePoint.x - cameraState.sample.x) * cameraState.sample.zoom + cameraState.outputWidth / 2;
  const screenY =
    (stagePoint.y - cameraState.sample.y) * cameraState.sample.zoom + cameraState.outputHeight / 2;
  const mapped = screenToRender(
    screenX,
    screenY,
    cameraState.outputWidth,
    cameraState.outputHeight,
    renderWidth,
    renderHeight
  );
  return {
    x: Object.is(mapped.x, -0) ? 0 : mapped.x,
    y: Object.is(mapped.y, -0) ? 0 : mapped.y,
    screenX: Object.is(screenX, -0) ? 0 : screenX,
    screenY: Object.is(screenY, -0) ? 0 : screenY,
    stageX: stagePoint.x,
    stageY: stagePoint.y,
    cameraState,
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

function getRangeIndex(items, kind) {
  const len = items.length;
  const firstItem = len > 0 ? items[0] : null;
  const lastItem = len > 0 ? items[len - 1] : null;
  const lastStart =
    lastItem && typeof lastItem === 'object'
      ? kind === 'ripple'
        ? lastItem.t
        : lastItem.start
      : 0;
  const lastEnd =
    lastItem && typeof lastItem === 'object'
      ? kind === 'ripple'
        ? lastItem.t + lastItem.duration
        : lastItem.end
      : 0;

  let cached = RANGE_INDEX_CACHE.get(items);
  if (
    cached &&
    cached.kind === kind &&
    cached.length === len &&
    cached.firstItem === firstItem &&
    cached.lastItem === lastItem &&
    cached.lastStart === lastStart &&
    cached.lastEnd === lastEnd
  ) {
    return cached;
  }

  let sorted = true;
  let runningMaxEnd = -Infinity;
  const starts = new Float64Array(len);
  const prefixMaxEnd = new Float64Array(len);
  for (let i = 0; i < len; i += 1) {
    const item = items[i];
    if (!item || typeof item !== 'object') {
      sorted = false;
      break;
    }
    const start = kind === 'ripple' ? item.t : item.start;
    const end = kind === 'ripple' ? item.t + item.duration : item.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || (i > 0 && start < starts[i - 1])) {
      sorted = false;
      break;
    }
    starts[i] = start;
    if (end > runningMaxEnd) runningMaxEnd = end;
    prefixMaxEnd[i] = runningMaxEnd;
  }

  cached = {
    kind,
    length: len,
    firstItem,
    lastItem,
    lastStart,
    lastEnd,
    sorted,
    starts,
    prefixMaxEnd,
  };
  RANGE_INDEX_CACHE.set(items, cached);
  return cached;
}

function findRightmostStartLe(starts, t) {
  if (starts.length === 0 || t < starts[0]) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function findFirstPrefixEndGe(prefixMaxEnd, hiInclusive, t) {
  if (hiInclusive < 0 || prefixMaxEnd[hiInclusive] < t) return hiInclusive + 1;
  let lo = 0;
  let hi = hiInclusive;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prefixMaxEnd[mid] >= t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function findFirstPrefixEndGt(prefixMaxEnd, hiInclusive, t) {
  if (hiInclusive < 0 || prefixMaxEnd[hiInclusive] <= t) return hiInclusive + 1;
  let lo = 0;
  let hi = hiInclusive;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prefixMaxEnd[mid] > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Compute all screen-space overlays at timestamp `t`.
 * Overlays are projected AFTER the camera via `projectViewportToScreen` so their anchor points
 * track zoomed/panned targets accurately while their visual scale stays constant (`outputScale`),
 * independent of `camera.zoom`.
 */
export function computeOverlaysAtTime(timeline, t, renderWidth, renderHeight, cameraStateOverride = null) {
  const cameraState =
    cameraStateOverride ??
    computeCameraTransform(timeline.camera, t, renderWidth, renderHeight, timeline);
  const { offsetX, offsetY, logicalWidth, logicalHeight, portrait } = cameraState;
  const effectiveRenderWidth =
    Number.isFinite(renderWidth) && renderWidth > 0 ? renderWidth : cameraState.outputWidth;
  const effectiveRenderHeight =
    Number.isFinite(renderHeight) && renderHeight > 0 ? renderHeight : cameraState.outputHeight;
  const overlayScale = portrait ? effectiveRenderWidth / 720 : cameraState.outputScale;

  const projectPoint = (vx, vy) =>
    projectViewportToRender(
      vx,
      vy,
      timeline,
      t,
      effectiveRenderWidth,
      effectiveRenderHeight,
      cameraState
    );

  // 1. Cursor overlay
  let cursor = null;
  const rawCursor = sampleCursor(timeline.overlays?.cursor, t);
  if (rawCursor && rawCursor.visible) {
    const projected = projectPoint(rawCursor.x, rawCursor.y);
    cursor = {
      style: timeline.overlays.cursor.style ?? 'macos',
      ...(timeline.overlays.cursor.color ? { color: timeline.overlays.cursor.color } : {}),
      ...(timeline.overlays.cursor.shadow !== undefined ? { shadow: timeline.overlays.cursor.shadow } : {}),
      ...(timeline.overlays.cursor.hidden !== undefined ? { hidden: timeline.overlays.cursor.hidden } : {}),
      viewportX: rawCursor.x,
      viewportY: rawCursor.y,
      screenX: projected.screenX,
      screenY: projected.screenY,
      x: projected.x,
      y: projected.y,
      pressed: rawCursor.pressed,
      scale: overlayScale,
      pressScale: rawCursor.pressed ? 0.88 : 1,
    };
  }

  // 2. Click ripples (binary-searched active range on sorted ripples)
  const ripples = [];
  const rawRipples = timeline.overlays?.ripples;
  if (Array.isArray(rawRipples) && rawRipples.length > 0) {
    const rippleIndex = getRangeIndex(rawRipples, 'ripple');
    let startIdx = 0;
    let endIdx = rawRipples.length - 1;
    if (rippleIndex.sorted) {
      endIdx = findRightmostStartLe(rippleIndex.starts, t);
      startIdx = findFirstPrefixEndGe(rippleIndex.prefixMaxEnd, endIdx, t);
    }
    for (let index = startIdx; index <= endIdx; index += 1) {
      const ripple = rawRipples[index];
      if (t < ripple.t || t > ripple.t + ripple.duration) continue;
      const progress = Math.min(1, Math.max(0, (t - ripple.t) / ripple.duration));
      const eased = 1 - (1 - progress) ** 3;
      const projected = projectPoint(ripple.x, ripple.y);
      ripples.push({
        key: `ripple-${index}-${ripple.t}`,
        button: ripple.button,
        progress,
        screenX: projected.screenX,
        screenY: projected.screenY,
        x: projected.x,
        y: projected.y,
        scale: overlayScale,
        radius: (8 + 28 * eased) * overlayScale,
        strokeWidth: Math.max(1.5, 2.5 * (1 - progress * 0.4) * overlayScale),
        opacity: Math.max(0, (1 - progress) ** 1.4 * 0.9),
        color: RIPPLE_COLORS[ripple.button] ?? RIPPLE_COLORS.left,
      });
    }
  }

  const MIN_HUD_DURATION = 1.0;

  // 3. Wheel / trackpad / drag gesture indicators (minimum 1.0s visible duration; latest active wins)
  const gestures = [];
  const rawGestures = timeline.overlays?.gestures ?? [];
  for (const [index, gesture] of rawGestures.entries()) {
    const nextStart = index + 1 < rawGestures.length ? rawGestures[index + 1].t : Infinity;
    const displayDuration = Math.min(
      Math.max(gesture.duration, MIN_HUD_DURATION),
      Math.max(gesture.duration, nextStart - gesture.t)
    );
    if (t < gesture.t || t > gesture.t + displayDuration) continue;
    const progress = Math.min(1, Math.max(0, (t - gesture.t) / Math.max(displayDuration, 0.001)));
    const projected = projectPoint(gesture.x, gesture.y);
    const magnitude = Math.hypot(gesture.deltaX, gesture.deltaY);
    const angleDeg = magnitude > 0 ? (Math.atan2(gesture.deltaY, gesture.deltaX) * 180) / Math.PI : 90;
    gestures.push({
      key: `gesture-${index}-${gesture.t}`,
      kind: gesture.kind,
      label: GESTURE_LABELS[gesture.kind] ?? gesture.kind,
      progress,
      screenX: projected.screenX,
      screenY: projected.screenY,
      x: projected.x,
      y: projected.y,
      deltaX: gesture.deltaX,
      deltaY: gesture.deltaY,
      magnitude,
      angleDeg,
      scale: overlayScale,
      opacity: envelopeOpacity(progress, 0.1, 0.22),
    });
  }

  // 4. Keystroke pills (minimum 1.0s visible duration so rapid shortcuts never flicker)
  const keystrokes = [];
  for (const [index, ks] of (timeline.overlays?.keystrokes ?? []).entries()) {
    const displayDuration = Math.max(ks.duration, MIN_HUD_DURATION);
    if (t < ks.t || t > ks.t + displayDuration) continue;
    const progress = Math.min(1, Math.max(0, (t - ks.t) / displayDuration));
    const opacity = envelopeOpacity(progress, 0.08, 0.2);
    const liftPx = (1 - Math.min(1, progress / 0.1)) * 6 * overlayScale;
    keystrokes.push({
      key: `keystroke-${index}-${ks.t}`,
      label: ks.label,
      keys: ks.keys,
      progress,
      opacity,
      liftPx,
      scale: overlayScale,
    });
  }

  // 5. Captions (binary-searched active range on sorted cues when enabled in timeline.overlays.captions)
  const captions = [];
  if (timeline.overlays?.captions?.enabled) {
    const rawCues = timeline.overlays.captions.tracks?.[0]?.cues;
    if (Array.isArray(rawCues) && rawCues.length > 0) {
      const cueIndex = getRangeIndex(rawCues, 'cue');
      let startIdx = 0;
      let endIdx = rawCues.length - 1;
      if (cueIndex.sorted) {
        endIdx = findRightmostStartLe(cueIndex.starts, t);
        startIdx = findFirstPrefixEndGt(cueIndex.prefixMaxEnd, endIdx, t);
      }
      for (let index = startIdx; index <= endIdx; index += 1) {
        const cue = rawCues[index];
        if (t >= cue.start && t < cue.end && cue.text.trim().length > 0) {
          captions.push({
            key: `caption-${index}-${cue.start}`,
            text: cue.text,
            scale: overlayScale,
          });
        }
      }
    }
  }

  let hudAnchor;
  if (portrait) {
    const safeLeft = Math.round(effectiveRenderWidth * (48 / 1080));
    const safeRight = Math.round(effectiveRenderWidth * (144 / 1080));
    const safeBottom = Math.round(effectiveRenderHeight * (240 / 1920));
    const safeTop = Math.round(effectiveRenderHeight * (120 / 1920));
    const safeWidth = Math.max(120, effectiveRenderWidth - safeLeft - safeRight);
    hudAnchor = {
      left: safeLeft,
      width: safeWidth,
      centerX: safeLeft + safeWidth / 2,
      bottomY: effectiveRenderHeight - safeBottom,
      maxWidth: safeWidth,
      safeMargins: {
        left: safeLeft,
        right: safeRight,
        bottom: safeBottom,
        top: safeTop,
      },
      portrait: true,
    };
  } else {
    const centerX = offsetX + logicalWidth / 2;
    const maxWidth = 720 * overlayScale;
    const safeWidth = Math.max(120, Math.min(effectiveRenderWidth, maxWidth));
    const safeLeft = centerX - safeWidth / 2;
    hudAnchor = {
      left: safeLeft,
      width: safeWidth,
      centerX,
      bottomY: offsetY + logicalHeight - 40 * overlayScale,
      maxWidth,
      portrait: false,
    };
  }

  return {
    scale: overlayScale,
    hudAnchor,
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
  const camera = computeCameraTransform(timeline.camera, t, renderWidth, renderHeight, timeline);
  const overlays = computeOverlaysAtTime(timeline, t, renderWidth, renderHeight, camera);
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
