/*
 * Headless unit tests for the glucose reader core. Run with: npm test
 * No test framework dependency — plain assertions so it runs anywhere Node does.
 */
const assert = require('assert');
const G = require('../js/reader.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

console.log('reader core');

test('mmol <-> mg/dL conversion round-trips', () => {
  assert.ok(Math.abs(G.mmolToMgdl(10) - 180.182) < 1e-3);
  assert.ok(Math.abs(G.mgdlToMmol(180.182) - 10) < 1e-6);
});

test('classifies an in-range reading', () => {
  assert.strictEqual(G.classify(5.5).key, 'in_range');
});

test('classifies a low reading', () => {
  assert.strictEqual(G.classify(3.2).key, 'low');
  assert.strictEqual(G.classify(2.0).key, 'critical_low');
});

test('THE FEATURE: a value past the 22.2 device cap is NOT clamped', () => {
  const r = new G.Reading(33.3); // 600 mg/dL — a real meter would show "HIGH"
  assert.strictEqual(r.mmol, 33.3, 'value preserved, not clamped to 22.2');
  assert.strictEqual(r.zone.key, 'extreme_high');
  assert.strictEqual(r.beyondCap, true);
  assert.strictEqual(r.mgdl, 600); // 33.3 * 18.0182 rounds to 600
});

test('exactly at the cap counts as beyond', () => {
  assert.strictEqual(G.isBeyondDeviceCap(22.2), true);
  assert.strictEqual(G.isBeyondDeviceCap(22.19), false);
  assert.strictEqual(new G.Reading(22.2).zone.key, 'extreme_high');
});

test('very high (below cap) is distinct from extreme high', () => {
  assert.strictEqual(new G.Reading(20.0).zone.key, 'very_high');
  assert.strictEqual(new G.Reading(20.0).beyondCap, false);
});

test('Reading.fromMgdl handles high-range input', () => {
  const r = G.Reading.fromMgdl(500); // ~27.75 mmol/L
  assert.ok(r.mmol > 22.2);
  assert.strictEqual(r.beyondCap, true);
  assert.strictEqual(r.zone.key, 'extreme_high');
});

test('rejects non-finite and negative values', () => {
  assert.throws(() => new G.Reading(NaN), RangeError);
  assert.throws(() => new G.Reading(Infinity), RangeError);
  assert.throws(() => new G.Reading(-1), RangeError);
});

test('parseCsv with mmol header, including a past-cap row', () => {
  const csv = 'timestamp,mmol\n2026-07-13T08:00:00,5.4\n2026-07-13T08:05:00,25.8';
  const { readings, errors } = G.parseCsv(csv);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(readings.length, 2);
  assert.strictEqual(readings[1].beyondCap, true);
  assert.strictEqual(readings[1].zone.key, 'extreme_high');
});

test('parseCsv with mg/dL header converts units', () => {
  const csv = 'time,mg/dl\n2026-07-13T08:00:00,540';
  const { readings } = G.parseCsv(csv);
  assert.ok(readings[0].mmol > 22.2);
});

test('parseCsv headerless falls back to default unit', () => {
  const { readings, errors } = G.parseCsv('6.1\n7.2\n30.0', 'mmol');
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(readings.length, 3);
  assert.strictEqual(readings[2].zone.key, 'extreme_high');
});

test('parseCsv collects bad rows instead of throwing', () => {
  const { readings, errors } = G.parseCsv('mmol\n5.0\nbanana\n8.0');
  assert.strictEqual(readings.length, 2);
  assert.strictEqual(errors.length, 1);
  assert.ok(/banana/.test(errors[0].reason));
});

test('Simulator produces readings and can exceed the cap over a long run', () => {
  let seed = 42;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const sim = new G.Simulator({ start: 18, rng });
  let sawExtreme = false;
  for (let i = 0; i < 2000; i++) {
    const r = sim.next();
    assert.ok(r instanceof G.Reading);
    assert.ok(r.mmol >= 0 && Number.isFinite(r.mmol));
    if (r.beyondCap) sawExtreme = true;
  }
  assert.ok(sawExtreme, 'a long simulated run should visit the extreme-high range');
});

console.log('\n' + passed + ' assertions passed.');
