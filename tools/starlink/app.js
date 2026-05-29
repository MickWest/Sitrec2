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
  { equatorialToAltAz },
  { BRIGHT_STARS },
  { compassRose, horizonView, horizonWindow },
] = await Promise.all([
  import("./location.js" + VERSION),
  import("./geo.js" + VERSION),
  import("./astro.js" + VERSION),
  import("./stars.js" + VERSION),
  import("./skyview.js" + VERSION),
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
  cone: $("cone"), minel: $("minel"), model: $("model"), window: $("window"),
  tlefile: $("tlefile"),
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
  return { lat: pos.lat, lon: pos.lon, altKm: 0, name: label, tz: "", source: "geolocation" };
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

async function getTLEText(fileInput, log) {
  // 1) explicit file
  if (fileInput.files && fileInput.files[0]) {
    log("Reading TLE file…");
    const text = await readFileText(fileInput.files[0]);
    if (!looksLikeTLE(text)) throw new Error("That file does not look like TLE data.");
    return text;
  }
  // 2) sessionStorage cache
  try {
    const cached = sessionStorage.getItem("starlinkTLE");
    if (cached && looksLikeTLE(cached)) { log("Using cached TLE data."); return cached; }
  } catch (_) { /* private mode etc. */ }

  // 3) same-origin Sitrec proxy, 4) direct Celestrak.
  // The Sitrec proxy (sitrecServer/proxy.php) takes a fixed allow-listed `request`
  // key — NOT an arbitrary url — and serves a server-cached, CORS-free copy.
  // basePath strips "/tools/..." so it resolves to "/sitrec/sitrecServer/..."
  // regardless of how deeply this tool is nested (matches tools/airport-arrivals).
  const basePath = window.location.pathname.replace(/\/tools\/.*$/, "");
  const sources = [
    { label: "Fetching TLE via Sitrec proxy…",
      url: basePath + "/sitrecServer/proxy.php?request=CURRENT_STARLINK" },
    { label: "Fetching TLE direct from Celestrak…", url: CELESTRAK },
  ];
  let lastErr;
  for (const s of sources) {
    try {
      log(s.label);
      const text = await tryFetch(s.url);
      try { sessionStorage.setItem("starlinkTLE", text); } catch (_) {}
      return text;
    } catch (e) { lastErr = e; }
  }
  const err = new Error(
    "Could not download Starlink TLE data (" + (lastErr ? lastErr.message : "network error") +
    "). Download the Starlink set from celestrak.org (GROUP=starlink, FORMAT=TLE) " +
    "and load it with the file picker under Advanced.");
  err.tleFailure = true;
  throw err;
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

  const dirPhrase = moved
    ? `starting in the <b>${startC}</b> and moving toward the <b>${endC}</b>`
    : `looking toward the <b>${startC}</b>`;
  const localRange = `<b>${fmtTime(t1, tz, { second: undefined })}</b> to <b>${fmtTime(t2, tz, { second: undefined })}</b>`;
  const utcRange = `${fmtTime(t1, "UTC", { second: undefined })}–${fmtTime(t2, "UTC", { second: undefined })} UTC`;
  const sentence =
    `Flares will be visible from ${localRange} ${escapeHtml(zone)} (${utcRange}) on ${fmtDate(t1, tz)}, ${dirPhrase}.`;

  const arrows = moved ? [{ azDeg: startAz }, { azDeg: endAz }] : [{ azDeg: startAz }];

  const obsLat = flares[0].obsLat ?? origin.lat;
  const obsLon = flares[0].obsLon ?? origin.lon;
  const stars = visibleStars(obsLat, obsLon, new Date(t1));
  const hvFlares = flares.map((f) => ({
    azDeg: f.azDeg, elDeg: f.elDeg, dAzDeg: f.dAzDeg, dElDeg: f.dElDeg, intensity: f.intensity,
  }));
  const win = horizonWindow(hvFlares);

  const place = dest ? `${origin.name} → ${dest.name}` : origin.name;
  const plural = flares.length === 1 ? "" : "s";

  // Shown when the requested date was out of TLE range and we fell back to today.
  const simBanner = (req && req.simulated)
    ? `<div class="sim-note">Simulated results, out of date range — using current satellite data.</div>`
    : "";

  els.results.innerHTML =
    `<div class="verdict yes">FLARES VISIBLE</div>
     ${simBanner}
     <p class="sentence">${sentence}</p>
     <div class="place">${escapeHtml(place)}</div>
     <div class="rose-wrap">${compassRose(arrows)}</div>
     <div class="section-label">The view toward the ${escapeHtml(startC)} around ${fmtTime(t1, tz, { second: undefined })} ${escapeHtml(zone)}</div>
     <div class="horizon-wrap">${horizonView({ stars, flares: hvFlares, ...win })}</div>
     <div class="legend"><span class="lg-flare">●</span> Starlink flare &nbsp;·&nbsp; <span class="lg-star">●</span> bright star &nbsp;·&nbsp; <span class="lg-arrow">↗</span> direction of travel</div>`;

  // Per-flare detail list — kept but disabled for a cleaner results page.
  const SHOW_FLARE_LIST = false;
  if (SHOW_FLARE_LIST) {
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
    lead = `<p>Searched the next <b>${days} day${days === 1 ? "" : "s"}</b> (${stats.scannedSessions || 0}
       twilight sessions) from this time and found no visible horizon flares.</p>`;
    tail = `<p>This is unusual at most latitudes. If you set a high <b>minimum elevation</b>, lower it;
       near the poles in continuous daylight or polar night, flares may be impossible — try another
       date or location. Increasing the look-ahead under Advanced may also help.</p>`;
  } else {
    // Flight mode (fixed window) with no flares during the flight.
    const span = stats ? `${Math.round((stats.windowSec || 0) / 60)} min` : "the window";
    const allOutOfTwilight = stats && stats.productiveSteps === 0;
    lead = allOutOfTwilight
      ? `<p>The whole ${span} flight was in <b>full daylight or deep night</b> — outside the brief
           twilight when flares can occur — so none was possible.</p>`
      : `<p>Scanned ${scanned} over the ${span} flight and found no horizon flares.</p>`;
    tail = `<p>Try a departure nearer dawn or dusk${allOutOfTwilight ? "" : ", or increasing the flare cone under Advanced"}.</p>`;
  }

  div.innerHTML = `
    ${lead}
    <p>Flares need a specific alignment: <b>you</b> must be in twilight or darkness
       while the <b>satellite</b> is still lit by the Sun. That sweet spot happens
       within roughly an hour of <b>dawn or dusk</b>.</p>
    ${tail}`;
  const simBanner = (req && req.simulated)
    ? `<div class="sim-note">Simulated results, out of date range — using current satellite data.</div>`
    : "";
  els.results.innerHTML = `<div class="verdict no">No Flares</div>${simBanner}`;
  els.results.appendChild(div);
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

    const options = {
      flareAngleDeg: +els.cone.value || 5,
      minElevationDeg: +els.minel.value || 0,
      flareModel: els.model.value,
    };

    let req;
    if (!dest) {
      const lookAheadDays = +els.window.value || 3;
      req = {
        mode: "fixed",
        lat: origin.lat, lon: origin.lon, altKm: origin.altKm || 0,
        startMs, maxLookAheadSec: lookAheadDays * 86400, options,
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
      tleText = await getTLEText(els.tlefile, (m) => load.setMsg(m));
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
        load.setMsg(m.phase === "seek" ? "Skipping ahead to the next twilight…" : "Computing flares…");
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

function init() {
  setNowDefaults();
  loadAirports();   // fire-and-forget; searchAirports degrades gracefully until ready
  wireAutocomplete(els.origin, els.originSug);
  wireAutocomplete(els.dest, els.destSug);
  els.form.addEventListener("submit", onSubmit);
  els.edit.addEventListener("click", showForm);  // results → back to the form
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
