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
  { equatorialToAltAz, planetEquatorial, moonEquatorial },
  { BRIGHT_STARS },
  { compassRose, horizonView, horizonWindow },
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

function showForm() {
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  els.resultsScreen.hidden = true;
  els.formScreen.hidden = false;
  window.scrollTo(0, 0);
}
function showResults() {
  els.formScreen.hidden = true;
  els.resultsScreen.hidden = false;
  window.scrollTo(0, 0);
}

// A loading panel inside the results screen; returns helpers to update it.
function renderLoading(msg) {
  els.results.innerHTML =
    `<div class="loading">
       <div class="spinner" aria-hidden="true"></div>
       <div class="loading-msg"></div>
       <div class="progress"><span style="width:0%"></span></div>
     </div>`;
  const msgEl = els.results.querySelector(".loading-msg");
  const bar = els.results.querySelector(".progress > span");
  if (msgEl) msgEl.textContent = msg;
  return {
    setMsg: (m) => { if (msgEl) msgEl.textContent = m; },
    setBar: (frac) => { if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%"; },
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

  els.results.innerHTML =
    `<div class="r-when">Flares visible <b>${localT}</b> ${escapeHtml(zone)} · peak <b>${peakT}</b></div>
     <div class="r-dir">${dirLine}</div>
     <div class="r-meta">${escapeHtml(place)} · ${fmtDateShort(t1, tz)} · ${utcT} UTC</div>
     <div class="rose-wrap">${compassRose(arrows, flares)}</div>
     <div class="horizon-wrap">${horizonView({ stars, bodies, flares: hvFlares, ...win })}</div>
     <div class="legend"><span class="lg-flare">●</span> flare &nbsp;·&nbsp; <span class="lg-star">●</span> star &nbsp;·&nbsp; <span class="lg-arrow">↗</span> direction</div>
     ${notesHTML(req)}`;

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
  showResults();
  const load = renderLoading("Resolving location…");

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
    const LOOK_AHEAD_DAYS = 3;

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

    // --- TLE ---
    load.setMsg("Loading satellite data…");
    let tleText;
    try {
      const tle = await getTLEText(els.tlefile, (m) => load.setMsg(m), new Date(startMs));
      tleText = tle.text;
      req.tleMode = tle.mode;   // 'dummy' / 'stale' surface a note on the results
    } catch (err) {
      renderError(err.message);
      return;
    }

    // --- run worker ---
    load.setMsg("Computing flares…");
    const w = new Worker("flareWorker.js" + VERSION, { type: "module" });
    activeWorker = w;

    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "progress") {
        load.setMsg(m.phase === "seek" ? "Skipping ahead to the next dark window…" : "Computing flares…");
        if (typeof m.fraction === "number") load.setBar(m.fraction);
        else if (m.total) load.setBar(m.done / m.total);
      } else if (m.type === "result") {
        renderResults(m.flares, m.stats, req, origin, dest);
        w.terminate(); activeWorker = null;
      } else if (m.type === "error") {
        renderError(m.message || "unknown computation error");
        w.terminate(); activeWorker = null;
      }
    };
    w.onerror = (err) => {
      renderError(err.message || "the worker failed to run");
      try { w.terminate(); } catch (_) {}
      activeWorker = null;
    };

    w.postMessage({ req, tleText });
  } catch (err) {
    renderError(err && err.message ? err.message : String(err));
  }
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

function init() {
  setNowDefaults();
  loadAirports();   // fire-and-forget; searchAirports degrades gracefully until ready
  wireAutocomplete(els.origin, els.originSug);
  wireAutocomplete(els.dest, els.destSug);
  wireTLEControls();
  els.form.addEventListener("submit", onSubmit);
  els.edit.addEventListener("click", showForm);  // results → back to the form
  registerServiceWorker();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
