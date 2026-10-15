# Redline Speedtest

A fast, **dependency-free** internet speed test that runs entirely in the browser and measures
your connection against the **Cloudflare edge network** (330+ cities worldwide).

No build step, no frameworks, no external CDN — just three static files. Drop it on GitHub
Pages (or any static host) and it works.

## Features

- **Live SVG gauge** — hand-built, animated speedometer (no third-party gauge library).
  The progress arc is redrawn analytically each frame, so it never depends on
  `getTotalLength()` / `stroke-dasharray` (which render inconsistently across browsers).
- **Smoothed live reading** — the running speed is a rolling-window average with exponential
  smoothing, so the needle stays readable instead of chasing every network fluctuation. The
  value it finally settles on is the measured result (90th percentile), not the last sample.
- **Latency, jitter & packet loss** — measured from a burst of edge round-trips.
- **Download & upload bandwidth** — progressive ramp-up across increasing payload sizes,
  scored with the 90th-percentile method (the same approach Cloudflare's own test uses).
- **Network quality score** — an A+ → F grade with a ring, plus Streaming / Gaming /
  Video-call readiness checks.
- **Connection details** — edge server location (IATA colo code + city), your ISP / ASN and IP.
- **Unit toggle** — Mbps ⇄ MB/s.
- **Test history** — your last 10 results, stored locally in your browser only.
- **Copy result** — one-click summary for sharing.
- **Stop mid-test**, graceful errors, responsive layout, reduced-motion support.

## How it works

The app talks to three public, CORS-enabled Cloudflare endpoints:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `https://speed.cloudflare.com/__down?bytes=N` | GET | Returns `N` bytes — used for latency and download measurement. |
| `https://speed.cloudflare.com/__up` | POST | Accepts and discards an upload body — used for upload measurement. |
| `https://speed.cloudflare.com/meta` | GET | Returns JSON describing your connection (IP, ASN, ISP, edge colo). |

- **Latency** is the median round-trip time of several small requests; **jitter** is the average
  change between consecutive latency samples; **packet loss** is the share of failed requests.
- **Bandwidth** ramps through progressively larger transfers and stops once a request runs long
  enough to be representative, then takes the 90th percentile of the measured throughputs.

A full test typically transfers 30–90 MB and never more than about 200 MB.

## Privacy

Everything runs client-side. Results are stored only in your browser's `localStorage` and are
never sent anywhere. The only network traffic is to the Cloudflare endpoints above.

## Run locally

```bash
# any static server works
python3 -m http.server 8080
# then open http://localhost:8080
```

> Note: open it over `http://` or `https://` (not `file://`) so that the browser allows the
> cross-origin measurement requests.

## Files

- `index.html` — markup and inline SVG icons
- `style.css` — theme and layout
- `script.js` — gauge, measurement engine, scoring and UI
