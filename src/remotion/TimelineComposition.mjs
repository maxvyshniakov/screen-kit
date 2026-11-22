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
import { buildSquirclePath, computeFrameScene } from './layout.mjs';

const h = React.createElement;

const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif';
const MONO_FONT =
  '"SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function renderTrafficLights() {
  const lights = [
    { fill: '#ff5f57', border: 'rgba(224, 68, 62, 0.72)' },
    { fill: '#febc2e', border: 'rgba(222, 161, 35, 0.72)' },
    { fill: '#28c840', border: 'rgba(26, 171, 41, 0.72)' },
  ];
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 16,
        flexShrink: 0,
      },
    },
    ...lights.map((light, idx) =>
      h('span', {
        key: idx,
        style: {
          width: 12,
          height: 12,
          borderRadius: '50%',
          backgroundColor: light.fill,
          boxShadow: `inset 0 0 0 0.75px ${light.border}, 0 0.5px 1px rgba(0, 0, 0, 0.35)`,
          display: 'inline-block',
        },
      })
    )
  );
}

function renderBrowserNavIcons() {
  const iconStyle = { display: 'block', opacity: 0.32 };
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginLeft: 18,
        flexShrink: 0,
      },
    },
    h(
      'svg',
      { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', style: iconStyle },
      h('path', {
        d: 'M7.75 2.25L4 6L7.75 9.75',
        stroke: '#e2e8f0',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      })
    ),
    h(
      'svg',
      { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', style: { display: 'block', opacity: 0.18 } },
      h('path', {
        d: 'M4.25 2.25L8 6L4.25 9.75',
        stroke: '#e2e8f0',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
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
          background: 'linear-gradient(180deg, #27292e 0%, #1d1f24 100%)',
          borderBottom: '1px solid rgba(0, 0, 0, 0.55)',
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
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
                left: 88,
                right: 88,
                textAlign: 'center',
                color: 'rgba(241, 245, 249, 0.82)',
                fontFamily: UI_FONT,
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '-0.005em',
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
          background: 'linear-gradient(180deg, #25272d 0%, #1c1e23 100%)',
          borderBottom: '1px solid rgba(0, 0, 0, 0.58)',
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
          userSelect: 'none',
        },
      },
      renderTrafficLights(),
      renderBrowserNavIcons(),
      h(
        'div',
        {
          style: {
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            minWidth: Math.min(340, Math.max(160, windowChrome.outerRect.width * 0.34)),
            maxWidth: Math.max(200, windowChrome.outerRect.width - 260),
            height: 27,
            padding: '0 14px',
            borderRadius: 8,
            backgroundColor: 'rgba(255, 255, 255, 0.055)',
            boxShadow:
              'inset 0 0 0 0.75px rgba(255, 255, 255, 0.075), inset 0 1px 2px rgba(0, 0, 0, 0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            color: 'rgba(226, 232, 240, 0.76)',
            fontFamily: UI_FONT,
            fontSize: 12,
            fontWeight: 450,
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          },
        },
        h(
          'svg',
          {
            width: 10,
            height: 11,
            viewBox: '0 0 10 11',
            fill: 'none',
            style: { flexShrink: 0, opacity: 0.48 },
          },
          h('rect', {
            x: 1.5,
            y: 4.5,
            width: 7,
            height: 5.2,
            rx: 1.4,
            fill: '#cbd5e1',
          }),
          h('path', {
            d: 'M3.1 4.5V3.2C3.1 2.15 3.95 1.3 5 1.3C6.05 1.3 6.9 2.15 6.9 3.2V4.5',
            stroke: '#cbd5e1',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
          })
        ),
        h(
          'span',
          {
            style: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          addressText
        )
      )
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

function hudPillStyle(scale, { opacity = 1, liftPx = 0, mono = false } = {}) {
  return {
    opacity,
    transform: liftPx ? `translateY(${liftPx}px)` : undefined,
    padding: `${9 * scale}px ${16 * scale}px`,
    borderRadius: 12 * scale,
    backgroundColor: 'rgba(14, 15, 19, 0.88)',
    border: `${Math.max(1, 1 * scale)}px solid rgba(255, 255, 255, 0.14)`,
    boxShadow:
      '0 10px 28px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
    color: '#ffffff',
    fontFamily: mono ? MONO_FONT : UI_FONT,
    fontSize: (mono ? 16 : 15) * scale,
    fontWeight: mono ? 600 : 500,
    letterSpacing: mono ? '0.03em' : '-0.005em',
    lineHeight: 1.15,
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8 * scale,
  };
}

function renderGesturePill(gesture) {
  const s = gesture.scale;
  return h(
    'div',
    {
      key: gesture.key,
      'data-overlay': 'gesture',
      style: hudPillStyle(s, { opacity: gesture.opacity }),
    },
    h(
      'svg',
      {
        width: 16 * s,
        height: 16 * s,
        viewBox: '0 0 24 24',
        fill: 'none',
        style: {
          flexShrink: 0,
          opacity: 0.9,
          transform: `rotate(${gesture.angleDeg}deg)`,
        },
      },
      gesture.kind === 'pinch'
        ? h('path', {
            d: 'M4 12H10M14 12H20M7 9L4 12L7 15M17 9L20 12L17 15',
            stroke: '#ffffff',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })
        : h('path', {
            d: 'M5 12H19M13 6L19 12L13 18',
            stroke: '#ffffff',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })
    ),
    h('span', null, gesture.label)
  );
}

function renderBottomHud(gestures, keystrokes, hudAnchor) {
  if (!gestures.length && !keystrokes.length) return null;
  const s = (keystrokes[0] ?? gestures[0]).scale;
  return h(
    'div',
    {
      'data-overlay': keystrokes.length ? 'keystrokes' : 'gesture-hud',
      style: {
        position: 'absolute',
        left: hudAnchor.centerX,
        top: hudAnchor.bottomY,
        transform: 'translate(-50%, -100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10 * s,
        pointerEvents: 'none',
      },
    },
    ...gestures.map(renderGesturePill),
    ...keystrokes.map((ks) =>
      h(
        'div',
        {
          key: ks.key,
          style: hudPillStyle(ks.scale, {
            opacity: ks.opacity,
            liftPx: ks.liftPx,
            mono: true,
          }),
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
  const outerW = windowChrome.outerRect.width;
  const outerH = windowChrome.outerRect.height;
  const outerRadius = windowChrome.borderRadius;
  const hasRoundedCorners = outerRadius > 0.01;
  const squirclePath = hasRoundedCorners ? buildSquirclePath(outerW, outerH, outerRadius, 0.6) : '';
  const squircleClipId = 'screen-kit-window-squircle';
  const rimGradId = 'screen-kit-window-rim-grad';
  const windowShadowFilter = windowChrome.shadow
    ? 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.38)) drop-shadow(0 18px 36px rgba(0, 0, 0, 0.44)) drop-shadow(0 38px 72px rgba(0, 0, 0, 0.36))'
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
      // Shadow wrapper follows the exact squircle silhouette via CSS drop-shadow
      h(
        'div',
        {
          'data-layer': 'window-shadow',
          style: {
            position: 'absolute',
            left: windowChrome.outerRect.x,
            top: windowChrome.outerRect.y,
            width: outerW,
            height: outerH,
            filter: windowShadowFilter,
          },
        },
        hasRoundedCorners
          ? h(
              'svg',
              {
                width: 0,
                height: 0,
                style: { position: 'absolute', pointerEvents: 'none' },
                'aria-hidden': 'true',
              },
              h(
                'defs',
                null,
                h(
                  'clipPath',
                  { id: squircleClipId, clipPathUnits: 'userSpaceOnUse' },
                  h('path', { d: squirclePath })
                )
              )
            )
          : null,
        h(
          'div',
          {
            'data-layer': 'window-frame',
            'data-frame-kind': windowChrome.frame,
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              width: outerW,
              height: outerH,
              ...(hasRoundedCorners
                ? { clipPath: `url(#${squircleClipId})` }
                : {}),
              backgroundColor: windowChrome.frame === 'device' ? '#0b0f17' : '#111318',
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
                borderRadius: windowChrome.frame === 'device' ? Math.max(0, outerRadius - 12) : 0,
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
        ),
        // Precision vector double-hairline rim (dark outer edge + vertical specular inner edge)
        hasRoundedCorners
          ? h(
              'svg',
              {
                'data-layer': 'window-rim',
                width: outerW,
                height: outerH,
                viewBox: `0 0 ${outerW} ${outerH}`,
                fill: 'none',
                style: {
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  pointerEvents: 'none',
                  overflow: 'visible',
                },
              },
              h(
                'defs',
                null,
                h(
                  'linearGradient',
                  { id: rimGradId, x1: '0', y1: '0', x2: '0', y2: '1' },
                  h('stop', { offset: '0%', stopColor: 'rgba(255, 255, 255, 0.24)' }),
                  h('stop', { offset: '18%', stopColor: 'rgba(255, 255, 255, 0.11)' }),
                  h('stop', { offset: '100%', stopColor: 'rgba(255, 255, 255, 0.05)' })
                )
              ),
              h('path', {
                d: squirclePath,
                stroke: 'rgba(0, 0, 0, 0.62)',
                strokeWidth: 2,
              }),
              h('path', {
                d: squirclePath,
                stroke: `url(#${rimGradId})`,
                strokeWidth: 1.5,
                clipPath: `url(#${squircleClipId})`,
              })
            )
          : null
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
      renderCaptions(
        overlays.captions,
        overlays.hudAnchor,
        overlays.keystrokes.length > 0 || overlays.gestures.length > 0
      ),
      renderBottomHud(overlays.gestures, overlays.keystrokes, overlays.hudAnchor),
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
