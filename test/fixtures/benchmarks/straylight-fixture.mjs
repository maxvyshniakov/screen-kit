import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';

/**
 * Generate a deterministic dusk-aurora desktop stage wallpaper PNG using `sharp` SVG rasterization.
 */
export async function writeStraylightWallpaper(filePath, { width = 1600, height = 960 } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="base" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0f172a"/>
        <stop offset="48%" stop-color="#1e1b4b"/>
        <stop offset="100%" stop-color="#0f2942"/>
      </linearGradient>
      <radialGradient id="orbA" cx="22%" cy="24%" r="52%">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.46"/>
        <stop offset="60%" stop-color="#6366f1" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#0f172a" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="orbB" cx="82%" cy="76%" r="55%">
        <stop offset="0%" stop-color="#c084fc" stop-opacity="0.38"/>
        <stop offset="55%" stop-color="#0ea5e9" stop-opacity="0.16"/>
        <stop offset="100%" stop-color="#0f172a" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#base)"/>
    <rect width="${width}" height="${height}" fill="url(#orbA)"/>
    <rect width="${width}" height="${height}" fill="url(#orbB)"/>
    <path d="M -80 ${Math.round(height * 0.72)} C ${Math.round(width * 0.28)} ${Math.round(height * 0.48)}, ${Math.round(width * 0.62)} ${Math.round(height * 0.9)}, ${width + 80} ${Math.round(height * 0.58)}" fill="none" stroke="rgba(148,163,184,0.16)" stroke-width="2"/>
    <path d="M -80 ${Math.round(height * 0.28)} C ${Math.round(width * 0.35)} ${Math.round(height * 0.1)}, ${Math.round(width * 0.68)} ${Math.round(height * 0.42)}, ${width + 80} ${Math.round(height * 0.2)}" fill="none" stroke="rgba(56,189,248,0.14)" stroke-width="1.5"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
  return filePath;
}

export function renderStraylightFixtureHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Straylight — Scenario Editor</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0c111d;
    --sidebar: #101726;
    --surface: #161f33;
    --surface-hover: #1e2942;
    --border: rgba(148, 163, 184, 0.18);
    --text: #f1f5f9;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --selected-ring: #38bdf8;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    width: 100%;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
    overflow: hidden;
    user-select: none;
  }
  .app {
    display: grid;
    grid-template-columns: 208px 1fr;
    width: 100%;
    height: 100%;
  }
  .sidebar {
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    padding: 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sidebar-section {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 4px 10px 6px;
  }
  .nav-item {
    padding: 8px 10px;
    border-radius: 8px;
    color: #cbd5e1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12.5px;
  }
  .nav-item.active {
    background: rgba(56, 189, 248, 0.14);
    color: #f8fafc;
    font-weight: 600;
    border: 1px solid rgba(56, 189, 248, 0.3);
  }
  .nav-meta {
    font-size: 11px;
    color: var(--muted);
  }
  .editor-main {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
  }
  .editor-header {
    height: 46px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    background: rgba(16, 23, 38, 0.92);
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 15;
  }
  .header-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
    font-size: 14px;
  }
  .trigger-chip {
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(99, 102, 241, 0.18);
    color: #c7d2fe;
    border: 1px solid rgba(99, 102, 241, 0.32);
  }
  .status-chip {
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    background: rgba(16, 185, 129, 0.15);
    color: #6ee7b7;
    border: 1px solid rgba(16, 185, 129, 0.28);
  }
  #scenario-canvas {
    position: relative;
    flex: 1;
    overflow: hidden;
    background-color: #0b101b;
    background-image: radial-gradient(rgba(148, 163, 184, 0.24) 1.25px, transparent 1.25px);
    background-size: 24px 24px;
    outline: none;
  }
  .palette-toolbar {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 7px;
    border-radius: 11px;
    background: rgba(22, 31, 51, 0.92);
    border: 1px solid rgba(148, 163, 184, 0.24);
    box-shadow: 0 12px 28px rgba(2, 6, 23, 0.52);
  }
  .palette-card {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 7px;
    background: rgba(30, 41, 66, 0.85);
    border: 1px solid rgba(148, 163, 184, 0.2);
    color: #e2e8f0;
    font-size: 12px;
    font-weight: 500;
    cursor: grab;
  }
  .palette-card:hover {
    background: rgba(56, 189, 248, 0.18);
    border-color: rgba(56, 189, 248, 0.45);
  }
  .palette-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  #world {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    transform-origin: 0 0;
    will-change: transform;
  }
  #edges-svg {
    position: absolute;
    left: 0;
    top: 0;
    width: 2000px;
    height: 1400px;
    overflow: visible;
    pointer-events: none;
  }
  .edge-path {
    fill: none;
    stroke: rgba(125, 211, 252, 0.55);
    stroke-width: 2.2;
    stroke-dasharray: 7 5;
    animation: edgeFlow 1.2s linear infinite;
  }
  @keyframes edgeFlow {
    from { stroke-dashoffset: 24; }
    to { stroke-dashoffset: 0; }
  }
  .start-node {
    position: absolute;
    width: 210px;
    height: 36px;
    border-radius: 999px;
    background: rgba(30, 41, 59, 0.92);
    border: 1px solid rgba(148, 163, 184, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11.5px;
    font-weight: 600;
    color: #cbd5e1;
    box-shadow: 0 8px 20px rgba(2, 6, 23, 0.4);
  }
  .action-card {
    position: absolute;
    width: 236px;
    padding: 10px 12px;
    border-radius: 11px;
    background: var(--surface);
    border: 1.5px solid rgba(148, 163, 184, 0.24);
    box-shadow: 0 12px 26px rgba(2, 6, 23, 0.45);
    transition: box-shadow 120ms ease, border-color 120ms ease;
  }
  .action-card.tidying {
    transition: left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms ease;
  }
  .action-card:hover {
    background: var(--surface-hover);
  }
  .action-card.selected {
    border-color: var(--selected-ring);
    box-shadow: 0 0 0 2.5px rgba(56, 189, 248, 0.32), 0 14px 30px rgba(2, 6, 23, 0.55);
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .card-kind {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: #f8fafc;
  }
  .card-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.14);
    color: var(--muted);
  }
  .card-field {
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(11, 16, 27, 0.68);
    border: 1px solid rgba(148, 163, 184, 0.14);
    font-size: 11.5px;
    color: #cbd5e1;
    display: flex;
    justify-content: space-between;
  }
  .port {
    position: absolute;
    left: 50%;
    width: 9px;
    height: 9px;
    margin-left: -4.5px;
    border-radius: 50%;
    background: #38bdf8;
    border: 2px solid #0b101b;
  }
  .port-in { top: -5px; }
  .port-out { bottom: -5px; }
  .bottom-bar {
    position: absolute;
    bottom: 14px;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 11px;
    border-radius: 9px;
    background: rgba(22, 31, 51, 0.92);
    border: 1px solid rgba(148, 163, 184, 0.24);
    box-shadow: 0 8px 22px rgba(2, 6, 23, 0.48);
    font-size: 12px;
  }
  .bar-left { left: 14px; cursor: pointer; }
  .bar-center {
    left: 50%;
    transform: translateX(-50%);
    background: rgba(14, 116, 144, 0.28);
    border-color: rgba(56, 189, 248, 0.45);
    color: #e0f2fe;
    font-weight: 600;
  }
  .bar-right {
    right: 14px;
    font-variant-numeric: tabular-nums;
  }
  .kbd-hint {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--muted);
  }
  #marquee-selection {
    position: absolute;
    display: none;
    border: 1.5px solid #38bdf8;
    background: rgba(56, 189, 248, 0.14);
    border-radius: 4px;
    z-index: 25;
    pointer-events: none;
  }
  #drag-ghost {
    position: fixed;
    display: none;
    width: 220px;
    padding: 9px 12px;
    border-radius: 10px;
    background: rgba(30, 41, 66, 0.95);
    border: 1.5px solid #38bdf8;
    box-shadow: 0 18px 36px rgba(2, 6, 23, 0.65);
    color: #f8fafc;
    font-size: 12px;
    font-weight: 600;
    z-index: 50;
    pointer-events: none;
  }
</style>
</head>
<body>
  <div class="app" id="storybook-root">
    <aside class="sidebar">
      <div class="sidebar-section">Scenarios</div>
      <div class="nav-item active"><span>Living Room Arrival</span><span class="nav-meta" id="step-count-nav">2</span></div>
      <div class="nav-item"><span>Cinema Dimmer</span><span class="nav-meta">5</span></div>
      <div class="nav-item"><span>Studio Desk Wake</span><span class="nav-meta">4</span></div>
      <div class="nav-item"><span>Night Lock</span><span class="nav-meta">3</span></div>
      <div class="sidebar-section" style="margin-top:12px;">Remotes</div>
      <div class="nav-item"><span>Siri Remote</span><span class="nav-meta">BLE</span></div>
      <div class="nav-item"><span>Ulanzi D200</span><span class="nav-meta">USB</span></div>
    </aside>
    <main class="editor-main">
      <header class="editor-header">
        <div class="header-title">
          <span>Living Room Arrival</span>
          <span class="trigger-chip">Siri Remote · Hold Home</span>
        </div>
        <div class="status-chip" id="editor-status">Ready · 2 steps</div>
      </header>
      <div id="scenario-canvas" data-testid="canvas" tabindex="0">
        <div class="palette-toolbar" role="toolbar" aria-label="Add action">
          <div class="palette-card" data-palette-kind="app"><span class="palette-dot" style="background:#38bdf8"></span>Launch App</div>
          <div class="palette-card" data-palette-kind="media"><span class="palette-dot" style="background:#a78bfa"></span>Media</div>
          <div class="palette-card" data-palette-kind="systemVolume"><span class="palette-dot" style="background:#34d399"></span>System Volume</div>
          <div class="palette-card" data-palette-kind="setState"><span class="palette-dot" style="background:#fbbf24"></span>Set State</div>
          <div class="palette-card" data-palette-kind="wait"><span class="palette-dot" style="background:#f472b6"></span>Wait</div>
        </div>
        <div id="world">
          <svg id="edges-svg"></svg>
          <div class="start-node" id="start-node" style="left:140px;top:66px;">Start · Hold Home</div>
        </div>
        <div id="marquee-selection"></div>
        <div class="bottom-bar bar-left" id="tidy-btn"><span>Tidy up</span><span class="kbd-hint">⇧⌘L</span></div>
        <div class="bottom-bar bar-center" id="selection-bar" style="display:none;"></div>
        <div class="bottom-bar bar-right"><span>Zoom</span><span id="zoom-readout" data-zoom-readout="true">100%</span></div>
      </div>
    </main>
  </div>
  <div id="drag-ghost"></div>
  <script>
    const canvas = document.getElementById('scenario-canvas');
    const world = document.getElementById('world');
    const edgesSvg = document.getElementById('edges-svg');
    const marqueeEl = document.getElementById('marquee-selection');
    const ghostEl = document.getElementById('drag-ghost');
    const selectionBar = document.getElementById('selection-bar');
    const zoomReadout = document.getElementById('zoom-readout');
    const statusChip = document.getElementById('editor-status');
    const stepCountNav = document.getElementById('step-count-nav');
    const startNode = document.getElementById('start-node');

    const KIND_META = {
      app: { title: 'Wake Apple TV 4K', badge: 'App', field: ['Target', 'Living Room TV'], color: '#38bdf8' },
      setState: { title: 'Set Dimmer Level', badge: 'State', field: ['Brightness', '35% Warm'], color: '#fbbf24' },
      systemVolume: { title: 'Set Receiver Volume', badge: 'Audio', field: ['Denon AVR', '-22 dB'], color: '#34d399' },
      media: { title: 'Resume Playback', badge: 'Media', field: ['Apple Music', 'Evening Mix'], color: '#a78bfa' },
      wait: { title: 'Wait for HDMI Handshake', badge: 'Flow', field: ['Delay', '800 ms'], color: '#f472b6' },
    };

    let cards = [
      { id: 'card-wake', kind: 'app', x: 127, y: 142 },
      { id: 'card-lights', kind: 'setState', x: 127, y: 274 },
    ];
    let selected = new Set(['card-wake']);
    let panX = 0;
    let panY = 0;
    let zoom = 1;

    const metrics = {
      paletteDrops: 0,
      cardsCount: cards.length,
      panCount: 0,
      panDelta: [0, 0],
      pinchCount: 0,
      minZoom: 1,
      maxZoom: 1,
      currentZoom: 1,
      marqueeSelections: 0,
      shiftClickSelections: 0,
      metaClickSelections: 0,
      selectedIds: ['card-wake'],
      shortcuts: [],
      tidied: false,
    };
    window.__scenarioBenchmark = metrics;

    function syncTransform() {
      world.style.transform = 'translate(' + panX.toFixed(2) + 'px, ' + panY.toFixed(2) + 'px) scale(' + zoom.toFixed(4) + ')';
      canvas.style.backgroundPosition = panX.toFixed(1) + 'px ' + panY.toFixed(1) + 'px';
      const stepGap = (24 * zoom).toFixed(2);
      canvas.style.backgroundSize = stepGap + 'px ' + stepGap + 'px';
      zoomReadout.textContent = Math.round(zoom * 100) + '%';
      metrics.currentZoom = Number(zoom.toFixed(4));
      metrics.minZoom = Math.min(metrics.minZoom, metrics.currentZoom);
      metrics.maxZoom = Math.max(metrics.maxZoom, metrics.currentZoom);
    }

    function syncSelectionUi() {
      metrics.selectedIds = [...selected];
      for (const el of world.querySelectorAll('.action-card')) {
        el.classList.toggle('selected', selected.has(el.dataset.cardId));
      }
      if (selected.size > 1) {
        selectionBar.style.display = 'flex';
        selectionBar.textContent = selected.size + ' cards selected · ⇧⌘L Tidy · ⌘D Duplicate';
      } else {
        selectionBar.style.display = 'none';
      }
    }

    function renderEdges() {
      if (!cards.length) {
        edgesSvg.innerHTML = '';
        return;
      }
      const segments = [];
      const startX = parseFloat(startNode.style.left) + 105;
      const startY = parseFloat(startNode.style.top) + 36;
      const first = cards[0];
      segments.push([startX, startY, first.x + 118, first.y]);

      for (let i = 0; i + 1 < cards.length; i++) {
        const a = cards[i];
        const b = cards[i + 1];
        segments.push([a.x + 118, a.y + 78, b.x + 118, b.y]);
      }

      edgesSvg.innerHTML = segments.map(([x1, y1, x2, y2]) => {
        const dy = Math.max(28, Math.abs(y2 - y1) * 0.5);
        const d = 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + dy) + ', ' + x2 + ' ' + (y2 - dy) + ', ' + x2 + ' ' + y2;
        return '<path class="edge-path" d="' + d + '"/>';
      }).join('');
    }

    function renderCards(animateTidy = false) {
      const existing = new Map([...world.querySelectorAll('.action-card')].map((el) => [el.dataset.cardId, el]));
      for (const card of cards) {
        const meta = KIND_META[card.kind] || KIND_META.app;
        let el = existing.get(card.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'action-card';
          el.dataset.cardId = card.id;
          el.innerHTML =
            '<span class="port port-in"></span>' +
            '<div class="card-head">' +
              '<span class="card-kind"><span class="palette-dot" style="background:' + meta.color + '"></span>' + meta.title + '</span>' +
              '<span class="card-badge">' + meta.badge + '</span>' +
            '</div>' +
            '<div class="card-field"><span>' + meta.field[0] + '</span><strong>' + meta.field[1] + '</strong></div>' +
            '<span class="port port-out"></span>';
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            canvas.focus({ preventScroll: true });
            if (ev.shiftKey) {
              selected.add(card.id);
              metrics.shiftClickSelections += 1;
            } else if (ev.metaKey || ev.ctrlKey) {
              if (selected.has(card.id)) selected.delete(card.id);
              else selected.add(card.id);
              metrics.metaClickSelections += 1;
            } else {
              selected = new Set([card.id]);
            }
            syncSelectionUi();
          });
          world.appendChild(el);
        }
        el.classList.toggle('tidying', animateTidy);
        el.style.left = Math.round(card.x) + 'px';
        el.style.top = Math.round(card.y) + 'px';
        existing.delete(card.id);
      }
      for (const stale of existing.values()) stale.remove();
      metrics.cardsCount = cards.length;
      stepCountNav.textContent = String(cards.length);
      renderEdges();
      syncSelectionUi();
    }

    function clientToWorld(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - panX) / zoom,
        y: (clientY - rect.top - panY) / zoom,
      };
    }

    // Palette drag -> canvas drop
    let activePaletteDrag = null;
    for (const btn of document.querySelectorAll('.palette-card')) {
      btn.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const kind = btn.dataset.paletteKind;
        const meta = KIND_META[kind] || KIND_META.app;
        activePaletteDrag = { kind };
        ghostEl.textContent = '+ ' + meta.title;
        ghostEl.style.display = 'block';
        ghostEl.style.left = (ev.clientX - 90) + 'px';
        ghostEl.style.top = (ev.clientY - 18) + 'px';
      });
    }

    // Marquee drag on empty canvas pane
    let activeMarquee = null;
    canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest('.action-card, .palette-toolbar, .bottom-bar')) return;
      canvas.focus({ preventScroll: true });
      const rect = canvas.getBoundingClientRect();
      activeMarquee = {
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        startX: ev.clientX - rect.left,
        startY: ev.clientY - rect.top,
        moved: false,
      };
    });

    window.addEventListener('pointermove', (ev) => {
      if (activePaletteDrag) {
        ghostEl.style.left = (ev.clientX - 90) + 'px';
        ghostEl.style.top = (ev.clientY - 18) + 'px';
        return;
      }
      if (activeMarquee) {
        const rect = canvas.getBoundingClientRect();
        const curX = ev.clientX - rect.left;
        const curY = ev.clientY - rect.top;
        const w = Math.abs(curX - activeMarquee.startX);
        const h = Math.abs(curY - activeMarquee.startY);
        if (w > 4 || h > 4) {
          activeMarquee.moved = true;
          const left = Math.min(activeMarquee.startX, curX);
          const top = Math.min(activeMarquee.startY, curY);
          marqueeEl.style.display = 'block';
          marqueeEl.style.left = left + 'px';
          marqueeEl.style.top = top + 'px';
          marqueeEl.style.width = w + 'px';
          marqueeEl.style.height = h + 'px';

          const minClientX = rect.left + left;
          const maxClientX = minClientX + w;
          const minClientY = rect.top + top;
          const maxClientY = minClientY + h;
          const hits = new Set();
          for (const el of world.querySelectorAll('.action-card')) {
            const r = el.getBoundingClientRect();
            const intersects = r.right >= minClientX && r.left <= maxClientX && r.bottom >= minClientY && r.top <= maxClientY;
            if (intersects) hits.add(el.dataset.cardId);
          }
          selected = hits;
          syncSelectionUi();
        }
      }
    });

    window.addEventListener('pointerup', (ev) => {
      if (activePaletteDrag) {
        const { kind } = activePaletteDrag;
        activePaletteDrag = null;
        ghostEl.style.display = 'none';
        const canvasRect = canvas.getBoundingClientRect();
        if (
          ev.clientX >= canvasRect.left &&
          ev.clientX <= canvasRect.right &&
          ev.clientY >= canvasRect.top &&
          ev.clientY <= canvasRect.bottom
        ) {
          const pt = clientToWorld(ev.clientX, ev.clientY);
          const id = kind === 'systemVolume' && !cards.some((c) => c.id === 'card-volume')
            ? 'card-volume'
            : 'card-' + kind + '-' + (cards.length + 1);
          cards.push({ id, kind, x: Math.max(40, pt.x - 118), y: Math.max(90, pt.y - 36) });
          selected = new Set([id]);
          metrics.paletteDrops += 1;
          statusChip.textContent = 'Inserted action · ' + cards.length + ' steps';
          renderCards(false);
          canvas.focus({ preventScroll: true });
        }
        return;
      }
      if (activeMarquee) {
        if (activeMarquee.moved) {
          metrics.marqueeSelections += 1;
        } else {
          selected.clear();
          syncSelectionUi();
        }
        activeMarquee = null;
        marqueeEl.style.display = 'none';
      }
    });

    // Two-finger pan (wheel) & trackpad pinch-zoom (ctrlKey wheel)
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey) {
        const rect = canvas.getBoundingClientRect();
        const cx = ev.clientX - rect.left;
        const cy = ev.clientY - rect.top;
        const prevZoom = zoom;
        const factor = Math.exp(-ev.deltaY * 0.0042);
        zoom = Math.max(0.55, Math.min(1.85, zoom * factor));
        panX = cx - ((cx - panX) / prevZoom) * zoom;
        panY = cy - ((cy - panY) / prevZoom) * zoom;
        metrics.pinchCount += 1;
        syncTransform();
      } else {
        panX -= ev.deltaX * 0.75;
        panY -= ev.deltaY * 0.75;
        metrics.panCount += 1;
        metrics.panDelta = [Math.round(panX), Math.round(panY)];
        syncTransform();
      }
    }, { passive: false });

    function runTidyUp() {
      startNode.style.left = '265px';
      startNode.style.top = '64px';
      cards = cards.map((card, index) => ({
        ...card,
        x: 252,
        y: 132 + index * 116,
      }));
      panX = 24;
      panY = 8;
      zoom = 1;
      metrics.tidied = true;
      statusChip.textContent = 'Tidied layout · ' + cards.length + ' steps';
      syncTransform();
      renderCards(true);
    }

    document.getElementById('tidy-btn').addEventListener('click', runTidyUp);

    window.addEventListener('keydown', (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      const lower = ev.key.toLowerCase();
      if (mod && ev.shiftKey && lower === 'l') {
        ev.preventDefault();
        metrics.shortcuts.push('Shift+Meta+l');
        runTidyUp();
        return;
      }
      if (mod && !ev.shiftKey && lower === 'a') {
        ev.preventDefault();
        metrics.shortcuts.push('Meta+a');
        selected = new Set(cards.map((c) => c.id));
        statusChip.textContent = 'Selected all · ' + selected.size + ' steps';
        syncSelectionUi();
        return;
      }
      if (mod && !ev.shiftKey && lower === 'd') {
        ev.preventDefault();
        metrics.shortcuts.push('Meta+d');
        const firstId = [...selected][0];
        const source = cards.find((c) => c.id === firstId);
        if (source) {
          const copyId = source.id + '-copy';
          cards.push({ id: copyId, kind: source.kind, x: source.x + 260, y: source.y + 24 });
          selected = new Set([copyId]);
          renderCards(false);
        }
      }
    });

    renderCards(false);
    syncTransform();
    canvas.focus({ preventScroll: true });
  </script>
</body>
</html>`;
}

export async function startStraylightFixtureServer() {
  const html = renderStraylightFixtureHtml();
  const server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/iframe.html?id=straylight-scenarios--linear&viewMode=story`,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
