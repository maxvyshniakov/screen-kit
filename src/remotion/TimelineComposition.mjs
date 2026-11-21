import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { computeFrameScene } from './layout.mjs';

const h = React.createElement;

const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif';
const MONO_FONT =
  '"SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function renderTrafficLights() {
  const colors = ['#ff5f57', '#febc2e', '#28c840'];
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 14,
        flexShrink: 0,
      },
    },
    ...colors.map((color, idx) =>
      h('span', {
        key: idx,
        style: {
          width: 12,
          height: 12,
          borderRadius: '50%',
          backgroundColor: color,
          boxShadow: 'inset 0 0 0 0.5px rgba(0, 0, 0, 0.28)',
          display: 'inline-block',
        },
      })
    )
  );
}

function renderTopChromeBar(windowChrome) {
  if (windowChrome.frame === 'macos') {
    return h(
      'div',
      {
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: windowChrome.outerRect.width,
          height: windowChrome.topBarHeight,
          background: 'linear-gradient(180deg, #2b303b 0%, #1f2430 100%)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
          userSelect: 'none',
        },
      },
      renderTrafficLights(),
      windowChrome.title
        ? h(
            'div',
            {
              style: {
                position: 'absolute',
                left: 84,
                right: 84,
                textAlign: 'center',
                color: 'rgba(241, 245, 249, 0.88)',
                fontFamily: UI_FONT,
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '0.01em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            windowChrome.title
          )
        : null
    );
  }

  if (windowChrome.frame === 'browser') {
    const addressText = windowChrome.title || 'app.local';
    return h(
      'div',
      {
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: windowChrome.outerRect.width,
          height: windowChrome.topBarHeight,
          backgroundColor: '#181c24',
          borderBottom: '1px solid rgba(255, 255, 255, 0.09)',
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
          userSelect: 'none',
        },
      },
      renderTrafficLights(),
      h(
        'div',
        {
          style: {
            margin: '0 auto',
            minWidth: Math.min(360, Math.max(140, windowChrome.outerRect.width * 0.42)),
            maxWidth: Math.max(180, windowChrome.outerRect.width - 180),
            height: 26,
            padding: '0 14px',
            borderRadius: 7,
            backgroundColor: 'rgba(255, 255, 255, 0.07)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(226, 232, 240, 0.85)',
            fontFamily: UI_FONT,
            fontSize: 12,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
        },
        addressText
      ),
      h('div', { style: { width: 66, flexShrink: 0 } })
    );
  }

  if (windowChrome.frame === 'device') {
    return h(
      React.Fragment,
      null,
      h(
        'div',
        {
          style: {
            position: 'absolute',
            left: '50%',
            top: Math.max(6, (windowChrome.topBarHeight - 8) / 2),
            transform: 'translateX(-50%)',
            width: 68,
            height: 8,
            borderRadius: 999,
            backgroundColor: 'rgba(255, 255, 255, 0.14)',
          },
        }
      ),
      h(
        'div',
        {
          style: {
            position: 'absolute',
            left: '50%',
            bottom: Math.max(5, (windowChrome.bottomBarHeight - 4) / 2),
            transform: 'translateX(-50%)',
            width: Math.min(120, windowChrome.contentRect.width * 0.32),
            height: 4,
            borderRadius: 999,
            backgroundColor: 'rgba(255, 255, 255, 0.28)',
          },
        }
      )
    );
  }

  return null;
}

function renderCursorOverlay(cursor) {
  if (!cursor) return null;
  const combinedScale = cursor.scale * cursor.pressScale;

  if (cursor.style === 'dot') {
    const size = 18 * combinedScale;
    return h('div', {
      'data-overlay': 'cursor',
      style: {
        position: 'absolute',
        left: cursor.x - size / 2,
        top: cursor.y - size / 2,
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: cursor.pressed ? '#38bdf8' : 'rgba(255, 255, 255, 0.95)',
        border: `${Math.max(1.5, 2 * cursor.scale)}px solid rgba(15, 23, 42, 0.9)`,
        boxShadow: '0 3px 10px rgba(0, 0, 0, 0.35)',
        pointerEvents: 'none',
      },
    });
  }

  if (cursor.style === 'ring') {
    const size = 26 * combinedScale;
    return h('div', {
      'data-overlay': 'cursor',
      style: {
        position: 'absolute',
        left: cursor.x - size / 2,
        top: cursor.y - size / 2,
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: cursor.pressed ? 'rgba(56, 189, 248, 0.28)' : 'rgba(255, 255, 255, 0.12)',
        border: `${Math.max(2, 2.5 * cursor.scale)}px solid ${cursor.pressed ? '#38bdf8' : '#ffffff'}`,
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.38)',
        pointerEvents: 'none',
      },
    });
  }

  // Vector arrow cursor ('macos' and 'pointer') anchored with exact tip hotspot at (0, 0)
  const fill = cursor.style === 'pointer'
    ? (cursor.pressed ? '#bae6fd' : '#ffffff')
    : (cursor.pressed ? '#e2e8f0' : '#111827');
  const stroke = cursor.style === 'pointer' ? '#0f172a' : '#ffffff';

  return h(
    'div',
    {
      'data-overlay': 'cursor',
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        transformOrigin: '0 0',
        transform: `translate(${cursor.x}px, ${cursor.y}px) scale(${combinedScale})`,
        pointerEvents: 'none',
        filter: 'drop-shadow(0 2px 5px rgba(0, 0, 0, 0.42))',
      },
    },
    h(
      'svg',
      {
        width: 28,
        height: 32,
        viewBox: '0 0 28 32',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        style: { display: 'block', overflow: 'visible' },
      },
      h('path', {
        d: 'M1 1L1 23.2L6.6 18.1L10.7 27.4L14.3 25.8L10.2 16.6L17.8 16.6L1 1Z',
        fill,
        stroke,
        strokeWidth: 1.8,
        strokeLinejoin: 'round',
      }),
      cursor.pressed
        ? h('circle', {
            cx: 2,
            cy: 2,
            r: 4.5,
            fill: 'rgba(56, 189, 248, 0.85)',
          })
        : null
    )
  );
}

function renderRippleOverlay(ripple) {
  const diameter = ripple.radius * 2;
  return h('div', {
    key: ripple.key,
    'data-overlay': 'ripple',
    style: {
      position: 'absolute',
      left: ripple.x - ripple.radius,
      top: ripple.y - ripple.radius,
      width: diameter,
      height: diameter,
      borderRadius: '50%',
      border: `${ripple.strokeWidth}px solid ${ripple.color}`,
      backgroundColor: 'rgba(56, 189, 248, 0.08)',
      opacity: ripple.opacity,
      boxSizing: 'border-box',
      pointerEvents: 'none',
    },
  });
}

function renderGestureOverlay(gesture) {
  const s = gesture.scale;
  const badgeRadius = 22 * s;
  const travelOffset = (gesture.progress - 0.5) * 10 * s;

  return h(
    'div',
    {
      key: gesture.key,
      'data-overlay': 'gesture',
      style: {
        position: 'absolute',
        left: gesture.x,
        top: gesture.y,
        transform: 'translate(-50%, -50%)',
        opacity: gesture.opacity,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4 * s,
      },
    },
    h(
      'div',
      {
        style: {
          width: badgeRadius * 2,
          height: badgeRadius * 2,
          borderRadius: '50%',
          backgroundColor: 'rgba(15, 23, 42, 0.78)',
          border: `${Math.max(1, 1.5 * s)}px solid rgba(255, 255, 255, 0.28)`,
          boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
      h(
        'svg',
        {
          width: 24 * s,
          height: 24 * s,
          viewBox: '0 0 24 24',
          fill: 'none',
          style: {
            transform: `rotate(${gesture.angleDeg}deg) translateX(${travelOffset / Math.max(s, 0.01)}px)`,
          },
        },
        gesture.kind === 'pinch'
          ? h('path', {
              d: 'M4 12H10M14 12H20M7 9L4 12L7 15M17 9L20 12L17 15',
              stroke: '#38bdf8',
              strokeWidth: 2.2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            })
          : h('path', {
              d: 'M5 12H19M13 6L19 12L13 18',
              stroke: '#38bdf8',
              strokeWidth: 2.2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            })
      )
    ),
    h(
      'div',
      {
        style: {
          padding: `${2 * s}px ${8 * s}px`,
          borderRadius: 999,
          backgroundColor: 'rgba(15, 23, 42, 0.82)',
          border: `${Math.max(1, s)}px solid rgba(255, 255, 255, 0.16)`,
          color: '#f8fafc',
          fontFamily: UI_FONT,
          fontSize: 11 * s,
          fontWeight: 600,
          letterSpacing: '0.02em',
          whiteSpace: 'nowrap',
        },
      },
      gesture.label
    )
  );
}

function renderKeystrokePills(keystrokes, hudAnchor) {
  if (!keystrokes.length) return null;
  return h(
    'div',
    {
      'data-overlay': 'keystrokes',
      style: {
        position: 'absolute',
        left: hudAnchor.centerX,
        top: hudAnchor.bottomY,
        transform: 'translate(-50%, -100%)',
        display: 'flex',
        alignItems: 'center',
        gap: 10 * keystrokes[0].scale,
        pointerEvents: 'none',
      },
    },
    ...keystrokes.map((ks) =>
      h(
        'div',
        {
          key: ks.key,
          style: {
            opacity: ks.opacity,
            transform: `translateY(${ks.liftPx}px)`,
            padding: `${8 * ks.scale}px ${16 * ks.scale}px`,
            borderRadius: 10 * ks.scale,
            backgroundColor: 'rgba(15, 23, 42, 0.88)',
            border: `${Math.max(1, 1.5 * ks.scale)}px solid rgba(255, 255, 255, 0.22)`,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.14)',
            color: '#f8fafc',
            fontFamily: MONO_FONT,
            fontSize: 18 * ks.scale,
            fontWeight: 600,
            letterSpacing: '0.04em',
            lineHeight: 1.1,
            whiteSpace: 'nowrap',
          },
        },
        ks.label
      )
    )
  );
}

function renderCaptions(captions, hudAnchor, hasKeystrokes) {
  if (!captions.length) return null;
  const s = captions[0].scale;
  const extraOffset = hasKeystrokes ? 54 * s : 0;
  return h(
    'div',
    {
      'data-overlay': 'captions',
      style: {
        position: 'absolute',
        left: hudAnchor.centerX,
        top: hudAnchor.bottomY - extraOffset,
        transform: 'translate(-50%, -100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6 * s,
        pointerEvents: 'none',
      },
    },
    ...captions.map((caption) =>
      h(
        'div',
        {
          key: caption.key,
          style: {
            padding: `${6 * s}px ${14 * s}px`,
            borderRadius: 8 * s,
            backgroundColor: 'rgba(9, 13, 22, 0.82)',
            color: '#f8fafc',
            fontFamily: UI_FONT,
            fontSize: 18 * s,
            fontWeight: 500,
            textAlign: 'center',
            whiteSpace: 'pre-line',
            maxWidth: 720 * s,
          },
        },
        caption.text
      )
    )
  );
}

/**
 * Remotion 4 composition reading ONLY a validated `timeline` prop and staged media assets.
 */
export function TimelineComposition({ timeline, renderVideoElement = true }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const scene = computeFrameScene(timeline, {
    frame,
    fps,
    width,
    height,
    mapAsset: staticFile,
  });

  const { stage, windowChrome, videoSrc, camera, overlays, audioTracks } = scene;
  const windowShadow = windowChrome.shadow
    ? '0 28px 70px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.1)'
    : 'none';

  return h(
    AbsoluteFill,
    {
      style: {
        backgroundColor: stage.background.fallbackColor,
        overflow: 'hidden',
      },
    },
    // Layer 1: Camera-transformed stage + window chrome + clean take video
    h(
      'div',
      {
        'data-layer': 'camera-stage',
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: stage.width,
          height: stage.height,
          transformOrigin: '0 0',
          transform: camera.cssTransform,
          overflow: 'hidden',
          ...stage.background.style,
        },
      },
      stage.background.imageSrc
        ? h(Img, {
            src: stage.background.imageSrc,
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              width: '100%',
              height: '100%',
              objectFit: stage.background.imageFit ?? 'cover',
            },
          })
        : null,
      h(
        'div',
        {
          'data-layer': 'window-frame',
          'data-frame-kind': windowChrome.frame,
          style: {
            position: 'absolute',
            left: windowChrome.outerRect.x,
            top: windowChrome.outerRect.y,
            width: windowChrome.outerRect.width,
            height: windowChrome.outerRect.height,
            borderRadius: windowChrome.borderRadius,
            boxShadow: windowShadow,
            backgroundColor: windowChrome.frame === 'device' ? '#0b0f17' : '#111827',
            overflow: 'hidden',
          },
        },
        renderTopChromeBar(windowChrome),
        h(
          'div',
          {
            'data-layer': 'viewport-content',
            style: {
              position: 'absolute',
              left: windowChrome.contentOffset.left,
              top: windowChrome.contentOffset.top,
              width: windowChrome.contentRect.width,
              height: windowChrome.contentRect.height,
              borderRadius: windowChrome.frame === 'device' ? Math.max(0, windowChrome.borderRadius - 12) : 0,
              overflow: 'hidden',
              backgroundColor: '#000000',
            },
          },
          renderVideoElement && videoSrc
            ? h(OffthreadVideo, {
                src: videoSrc,
                muted: true,
                style: {
                  width: '100%',
                  height: '100%',
                  objectFit: 'fill',
                  display: 'block',
                },
              })
            : null
        )
      )
    ),
    // Layer 2: Screen-space overlays AFTER camera at constant scale
    h(
      AbsoluteFill,
      {
        'data-layer': 'screen-overlays',
        style: { pointerEvents: 'none', overflow: 'hidden' },
      },
      ...overlays.ripples.map(renderRippleOverlay),
      ...overlays.gestures.map(renderGestureOverlay),
      renderCaptions(overlays.captions, overlays.hudAnchor, overlays.keystrokes.length > 0),
      renderKeystrokePills(overlays.keystrokes, overlays.hudAnchor),
      renderCursorOverlay(overlays.cursor)
    ),
    // Layer 3: Optional timeline audio tracks
    ...audioTracks.map((track) =>
      h(
        Sequence,
        { key: track.id, from: track.startFrame },
        h(Audio, {
          src: track.resolvedSrc,
          volume: track.volume ?? 1,
        })
      )
    )
  );
}
