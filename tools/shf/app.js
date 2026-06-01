// app.js — main thread for the Starlink Flare Predictor.
//
// Responsibilities:
//   * form wiring, airport autocomplete, default date/time = now
//   * resolve origin / destination locations
//   * build the scan request (fixed location or flight path)
//   * obtain Starlink TLE text (file > sessionStorage cache > proxy > direct)
//   * hand off to flareWorker.js and render the returned flare events
//
// All physics lives in the worker / flareEngine.js. This file is pure UI/glue.

// Cache-busting: index.html loads this module as `app.js?v=<build timestamp>`.
// We read that query off our own URL and append it to everything we load, so the
// whole module graph (and airports.json, the worker, etc.) is versioned by the
// same build stamp. Each build => new query => the browser refetches; between
// builds everything stays cached. See VERSION below, reused for the Worker URL.
const VERSION = new URL(import.meta.url).search; // e.g. "?v=1716998400000" (or "")
const [
  { resolveLocation, searchAirports, loadAirports, reverseGeocode },
  { compass16, greatCircleDistanceKm },
  { equatorialToAltAz, planetEquatorial, moonEquatorial, sunEquatorial },
  { BRIGHT_STARS },
  { compassRose, horizonView, horizonWindow, flareSimSky },
  { generateDummyTLE },
] = await Promise.all([
  import("./location.js" + VERSION),
  import("./geo.js" + VERSION),
  import("./astro.js" + VERSION),
  import("./stars.js" + VERSION),
  import("./skyview.js" + VERSION),
  import("./dummyTLE.js" + VERSION),
]);

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  form: $("form"), go: $("go"),
  origin: $("origin"), dest: $("dest"),
  originSug: $("origin-suggestions"), destSug: $("dest-suggestions"),
  date: $("date"), time: $("time"),
  duration: $("duration"), alt: $("alt"),
  tlefile: $("tlefile"), fetchtle: $("fetchtle"), tlestatus: $("tlestatus"),
  status: $("status"), results: $("results"),
  formScreen: $("form-screen"), resultsScreen: $("results-screen"), edit: $("edit"),
  infoScreen: $("info-screen"), infoBack: $("info-back"),
  infoLookLike: $("info-looklike"), infoRose: $("info-rose"), infoHorizon: $("info-horizon"),
  installWrap: $("install-wrap"), installApp: $("install-app"),
  installModal: $("install-modal"), installModalTitle: $("install-modal-title"),
  installModalBody: $("install-modal-body"), installModalClose: $("install-modal-close"),
};

// Smallest signed difference a−b on a circle, in (−180, 180].
function angDiff(a, b) { return ((a - b + 540) % 360) - 180; }

const CELESTRAK =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle";

// ---------------------------------------------------------------------------
// Time-zone aware wall-clock <-> UTC helpers (per spec)
// ---------------------------------------------------------------------------

// Milliseconds that the given tz is *ahead* of UTC at the instant `date`.
function tzOffsetMs(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Interpret a wall-clock (y, mo[1-12], d, h, mi) AT location tz -> UTC ms.
// If tz is empty/unknown, fall back to the browser's local zone.
function wallClockToUTCms(y, mo, d, h, mi, tz) {
  if (!tz) return new Date(y, mo - 1, d, h, mi).getTime();
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return guess - tzOffsetMs(new Date(guess), tz);
}

// Format a UTC ms back into a location's tz (or browser-local when tz empty).
function fmtTime(utcMs, tz, opts) {
  const o = Object.assign(
    { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
    opts || {});
  if (tz) o.timeZone = tz;
  return new Intl.DateTimeFormat(undefined, o).format(new Date(utcMs));
}
function fmtDate(utcMs, tz) {
  const o = { weekday: "short", year: "numeric", month: "short", day: "numeric" };
  if (tz) o.timeZone = tz;
  return new Intl.DateTimeFormat(undefined, o).format(new Date(utcMs));
}
function fmtDateShort(utcMs, tz) {   // compact, no year — e.g. "Fri, May 29"
  const o = { weekday: "short", month: "short", day: "numeric" };
  if (tz) o.timeZone = tz;
  return new Intl.DateTimeFormat(undefined, o).format(new Date(utcMs));
}
// Compact 12-hour label for an on-the-hour marker, e.g. "10pm", "12am", "1am".
function fmtHourLabel(utcMs, tz) {
  const o = { hour: "numeric", hour12: true };
  if (tz) o.timeZone = tz;
  return new Intl.DateTimeFormat("en-US", o).format(new Date(utcMs))
    .replace(/\s/g, "").toLowerCase();   // "10 PM" -> "10pm"
}
function tzAbbrev(utcMs, tz) {
  if (!tz) return "local time";
  const parts = new Intl.DateTimeFormat("en-US",
    { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(utcMs));
  const z = parts.find((p) => p.type === "timeZoneName");
  return z ? z.value : tz;
}

// ---------------------------------------------------------------------------
// Status / progress helpers
// ---------------------------------------------------------------------------
function setStatus(html) { els.status.innerHTML = html; }
function statusLine(text, cls) {
  const d = document.createElement("div");
  d.className = "line" + (cls ? " " + cls : "");
  d.textContent = text;
  els.status.appendChild(d);
  return d;
}
function showProgressBar() {
  const wrap = document.createElement("div");
  wrap.className = "progress";
  const inner = document.createElement("span");
  wrap.appendChild(inner);
  els.status.appendChild(wrap);
  return inner;
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------
function airportLabel(rec) {
  const code = rec.iata || rec.icao || "";
  const place = [rec.city, rec.country].filter(Boolean).join(", ");
  return { code, name: rec.name || "", place };
}

function wireAutocomplete(input, box) {
  let items = [];
  let active = -1;
  let seq = 0;   // guards against out-of-order async results from fast typing

  const close = () => {
    box.hidden = true;
    box.innerHTML = "";
    active = -1;
    input.setAttribute("aria-expanded", "false");
  };

  const pick = (rec) => {
    const { code } = airportLabel(rec);
    // Prefer a code (unambiguous to resolveLocation); fall back to name.
    input.value = code || rec.name || `${rec.lat},${rec.lon}`;
    input._resolved = rec;          // cache so we skip a redundant resolve
    close();
  };

  const render = () => {
    box.innerHTML = "";
    items.forEach((rec, i) => {
      const { code, name, place } = airportLabel(rec);
      const row = document.createElement("div");
      row.className = "suggestion" + (i === active ? " active" : "");
      row.setAttribute("role", "option");
      row.innerHTML =
        `<div class="s-code">${code}<span class="s-name">${escapeHtml(name)}</span></div>` +
        (place ? `<div class="s-sub">${escapeHtml(place)}</div>` : "");
      row.addEventListener("mousedown", (e) => { e.preventDefault(); pick(rec); });
      box.appendChild(row);
    });
    box.hidden = items.length === 0;
    input.setAttribute("aria-expanded", items.length ? "true" : "false");
  };

  input.addEventListener("input", async () => {
    input._resolved = null;
    const q = input.value.trim();
    if (q.length < 2) { items = []; close(); return; }
    // searchAirports is async (it awaits the airports dataset). Await it and drop
    // the result if a newer keystroke has since superseded this one.
    const my = ++seq;
    let results;
    try { results = await searchAirports(q, 8); } catch { results = []; }
    if (my !== seq) return;
    items = Array.isArray(results) ? results : [];
    active = -1;
    render();
  });

  input.addEventListener("keydown", (e) => {
    if (box.hidden || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") { close(); }
  });

  input.addEventListener("blur", () => setTimeout(close, 120));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Location resolution (use cached autocomplete pick when available)
// ---------------------------------------------------------------------------
async function resolveField(input) {
  const q = input.value.trim();
  if (!q) return null;
  if (input._resolved) {
    const r = input._resolved;
    return {
      lat: r.lat, lon: r.lon,
      altKm: (r.alt || 0) / 1000,
      name: r.name || (r.iata || r.icao || q),
      short: (r.iata || r.icao || "") + (r.city ? ", " + r.city : ""),
      tz: r.tz || "", source: "airport",
    };
  }
  return await resolveLocation(q);
}

// Ask the browser for the user's position (used when Origin is left blank).
function getBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser can't share a location — tap Edit and enter a place or airport."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (err) => reject(new Error("Couldn't get your location (" +
        (err && err.message ? err.message : "permission denied") +
        ") — tap Edit and enter a place or airport.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 }
    );
  });
}

// Resolve the origin from the browser's geolocation: reverse-geocode to a place
// name (falling back to lat/lon), populate the Origin field, and return the
// origin object. tz is left blank, so times use the browser's local zone — which
// for the user's own location is the right one.
async function resolveBrowserLocation(load) {
  const pos = await getBrowserLocation();
  const name = await reverseGeocode(pos.lat, pos.lon);
  const label = name || `${pos.lat.toFixed(3)}°, ${pos.lon.toFixed(3)}°`;
  els.origin.value = label;       // show what we detected (and for Edit)
  els.origin._resolved = null;
  return { lat: pos.lat, lon: pos.lon, altKm: 0, name: label, short: label, tz: "", source: "geolocation" };
}

// ---------------------------------------------------------------------------
// TLE acquisition
// ---------------------------------------------------------------------------
function looksLikeTLE(text) {
  return typeof text === "string" &&
    /(^|\n)1 \d/.test(text) && /(^|\n)2 \d/.test(text);
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read the selected file."));
    r.readAsText(file);
  });
}

async function tryFetch(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  if (!looksLikeTLE(text)) throw new Error("Response was not TLE data.");
  return text;
}

// Persistent TLE cache (localStorage so it survives reloads / offline use).
const TLE_CACHE_KEY = "starlinkTLE.v1";
const ONE_DAY = 86400000;
function readTLECache() {
  try {
    const o = JSON.parse(localStorage.getItem(TLE_CACHE_KEY));
    if (o && typeof o.text === "string" && looksLikeTLE(o.text) && Number.isFinite(o.fetchedMs)) return o;
  } catch (_) { /* unavailable / corrupt */ }
  return null;
}
function writeTLECache(text) {
  try { localStorage.setItem(TLE_CACHE_KEY, JSON.stringify({ text, fetchedMs: Date.now() })); } catch (_) {}
}

// Set to the in-flight promise while the Advanced "Fetch current TLE" download is
// running, so a search started *during* the fetch can await it instead of silently
// falling through to the synthetic set (which made a loaded TLE apply one run late).
let tleFetchInFlight = null;

// True once the user has opted into REAL data THIS session (fetched the current TLE
// or loaded a .tle file). In-memory only, so a page reload resets to the synthetic
// default — the fetched set stays cached for fast reuse *during* the session, but is
// NOT silently reused as the default after a reload. Synthetic is the default.
let useRealTLE = false;

// Obtain a Starlink TLE set, returning { text, mode }:
//   file      — user-supplied .tle (Advanced)
//   cache     — real TLE fetched earlier (Advanced › Fetch) and still fresh (< 1 day)
//   synthetic — the default: a synthesised Starlink-like constellation (no network)
//
// Find Flares NEVER hits the network — real data is opt-in via the Advanced controls
// (the Fetch button, below, or a file). This keeps the default instant & offline-safe.
async function getTLEText(fileInput, log, epochDate) {
  // 1) explicit file always wins (and seeds the cache).
  if (fileInput.files && fileInput.files[0]) {
    log("Reading TLE file…");
    const text = await readFileText(fileInput.files[0]);
    if (!looksLikeTLE(text)) throw new Error("That file does not look like TLE data.");
    writeTLECache(text);
    useRealTLE = true;
    return { text, mode: "file" };
  }

  // 1b) If a "Fetch current TLE" is still downloading, wait for it so the freshly
  //     fetched data applies to THIS search — not the next one. Without this, a
  //     search started while the fetch was in flight would silently use synthetic.
  if (tleFetchInFlight) {
    log("Finishing current TLE download…");
    try { await tleFetchInFlight; } catch (_) { /* fetch failed — fall through to cache/synthetic */ }
  }

  // 2) Real TLE fetched recently (< 1 day) — reuse it so small date/time tweaks
  //    don't re-download. ONLY when the user opted into real data this session
  //    (useRealTLE); a fresh page load ignores the cache and defaults to synthetic.
  const cache = readTLECache();
  if (useRealTLE && cache && Date.now() - cache.fetchedMs < ONE_DAY) {
    log("Using current satellite data.");
    return { text: cache.text, mode: "cache" };
  }

  // 3) Default: a synthetic constellation. Instant, offline, no rate limits.
  //    Epoch = the requested time (not "now"), so the same inputs give the same
  //    positions on every run — a repeated search with no changes is reproducible.
  log("Building a synthetic constellation…");
  return { text: generateDummyTLE(epochDate || new Date()), mode: "synthetic" };
}

// Download the current Starlink TLE (Advanced "Fetch current TLE" button only).
// Same-origin Sitrec proxy first (allow-listed `request`, server-cached, CORS-free),
// then direct Celestrak. Caches on success; throws on failure (e.g. offline).
async function fetchCurrentTLE() {
  const basePath = window.location.pathname.replace(/\/tools\/.*$/, "");
  const sources = [basePath + "/sitrecServer/proxy.php?request=CURRENT_STARLINK", CELESTRAK];
  let lastErr;
  for (const url of sources) {
    // Set useRealTLE synchronously on success (before this promise resolves) so a
    // search awaiting the in-flight fetch sees the opt-in and uses the real data.
    try { const text = await tryFetch(url); writeTLECache(text); useRealTLE = true; return text; }
    catch (e) { lastErr = e; }
  }
  throw new Error(lastErr ? lastErr.message : "network error");
}

// ---------------------------------------------------------------------------
// Build request from form
// ---------------------------------------------------------------------------
function parseDateTime() {
  const [y, mo, d] = (els.date.value || "").split("-").map(Number);
  const [h, mi] = (els.time.value || "").split(":").map(Number);
  if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) return null;
  return { y, mo, d, h, mi };
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// --- screen toggling -------------------------------------------------------
let activeWorker = null;

// Render a screen by name ("form" | "results" | "info") — toggles visibility ONLY,
// with no history changes, so it is safe to call from both navigation and the
// popstate handler. Preserves the side effects the old togglers had: terminate the
// flare worker when landing on the form, and build the info visuals (once) for info.
function renderScreen(name) {
  if (name === "form" && activeWorker) { activeWorker.terminate(); activeWorker = null; }
  if (name === "info") buildInfoVisuals();
  els.formScreen.hidden = name !== "form";
  els.resultsScreen.hidden = name !== "results";
  els.infoScreen.hidden = name !== "info";
  window.scrollTo(0, 0);
}

// --- history-backed navigation ---------------------------------------------
// Entering a sub-view (results/info) pushes a history entry, so the browser's (and
// mouse's) Back button returns to the previous screen; the on-screen Edit/Back
// buttons call history.back() so manual and browser navigation share one code path
// and never desync the stack. The form is the base entry (replaceState in init);
// popstate renders the target screen WITHOUT pushing. Back from info pops to
// whatever entry was underneath (form or results), so no return-screen bookkeeping
// is needed — the history stack reproduces it losslessly.
function navigateResults() {
  // onSubmit is only reachable from the form, but guard against stacking a second
  // results entry on a re-submit so a single Back always reaches the form.
  if (history.state && history.state.screen === "results") {
    history.replaceState({ screen: "results" }, "");
  } else {
    history.pushState({ screen: "results" }, "");
  }
  renderScreen("results");
}

function navigateInfo() {
  history.pushState({ screen: "info" }, "");
  renderScreen("info");
}

// --- info screen visuals ---------------------------------------------------
let infoBuilt = false;

// Build the info screen's two live visuals once (they animate via SMIL forever):
//   * the "it looks like" naked-eye flare-train preview, and
//   * a demo of the same animated compass rose the results page shows.
function buildInfoVisuals() {
  if (infoBuilt) return;
  infoBuilt = true;
  if (els.infoLookLike) els.infoLookLike.innerHTML = flareSimSky();
  if (els.infoRose) {
    const arrows = [{ azDeg: 296 }, { azDeg: 322 }];
    const flares = [];
    for (let i = 0; i < 40; i++) flares.push({ azDeg: 296 + Math.random() * 26 });
    els.infoRose.innerHTML = compassRose(arrows, flares);
  }
  if (els.infoHorizon) {
    // A stylised example of the horizon "view from here": a low NW flare swarm with
    // drift arrows, a few orientation stars (unlabelled), and three hourly Sun markers
    // sliding across the top — the same builder the results page uses.
    const flares = [];
    for (let i = 0; i < 38; i++) {
      flares.push({
        azDeg: 296 + Math.random() * 26, elDeg: 4 + Math.random() * 13,
        dAzDeg: 0.7 + Math.random() * 0.6, dElDeg: (Math.random() - 0.35) * 0.5, intensity: 0.85,
      });
    }
    const stars = [
      { name: "", azDeg: 288, altDeg: 24, mag: 2.0 },
      { name: "", azDeg: 312, altDeg: 27, mag: 2.2 },
      { name: "", azDeg: 330, altDeg: 17, mag: 1.9 },
    ];
    const sunMarks = [
      { azDeg: 299, label: "10pm" }, { azDeg: 309, label: "11pm" }, { azDeg: 319, label: "12am" },
    ];
    els.infoHorizon.innerHTML =
      horizonView({ stars, bodies: [], flares, sunMarks, ...horizonWindow(flares) });
  }
}

// A loading panel inside the results screen with a SINGLE-PASS progress bar.
//
// The bar is divided into named stages whose widths are proportional to each
// stage's TYPICAL duration in seconds (set via setStages) — so it advances at a
// roughly even real-world pace. The value is monotonic: it can only ever move
// forward (one pass, never a reset), even though the worker reports several
// restarting sub-progress signals (seek fraction, then per-session filter/refine
// done/total). Within the current stage the bar follows real progress when the
// worker reports it (frac), and otherwise CREEPS forward on a timer toward — but
// never reaching — the stage's end, so it keeps moving during indeterminate
// network waits. setMsg sets the small "what's happening" label above the bar.
function renderLoading(msg) {
  els.results.innerHTML =
    `<div class="loading">
       <div class="spinner" aria-hidden="true"></div>
       <div class="loading-msg"></div>
       <div class="progress"><span style="width:0%"></span></div>
     </div>`;
  const msgEl = els.results.querySelector(".loading-msg");
  const bar = els.results.querySelector(".progress > span");
  if (msgEl && msg) msgEl.textContent = msg;

  let segs = {};                                   // id -> { start, end, secs } (bar fractions)
  let curId = null, curStart = 0, curEnd = 1, curSecs = 1, curEnterMs = 0;
  let realFrac = 0;                                // last real fraction for the current stage
  let value = 0;                                   // current bar value (0..1), monotonic
  let timer = null;

  const write = (v) => {
    // monotonic, and never quite 100% until done() — so the fill can't complete early
    value = Math.max(value, Math.min(0.995, v));
    if (bar) bar.style.width = (value * 100).toFixed(1) + "%";
  };
  const recompute = () => {
    const elapsed = (Date.now() - curEnterMs) / 1000;
    // asymptotic creep to 95% of the segment, half-filled after ~curSecs/2 seconds
    const creep = curStart + (curEnd - curStart) * 0.95 * (1 - Math.pow(2, -elapsed / (curSecs * 0.5)));
    const real = curStart + (curEnd - curStart) * Math.max(0, Math.min(1, realFrac));
    write(Math.max(creep, real));
  };

  return {
    setMsg: (m) => { if (msgEl) msgEl.textContent = m; },
    // list: [{ id, secs }] — secs are typical durations; widths are proportional.
    setStages: (list) => {
      const total = list.reduce((s, x) => s + x.secs, 0) || 1;
      let acc = 0; segs = {};
      for (const x of list) {
        const start = acc / total; acc += x.secs;
        segs[x.id] = { start, end: acc / total, secs: x.secs };
      }
    },
    stage: (id) => {
      const s = segs[id];
      if (!s || id === curId) return;              // unknown stage, or already here (idempotent)
      curId = id;
      curStart = Math.max(value, s.start);         // never step back
      curEnd = Math.max(curStart, s.end);
      curSecs = s.secs; curEnterMs = Date.now(); realFrac = 0;
      if (!timer) timer = setInterval(recompute, 60);
      recompute();
    },
    frac: (p) => { realFrac = Math.max(realFrac, p); recompute(); },
    done: () => { if (timer) { clearInterval(timer); timer = null; } value = 1; if (bar) bar.style.width = "100%"; },
    stop: () => { if (timer) { clearInterval(timer); timer = null; } },
  };
}

function renderError(msg) {
  els.results.innerHTML =
    `<div class="verdict no">Couldn't compute flares</div>
     <div class="no-flares"><p>${escapeHtml(msg)}</p>
       <p>Use <b>Edit</b> (top-left) to change your inputs and try again.</p></div>`;
}

// {name, azDeg, altDeg, mag} for bright stars above the horizon at a place/time.
function visibleStars(latDeg, lonDeg, date) {
  const out = [];
  for (const s of BRIGHT_STARS) {
    const aa = equatorialToAltAz(s.raDeg, s.decDeg, latDeg, lonDeg, date);
    if (aa.altDeg > -1) out.push({ name: s.name, azDeg: aa.azDeg, altDeg: aa.altDeg, mag: s.mag });
  }
  return out;
}

// Bright planets (distinct colours) and the Moon (grey, 2× size) above the horizon.
const PLANET_COLORS = [
  ["Venus", "#5dff8a"],   // green
  ["Mars", "#ff5a4d"],    // red
  ["Jupiter", "#ffd24a"], // yellow
  ["Saturn", "#6db4ff"],  // blue
];
function visibleBodies(latDeg, lonDeg, date) {
  const out = [];
  for (const [name, color] of PLANET_COLORS) {
    const eq = planetEquatorial(name, date);
    if (!eq) continue;
    const aa = equatorialToAltAz(eq.raDeg, eq.decDeg, latDeg, lonDeg, date);
    if (aa.altDeg > -1) out.push({ name, azDeg: aa.azDeg, altDeg: aa.altDeg, color, r: 3.4 });
  }
  const m = moonEquatorial(date);
  const ma = equatorialToAltAz(m.raDeg, m.decDeg, latDeg, lonDeg, date);
  if (ma.altDeg > -1) out.push({ name: "Moon", azDeg: ma.azDeg, altDeg: ma.altDeg, color: "#cfd4dc", r: 6.8 });
  return out;
}

// Hourly Sun-azimuth markers spanning the visible window [t1,t2]. The flares are
// forward-scattered sunlight, so the Sun's azimuth tracks where the swarm is; one
// marker per whole local hour turns the horizon view's azimuth axis into a rough
// time axis. The Sun is below the horizon (twilight/night), so only its azimuth
// is meaningful — we return { azDeg, label } and the chart draws a labelled tick.
function sunHourMarkers(t1, t2, tz, latDeg, lonDeg) {
  const HOUR = 3600000;
  // ms the zone is ahead of UTC at a given instant (browser-local when tz empty).
  const offAt = (ms) => tz ? tzOffsetMs(new Date(ms), tz)
                           : -new Date(ms).getTimezoneOffset() * 60000;
  // The Sun's azimuth at a UTC instant.
  const sunAz = (utc) => {
    const eq = sunEquatorial(new Date(utc));
    return equatorialToAltAz(eq.raDeg, eq.decDeg, latDeg, lonDeg, new Date(utc)).azDeg;
  };
  const off0 = offAt(t1);
  const out = [];
  // First whole local hour at or after t1, then step hour by hour to t2. Each
  // local-hour boundary is re-projected to UTC with the offset at that instant,
  // so a DST/odd-offset change inside the (short) window is still placed correctly.
  let local = Math.ceil((t1 + off0) / HOUR) * HOUR;
  for (let i = 0; i < 48; i++, local += HOUR) {        // 48 = generous safety cap
    const utc = local - offAt(local - off0);
    if (utc > t2) break;
    if (utc < t1) continue;
    out.push({ azDeg: sunAz(utc), label: fmtHourLabel(utc, tz) });
  }
  return out;
}

// Base URL of the Sitrec app that hosts this tool: the tool lives at
// <origin><base>/tools/shf/, so Sitrec is at <origin><base>/. Using the SAME
// host means local.metabunk.org opens local Sitrec, production opens production.
function sitrecBaseURL() {
  const base = window.location.pathname.replace(/\/tools\/shf\/.*$/, "").replace(/\/+$/, "");
  return window.location.origin + base + "/";
}

// "Open in Sitrec" — hand the current prediction to the main Sitrec app, which
// builds a night-sky sitch (satellites + flares), a 60×-speed timeline over the
// window/flight, a synthetic flight camera track (or fixed ground camera +50ft),
// and aims the look camera at the peak flare direction. See src/fromApp.js.
function openInSitrec(req, flares, origin, dest, peakMs) {
  // Peak look direction = the flare nearest the peak (busiest) minute.
  let peak = flares[0], best = Infinity;
  for (const f of flares) { const d = Math.abs(f.peakMs - peakMs); if (d < best) { best = d; peak = f; } }
  const t1 = Math.min(...flares.map((f) => f.startMs));
  const t2 = Math.max(...flares.map((f) => f.endMs));

  const q = new URLSearchParams();
  q.set("fromapp", "1");
  q.set("mode", dest ? "flight" : "fixed");
  q.set("lat", origin.lat.toFixed(5));
  q.set("lon", origin.lon.toFixed(5));
  q.set("peakAz", peak.azDeg.toFixed(1));
  q.set("peakEl", peak.elDeg.toFixed(1));
  // The Sitrec timeline runs (1×) from the first flare to the last, starting at the peak.
  q.set("firstMs", String(Math.round(t1)));
  q.set("lastMs", String(Math.round(t2)));
  q.set("peakMs", String(Math.round(peakMs)));
  if (origin.name) q.set("place", origin.name);

  if (dest) {
    q.set("dlat", dest.lat.toFixed(5));
    q.set("dlon", dest.lon.toFixed(5));
    q.set("cruiseAltFt", String(Math.round((req.cruiseAltKm || 11.2772) * 1000 / 0.3048)));
    // The flight envelope (departure + duration) lets Sitrec place the camera at the
    // correct point along the route for each moment of the (shorter) flare window.
    q.set("flightStartMs", String(Math.round(req.startMs)));
    q.set("flightDurSec", String(Math.round(req.durationSec || ((t2 - req.startMs) / 1000))));
  }
  window.open(sitrecBaseURL() + "?" + q.toString(), "_blank", "noopener");
}

// Full results screen: verdict, one-sentence summary, compass rose, horizon view.
function renderResults(flares, stats, req, origin, dest) {
  if (!flares || flares.length === 0) { renderNoFlares(stats, req, origin); return; }
  flares = flares.slice().sort((a, b) => a.peakMs - b.peakMs);
  const tz = origin.tz || "";
  const t1 = Math.min(...flares.map((f) => f.startMs));
  const t2 = Math.max(...flares.map((f) => f.endMs));
  const startAz = flares[0].azDeg, endAz = flares[flares.length - 1].azDeg;
  const startC = flares[0].compass || compass16(startAz);
  const endC = flares[flares.length - 1].compass || compass16(endAz);
  const moved = startC !== endC && Math.abs(angDiff(endAz, startAz)) >= 12;
  const zone = tzAbbrev(t1, tz);

  // Compact three-line header (no big banner) — tuned to fit an iPhone SE.
  const localT = `${fmtTime(t1, tz, { second: undefined })}–${fmtTime(t2, tz, { second: undefined })}`;
  const utcT = `${fmtTime(t1, "UTC", { second: undefined })}–${fmtTime(t2, "UTC", { second: undefined })}`;
  const dirLine = moved ? `Look <b>${startC}</b> → <b>${endC}</b>` : `Look <b>${startC}</b>`;
  const place = dest ? `${origin.short || origin.name} → ${dest.short || dest.name}` : (origin.short || origin.name);

  // Peak = the busiest minute (greatest flare density) — the best moment to look,
  // matching the rose's density arc. (Flare intensity saturates at 1.0, so the
  // single "brightest" flare isn't meaningful; density is.)
  const peakMs = (() => {
    const bin = 60000, m = new Map();
    for (const f of flares) { const b = Math.round(f.peakMs / bin); m.set(b, (m.get(b) || 0) + 1); }
    let bestBin = Math.round(flares[0].peakMs / bin), bestN = -1;
    for (const [b, n] of m) if (n > bestN) { bestN = n; bestBin = b; }
    return bestBin * bin;
  })();
  const peakT = fmtTime(peakMs, tz, { second: undefined });

  const arrows = moved ? [{ azDeg: startAz }, { azDeg: endAz }] : [{ azDeg: startAz }];

  const obsLat = flares[0].obsLat ?? origin.lat;
  const obsLon = flares[0].obsLon ?? origin.lon;
  const stars = visibleStars(obsLat, obsLon, new Date(t1));
  const bodies = visibleBodies(obsLat, obsLon, new Date(t1));
  const hvFlares = flares.map((f) => ({
    azDeg: f.azDeg, elDeg: f.elDeg, dAzDeg: f.dAzDeg, dElDeg: f.dElDeg, intensity: f.intensity,
  }));
  const win = horizonWindow(hvFlares);
  const sunMarks = sunHourMarkers(t1, t2, tz, obsLat, obsLon);

  els.results.innerHTML =
    `<div class="r-when">Flares visible <b>${localT}</b> ${escapeHtml(zone)} · peak <b>${peakT}</b></div>
     <div class="r-dir">${dirLine}</div>
     <div class="r-meta">${escapeHtml(place)} · ${fmtDateShort(t1, tz)} · ${utcT} UTC</div>
     <div class="rose-wrap">${compassRose(arrows, flares)}</div>
     <div class="horizon-wrap">${horizonView({ stars, bodies, flares: hvFlares, sunMarks, ...win })}</div>
     <div class="legend"><span class="lg-flare">●</span> flare &nbsp;·&nbsp; <span class="lg-star">●</span> star &nbsp;·&nbsp; <span class="lg-arrow">↗</span> direction &nbsp;·&nbsp; <span class="lg-hour">↓</span> Sun by hour</div>
     <button id="opensitrec" type="button" class="go-btn sitrec-btn">Open in Sitrec ↗</button>
     ${notesHTML(req)}`;

  const openBtn = els.results.querySelector("#opensitrec");
  if (openBtn) openBtn.addEventListener("click", () => openInSitrec(req, flares, origin, dest, peakMs));

  // Per-flare detail list — kept but disabled for a cleaner results page.
  const SHOW_FLARE_LIST = false;
  if (SHOW_FLARE_LIST) {
    const plural = flares.length === 1 ? "" : "s";
    const det = document.createElement("details");
    det.className = "flare-details";
    det.innerHTML = `<summary>All ${flares.length} flare${plural} · scanned ${stats.satsTotal} satellites</summary>`;
    for (const f of flares) det.appendChild(flareCard(f, tz));
    els.results.appendChild(det);
  }
}

function flareCard(f, tz) {
  const card = document.createElement("div");
  card.className = "card";
  const compass = f.compass || compass16(f.azDeg);
  const dur = Math.max(0, (f.endMs - f.startMs) / 1000);
  const intensity = Math.max(0, Math.min(1, f.intensity ?? 0));
  const pct = Math.round(intensity * 100);

  card.innerHTML = `
    <div class="card-top">
      <div>
        <div class="time">${fmtTime(f.peakMs, tz)}</div>
        <div class="dur">${dur.toFixed(1)} s · peak glint ${f.peakGlintDeg.toFixed(2)}°</div>
      </div>
      <div class="sat">
        ${escapeHtml(f.satName || "Starlink")}<br>
        <span class="norad">NORAD ${f.noradId ?? "—"}</span>
      </div>
    </div>
    <div class="dir">
      <span class="compass">${compass}</span>
      <span class="az">azimuth ${f.azDeg.toFixed(0)}°</span>
      <span class="el">elevation <b>${f.elDeg.toFixed(0)}°</b></span>
    </div>
    <div class="meta">
      <span><b>Range</b> ${Math.round(f.rangeKm)} km</span>
      <span><b>Sat altitude</b> ${Math.round(f.satAltKm)} km</span>
    </div>
    <div class="bar-wrap">
      <div class="bar-label"><span>Relative brightness</span><span>${pct}%</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>`;
  return card;
}

function renderNoFlares(stats, req, origin) {
  const div = document.createElement("div");
  div.className = "no-flares";
  const scanned = stats ? `${stats.satsTotal} satellites` : "the satellites";

  let lead, tail;
  if (stats && stats.exhausted) {
    // Forward search reached the look-ahead limit without finding a flare session.
    const days = Math.round((stats.lookAheadSec || 0) / 86400);
    lead = `<p>Searched the next <b>${days} day${days === 1 ? "" : "s"}</b> from this time and found no
       visible horizon flares.</p>`;
    tail = `<p>This is unusual at most latitudes. Near the poles (continuous daylight or polar night)
       flares can be impossible — try another date or location.</p>`;
  } else {
    // Flight mode (fixed window) with no flares during the flight.
    const span = stats ? `${Math.round((stats.windowSec || 0) / 60)} min` : "the window";
    const allDark = stats && stats.productiveSteps === 0;
    lead = allDark
      ? `<p>For the whole ${span} flight it was either <b>daylight</b>, or the night was so deep that the
           satellites were in <b>Earth's shadow</b> — so no flares were possible.</p>`
      : `<p>Scanned ${scanned} over the ${span} flight and found no horizon flares.</p>`;
    tail = `<p>Try a flight during the <b>dark hours</b> — flares appear once the sky is dark, and continue
       through much of the night while the satellites overhead are still catching sunlight.</p>`;
  }

  div.innerHTML = `
    ${lead}
    <p>A flare needs <b>you</b> in darkness while the <b>satellite</b> is still lit by the Sun. That holds
       from dusk, through much of the night, until the small hours when even low satellites fall into
       shadow (and again before dawn).</p>
    ${tail}`;
  els.results.innerHTML = `<div class="verdict no">No Flares</div>${notesHTML(req)}`;
  els.results.appendChild(div);
}

// Advisory banners: out-of-range date fallback, and which satellite data was used.
// The data-source note shows on EVERY run so it is always clear whether the
// positions came from synthetic (approximate) or real Starlink elements.
function notesHTML(req) {
  let html = "";
  if (req && req.simulated)
    html += `<div class="sim-note">Simulated results, out of date range — recomputed for today.</div>`;
  if (req && req.tleMode === "synthetic")
    html += `<div class="sim-note synth">⚠ Synthetic satellites — positions are approximate. Use <b>Advanced › Fetch current TLE</b> for real data.</div>`;
  else if (req && req.tleMode === "cache")
    html += `<div class="sim-note real">Real Starlink data (current TLE).</div>`;
  else if (req && req.tleMode === "file")
    html += `<div class="sim-note real">Using your uploaded TLE file.</div>`;
  return html;
}

// ---------------------------------------------------------------------------
// Main submit handler
// ---------------------------------------------------------------------------
function formError(msg) { setStatus(""); statusLine(msg, "err"); }

async function onSubmit(e) {
  e.preventDefault();
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }

  // Validate while still on the form.
  const dt = parseDateTime();
  if (!dt) { formError("Please choose a valid date and time."); return; }
  setStatus("");

  // Switch to the results screen with a loading panel; everything else renders there.
  navigateResults();
  const load = renderLoading("Resolving location…");

  // One-pass progress bar tracking ONLY the long step — the flare scan — which is driven
  // by the worker's real filter/refine progress (see the message handler). Locating the
  // place and loading the TLE set are near-instant when warm (only the first, slow TLE
  // fetch ever isn't), so they're kept OFF the bar: reserving a slice for them just made
  // it hop to ~25% instantly. The bar stays at 0 (spinner + label show activity) until the
  // scan starts. secs only sets the gentle creep that fills gaps with no measurable
  // progress (the seek phase, or the wait between dark windows); ≈ a full ~10k-sat scan.
  const isFlight = !!els.dest.value.trim();
  load.setStages(isFlight ? [{ id: "scan", secs: 10 }] : [{ id: "compute", secs: 12 }]);

  try {
    // Origin: use the typed value, or fall back to the browser's location if blank.
    let origin;
    if (els.origin.value.trim()) {
      origin = await resolveField(els.origin);
      if (!origin) throw new Error("Couldn't find that origin — check the spelling.");
    } else {
      load.setMsg("Getting your location…");
      origin = await resolveBrowserLocation(load);
    }

    let dest = null;
    if (els.dest.value.trim()) {
      dest = await resolveField(els.dest);
      if (!dest) throw new Error("Couldn't find that destination — check the spelling.");
    }

    // TLEs are only accurate within roughly a week of "now"; far-future/past dates
    // make SGP4 diverge into nonsense. If the requested moment is more than a week
    // away, fall back to today's date (keeping the requested time of day) and flag
    // the results as a simulation using current orbital data.
    let startMs = wallClockToUTCms(dt.y, dt.mo, dt.d, dt.h, dt.mi, origin.tz);
    let simulated = false;
    const WEEK = 7 * 86400 * 1000;
    if (Math.abs(startMs - Date.now()) > WEEK) {
      simulated = true;
      const today = new Date();
      startMs = wallClockToUTCms(today.getFullYear(), today.getMonth() + 1, today.getDate(),
        dt.h, dt.mi, origin.tz);
    }

    // Engine defaults (flare angle 5°, min elevation 0°, geocentric nadir model) —
    // fixed internally; Advanced controls only the TLE source, not these.
    const options = {};
    // Search at most 24 hours ahead for the next flares. The flare geometry recurs on
    // a ~daily cycle (Sun position + the constellation's ground track), so if there is
    // no flare in the first day there won't be one in the next two either — searching
    // further just wastes time.
    const LOOK_AHEAD_DAYS = 1;

    let req;
    if (!dest) {
      req = {
        mode: "fixed",
        lat: origin.lat, lon: origin.lon, altKm: origin.altKm || 0,
        startMs, maxLookAheadSec: LOOK_AHEAD_DAYS * 86400, options,
      };
      load.setMsg(`Searching for the next flares near ${origin.name}…`);
    } else {
      const distKm = greatCircleDistanceKm(origin.lat, origin.lon, dest.lat, dest.lon);
      const durationSec = (+els.duration.value > 0)
        ? +els.duration.value * 3600
        : distKm / 875 * 3600 + 1800;   // ~875 km/h cruise + 30 min overhead
      const cruiseAltKm = (+els.alt.value > 0 ? +els.alt.value : 37000) * 0.3048 / 1000;
      req = {
        mode: "flight",
        origin: { lat: origin.lat, lon: origin.lon },
        dest: { lat: dest.lat, lon: dest.lon },
        cruiseAltKm, durationSec, startMs, options,
      };
      load.setMsg(`Checking the ${origin.name} → ${dest.name} flight…`);
    }
    req.simulated = simulated;

    // --- TLE --- (off the bar; bar stays at 0 with just the spinner + this label)
    load.setMsg("Loading satellite data…");
    let tleText;
    try {
      const tle = await getTLEText(els.tlefile, (m) => load.setMsg(m), new Date(startMs));
      tleText = tle.text;
      req.tleMode = tle.mode;   // 'dummy' / 'stale' surface a note on the results
    } catch (err) {
      load.stop();
      renderError(err.message);
      return;
    }

    // --- run worker ---
    const computeStage = isFlight ? "scan" : "compute";
    const scanCeil = isFlight ? 1 : 0.92;   // fixed leaves headroom in case it scans >1 dark window
    load.stage(computeStage);
    load.setMsg("Computing flares…");
    const w = new Worker("flareWorker.js" + VERSION, { type: "module" });
    activeWorker = w;

    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "progress") {
        // Label narrates the phase; the bar follows the scan's real filter/refine
        // progress (filter = first half, refine = second). frac() is monotonic, so a
        // fixed search's later dark window can't shove it back — and its fill is capped
        // just below 100% (scanCeil) so a possible extra window can't read as fully done;
        // a flight is one scan and fills the whole bar. The seek phase has no measurable
        // progress, so the creep floor nudges the bar along until the scan reports in.
        load.stage(computeStage);
        if (m.phase === "seek") load.setMsg("Finding the next dark window…");
        else if (m.phase === "filter") {
          load.setMsg("Scanning satellites…");
          if (m.total) load.frac(scanCeil * 0.5 * m.done / m.total);
        } else if (m.phase === "refine") {
          // Fixed mode cycles filter/refine once per window; keep a steady label there
          // so the text doesn't flip each session (flight makes a single clean pass).
          load.setMsg(isFlight ? "Pinpointing flares…" : "Scanning satellites…");
          if (m.total) load.frac(scanCeil * (0.5 + 0.5 * m.done / m.total));
        }
      } else if (m.type === "result") {
        load.done();
        lastResults = { flares: m.flares, stats: m.stats, req, origin, dest };   // for shf/shfEval debugging
        renderResults(m.flares, m.stats, req, origin, dest);
        w.terminate(); activeWorker = null;
      } else if (m.type === "error") {
        load.stop();
        renderError(m.message || "unknown computation error");
        w.terminate(); activeWorker = null;
      }
    };
    w.onerror = (err) => {
      load.stop();
      renderError(err.message || "the worker failed to run");
      try { w.terminate(); } catch (_) {}
      activeWorker = null;
    };

    w.postMessage({ req, tleText });
  } catch (err) {
    load.stop();
    renderError(err && err.message ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// MCP / debug bridge
// ---------------------------------------------------------------------------
// The SitrecBridge browser extension already injects into this page (it matches
// any /sitrec/tools/ path and treats it as "ready"), so its sitrec_eval works
// here. But sitrec_eval runs `new Function()` in the extension's own scope, which
// only sees `window.*` — and app.js is a non-bundled ES module, so els, lastResults,
// the imported helpers, etc. live in module scope, invisible to it.
//
// Two hooks bridge that gap:
//   * window.shf      — curated live handles; reachable straight from sitrec_eval:
//                         sitrec_eval({ expression: "shf.lastResults?.flares.length" })
//                         sitrec_eval({ expression: "shf.els.origin.value" })
//   * window.shfEval  — runs a DIRECT eval() inside this module, so it can reach any
//                       module-private binding (works because tools are served as raw,
//                       un-minified ES modules — names are preserved):
//                         sitrec_eval({ expression: "shfEval('horizonWindow(lastResults.flares)')" })
//                         sitrec_eval({ expression: "shfEval('Object.keys(lastResults.stats)')" })
// No secrets live in this module (it is all public client-side code), but to avoid
// shipping an eval gadget to production we attach the hooks ONLY on local dev hosts
// (local.metabunk.org / localhost / 127.0.0.1) — never on www.metabunk.org.
let lastResults = null;       // { flares, stats, req, origin, dest } from the most recent run
const isLocalHost = /^(local\.metabunk\.org|localhost|127\.0\.0\.1)$/.test(window.location.hostname);
if (isLocalHost) {
  window.shfEval = (code) => eval(code);   // direct eval => this module's scope
  window.shf = {
    VERSION,
    get els() { return els; },
    get lastResults() { return lastResults; },
    get activeWorker() { return activeWorker; },
    get useRealTLE() { return useRealTLE; },
    // live module helpers, callable from the MCP / console for ad-hoc checks
    horizonView, horizonWindow, compassRose,
    equatorialToAltAz, sunEquatorial, planetEquatorial, moonEquatorial,
    resolveLocation, greatCircleDistanceKm,
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function setNowDefaults() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  els.date.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  els.time.value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const countSats = (text) => (text.match(/^1 \d/gm) || []).length;

function wireTLEControls() {
  // "Fetch current TLE" — the only thing that hits the network (opt-in real data).
  els.fetchtle.addEventListener("click", async () => {
    els.fetchtle.disabled = true;
    els.tlestatus.className = "help";
    els.tlestatus.textContent = "Downloading current satellite data…";
    const p = fetchCurrentTLE();
    tleFetchInFlight = p;   // so a search started now waits for this download
    try {
      const text = await p;
      els.tlestatus.className = "help ok";
      const n = countSats(text);
      els.tlestatus.textContent = `✓ Current TLE loaded — ${n} satellite${n === 1 ? "" : "s"}. (Used for the next search.)`;
    } catch (e) {
      els.tlestatus.className = "help err";
      els.tlestatus.textContent = `Couldn't fetch (${e.message || "offline?"}); the synthetic set will be used.`;
    } finally {
      if (tleFetchInFlight === p) tleFetchInFlight = null;
      els.fetchtle.disabled = false;
    }
  });
  // Reflect a chosen .tle file in the status line.
  els.tlefile.addEventListener("change", () => {
    const file = els.tlefile.files && els.tlefile.files[0];
    els.tlestatus.className = file ? "help ok" : "help";
    els.tlestatus.textContent = file ? `✓ Using file: ${file.name}` : "";
  });
}

// Register the service worker that makes this an installable, offline-capable PWA.
// Relative scriptURL + scope so it works at any deploy path; updateViaCache:"none"
// so each new build's sw.js (with its version stamp) is always picked up fresh.
// Skipped under automation (navigator.webdriver) to keep e2e runs deterministic.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || navigator.webdriver) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" })
      .catch((e) => console.warn("Service worker registration failed:", e && e.message));
  });
}

// ---------------------------------------------------------------------------
// Install-as-app (PWA)
// ---------------------------------------------------------------------------
// True when the page is already running as an installed app (so there's nothing
// to install). Covers the standard display-mode and iOS Safari's navigator.standalone.
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: window-controls-overlay)").matches
    || window.navigator.standalone === true;
}

// Detect platform + browser so the MANUAL install steps match what the user sees.
// (The automated path is chosen purely by whether `beforeinstallprompt` fired, which
// no iOS browser and no desktop Safari/Firefox ever do — so detection only drives the
// instruction text.) Since iOS 16.4 every iOS browser, not just Safari, can Add to
// Home Screen, but the Share button lives in a different place in each.
function platformInfo() {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop (MacIntel) UA, so fall back to the touch-point test.
  const ios = /iphone|ipad|ipod/i.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  const iosChrome = ios && /CriOS\//.test(ua);                 // Chrome on iOS
  const iosSafari = ios && !/CriOS\/|FxiOS\/|EdgiOS\/|OPiOS\/|OPT\//.test(ua); // Safari (not a wrapper)
  const macSafari = !ios && /Macintosh/.test(ua) && /Safari\//.test(ua)
    && !/Chrom(e|ium)|Edg\/|OPR\//.test(ua);                   // Safari on macOS
  const firefoxDesktop = !ios && !android && /Firefox\//.test(ua);
  return { ios, android, iosChrome, iosSafari, macSafari, firefoxDesktop };
}

// Whether the user dismissed the install suggestion this session (sessionStorage
// can throw in some privacy modes, so guard it).
function installDismissed() {
  try { return sessionStorage.getItem("shfInstallDismissed") === "1"; } catch (_) { return false; }
}

// Show the Install button only when not already installed and not dismissed.
function updateInstallButton() {
  if (els.installWrap) els.installWrap.hidden = isStandalone() || installDismissed();
}

function openInstallModal(title, bodyHTML) {
  els.installModalTitle.textContent = title;
  els.installModalBody.innerHTML = bodyHTML;
  els.installModal.hidden = false;
}
function closeInstallModal() { els.installModal.hidden = true; }

// The iOS share glyph (a box with an up-arrow), drawn inline so the steps are unambiguous.
const SHARE_ICON =
  `<svg class="share-ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
     <path d="M12 3 L12 15 M8.5 6.5 L12 3 L15.5 6.5" fill="none" stroke="#7fd0ff"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
     <path d="M7 10 L5 10 L5 21 L19 21 L19 10 L17 10" fill="none" stroke="#7fd0ff"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
   </svg>`;

// Platform-specific manual instructions (used when there's no automated prompt).
function manualInstall() {
  const p = platformInfo();
  if (p.ios) {
    // Where the Share button is differs by iOS browser; all then offer Add to Home Screen.
    const whereShare = p.iosSafari
      ? `the <strong>Share</strong> button ${SHARE_ICON} in the toolbar (bottom of the screen)`
      : p.iosChrome
        ? `the <strong>Share</strong> button ${SHARE_ICON} (in the address bar, or the <strong>⋯</strong> menu)`
        : `your browser's <strong>Share</strong> ${SHARE_ICON} option (usually in the <strong>⋯</strong> menu)`;
    return {
      title: "Add to your Home Screen",
      body: `<p>To install on iPhone or iPad:</p>
        <ol>
          <li>Tap ${whereShare}.</li>
          <li>Scroll down and tap <strong>“Add to Home Screen”</strong>.</li>
          <li>Tap <strong>Add</strong>.</li>
        </ol>
        <p class="modal-note">In non-Safari browsers this needs iOS/iPadOS 16.4 or later. The
          app then opens full-screen and works offline.</p>`,
    };
  }
  if (p.android) {
    return {
      title: "Add to your Home Screen",
      body: `<p>To install on Android:</p>
        <ol>
          <li>Tap the <strong>⋮</strong> menu (top-right).</li>
          <li>Tap <strong>“Install app”</strong> (or <strong>“Add to Home screen”</strong>).</li>
          <li>Tap <strong>Install</strong>.</li>
        </ol>`,
    };
  }
  if (p.macSafari) {
    return {
      title: "Install the app",
      body: `<p>To install in Safari on a Mac:</p>
        <ol>
          <li>In the menu bar, choose <strong>File → Add to Dock</strong>.</li>
          <li>Click <strong>Add</strong>.</li>
        </ol>
        <p class="modal-note">Requires macOS Sonoma (14) or later.</p>`,
    };
  }
  if (p.firefoxDesktop) {
    return {
      title: "Install the app",
      body: `<p>Firefox on the desktop can't install web apps. To install Starlink Horizon
        Flares, open this page in desktop <strong>Chrome</strong> or <strong>Edge</strong>,
        <strong>Safari</strong> on a Mac, or use <strong>Add to Home Screen</strong> on your
        phone.</p>`,
    };
  }
  // Desktop Chrome / Edge (and anything else with an address-bar install affordance).
  return {
    title: "Install the app",
    body: `<p>To install on this device:</p>
      <ol>
        <li>Click the <strong>install icon</strong> in the address bar (a monitor with a ↓),
          or open the browser's <strong>⋮</strong> menu.</li>
        <li>Choose <strong>“Install Starlink Horizon Flares…”</strong>.</li>
      </ol>`,
  };
}

async function onInstallClick() {
  const bip = window.__bipEvent;
  if (bip) {
    // Automated path (Android Chrome/Edge/Opera/Firefox, desktop Chrome/Edge): confirm,
    // then show the browser's native install prompt.
    if (!window.confirm("Install the Starlink Horizon Flares app on this device?")) return;
    bip.prompt();
    try {
      const choice = await bip.userChoice;
      if (choice && choice.outcome === "accepted") {
        window.__bipEvent = null;          // a prompt can only be used once
        updateInstallButton();
      }
    } catch (_) { /* user dismissed — leave the button in place */ }
    return;
  }
  // Manual path (all iOS browsers, desktop Safari/Firefox): platform-specific steps.
  const { title, body } = manualInstall();
  openInstallModal(title, body);
}

function wireInstall() {
  if (!els.installApp) return;
  els.installApp.addEventListener("click", onInstallClick);
  els.installModalClose.addEventListener("click", closeInstallModal);
  els.installModal.querySelector("[data-close]").addEventListener("click", closeInstallModal);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.installModal.hidden) closeInstallModal();
  });
  // The early-capture inline script (in index.html) re-fires these on window.
  window.addEventListener("bip-ready", updateInstallButton);
  window.addEventListener("app-installed", () => { closeInstallModal(); updateInstallButton(); });
  // Dismiss "×" — hide the install suggestion for the rest of the session.
  const dismiss = document.getElementById("install-dismiss");
  if (dismiss) dismiss.addEventListener("click", () => {
    try { sessionStorage.setItem("shfInstallDismissed", "1"); } catch (_) { /* ignore */ }
    updateInstallButton();
  });
  updateInstallButton();
}

function init() {
  setNowDefaults();
  loadAirports();   // fire-and-forget; searchAirports degrades gracefully until ready
  wireAutocomplete(els.origin, els.originSug);
  wireAutocomplete(els.dest, els.destSug);
  wireTLEControls();
  els.form.addEventListener("submit", onSubmit);
  // History-backed navigation: the form is the base entry; sub-views push a state and
  // popstate renders the target. Edit/Back go through history.back() so the on-screen
  // buttons and the browser/mouse Back button share one path.
  history.replaceState({ screen: "form" }, "");
  window.addEventListener("popstate", (e) => renderScreen((e.state && e.state.screen) || "form"));
  els.edit.addEventListener("click", () => history.back());   // results → back to the form
  // "i" buttons (one per screen) open the info page; Back returns to the caller.
  for (const b of document.querySelectorAll("[data-info]")) b.addEventListener("click", navigateInfo);
  if (els.infoBack) els.infoBack.addEventListener("click", () => history.back());
  wireInstall();
  registerServiceWorker();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
