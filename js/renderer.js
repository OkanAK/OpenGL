/*
 * renderer.js — draws the glucose gauge and the rolling history chart in WebGL.
 *
 * Coordinates are in device pixels (ctx.canvas.width/height), so everything is
 * multiplied through by devicePixelRatio for crispness. Text is intentionally
 * NOT drawn here — WebGL text is a rabbit hole; app.js overlays the few numeric
 * labels as positioned DOM, which is the pragmatic, readable choice.
 *
 * The defining detail lives in the scale: the gauge and chart y-axis extend to
 * `axisMax`, which starts at 33.3 mmol/L (600 mg/dL) and auto-expands if a
 * reading climbs even higher. The 22.2 device cap is drawn as a marked line so
 * the "past the cap" region is always visible rather than clipped away.
 */
(function (root, factory) {
  const api = factory(root.GLU, root.Glucose);
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./gl-utils.js'), require('./reader.js'));
  } else {
    root.Renderer = api;
  }
})(typeof self !== 'undefined' ? self : this, function (GLU, Glucose) {
  'use strict';

  const TWO_PI = Math.PI * 2;
  const GAUGE_START = Math.PI * 0.75;   // 135°, lower-left
  const GAUGE_SWEEP = Math.PI * 1.5;    // 270° sweep, clockwise to lower-right
  const DEFAULT_AXIS_MAX = 33.3;        // 600 mg/dL headroom above the 22.2 cap

  function zoneColorAt(mmol, alpha) {
    return GLU.hexColor(Glucose.classify(mmol).color, alpha);
  }

  /**
   * Draw the radial gauge into `batch` (device-pixel space).
   * Returns label anchors {ticks:[{mmol,x,y}], capX, capY} for the DOM overlay.
   */
  function drawGauge(batch, ctx, reading, axisMax) {
    const W = ctx.canvas.width, H = ctx.canvas.height, dpr = ctx.dpr;
    const cx = W / 2, cy = H * 0.56;
    const rOuter = Math.min(W, H) * 0.42;
    const rInner = rOuter * 0.78;
    const value = reading ? reading.mmol : 0;

    const angleFor = (mmol) => GAUGE_START + Math.min(mmol / axisMax, 1) * GAUGE_SWEEP;

    // Track (dim background arc).
    batch.arc(cx, cy, rInner, rOuter, GAUGE_START, GAUGE_START + GAUGE_SWEEP,
      GLU.hexColor('#20242e', 1));

    // Colored zone bands. Walk the zones and paint each one's sub-arc up to axisMax.
    const zones = Glucose.ZONES;
    for (let i = 0; i < zones.length; i++) {
      const lo = Math.max(zones[i].min, 0);
      const hi = i + 1 < zones.length ? zones[i + 1].min : axisMax;
      if (lo >= axisMax) break;
      const a0 = angleFor(lo), a1 = angleFor(Math.min(hi, axisMax));
      if (a1 <= a0) continue;
      batch.arc(cx, cy, rInner, rOuter, a0, a1, GLU.hexColor(zones[i].color, 0.85));
    }

    // The 22.2 device-cap marker: a bright radial tick spanning the band.
    const capAngle = angleFor(Glucose.DEVICE_CAP_MMOL);
    if (Glucose.DEVICE_CAP_MMOL < axisMax) {
      const cc = Math.cos(capAngle), sc = Math.sin(capAngle);
      batch.thickLine(cx + cc * (rInner - 6 * dpr), cy + sc * (rInner - 6 * dpr),
        cx + cc * (rOuter + 6 * dpr), cy + sc * (rOuter + 6 * dpr),
        2.2 * dpr, GLU.hexColor('#ffffff', 0.95));
    }

    // Minor ticks every 5 mmol/L, plus collect label anchors.
    const ticks = [];
    for (let m = 0; m <= axisMax + 0.001; m += 5) {
      const a = angleFor(m), c = Math.cos(a), s = Math.sin(a);
      batch.thickLine(cx + c * rInner, cy + s * rInner,
        cx + c * (rInner - 8 * dpr), cy + s * (rInner - 8 * dpr),
        1.2 * dpr, GLU.hexColor('#8a93a6', 0.9));
      const lr = rOuter + 16 * dpr;
      ticks.push({ mmol: m, x: (cx + c * lr) / dpr, y: (cy + s * lr) / dpr });
    }

    // Needle: colored by the current zone. Points from hub to the value angle.
    if (reading) {
      const a = angleFor(value);
      const tipR = rOuter - 4 * dpr, tail = 14 * dpr, hw = 5 * dpr;
      const c = Math.cos(a), s = Math.sin(a);
      const px = -s, py = c; // perpendicular
      const col = zoneColorAt(value, 1);
      batch.tri(
        cx + c * tipR, cy + s * tipR,
        cx + px * hw - c * tail, cy + py * hw - s * tail,
        cx - px * hw - c * tail, cy - py * hw - s * tail, col);
      batch.disc(cx, cy, 9 * dpr, GLU.hexColor('#e8ecf3', 1));
      batch.disc(cx, cy, 5 * dpr, col);
    }

    const capLr = rOuter + 16 * dpr;
    return {
      center: { x: cx / dpr, y: cy / dpr },
      radius: rOuter / dpr,
      ticks,
      cap: {
        mmol: Glucose.DEVICE_CAP_MMOL,
        x: (cx + Math.cos(capAngle) * capLr) / dpr,
        y: (cy + Math.sin(capAngle) * capLr) / dpr,
      },
    };
  }

  /**
   * Draw the rolling history chart into `batch` (device-pixel space).
   * `history` is an array of Reading. Returns label anchors for the y-axis.
   */
  function drawChart(batch, ctx, history, axisMax, region) {
    const dpr = ctx.dpr;
    const x0 = region.x * dpr, y0 = region.y * dpr;
    const w = region.w * dpr, h = region.h * dpr;

    batch.quad(x0, y0, x0 + w, y0 + h, GLU.hexColor('#161a22', 1));

    const yFor = (mmol) => y0 + h - Math.min(mmol / axisMax, 1) * h;

    // In-range band (3.9–10) as a subtle green field.
    const bandTop = yFor(10.0), bandBot = yFor(3.9);
    batch.quad(x0, bandTop, x0 + w, bandBot, GLU.hexColor('#2eb872', 0.10));

    // Gridlines + the 22.2 cap line.
    const yLabels = [];
    for (let m = 0; m <= axisMax + 0.001; m += 5) {
      const y = yFor(m);
      batch.quad(x0, y - 0.5 * dpr, x0 + w, y + 0.5 * dpr, GLU.hexColor('#2a3040', 0.8));
      yLabels.push({ mmol: m, x: region.x, y: y / dpr });
    }
    const capY = yFor(Glucose.DEVICE_CAP_MMOL);
    batch.quad(x0, capY - 1 * dpr, x0 + w, capY + 1 * dpr, GLU.hexColor('#ffffff', 0.55));

    if (history.length >= 1) {
      const n = history.length;
      const xFor = (i) => n <= 1 ? x0 + w : x0 + (i / (n - 1)) * w;

      // Filled area under the trace, tinted by whether we're above the cap.
      for (let i = 1; i < n; i++) {
        const xa = xFor(i - 1), xb = xFor(i);
        const ya = yFor(history[i - 1].mmol), yb = yFor(history[i].mmol);
        const above = history[i].beyondCap || history[i - 1].beyondCap;
        const fill = above ? GLU.hexColor('#b8002e', 0.30) : GLU.hexColor('#3a7bd5', 0.16);
        batch.tri(xa, ya, xb, yb, xb, y0 + h, fill);
        batch.tri(xa, ya, xb, y0 + h, xa, y0 + h, fill);
      }

      // The line itself, segment-colored by zone.
      for (let i = 1; i < n; i++) {
        const xa = xFor(i - 1), xb = xFor(i);
        const ya = yFor(history[i - 1].mmol), yb = yFor(history[i].mmol);
        batch.thickLine(xa, ya, xb, yb, 1.6 * dpr, zoneColorAt(history[i].mmol, 1));
      }

      // Latest point marker.
      const last = history[n - 1];
      batch.disc(xFor(n - 1), yFor(last.mmol), 4 * dpr, zoneColorAt(last.mmol, 1));
      batch.disc(xFor(n - 1), yFor(last.mmol), 2 * dpr, GLU.hexColor('#ffffff', 1));
    }

    return { yLabels, cap: { mmol: Glucose.DEVICE_CAP_MMOL, x: region.x, y: capY / dpr } };
  }

  return { drawGauge, drawChart, DEFAULT_AXIS_MAX, GAUGE_START, GAUGE_SWEEP };
});
