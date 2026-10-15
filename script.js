/* ============================================================
   Redline Speedtest
   A dependency-free internet speed test built on the Cloudflare
   edge network (speed.cloudflare.com).
   ============================================================ */
'use strict';

/* ------------------------------------------------------------------
   Config
------------------------------------------------------------------ */
const CF = {
  down: 'https://speed.cloudflare.com/__down',
  up: 'https://speed.cloudflare.com/__up',
  meta: 'https://speed.cloudflare.com/meta',
};

const HISTORY_KEY = 'redline.speedtest.history.v1';
const UNIT_KEY = 'redline.speedtest.unit.v1';
const HISTORY_MAX = 10;

/* Live-display tuning: how much we smooth the running speed so the
   needle and number stay readable instead of flickering with every
   network fluctuation. */
const LIVE_WINDOW_MS = 1000; // rolling window used to estimate current speed
const LIVE_UI_MS = 180;      // minimum gap between UI updates
const LIVE_ALPHA = 0.22;     // EMA smoothing factor for the live value

/* ------------------------------------------------------------------
   Tiny helpers
------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (v) => typeof v === 'number' && isFinite(v);

function percentile(arr, p) {
  if (!arr || !arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

const SPEED_LADDER = [5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000];
function niceMax(v) {
  for (const x of SPEED_LADDER) if (v <= x) return x;
  return Math.ceil(v / 1000) * 1000;
}

/* Exponential moving average, used to calm the live reading. */
class Smoother {
  constructor(alpha) {
    this.alpha = alpha;
    this.v = null;
  }
  push(x) {
    if (!isNum(x) || x < 0) return this.v;
    this.v = this.v == null ? x : this.v + this.alpha * (x - this.v);
    return this.v;
  }
  reset() {
    this.v = null;
  }
}

/* Estimate the current throughput (Mbps) from a rolling window of
   {t, bytes} samples, so short-lived spikes do not dominate. */
function windowRate(win, now) {
  while (win.length && win[0].t < now - LIVE_WINDOW_MS) win.shift();
  if (win.length < 2) return null;
  let bytes = 0;
  for (let i = 0; i < win.length; i++) bytes += win[i].bytes;
  const dt = (now - win[0].t) / 1000;
  if (dt <= 0) return null;
  return (bytes * 8) / dt / 1e6;
}

/* ------------------------------------------------------------------
   Self-contained SVG gauge (no external CDN dependency)
   The progress arc is redrawn analytically every frame, so it never
   depends on getTotalLength() / stroke-dasharray, which render
   inconsistently across browsers.
------------------------------------------------------------------ */
class Gauge {
  constructor(el) {
    this.el = el;
    this.cx = 150;
    this.cy = 150;
    this.startDeg = -120;   // degrees, measured clockwise from 12 o'clock
    this.sweepDeg = 240;
    this.rTrack = 120;
    this.min = 0;
    this.max = 100;
    this.unit = 'Mbps';
    this.shown = 0;
    this.target = 0;
    this._raf = null;
    this._build();
  }

  _polar(deg, r) {
    const rad = (deg * Math.PI) / 180;
    return [this.cx + r * Math.sin(rad), this.cy - r * Math.cos(rad)];
  }

  _arcD(fromDeg, toDeg, r) {
    const span = toDeg - fromDeg;
    if (Math.abs(span) < 0.4) return '';
    const [x1, y1] = this._polar(fromDeg, r);
    const [x2, y2] = this._polar(toDeg, r);
    const large = Math.abs(span) > 180 ? 1 : 0;
    const sweep = span >= 0 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  _tickLabel(v) {
    const dec = this.max < 10 ? 1 : 0;
    if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    return v.toFixed(dec);
  }

  _ticksMarkup() {
    const n = 10;
    let out = '';
    for (let i = 0; i <= n; i++) {
      const deg = this.startDeg + this.sweepDeg * (i / n);
      const [x1, y1] = this._polar(deg, 108);
      const [x2, y2] = this._polar(deg, 96);
      out += `<line class="tick-major" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
      const [lx, ly] = this._polar(deg, 82);
      out += `<text class="tick-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${this._tickLabel(this.max * (i / n))}</text>`;
      if (i < n) {
        const d2 = this.startDeg + this.sweepDeg * ((i + 0.5) / n);
        const [mx1, my1] = this._polar(d2, 105);
        const [mx2, my2] = this._polar(d2, 98);
        out += `<line class="tick-minor" x1="${mx1.toFixed(1)}" y1="${my1.toFixed(1)}" x2="${mx2.toFixed(1)}" y2="${my2.toFixed(1)}"/>`;
      }
    }
    return out;
  }

  _build() {
    const track = this._arcD(this.startDeg, this.startDeg + this.sweepDeg, this.rTrack);
    this.el.innerHTML = `
      <svg viewBox="0 0 300 300" class="gauge-svg" role="img" aria-label="Speed gauge" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="gaugeGrad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stop-color="#2bd67b"/>
            <stop offset="55%" stop-color="#ffc23b"/>
            <stop offset="100%" stop-color="#ff3b3b"/>
          </linearGradient>
        </defs>
        <path class="track" d="${track}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="13" stroke-linecap="round"/>
        <path class="progress" d="" fill="none" stroke="url(#gaugeGrad)" stroke-width="13" stroke-linecap="round"/>
        <g class="ticks">${this._ticksMarkup()}</g>
        <g class="needle"><polygon points="" fill="#ff3b3b"/></g>
        <circle class="hub" cx="150" cy="150" r="6" fill="#ffffff"/>
        <circle class="hub-ring" cx="150" cy="150" r="11" fill="none" stroke="#ff3b3b" stroke-width="3"/>
        <text class="gauge-value" x="150" y="200">0</text>
        <text class="gauge-unit" x="150" y="222">Mbps</text>
      </svg>`;

    this.ticksEl = this.el.querySelector('.ticks');
    this.progressEl = this.el.querySelector('.progress');
    this.needlePoly = this.el.querySelector('.needle polygon');
    this.valueEl = this.el.querySelector('.gauge-value');
    this.unitEl = this.el.querySelector('.gauge-unit');
    this.render();
  }

  _applyMax(m) {
    if (m === this.max) return;
    this.max = m;
    if (this.ticksEl) this.ticksEl.innerHTML = this._ticksMarkup();
  }

  setUnit(u) {
    this.unit = u;
    this.render();
  }

  setValue(v) {
    v = isNum(v) ? Math.max(0, v) : 0;
    if (v > this.max) this._applyMax(niceMax(v));
    this.target = v;
    if (this._raf == null) this._loop();
  }

  reset() {
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._applyMax(100);
    this.shown = 0;
    this.target = 0;
    this.render();
  }

  _loop() {
    this._raf = requestAnimationFrame(() => {
      const diff = this.target - this.shown;
      const eps = Math.max(0.02, this.max * 0.001);
      if (Math.abs(diff) < eps) {
        this.shown = this.target;
        this.render();
        this._raf = null;
        return;
      }
      this.shown += diff * 0.16;
      this.render();
      this._loop();
    });
  }

  /* The needle polygon is recomputed from the angle every frame rather than
     rotated with an SVG/CSS transform. Transforms on this element proved
     fragile across browsers (a CSS transform-origin could double-apply the
     rotation and swing the needle wildly), so we avoid them entirely. */
  _drawNeedle(deg) {
    if (!this.needlePoly) return;
    const rad = (deg * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const px = -dy;
    const py = dx;
    const len = 92;
    const tail = 12;
    const halfW = 4.8;
    const tx = this.cx + dx * len;
    const ty = this.cy + dy * len;
    const bx = this.cx - dx * tail;
    const by = this.cy - dy * tail;
    const p1 = `${tx.toFixed(2)},${ty.toFixed(2)}`;
    const p2 = `${(bx + px * halfW).toFixed(2)},${(by + py * halfW).toFixed(2)}`;
    const p3 = `${(bx - px * halfW).toFixed(2)},${(by - py * halfW).toFixed(2)}`;
    this.needlePoly.setAttribute('points', `${p1} ${p2} ${p3}`);
  }

  render() {
    const f = clamp((this.shown - this.min) / (this.max - this.min), 0, 1);
    const deg = this.startDeg + this.sweepDeg * f;
    this._drawNeedle(deg);
    if (this.progressEl) this.progressEl.setAttribute('d', this._arcD(this.startDeg, deg, this.rTrack));
    if (this.valueEl) this.valueEl.textContent = this.shown >= 100 ? this.shown.toFixed(0) : this.shown.toFixed(1);
    if (this.unitEl) this.unitEl.textContent = this.unit;
  }
}

/* ------------------------------------------------------------------
   Application state
------------------------------------------------------------------ */
const state = {
  running: false,
  unit: 'Mbps',
  controller: null,
  meta: null,
  results: { ping: null, jitter: null, loss: null, down: null, up: null },
};

let gauge = null;

/* ------------------------------------------------------------------
   Unit formatting
------------------------------------------------------------------ */
function toDisplay(mbps) {
  return state.unit === 'MB/s' ? mbps / 8 : mbps;
}
function fmtSpeed(mbps) {
  if (!isNum(mbps)) return '—';
  const v = toDisplay(mbps);
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(state.unit === 'MB/s' ? 2 : 1);
}
function fmtMs(v) {
  if (!isNum(v)) return '—';
  return String(Math.round(v));
}
function fmtLoss(v) {
  if (!isNum(v)) return '—';
  if (v === 0) return '0';
  return v < 1 ? v.toFixed(2) : v.toFixed(1);
}

/* ------------------------------------------------------------------
   Measurement engine
------------------------------------------------------------------ */
async function warmup(signal) {
  try {
    await fetch(`${CF.down}?bytes=0`, { cache: 'no-store', signal });
  } catch (e) {
    if (signal && signal.aborted) throw abortError();
  }
}

async function measureLatency(signal, onSample) {
  const N = 12;
  const pings = [];
  let fails = 0;

  for (let i = 0; i < N; i++) {
    throwIfAborted(signal);
    const t0 = performance.now();
    try {
      const res = await fetch(`${CF.down}?bytes=0`, { cache: 'no-store', signal });
      if (!res.ok) throw new Error('status ' + res.status);
      await res.arrayBuffer();
      pings.push(performance.now() - t0);
      if (onSample) onSample(pings);
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      fails++;
    }
    await sleep(55);
  }

  const ping = pings.length ? percentile(pings, 0.5) : null;
  let jsum = 0;
  let jn = 0;
  for (let i = 1; i < pings.length; i++) {
    jsum += Math.abs(pings[i] - pings[i - 1]);
    jn++;
  }
  const jitter = jn ? jsum / jn : null;
  const loss = (fails / N) * 100;
  return { ping, jitter, loss, samples: pings.length };
}

async function measureDownload(signal, onLive) {
  const plan = [
    { bytes: 1e5, count: 3 },
    { bytes: 3e5, count: 3 },
    { bytes: 1e6, count: 3 },
    { bytes: 5e6, count: 2 },
    { bytes: 1e7, count: 2 },
    { bytes: 2.5e7, count: 1 },
  ];
  const points = [];
  const smoother = new Smoother(LIVE_ALPHA);

  for (const step of plan) {
    for (let i = 0; i < step.count; i++) {
      throwIfAborted(signal);
      const res = await fetch(`${CF.down}?bytes=${step.bytes}`, { cache: 'no-store', signal });
      if (!res.ok) throw new Error('Download endpoint returned ' + res.status);

      const t0 = performance.now();
      let received = 0;

      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const win = [];
        let lastUi = t0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const now = performance.now();
          received += value.length;
          win.push({ t: now, bytes: value.length });
          while (win.length && win[0].t < now - LIVE_WINDOW_MS) win.shift();
          if (now - lastUi >= LIVE_UI_MS) {
            const rate = windowRate(win, now);
            if (rate != null && onLive) onLive(smoother.push(rate));
            lastUi = now;
          }
        }
      } else {
        const buf = await res.arrayBuffer();
        received = buf.byteLength;
      }

      const dur = (performance.now() - t0) / 1000;
      const bps = dur > 0 ? (received * 8) / dur : 0;
      points.push({ bytes: received, dur, bps });
    }
    const last = points[points.length - 1];
    if (last && last.dur >= 2.5) break; // large enough to be representative
  }

  const usable = points.filter((p) => p.dur >= 0.8);
  const pool = (usable.length ? usable : points).map((p) => p.bps);
  return { value: percentile(pool, 0.9) / 1e6, points };
}

function uploadOnce(url, blob, signal, onLive) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    const t0 = performance.now();
    const win = [];
    let lastLoaded = 0;
    let lastUi = t0;
    const onAbort = () => xhr.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    xhr.upload.onprogress = (e) => {
      const now = performance.now();
      const delta = e.loaded - lastLoaded;
      lastLoaded = e.loaded;
      if (delta > 0) win.push({ t: now, bytes: delta });
      while (win.length && win[0].t < now - LIVE_WINDOW_MS) win.shift();
      if (now - lastUi >= LIVE_UI_MS) {
        const rate = windowRate(win, now);
        if (rate != null && onLive) onLive(rate);
        lastUi = now;
      }
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 400) {
        resolve((performance.now() - t0) / 1000);
      } else {
        reject(new Error('Upload endpoint returned ' + xhr.status));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('Upload request failed (network or CORS)'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(abortError());
    };
    xhr.send(blob);
  });
}

async function measureUpload(signal, onLive) {
  const plan = [
    { bytes: 1e5, count: 3 },
    { bytes: 5e5, count: 3 },
    { bytes: 2e6, count: 2 },
    { bytes: 5e6, count: 2 },
    { bytes: 1e7, count: 1 },
  ];
  const points = [];
  const smoother = new Smoother(LIVE_ALPHA);

  for (const step of plan) {
    const blob = new Blob([new Uint8Array(step.bytes)]);
    for (let i = 0; i < step.count; i++) {
      throwIfAborted(signal);
      const dur = await uploadOnce(CF.up, blob, signal, (rate) => {
        if (onLive) onLive(smoother.push(rate));
      });
      const bps = dur > 0 ? (step.bytes * 8) / dur : 0;
      points.push({ bytes: step.bytes, dur, bps });
    }
    const last = points[points.length - 1];
    if (last && last.dur >= 2.5) break;
  }

  const usable = points.filter((p) => p.dur >= 0.8);
  const pool = (usable.length ? usable : points).map((p) => p.bps);
  return { value: percentile(pool, 0.9) / 1e6, points };
}

async function fetchMeta(signal) {
  try {
    const res = await fetch(CF.meta, { signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------
   Scoring
------------------------------------------------------------------ */
function bandLog(v, lo, hi) {
  if (!isNum(v)) return null;
  return clamp((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)), 0, 1);
}
function bandInv(v, good, bad) {
  if (!isNum(v)) return null;
  return clamp((bad - v) / (bad - good), 0, 1);
}

function computeScore(r) {
  const parts = [
    { w: 0.35, s: bandLog(r.down, 1, 300) },
    { w: 0.2, s: bandLog(r.up, 0.5, 60) },
    { w: 0.2, s: bandInv(r.ping, 12, 250) },
    { w: 0.15, s: bandInv(r.jitter, 2, 60) },
    { w: 0.1, s: bandInv(r.loss, 0, 8) },
  ];
  let sum = 0;
  let tw = 0;
  for (const p of parts) {
    if (p.s != null) {
      sum += p.s * p.w;
      tw += p.w;
    }
  }
  return tw ? sum / tw : 0;
}

function gradeOf(score) {
  const p = score * 100;
  if (p >= 92) return 'A+';
  if (p >= 82) return 'A';
  if (p >= 70) return 'B';
  if (p >= 55) return 'C';
  if (p >= 38) return 'D';
  return 'F';
}
function gradeColor(g) {
  if (g === 'A+' || g === 'A' || g === 'B') return 'var(--green)';
  if (g === 'C') return 'var(--amber)';
  return 'var(--red)';
}

function activityVerdicts(r) {
  const out = {};
  // Only judge once both bandwidth directions have been measured, so the
  // chips do not flash a verdict from partial data mid-test.
  if (!isNum(r.down) || !isNum(r.up)) return out;
  if (isNum(r.down) && isNum(r.loss)) {
    out.streaming = r.down >= 25 && r.loss < 2 ? 'ok' : r.down >= 10 ? 'warn' : 'bad';
  }
  if (isNum(r.ping) && isNum(r.jitter) && isNum(r.loss)) {
    out.gaming = r.ping <= 50 && r.jitter <= 15 && r.loss < 1 ? 'ok' : r.ping <= 90 ? 'warn' : 'bad';
  }
  if (isNum(r.down) && isNum(r.up) && isNum(r.ping)) {
    out.calls = r.down >= 5 && r.up >= 2 && r.ping <= 150 ? 'ok' : r.down >= 3 ? 'warn' : 'bad';
  }
  return out;
}

/* ------------------------------------------------------------------
   DOM refs
------------------------------------------------------------------ */
const el = {
  phase: $('phase'),
  phaseText: $('phase-text'),
  gaugeMetric: $('gauge-metric'),
  start: $('start'),
  stop: $('stop'),
  unit: $('unit'),
  share: $('share'),
  ring: $('ring'),
  scoreGrade: $('score-grade'),
  scoreLabel: $('score-label'),
  history: $('history'),
  historyList: $('history-list'),
  clearHistory: $('clear-history'),
  toast: $('toast'),
  connColo: $('conn-colo'),
  connIsp: $('conn-isp'),
  connIp: $('conn-ip'),
};

const CARD = {
  ping: { card: $('card-ping'), value: $('val-ping') },
  jitter: { card: $('card-jitter'), value: $('val-jitter') },
  download: { card: $('card-download'), value: $('val-download') },
  upload: { card: $('card-upload'), value: $('val-upload') },
  loss: { card: $('card-loss'), value: $('val-loss') },
};

/* ------------------------------------------------------------------
   UI helpers
------------------------------------------------------------------ */
let toastTimer = null;
function toast(msg, isErr) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('err', !!isErr);
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
}

function setPhase(text, mode) {
  el.phaseText.textContent = text;
  el.phase.classList.remove('is-live', 'is-done', 'is-err');
  if (mode) el.phase.classList.add('is-' + mode);
}

function setGaugeMetric(text) {
  if (el.gaugeMetric) el.gaugeMetric.textContent = text;
}

function activateCard(name) {
  Object.values(CARD).forEach((c) => c.card.classList.remove('active', 'testing'));
  if (name && CARD[name]) {
    CARD[name].card.classList.add('active', 'testing');
  }
}

function setCardValue(name, text) {
  if (CARD[name]) CARD[name].value.textContent = text;
}

function renderResults() {
  const r = state.results;
  setCardValue('ping', fmtMs(r.ping));
  setCardValue('jitter', fmtMs(r.jitter));
  setCardValue('download', fmtSpeed(r.down));
  setCardValue('upload', fmtSpeed(r.up));
  setCardValue('loss', fmtLoss(r.loss));

  $('unit-download').textContent = state.unit;
  $('unit-upload').textContent = state.unit;

  const score = computeScore(r);
  const hasAny = isNum(r.down) || isNum(r.up);
  if (hasAny) {
    const g = gradeOf(score);
    el.scoreGrade.textContent = g;
    el.ring.style.stroke = gradeColor(g);
    el.ring.style.strokeDashoffset = `${326.7 * (1 - score)}`;
  }

  const verdicts = activityVerdicts(r);
  document.querySelectorAll('.chip').forEach((chip) => {
    const act = chip.getAttribute('data-act');
    chip.classList.remove('ok', 'warn', 'bad');
    if (verdicts[act]) chip.classList.add(verdicts[act]);
  });
}

function resetResults() {
  state.results = { ping: null, jitter: null, loss: null, down: null, up: null };
  el.ring.style.strokeDashoffset = '326.7';
  el.scoreGrade.textContent = '—';
  el.scoreLabel.textContent = 'Network quality';
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('ok', 'warn', 'bad'));
  renderResults();
}

function setRunningUI(running) {
  el.start.disabled = running;
  el.start.textContent = running ? 'TESTING…' : 'START TEST';
  el.stop.hidden = !running;
  el.unit.disabled = running;
}

/* ------------------------------------------------------------------
   Main test flow
------------------------------------------------------------------ */
async function runTest() {
  if (state.running) return;
  state.running = true;
  state.controller = new AbortController();
  const signal = state.controller.signal;

  setRunningUI(true);
  resetResults();
  gauge.reset();
  gauge.setUnit(state.unit);
  el.share.disabled = true;

  try {
    setPhase('Measuring latency…', 'live');
    setGaugeMetric('Latency');
    activateCard('ping');
    await warmup(signal);

    const lat = await measureLatency(signal, (pings) => {
      setCardValue('ping', fmtMs(percentile(pings, 0.5)));
    });
    state.results.ping = lat.ping;
    state.results.jitter = lat.jitter;
    state.results.loss = lat.loss;
    activateCard('jitter');
    renderResults();

    setPhase('Measuring download…', 'live');
    setGaugeMetric('Download · live');
    activateCard('download');
    const dl = await measureDownload(signal, (live) => {
      gauge.setUnit(state.unit);
      gauge.setValue(toDisplay(live));
      setCardValue('download', fmtSpeed(live));
    });
    state.results.down = dl.value;
    setCardValue('download', fmtSpeed(dl.value));
    renderResults();

    setPhase('Measuring upload…', 'live');
    setGaugeMetric('Upload · live');
    activateCard('upload');
    const ul = await measureUpload(signal, (live) => {
      gauge.setUnit(state.unit);
      gauge.setValue(toDisplay(live));
      setCardValue('upload', fmtSpeed(live));
    });
    state.results.up = ul.value;
    setCardValue('upload', fmtSpeed(ul.value));

    activateCard(null);
    renderResults();

    // Settle the needle on the measured result — never the last fluctuation.
    setGaugeMetric('Download · result');
    gauge.setValue(toDisplay(state.results.down || 0));

    setPhase('Test complete', 'done');
    el.share.disabled = false;
    saveHistory();
  } catch (e) {
    activateCard(null);
    if (e && e.name === 'AbortError') {
      setPhase('Stopped', 'err');
      setGaugeMetric('Stopped');
      toast('Test stopped.');
    } else {
      console.error(e);
      setPhase('Test failed', 'err');
      setGaugeMetric('Failed');
      toast('Speed test failed: ' + (e && e.message ? e.message : 'unknown error'), true);
    }
  } finally {
    state.running = false;
    setRunningUI(false);
  }
}

/* ------------------------------------------------------------------
   History (localStorage)
------------------------------------------------------------------ */
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveHistory() {
  const r = state.results;
  const entry = {
    t: Date.now(),
    down: r.down,
    up: r.up,
    ping: r.ping,
    jitter: r.jitter,
    loss: r.loss,
  };
  const arr = loadHistory();
  arr.unshift(entry);
  const trimmed = arr.slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {
    /* storage may be unavailable (private mode) */
  }
  renderHistory();
}

function renderHistory() {
  const arr = loadHistory();
  if (!arr.length) {
    el.history.hidden = true;
    return;
  }
  el.history.hidden = false;
  const maxDown = Math.max(...arr.map((e) => (isNum(e.down) ? e.down : 0)), 1);
  el.historyList.innerHTML = arr
    .map((e) => {
      const d = new Date(e.t);
      const time = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const pct = isNum(e.down) ? clamp((e.down / maxDown) * 100, 2, 100) : 0;
      return `<li>
        <span class="hist-time">${time}</span>
        <span class="hist-bar"><i style="width:${pct}%"></i></span>
        <span class="hist-vals">↓${fmtSpeed(e.down)} ↑${fmtSpeed(e.up)} ${fmtMs(e.ping)}ms</span>
      </li>`;
    })
    .join('');
}

/* ------------------------------------------------------------------
   Share / copy
------------------------------------------------------------------ */
function buildSummary() {
  const r = state.results;
  const meta = state.meta;
  const lines = [
    'Redline Speedtest',
    `Download: ${fmtSpeed(r.down)} ${state.unit}`,
    `Upload:   ${fmtSpeed(r.up)} ${state.unit}`,
    `Ping:     ${fmtMs(r.ping)} ms`,
    `Jitter:   ${fmtMs(r.jitter)} ms`,
    `Loss:     ${fmtLoss(r.loss)} %`,
  ];
  if (meta) {
    const loc = [meta.city, meta.country].filter(Boolean).join(', ');
    lines.push(`Server:   ${meta.colo || '—'}${loc ? ' (' + loc + ')' : ''}`);
    if (meta.asOrganization) lines.push(`Network:  ${meta.asOrganization}`);
  }
  lines.push(`When:     ${new Date().toLocaleString()}`);
  return lines.join('\n');
}

async function copySummary() {
  const text = buildSummary();
  try {
    await navigator.clipboard.writeText(text);
    toast('Result copied to clipboard.');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Result copied to clipboard.');
    } catch (err) {
      toast('Copy failed — please copy manually.', true);
    }
    document.body.removeChild(ta);
  }
}

/* ------------------------------------------------------------------
   Connection info
------------------------------------------------------------------ */
async function loadMeta() {
  const meta = await fetchMeta();
  state.meta = meta;
  if (!meta) {
    el.connColo.textContent = 'unavailable';
    el.connIsp.textContent = 'unavailable';
    el.connIp.textContent = 'unavailable';
    return;
  }
  const loc = [meta.city, meta.country].filter(Boolean).join(', ');
  el.connColo.textContent = meta.colo ? `${meta.colo}${loc ? ' · ' + loc : ''}` : loc || '—';
  el.connIsp.textContent = meta.asOrganization || (meta.asn ? 'AS' + meta.asn : '—');
  el.connIp.textContent = meta.clientIp || '—';
}

/* ------------------------------------------------------------------
   Init
------------------------------------------------------------------ */
function init() {
  gauge = new Gauge($('gauge'));

  const savedUnit = (() => {
    try {
      return localStorage.getItem(UNIT_KEY);
    } catch (e) {
      return null;
    }
  })();
  state.unit = savedUnit === 'MB/s' ? 'MB/s' : 'Mbps';
  el.unit.textContent = 'Unit: ' + state.unit;
  gauge.setUnit(state.unit);

  const yr = $('year');
  if (yr) yr.textContent = String(new Date().getFullYear());

  el.start.addEventListener('click', runTest);
  el.stop.addEventListener('click', () => {
    if (state.controller) state.controller.abort();
  });
  el.share.addEventListener('click', copySummary);
  el.unit.addEventListener('click', () => {
    state.unit = state.unit === 'Mbps' ? 'MB/s' : 'Mbps';
    el.unit.textContent = 'Unit: ' + state.unit;
    try {
      localStorage.setItem(UNIT_KEY, state.unit);
    } catch (e) {
      /* ignore */
    }
    gauge.setUnit(state.unit);
    if (isNum(state.results.down)) gauge.setValue(toDisplay(state.results.down));
    renderResults();
    renderHistory();
  });
  el.clearHistory.addEventListener('click', () => {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch (e) {
      /* ignore */
    }
    renderHistory();
    toast('History cleared.');
  });

  renderResults();
  renderHistory();
  loadMeta();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
