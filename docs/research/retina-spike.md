# Retina capture spike (2026-11-04)

Question: can an agent capture 2× video of a web page in Chromium on macOS, at 60 fps, with a
real trackpad rubber band, without taking over the owner's screen?

Answer: **yes, with a real Chromium window on the Retina display, kept behind the owner's
windows.** Headless gets 2× only at about 16 fps.

Setup:
- Chromium 156.0.8078.4 (Playwright 1.64.1), CDP `Page.startScreencast`.
- A 1440 × 810 CSS viewport.
- A CDP trackpad gesture (`Input.synthesizeScrollGesture`, `gestureSourceType: "mouse"`)
  drawn 300 px past the left edge of an `overflow-x: auto` scroller.
- The bounce is measured from the frames' pixels (a marker bar's x), since the DOM does not see
  the compositor's overscroll.
- Script: [retina-spike-2026-11-04/spike.mjs](retina-spike-2026-11-04/spike.mjs). It loads
  Playwright from a Data Grid checkout. **[probe]** for every row below.

| Mode | Page DPR | Frame | fps | Bounce |
| --- | --- | --- | --- | --- |
| Headless, no flag (1×) | 1 | 1440 × 810 | 39.6 | 16 CSS px |
| Headless, `--force-device-scale-factor=2`, PNG frames | 1 | 2880 × 1620, text crisp | 15.8 | 15.5 CSS px |
| Same, JPEG frames, 1 or 3 frames in flight | 1 | 2880 × 1620 | 15.8 / 16.1 | 15.5 CSS px |
| Headful window, no DPR emulation | 1 | 2880 × 1620 | 65.6 | 16 CSS px |
| Headful window, `deviceScaleFactor: 2` | 2 | 2880 × 1620 | 61.9 | 16 CSS px |
| Same, window behind another app (focus handed back) with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding` | 2 | 2880 × 1620 | 60.0 | 16 CSS px |

Findings:
- **Headless 2×:**
  - the frames are real 2× renders (text is crisp, not upscaled), but they arrive at about 16 fps
    whatever the image format or the frames in flight; the same page at 1× gives about 40;
  - the page still sees `devicePixelRatio` 1, so `srcset` and hairline rules pick their 1×
    variants.
- **Headful:** a window on the Retina display gives 2× frames at 60 fps. With
  `deviceScaleFactor: 2` the page sees DPR 2.
  - It keeps 60 fps behind another app's window if Chromium's occlusion backgrounding is off.
  - The launch takes focus for a moment; handing it back to the previous frontmost app is the
    same JXA call `browser-verify` uses for Safari Technology Preview.
  - The window must fit the screen: 1440 × 810 points needs a display at least that large.
- **Earlier, from [capture.md](capture.md):**
  - DPR emulation alone, `setDeviceMetricsOverride({ scale })` and `html { zoom: 2 }` do not
    give usable 2× headless frames;
  - `HeadlessExperimental.beginFrame` is unavailable on macOS, so frame-by-frame capture on a
    virtual clock is out on this Mac;
  - the rubber band is a compositor animation in real time anyway.

Not yet checked:
- Display P3 in the screencast JPEGs: does the colour profile survive? The site's stills are
  P3 PNG → WebP.
- 3× (the site's stills): no display here is 3×.
- Whether a gesture in a background window ever lands on the owner's foreground window: CDP
  input goes to the page, not to the OS, so it should not. **[inferred]**
