# Glucose Reader — High Range

A small **WebGL** web app that reads glucose values and — its whole reason for
existing — **keeps reading past 22.2 mmol/L (400 mg/dL)**, the point where most
consumer meters and CGMs stop showing a number and just display `HIGH`.

Instead of clamping, this app preserves the true value, classifies it into an
**"Extreme high"** zone above the device cap, and makes that region impossible
to miss on both the gauge and the history chart.

## Why "past 22 mmol/L" matters

| Device behaviour | This app |
| --- | --- |
| Reports `HIGH` at/above ~22.2 mmol/L (400 mg/dL) and discards the number | Keeps the exact value (e.g. 31.6 mmol/L) |
| Fixed display range | Axis auto-expands so nothing is clipped |
| One "high" state | Distinguishes *very high* (18–22.2) from *extreme high* (≥ 22.2) |

Values above 22.2 mmol/L are DKA / hyperosmolar territory — a real medical
emergency — so surfacing the actual number is more useful than hiding it.

## Run it

It's fully static — no build step, no dependencies.

```bash
# any static server works; from the repo root:
npm run serve      # → http://localhost:8000
# or:  python3 -m http.server 8000
```

Then open `http://localhost:8000/`. (Opening `index.html` directly via
`file://` also works, since file uploads and CSV parsing are all client-side.)

### What you can do

- **Live feed** — a simulated CGM trace that will occasionally excurse past the
  cap. Pause/resume it.
- **⚡ Force high spike** — inject a reading well past 22.2 mmol/L on demand.
- **Load CSV** — paste, upload a file, or click *Load sample*. Header is
  `mmol` or `mg/dl`, with an optional `timestamp` column. See
  [`data/sample.csv`](data/sample.csv).
- **Unit toggle** — mmol/L ⇄ mg/dL.

## How it's built

| File | Role |
| --- | --- |
| `js/reader.js` | **Core** — `Reading`, unit conversion, zone classification (never clamps), CSV parsing, and a `Simulator`. Runs in the browser *and* Node. |
| `js/gl-utils.js` | Minimal batched WebGL immediate-mode helper (shaders, arcs, lines, discs). |
| `js/renderer.js` | Draws the radial gauge and rolling chart in WebGL; the 22.2 cap is a marked line. |
| `js/app.js` | UI wiring, data sources, animation loop, DOM label overlay. |
| `index.html` / `css/styles.css` | Layout and styling. |
| `tests/reader.test.js` | Headless unit tests for the core. |

## Test

```bash
npm test        # node tests/reader.test.js
```

The suite covers unit conversion, zone classification, CSV parsing, and — the
headline case — that a reading of 33.3 mmol/L / 600 mg/dL is **preserved and
classified as extreme high, not clamped to the device cap.**

## Disclaimer

Educational / demonstration visualization only. **Not a medical device** and
not for diagnosis or treatment decisions. If you see a real glucose reading this
high, seek medical care.
