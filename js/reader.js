/*
 * reader.js — Glucose reading core.
 *
 * The whole reason this project exists: most consumer meters and CGMs clamp
 * their readable range at 22.2 mmol/L (400 mg/dL) and just display "HIGH".
 * This module keeps the true numeric value, classifies it — including the
 * "extreme" zone above the usual cap — and never silently clamps.
 *
 * Written to run unchanged in the browser and in Node (for tests):
 *   - Browser:  <script src="js/reader.js"></script>  -> window.Glucose
 *   - Node:     const Glucose = require('./js/reader.js')
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;          // Node / tests
  } else {
    root.Glucose = api;            // Browser
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 1 mmol/L of glucose == 18.0182 mg/dL. The rounded 18.0 is the clinical
  // convention, but we keep the precise factor so round-trips stay stable.
  const MGDL_PER_MMOL = 18.0182;

  /**
   * The typical hardware cap. Readings at or above this on a real device are
   * usually reported as "HIGH" with the number thrown away. We keep the number.
   */
  const DEVICE_CAP_MMOL = 22.2; // 400 mg/dL

  // Classification thresholds in mmol/L, ordered low -> high. Each zone owns
  // the half-open interval [min, next.min). The final zone is unbounded above,
  // which is precisely the range past the device cap that we care about.
  const ZONES = [
    { key: 'critical_low', label: 'Critical low', min: -Infinity, color: '#7c1d6f' },
    { key: 'low',          label: 'Low',          min: 3.0,       color: '#e4572e' },
    { key: 'in_range',     label: 'In range',     min: 3.9,       color: '#2eb872' },
    { key: 'elevated',     label: 'Elevated',     min: 10.0,      color: '#f2c14e' },
    { key: 'high',         label: 'High',         min: 13.9,      color: '#f0932b' },
    { key: 'very_high',    label: 'Very high',    min: 18.0,      color: '#eb4d4b' },
    // Above the usual 22.2 device cap — DKA / hyperosmolar territory. The point.
    { key: 'extreme_high', label: 'Extreme high', min: DEVICE_CAP_MMOL, color: '#b8002e' },
  ];

  function round(value, dp) {
    const f = Math.pow(10, dp);
    return Math.round(value * f) / f;
  }

  function mgdlToMmol(mgdl) { return mgdl / MGDL_PER_MMOL; }
  function mmolToMgdl(mmol) { return mmol * MGDL_PER_MMOL; }

  /**
   * Classify a reading given in mmol/L. Returns the owning zone descriptor.
   * Never clamps: a value of 40 mmol/L returns the extreme_high zone, not the
   * top of some fixed scale.
   */
  function classify(mmol) {
    let match = ZONES[0];
    for (const zone of ZONES) {
      if (mmol >= zone.min) match = zone; else break;
    }
    return match;
  }

  /** True when the value exceeds what a typical device would report numerically. */
  function isBeyondDeviceCap(mmol) {
    return mmol >= DEVICE_CAP_MMOL;
  }

  /**
   * A single normalized reading. Construct from either unit; both unit values
   * and the zone are computed once and stored.
   */
  class Reading {
    constructor(mmol, timestamp) {
      if (!Number.isFinite(mmol)) {
        throw new RangeError('glucose value must be a finite number, got ' + mmol);
      }
      if (mmol < 0) {
        throw new RangeError('glucose value cannot be negative, got ' + mmol);
      }
      this.mmol = round(mmol, 2);
      this.mgdl = Math.round(mmolToMgdl(mmol));
      this.timestamp = timestamp instanceof Date ? timestamp
        : (timestamp != null ? new Date(timestamp) : new Date());
      this.zone = classify(this.mmol);
      this.beyondCap = isBeyondDeviceCap(this.mmol);
    }

    static fromMgdl(mgdl, timestamp) {
      return new Reading(mgdlToMmol(mgdl), timestamp);
    }

    valueIn(unit) {
      return unit === 'mgdl' ? this.mgdl : this.mmol;
    }
  }

  /**
   * Parse CSV text into readings. Accepted, header-driven and forgiving:
   *   - a column named one of: mmol, mmol/l, glucose  -> treated as mmol/L
   *   - a column named one of: mgdl, mg/dl            -> treated as mg/dL
   *   - an optional timestamp/time/date column
   * If there is no recognizable header, each non-empty line is parsed as
   *   [timestamp,] value   with value assumed to be in `defaultUnit`.
   * Unparseable rows are collected in `.errors` rather than aborting the batch.
   */
  function parseCsv(text, defaultUnit) {
    defaultUnit = defaultUnit || 'mmol';
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
    const readings = [];
    const errors = [];
    if (!lines.length) return { readings, errors };

    const firstCols = lines[0].split(',').map(c => c.trim().toLowerCase());
    const hasHeader = firstCols.some(c => /[a-z]/.test(c) && !isNumericToken(c));

    let valueIdx = 0, timeIdx = -1, unit = defaultUnit;
    let start = 0;

    if (hasHeader) {
      start = 1;
      const findIdx = (names) => firstCols.findIndex(c => names.includes(c));
      const mmolIdx = findIdx(['mmol', 'mmol/l', 'mmoll', 'glucose', 'value']);
      const mgdlIdx = findIdx(['mgdl', 'mg/dl', 'mg_dl']);
      timeIdx = findIdx(['timestamp', 'time', 'date', 'datetime']);
      if (mgdlIdx >= 0) { valueIdx = mgdlIdx; unit = 'mgdl'; }
      else if (mmolIdx >= 0) { valueIdx = mmolIdx; unit = 'mmol'; }
      else { valueIdx = timeIdx >= 0 ? (timeIdx === 0 ? 1 : 0) : 0; }
    }

    for (let i = start; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const raw = cols[valueIdx];
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        errors.push({ line: i + 1, text: lines[i], reason: 'non-numeric value "' + raw + '"' });
        continue;
      }
      let ts = null;
      if (timeIdx >= 0 && cols[timeIdx]) {
        const parsed = new Date(cols[timeIdx]);
        ts = isNaN(parsed.getTime()) ? null : parsed;
      }
      try {
        readings.push(unit === 'mgdl' ? Reading.fromMgdl(value, ts) : new Reading(value, ts));
      } catch (e) {
        errors.push({ line: i + 1, text: lines[i], reason: e.message });
      }
    }
    return { readings, errors };
  }

  function isNumericToken(tok) {
    return tok !== '' && Number.isFinite(Number(tok));
  }

  /**
   * Simulated CGM feed. Produces a plausible random-walk glucose trace and,
   * crucially, will occasionally excurse well past the 22.2 device cap so the
   * high-range handling is exercised. `next()` advances one 5-minute step.
   */
  class Simulator {
    constructor(opts) {
      opts = opts || {};
      this.mmol = opts.start != null ? opts.start : 6.5;
      this.stepMinutes = opts.stepMinutes || 5;
      this.time = opts.startTime ? new Date(opts.startTime) : new Date();
      this.rng = opts.rng || Math.random;
      this._drift = 0;
      this._maxObserved = this.mmol;
    }

    next() {
      // Momentum-based random walk: drift persists, so the trace makes long
      // rises and falls instead of jittering, and can climb past the cap.
      this._drift = this._drift * 0.8 + (this.rng() - 0.5) * 0.9;
      this.mmol += this._drift;

      // Rare strong excursion to guarantee the extreme-high path gets hit.
      if (this.rng() < 0.03) this._drift += (this.rng() - 0.3) * 3.5;

      // Soft floor so we never go non-physiological low; NO upper clamp, on
      // purpose — the app must handle whatever the sensor throws at it.
      if (this.mmol < 2.2) { this.mmol = 2.2; this._drift = Math.abs(this._drift); }
      if (this.mmol > 40) { this.mmol = 40; this._drift = -Math.abs(this._drift); }

      this.time = new Date(this.time.getTime() + this.stepMinutes * 60000);
      this._maxObserved = Math.max(this._maxObserved, this.mmol);
      return new Reading(this.mmol, new Date(this.time));
    }
  }

  return {
    MGDL_PER_MMOL,
    DEVICE_CAP_MMOL,
    ZONES,
    Reading,
    Simulator,
    classify,
    isBeyondDeviceCap,
    mgdlToMmol,
    mmolToMgdl,
    parseCsv,
    round,
  };
});
