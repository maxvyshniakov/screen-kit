// Spike: can headless or headful Chromium on macOS screencast at 2x while a CDP trackpad gesture rubber-bands?
// MODE=flag     headless, --force-device-scale-factor=2, no DPR emulation
// MODE=headful  a real window on the Retina display, no DPR emulation
// Measures: frame size, frames per second during the gesture, and the bounce, as the marker bar's x in each frame.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const require = createRequire("/Users/maxwish/data-grid/package.json");
const { chromium } = require("playwright");

const mode = process.env.MODE ?? "flag";
const dir = new URL(`./out-${mode}-${process.env.FORMAT ?? "png"}/`, import.meta.url).pathname;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const W = 1440, H = 810;
const args = ["--force-color-profile=display-p3-d65", ...(process.env.BEHIND ? ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] : [])];
if (mode === "flag") args.push("--force-device-scale-factor=2");
const browser = await chromium.launch({ headless: mode !== "headful", args });
const context = await browser.newContext({ viewport: { width: W, height: H }, ...(process.env.DSF ? { deviceScaleFactor: Number(process.env.DSF) } : {}) });
const page = await context.newPage();
// A horizontal scroller at its left edge; a 6 px black bar marks the content's left edge.
await page.setContent(`<!doctype html><style>
  html,body{margin:0;background:#fff;font:16px system-ui}
  #s{overflow-x:auto;overscroll-behavior-x:contain;width:100vw;height:400px;margin-top:200px;background:#eee}
  #c{width:4000px;height:100%;position:relative;background:repeating-linear-gradient(90deg,#fff 0 98px,#ccc 98px 100px)}
  #bar{position:absolute;left:0;top:0;bottom:0;width:6px;background:#000}
  p{position:absolute;left:40px;top:40px;font-size:24px}
</style><div id=s><div id=c><div id=bar></div><p>Retina spike: text should be crisp at 2x.</p></div></div>`);
if (process.env.BEHIND) {
  // Hand focus back to the app that had it, so the window works behind the owner's windows.
  execFileSync("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("${process.env.BEHIND}"); a.count ? a.objectAtIndex(0).activateWithOptions(0) : false`]);
  await page.waitForTimeout(800);
}
const info = await page.evaluate(() => ({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight] }));
const cdp = await context.newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  frames.push({ t: metadata.timestamp, data });
  await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: process.env.FORMAT ?? "png", quality: 92, maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 1, maxFramesInFlight: Number(process.env.INFLIGHT ?? 1) });
await page.waitForTimeout(500);
const before = frames.length;
// Drag past the left edge: positive xDistance moves content right, which at scrollLeft 0 is overscroll.
await cdp.send("Input.synthesizeScrollGesture", { x: 700, y: 400, xDistance: 300, yDistance: 0, gestureSourceType: "mouse", speed: 900, preventFling: false });
await page.waitForTimeout(1200);
await cdp.send("Page.stopScreencast");
const shot = frames.slice(before);
// Bar position: the first dark column in a row through the scroller, in the frame's own pixels.
function barX(png) {
  const file = `${dir}f.${process.env.FORMAT === "jpeg" ? "jpg" : "png"}`;
  fs.writeFileSync(file, png);
  const size = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).trim().split(",").map(Number);
  const [fw, fh] = size;
  const y = Math.round(fh * (420 / H));
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `format=gray,crop=${fw}:1:0:${y}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  let x = -1;
  for (let i = 0; i < raw.length; i++) if (raw[i] < 40) { x = i; break; }
  return { fw, fh, x };
}
const rows = shot.map((f) => ({ t: f.t, ...barX(Buffer.from(f.data, "base64")) }));
const span = rows.length > 1 ? rows.at(-1).t - rows[0].t : 0;
const scale = rows[0] ? rows[0].fw / W : 0;
const peak = Math.max(...rows.map((r) => r.x));
if (shot[Math.floor(shot.length / 4)]) fs.writeFileSync(`${dir}peak.png`, Buffer.from(shot[rows.findIndex((r) => r.x === peak)].data, "base64"));
console.log(JSON.stringify({
  mode, dsf: process.env.DSF ?? "-", behind: !!process.env.BEHIND, version: browser.version(), page: info,
  frame: rows[0] && [rows[0].fw, rows[0].fh], scale,
  frames: rows.length, seconds: +span.toFixed(2), fps: span ? +(rows.length / span).toFixed(1) : 0,
  bouncePx: peak, bounceCss: scale ? +(peak / scale).toFixed(1) : 0,
  xs: rows.map((r) => r.x).join(","),
}));
await browser.close();
