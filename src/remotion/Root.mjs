import React from 'react';
import { Composition } from 'remotion';
import { TimelineComposition } from './TimelineComposition.mjs';

export const COMPOSITION_ID = 'ScreenKitTimeline';

const DEFAULT_TIMELINE = {
  version: 1,
  take: {
    video: '',
    eventTrack: 'event-track.json',
    width: 1280,
    height: 720,
    fps: 30,
    duration: 1,
    frames: 30,
    captureMode: 'headless',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  },
  stage: {
    width: 1520,
    height: 960,
    padding: 120,
    background: { type: 'solid', color: '#0f172a' },
  },
  window: {
    frame: 'none',
    x: 120,
    y: 120,
    width: 1280,
    height: 720,
    borderRadius: 0,
    shadow: false,
  },
  camera: {
    outputWidth: 1280,
    outputHeight: 720,
    keyframes: [{ t: 0, x: 760, y: 480, zoom: 1, easing: 'linear' }],
  },
  overlays: {
    cursor: { enabled: false, style: 'macos', samples: [] },
    ripples: [],
    gestures: [],
    keystrokes: [],
    captions: { enabled: false, tracks: [] },
  },
  audio: { tracks: [] },
  outputs: [{ id: 'web-loop', format: 'webm', codec: 'vp9', width: 1280, height: 720, fps: 30, loop: true, poster: true }],
};

export function calculateTimelineMetadata({ props }) {
  const timeline = props?.timeline ?? DEFAULT_TIMELINE;
  const output = props?.output ?? {};
  const fps = Math.max(1, Math.round(output.fps ?? timeline.take?.fps ?? 30));
  const width = Math.max(2, Math.round(output.width ?? timeline.camera?.outputWidth ?? 1280));
  const height = Math.max(2, Math.round(output.height ?? timeline.camera?.outputHeight ?? 720));
  const durationSeconds = timeline.take?.duration ?? 1;
  const durationInFrames = Math.max(1, Math.round(durationSeconds * fps));

  return {
    fps,
    width,
    height,
    durationInFrames,
    props,
  };
}

export function RemotionRoot() {
  return React.createElement(Composition, {
    id: COMPOSITION_ID,
    component: TimelineComposition,
    defaultProps: {
      timeline: DEFAULT_TIMELINE,
      output: {
        width: 1280,
        height: 720,
        fps: 30,
      },
    },
    calculateMetadata: calculateTimelineMetadata,
  });
}
