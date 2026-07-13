/*
 * app.js — wires the UI, data sources and the WebGL renderer together.
 *
 * Responsibilities:
 *   - own the reading history and the auto-expanding axis maximum
 *   - drive a live simulated feed, or ingest a pasted/uploaded CSV
 *   - render every animation frame and reconcile the DOM text overlays
 *   - keep the big numeric readout honest for values past the 22.2 device cap
 */
(function () {
  'use strict';
  const G = window.Glucose, R = window.Renderer;

  const el = (id) => document.getElementById(id);
  const gaugeCanvas = el('gauge-gl');
  const chartCanvas = el('chart-gl');
  const gaugeOverlay = el('gauge-overlay');
  const chartOverlay = el('chart-overlay');

  let gaugeCtx, chartCtx;
  try {
    gaugeCtx = new window.GLU.Context(gaugeCanvas);
    chartCtx = new window.GLU.Context(chartCanvas);
  } catch (e) {
    el('gl-error').textContent = 'WebGL unavailable: ' + e.message;
    el('gl-error').hidden = false;
    return;
  }
  const gaugeBatch = new window.GLU.Batch();
  const chartBatch = new window.GLU.Batch();

  const state = {
    history: [],          // Reading[]
    maxPoints: 288,       // 24h at 5-min cadence
    axisMax: R.DEFAULT_AXIS_MAX,
    unit: 'mmol',         // 'mmol' | 'mgdl'
    live: true,
    sim: new G.Simulator({ start: 6.4 }),
    lastStep: 0,
    stepMs: 900,          // wall-clock ms between simulated readings
  };

  function unitLabel() { return state.unit === 'mgdl' ? 'mg/dL' : 'mmol/L'; }
  function toDisplay(mmol) {
    return state.unit === 'mgdl' ? Math.round(G.mmolToMgdl(mmol)) : G.round(mmol, 1);
  }

  function pushReading(r) {
    state.history.push(r);
    if (state.history.length > state.maxPoints) state.history.shift();
    // Auto-expand the axis so a value past the cap is never clipped, with a
    // little headroom. Never shrink mid-session — keeps the scale stable.
    const need = r.mmol * 1.08;
    if (need > state.axisMax) state.axisMax = Math.ceil(need / 5) * 5;
  }

  function latest() { return state.history[state.history.length - 1] || null; }

  // ---- DOM overlay reconciliation ---------------------------------------
  // We keep a small pool of <span> labels per overlay and reposition them each
  // frame instead of thrashing the DOM with creates/removes.
  function reconcileLabels(overlay, specs) {
    let nodes = overlay._pool || (overlay._pool = []);
    while (nodes.length < specs.length) {
      const s = document.createElement('span');
      s.className = 'gl-label';
      overlay.appendChild(s); nodes.push(s);
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], spec = specs[i];
      if (!spec) { n.hidden = true; continue; }
      n.hidden = false;
      n.textContent = spec.text;
      n.className = 'gl-label' + (spec.cls ? ' ' + spec.cls : '');
      n.style.left = spec.x + 'px';
      n.style.top = spec.y + 'px';
    }
  }

  function tickText(mmol) {
    return state.unit === 'mgdl' ? String(Math.round(G.mmolToMgdl(mmol))) : String(Math.round(mmol));
  }

  // ---- Render loop -------------------------------------------------------
  function frame(now) {
    if (state.live && now - state.lastStep >= state.stepMs) {
      state.lastStep = now;
      pushReading(state.sim.next());
    }

    // Gauge
    const [gw, gh] = gaugeCtx.resize();
    gaugeCtx.clear([0.043, 0.051, 0.067, 1]);
    gaugeBatch.clear();
    const gInfo = R.drawGauge(gaugeBatch, gaugeCtx, latest(), state.axisMax);
    gaugeCtx.draw(gaugeBatch);

    const gLabels = gInfo.ticks.map(t => ({
      text: tickText(t.mmol), x: t.x - 6, y: t.y - 8, cls: 'tick',
    }));
    gLabels.push({
      text: 'device cap ' + toDisplay(gInfo.cap.mmol),
      x: gInfo.cap.x - 30, y: gInfo.cap.y - 8, cls: 'cap',
    });
    reconcileLabels(gaugeOverlay, gLabels);

    // Chart
    chartCtx.resize();
    chartCtx.clear([0.086, 0.102, 0.133, 1]);
    chartBatch.clear();
    const region = { x: 44, y: 12, w: chartCanvas.clientWidth - 56, h: chartCanvas.clientHeight - 34 };
    const cInfo = R.drawChart(chartBatch, chartCtx, state.history, state.axisMax, region);
    chartCtx.draw(chartBatch);

    const cLabels = cInfo.yLabels.map(t => ({ text: tickText(t.mmol), x: 6, y: t.y - 7, cls: 'tick' }));
    cLabels.push({ text: 'cap', x: region.x + region.w - 26, y: cInfo.cap.y - 7, cls: 'cap' });
    reconcileLabels(chartOverlay, cLabels);

    updateReadout();
    requestAnimationFrame(frame);
  }

  // ---- Numeric readout & status -----------------------------------------
  function updateReadout() {
    const r = latest();
    const big = el('readout-value');
    const zoneEl = el('readout-zone');
    const unitEl = el('readout-unit');
    const capBadge = el('cap-badge');

    if (!r) {
      big.textContent = '--';
      zoneEl.textContent = 'no data';
      zoneEl.style.color = '#8a93a6';
      capBadge.hidden = true;
      unitEl.textContent = unitLabel();
      return;
    }
    big.textContent = toDisplay(r.mmol);
    big.style.color = r.zone.color;
    unitEl.textContent = unitLabel();
    zoneEl.textContent = r.zone.label;
    zoneEl.style.color = r.zone.color;

    // A real meter would show "HIGH" here and drop the number. We keep it and
    // shout instead — that is the entire premise of this app.
    capBadge.hidden = !r.beyondCap;
    if (r.beyondCap) {
      capBadge.textContent = 'PAST DEVICE CAP · ' + toDisplay(r.mmol) + ' ' + unitLabel();
    }
    el('readout-mgdl').textContent = state.unit === 'mgdl'
      ? G.round(r.mmol, 1) + ' mmol/L'
      : Math.round(G.mmolToMgdl(r.mmol)) + ' mg/dL';
  }

  // ---- Controls ----------------------------------------------------------
  el('btn-live').addEventListener('click', () => {
    state.live = !state.live;
    el('btn-live').textContent = state.live ? '⏸ Pause feed' : '▶ Resume feed';
    el('btn-live').classList.toggle('active', state.live);
  });

  el('btn-spike').addEventListener('click', () => {
    // Force a reading well past the cap so the high-range handling is obvious.
    const base = latest() ? latest().mmol : 8;
    pushReading(new G.Reading(Math.max(base, 0) + 18 + Math.random() * 6));
  });

  el('btn-unit').addEventListener('click', () => {
    state.unit = state.unit === 'mmol' ? 'mgdl' : 'mmol';
    el('btn-unit').textContent = 'Unit: ' + unitLabel();
  });

  el('btn-clear').addEventListener('click', () => {
    state.history.length = 0;
    state.axisMax = R.DEFAULT_AXIS_MAX;
  });

  function ingestCsv(text) {
    const { readings, errors } = G.parseCsv(text, state.unit);
    if (!readings.length) {
      setStatus(errors.length ? ('No valid rows. ' + errors[0].reason) : 'No rows found.', true);
      return;
    }
    state.live = false;
    el('btn-live').textContent = '▶ Resume feed';
    el('btn-live').classList.remove('active');
    state.history.length = 0;
    state.axisMax = R.DEFAULT_AXIS_MAX;
    for (const r of readings) pushReading(r);
    const beyond = readings.filter(r => r.beyondCap).length;
    setStatus('Loaded ' + readings.length + ' readings' +
      (beyond ? ' · ' + beyond + ' past the device cap' : '') +
      (errors.length ? ' · ' + errors.length + ' skipped' : ''), false);
  }

  function setStatus(msg, isError) {
    const s = el('status');
    s.textContent = msg;
    s.style.color = isError ? '#eb4d4b' : '#8a93a6';
  }

  el('btn-load-csv').addEventListener('click', () => ingestCsv(el('csv-input').value));
  el('file-input').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => ingestCsv(String(reader.result));
    reader.readAsText(f);
  });
  el('btn-sample').addEventListener('click', () => {
    el('csv-input').value = SAMPLE_CSV.trim();
    ingestCsv(SAMPLE_CSV);
  });

  const SAMPLE_CSV = `timestamp,mmol
2026-07-13T07:00:00,5.6
2026-07-13T07:05:00,6.1
2026-07-13T07:10:00,7.8
2026-07-13T07:15:00,10.4
2026-07-13T07:20:00,14.2
2026-07-13T07:25:00,18.9
2026-07-13T07:30:00,22.2
2026-07-13T07:35:00,25.7
2026-07-13T07:40:00,29.1
2026-07-13T07:45:00,31.6
2026-07-13T07:50:00,27.3
2026-07-13T07:55:00,21.0
2026-07-13T08:00:00,15.5`;

  // Seed a little history so the first paint isn't empty.
  for (let i = 0; i < 40; i++) pushReading(state.sim.next());
  el('btn-unit').textContent = 'Unit: ' + unitLabel();
  requestAnimationFrame(frame);
})();
