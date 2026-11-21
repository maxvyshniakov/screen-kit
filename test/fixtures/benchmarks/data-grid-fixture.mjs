import { createServer } from 'node:http';

const ROWS = [
  ['row-01', 'Hero Reel — Arrival Sequence', 'AST-2401', 'Approved', 'CinemaDNG', '98.4', '3840×2160', '142.8 MB', 'Display P3', '2m ago', 'hero, launch', 'M. Vyshniakov', 'Pinned opening loop with clean alpha edge'],
  ['row-02', 'Straylight Canvas — Route Preview', 'AST-2402', 'Approved', 'ProRes 4444', '97.9', '2880×1620', '96.4 MB', 'Display P3', '6m ago', 'canvas, nodes', 'A. Kovalenko', 'Retina 2× 60fps window behind foreground'],
  ['row-03', 'Data Grid — Horizontal Overscroll', 'AST-2403', 'Review', 'WebM VP9', '96.2', '2880×1620', '18.2 MB', 'BT.709', '11m ago', 'scroll, seam', 'M. Vyshniakov', 'Pinned left track holds crisp hairline seam'],
  ['row-04', 'Slotfather — Active Lane Queue', 'AST-2404', 'Approved', 'WebP Lossless', '99.1', '2400×1350', '4.7 MB', 'sRGB', '19m ago', 'pty, terminal', 'D. Moroz', 'Frozen historical workload with real j/k nav'],
  ['row-05', 'Siri Remote — Hold Home Chord', 'AST-2405', 'Approved', 'PNG 16-bit', '95.8', '1920×1080', '6.1 MB', 'Display P3', '24m ago', 'remote, hid', 'O. Savchenko', 'Vector callout aligned to physical ring'],
  ['row-06', 'Ulanzi Deck — Dial Sensitivity', 'AST-2406', 'Staged', 'MP4 H.264', '94.5', '2560×1440', '22.9 MB', 'BT.709', '33m ago', 'dial, scale', 'I. Bondar', 'Continuous rotation ticks feed state scale'],
  ['row-07', 'Column Resize — Live Track Fit', 'AST-2407', 'Approved', 'WebM VP9', '97.0', '2880×1620', '15.6 MB', 'BT.709', '41m ago', 'grid, resize', 'M. Vyshniakov', 'Zero header jitter across 60fps drag'],
  ['row-08', 'Quick Find — Highlighted Tokens', 'AST-2408', 'Approved', 'WebP', '96.7', '2880×1620', '3.9 MB', 'Display P3', '52m ago', 'search, filter', 'A. Kovalenko', 'Instant match counter across 10k rows'],
  ['row-09', 'Voice Setup — Local Kokoro Check', 'AST-2409', 'Draft', 'WAV + JSON', '92.3', '1920×1080', '12.0 MB', 'BT.709', '1h ago', 'tts, captions', 'D. Moroz', 'Word-level forced alignment cues'],
  ['row-10', 'Gallery Reflow — Card Masonry', 'AST-2410', 'Approved', 'MP4 H.264', '95.4', '2560×1440', '27.3 MB', 'BT.709', '1h ago', 'gallery, layout', 'O. Savchenko', 'Smooth FLIP transition from table to cards'],
  ['row-11', 'Android TV — Living Room Wake', 'AST-2411', 'Approved', 'WebM VP9', '98.0', '2880×1620', '19.8 MB', 'BT.709', '2h ago', 'adb, hdmi-cec', 'I. Bondar', 'Verified state transition under 400ms'],
  ['row-12', 'Multi-Sort — Pinned Numeric RTL', 'AST-2412', 'Review', 'WebP', '94.9', '2880×1620', '3.2 MB', 'Display P3', '2h ago', 'rtl, tabular', 'M. Vyshniakov', 'Tabular numerals align across locale switch'],
  ['row-13', 'Skeleton Twin — Geometry Lock', 'AST-2413', 'Approved', 'MP4 H.264', '99.3', '2880×1620', '11.4 MB', 'BT.709', '3h ago', 'loading, cls', 'A. Kovalenko', 'Zero pixel shift between placeholder and row'],
  ['row-14', 'Selection Bar — Batch Archive', 'AST-2414', 'Approved', 'WebM VP9', '96.8', '2560×1440', '14.1 MB', 'BT.709', '4h ago', 'marquee, bulk', 'D. Moroz', 'Floating bar enters without layout thrash'],
];

const COLUMNS = [
  { key: 'name', label: 'Asset', width: 248, pinned: true },
  { key: 'sku', label: 'SKU', width: 108, pinned: true },
  { key: 'status', label: 'Status', width: 118 },
  { key: 'source', label: 'Codec / Source', width: 146 },
  { key: 'score', label: 'QA Score', width: 108, align: 'right' },
  { key: 'dimensions', label: 'Dimensions', width: 132 },
  { key: 'size', label: 'Size', width: 116, align: 'right' },
  { key: 'color', label: 'Color Space', width: 132 },
  { key: 'modified', label: 'Modified ↓', width: 124 },
  { key: 'tags', label: 'Tags', width: 164 },
  { key: 'owner', label: 'Owner', width: 152 },
  { key: 'notes', label: 'Verification Notes', width: 340 },
];

export function renderDataGridFixtureHtml() {
  const pinnedWidth = COLUMNS.filter((c) => c.pinned).reduce((sum, c) => sum + c.width, 0);
  const totalWidth = COLUMNS.reduce((sum, c) => sum + c.width, 0);

  const headerCells = COLUMNS.map((col, idx) => {
    const left = col.pinned
      ? COLUMNS.slice(0, idx).reduce((sum, c) => sum + c.width, 0)
      : null;
    const isLastPinned = col.pinned && !COLUMNS[idx + 1]?.pinned;
    return `<div class="dg-cell dg-header-cell${col.pinned ? ' dg-pinned' : ''}${isLastPinned ? ' dg-pinned-edge' : ''}${col.align === 'right' ? ' dg-right' : ''}" style="width:${col.width}px;${left !== null ? `left:${left}px;` : ''}">${col.label}</div>`;
  }).join('');

  const bodyRows = ROWS.map((row, rowIdx) => {
    const [id, ...values] = row;
    const cells = COLUMNS.map((col, colIdx) => {
      const val = values[colIdx];
      const left = col.pinned
        ? COLUMNS.slice(0, colIdx).reduce((sum, c) => sum + c.width, 0)
        : null;
      const isLastPinned = col.pinned && !COLUMNS[colIdx + 1]?.pinned;
      let content = val;
      if (col.key === 'status') {
        const cls = val === 'Approved' ? 'badge-ok' : val === 'Review' ? 'badge-warn' : 'badge-neutral';
        content = `<span class="dg-badge ${cls}">${val}</span>`;
      } else if (col.key === 'tags') {
        content = val
          .split(',')
          .map((t) => `<span class="dg-tag">${t.trim()}</span>`)
          .join('');
      }
      return `<div class="dg-cell${col.pinned ? ' dg-pinned' : ''}${isLastPinned ? ' dg-pinned-edge' : ''}${col.align === 'right' ? ' dg-right' : ''}" data-col="${col.key}" style="width:${col.width}px;${left !== null ? `left:${left}px;` : ''}">${content}</div>`;
    }).join('');
    return `<div class="dg-row${rowIdx === 1 ? ' dg-row-selected' : ''}" data-row-id="${id}">${cells}</div>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Data Grid — Horizontal Rubber-Band Surface</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b101b;
    --panel: #111827;
    --panel-alt: #151e30;
    --pinned-bg: #131c2e;
    --row-hover: #1b2740;
    --row-selected: #172a46;
    --border: rgba(148, 163, 184, 0.16);
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --rubber-x: 0px;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    width: 100%;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    overflow: hidden;
    user-select: none;
  }
  .shell {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    padding: 16px 20px 18px;
    gap: 12px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .title {
    font-weight: 600;
    font-size: 14px;
    color: #f8fafc;
  }
  .pill {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(56, 189, 248, 0.14);
    color: #7dd3fc;
    border: 1px solid rgba(56, 189, 248, 0.28);
  }
  .telemetry {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--muted);
    display: flex;
    gap: 14px;
  }
  .grid-frame {
    position: relative;
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    overflow: hidden;
  }
  .rubber-gutter {
    position: absolute;
    top: 38px;
    bottom: 0;
    left: ${pinnedWidth}px;
    width: 96px;
    background: repeating-linear-gradient(
      -45deg,
      rgba(56, 189, 248, 0.08) 0 8px,
      rgba(15, 23, 42, 0.35) 8px 16px
    );
    pointer-events: none;
    z-index: 0;
  }
  #grid-scroller {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    overflow-x: auto;
    overflow-y: auto;
    overscroll-behavior-x: contain;
    overscroll-behavior-y: contain;
    scrollbar-width: thin;
  }
  .dg-table {
    width: ${totalWidth}px;
    min-height: 100%;
    position: relative;
  }
  .dg-header {
    position: sticky;
    top: 0;
    z-index: 4;
    display: flex;
    height: 38px;
    background: #0f172a;
    border-bottom: 1px solid rgba(148, 163, 184, 0.24);
  }
  .dg-row {
    display: flex;
    height: 36px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    background: var(--panel);
    transition: background-color 90ms ease;
  }
  .dg-row:nth-child(even) { background: var(--panel-alt); }
  .dg-row:hover { background: var(--row-hover); }
  .dg-row.dg-row-selected { background: var(--row-selected); }
  .dg-cell {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    padding: 0 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-right: 1px solid rgba(148, 163, 184, 0.08);
    transform: translate3d(var(--rubber-x), 0, 0);
    will-change: transform;
  }
  .dg-header-cell {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: #94a3b8;
  }
  .dg-right {
    justify-content: flex-end;
    font-variant-numeric: tabular-nums;
  }
  .dg-pinned {
    position: sticky;
    z-index: 3;
    background: var(--pinned-bg);
    transform: none !important;
  }
  .dg-row:hover .dg-pinned { background: #1c2942; }
  .dg-row.dg-row-selected .dg-pinned { background: #193052; }
  .dg-header .dg-pinned {
    z-index: 5;
    background: #0f172a;
  }
  .dg-pinned-edge {
    border-right: 2px solid rgba(56, 189, 248, 0.45);
    box-shadow: 8px 0 18px rgba(2, 6, 23, 0.55);
  }
  .dg-badge {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-ok { background: rgba(16, 185, 129, 0.16); color: #6ee7b7; }
  .badge-warn { background: rgba(245, 158, 11, 0.16); color: #fcd34d; }
  .badge-neutral { background: rgba(148, 163, 184, 0.16); color: #cbd5e1; }
  .dg-tag {
    display: inline-block;
    margin-right: 5px;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    background: rgba(99, 102, 241, 0.16);
    color: #c7d2fe;
  }
</style>
</head>
<body>
  <div class="shell" id="storybook-root">
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="title">Release Media Catalog</span>
        <span class="pill">2 Pinned Columns</span>
        <span class="pill">Elastic Overscroll</span>
      </div>
      <div class="telemetry">
        <span id="scroll-readout">scrollLeft: 0px</span>
        <span id="rubber-readout">overscroll: 0.0px</span>
      </div>
    </div>
    <div class="grid-frame">
      <div class="rubber-gutter" aria-hidden="true"></div>
      <div id="grid-scroller" data-grid-scroller="true">
        <div class="dg-table">
          <div class="dg-header">${headerCells}</div>
          <div class="dg-body">${bodyRows}</div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const scroller = document.getElementById('grid-scroller');
    const scrollReadout = document.getElementById('scroll-readout');
    const rubberReadout = document.getElementById('rubber-readout');
    const rootStyle = document.documentElement.style;

    const state = {
      hoveredRow: null,
      selectedRow: 'row-02',
      wheelEvents: 0,
      scrollEvents: 0,
      maxScrollLeft: 0,
      maxRubberOffsetPx: 0,
      minRubberOffsetPx: 0,
      overscrollBounces: 0,
      currentRubberPx: 0,
    };
    window.__gridBenchmark = state;

    let rubberPos = 0;
    let rubberVel = 0;
    let lastWheelAt = 0;
    let springRaf = 0;

    function applyRubber(px) {
      rubberPos = px;
      state.currentRubberPx = Number(px.toFixed(2));
      state.maxRubberOffsetPx = Math.max(state.maxRubberOffsetPx, state.currentRubberPx);
      state.minRubberOffsetPx = Math.min(state.minRubberOffsetPx, state.currentRubberPx);
      rootStyle.setProperty('--rubber-x', px.toFixed(2) + 'px');
      rubberReadout.textContent = 'overscroll: ' + px.toFixed(1) + 'px';
    }

    function stepSpring() {
      const idleMs = performance.now() - lastWheelAt;
      if (idleMs > 32) {
        const stiffness = 0.22;
        const damping = 0.74;
        rubberVel = (rubberVel - rubberPos * stiffness) * damping;
        rubberPos += rubberVel;
        if (Math.abs(rubberPos) < 0.18 && Math.abs(rubberVel) < 0.18) {
          applyRubber(0);
          springRaf = 0;
          return;
        }
        applyRubber(rubberPos);
      }
      springRaf = requestAnimationFrame(stepSpring);
    }

    scroller.addEventListener('scroll', () => {
      state.scrollEvents += 1;
      state.maxScrollLeft = Math.max(state.maxScrollLeft, scroller.scrollLeft);
      scrollReadout.textContent = 'scrollLeft: ' + Math.round(scroller.scrollLeft) + 'px';
    }, { passive: true });

    scroller.addEventListener('wheel', (event) => {
      state.wheelEvents += 1;
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const atLeft = scroller.scrollLeft <= 1 && event.deltaX < 0;
      const atRight = scroller.scrollLeft >= maxLeft - 1 && event.deltaX > 0;
      if (atLeft || atRight) {
        lastWheelAt = performance.now();
        const resistance = 0.34 / (1 + Math.abs(rubberPos) / 56);
        const next = Math.max(-72, Math.min(72, rubberPos - event.deltaX * resistance));
        if (Math.abs(rubberPos) < 1 && Math.abs(next) >= 1) {
          state.overscrollBounces += 1;
        }
        applyRubber(next);
        if (!springRaf) springRaf = requestAnimationFrame(stepSpring);
      }
    }, { passive: true });

    for (const row of document.querySelectorAll('.dg-row')) {
      row.addEventListener('pointerenter', () => {
        state.hoveredRow = row.dataset.rowId;
      });
      row.addEventListener('click', () => {
        for (const prev of document.querySelectorAll('.dg-row-selected')) {
          prev.classList.remove('dg-row-selected');
        }
        row.classList.add('dg-row-selected');
        state.selectedRow = row.dataset.rowId;
      });
    }
  </script>
</body>
</html>`;
}

export async function startDataGridFixtureServer() {
  const html = renderDataGridFixtureHtml();
  const server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/iframe.html?id=data-grid-regression-datagrid--playground&viewMode=story`,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
