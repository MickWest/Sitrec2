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
  { compassRose, horizonView, horizonWindow, flareSimSky, horizonProjection, flareBrightnessAt, skyBodiesSVG, MOTION_SAMPLE_MS },
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
  date: $("date"), time: $("time"), tzbtn: $("tzbtn"),
  duration: $("duration"), alt: $("alt"),
  tlefile: $("tlefile"), fetchtle: $("fetchtle"), tlestatus: $("tlestatus"),
  status: $("status"), results: $("results"),
  formScreen: $("form-screen"), resultsScreen: $("results-screen"), edit: $("edit"),
  infoScreen: $("info-screen"), infoBack: $("info-back"),
  infoLookLike: $("info-looklike"), infoRose: $("info-rose"), infoHorizon: $("info-horizon"),
  installWrap: $("install-wrap"), installApp: $("install-app"),
  installModal: $("install-modal"), installModalTitle: $("install-modal-title"),
  installModalBody: $("install-modal-body"), installModalClose: $("install-modal-close"),
  topProgressWrap: $("top-progress"), topProgress: $("top-progress-bar"),
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
// Short zone abbreviation (e.g. "PST", "MDT", "UTC") for a zone at a given instant.
// tz "" → the browser's local zone. Used for the form button and every where/when line
// so the location, date, and zone are always spelled out — never a bare "No Flares".
function zoneAbbrev(tz, atMs) {
  const o = { timeZoneName: "short", hour: "2-digit" };
  if (tz) o.timeZone = tz;
  const parts = new Intl.DateTimeFormat("en-US", o).formatToParts(new Date(atMs ?? Date.now()));
  const z = parts.find((p) => p.type === "timeZoneName");
  return z ? z.value : (tz || "local");
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

function wireAutocomplete(input, box, onPick) {
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
    if (onPick) onPick(rec);        // e.g. origin → update the time-zone button
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
async function resolveBrowserLocation() {
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

// One-shot, tab-scoped flag written by the "CLICK HERE TO LOAD CURRENT SATELLITES"
// button just before it reloads. useRealTLE is in-memory only (reset on reload), so
// without this the reload would fall back to synthetic; on the next load init() reads
// this, opts into the freshly-fetched real data, restores the form, and re-runs.
const PENDING_REAL_KEY = "shfPendingRealSearch";
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

// Set to the in-flight TLE download (the startup background fetch, the Advanced "Fetch
// current TLE" button, or the in-results "Load current satellites" button) so a search
// started *during* the download awaits it instead of falling through to synthetic early.
let tleFetchInFlight = null;

// True once a real current TLE has been successfully loaded this session (background
// startup fetch, manual fetch, or a .tle file). Informational only — getTLEText keys
// off the cache freshness, not this — but the debug bridge surfaces it.
let useRealTLE = false;

// True iff a fresh (< 1 day) real TLE is cached and ready to use right now.
function haveFreshRealTLE() {
  const c = readTLECache();
  return !!(c && Date.now() - c.fetchedMs < ONE_DAY);
}

// Obtain a Starlink TLE set, returning { text, mode }:
//   file      — user-supplied .tle (Advanced); always wins
//   cache     — the real current TLE (downloaded at startup / on demand), fresh (< 1 day)
//   synthetic — fallback: a synthesised Starlink-like constellation (no network)
//
// Real data is the DEFAULT: a download is kicked off at startup (startBackgroundTLEFetch)
// and reused here whenever fresh. We fall back to synthetic only when the real data is
// unavailable (offline / fetch failed) OR the requested date is out of the TLE's useful
// range (inRange === false) — for those dates synthetic, anchored to that date, is apter.
async function getTLEText(fileInput, log, epochDate, inRange) {
  // 1) explicit file always wins (and seeds the cache).
  if (fileInput.files && fileInput.files[0]) {
    log("Reading TLE file…");
    const text = await readFileText(fileInput.files[0]);
    if (!looksLikeTLE(text)) throw new Error("That file does not look like TLE data.");
    writeTLECache(text);
    useRealTLE = true;
    return { text, mode: "file" };
  }

  // 2) Out of the current TLE's useful range → synthetic anchored to the requested date.
  //    Real elements are only valid near "now"; for far dates a synthetic constellation
  //    at that date gives the meaningful seasonal flare geometry the user asked about.
  if (!inRange) {
    log("Building a synthetic constellation for this date…");
    return { text: generateDummyTLE(epochDate || new Date()), mode: "synthetic" };
  }

  // 3) In range → prefer the real current TLE. If the startup/on-demand download is still
  //    running, wait for it so the freshly downloaded data applies to THIS search.
  if (tleFetchInFlight) {
    log("Finishing current TLE download…");
    try { await tleFetchInFlight; } catch (_) { /* failed — fall through to cache/synthetic */ }
  }
  const cache = readTLECache();
  if (cache && Date.now() - cache.fetchedMs < ONE_DAY) {
    log("Using current satellite data.");
    return { text: cache.text, mode: "cache" };
  }

  // 4) Real data unavailable (offline / fetch failed) → synthetic fallback.
  log("Couldn't load current satellites — using a synthetic constellation…");
  return { text: generateDummyTLE(epochDate || new Date()), mode: "synthetic" };
}

// Download the current Starlink TLE. Same-origin Sitrec proxy first (allow-listed
// `request`, server-cached, CORS-free), then direct Celestrak. Caches on success;
// throws on failure (e.g. offline).
async function fetchCurrentTLE() {
  // Strip from "/tools/" onward case-INSENSITIVELY (the tool may be served at /tools/SHF/ on a
  // case-insensitive filesystem), matching sitrecBaseURL(), so the proxy base path is always right.
  const basePath = window.location.pathname.replace(/\/tools\/.*$/i, "");
  const sources = [basePath + "/sitrecServer/proxy.php?request=CURRENT_STARLINK", CELESTRAK];
  let lastErr;
  for (const url of sources) {
    // Set useRealTLE synchronously on success (before this promise resolves) so a
    // search awaiting the in-flight fetch sees that real data is now available.
    try { const text = await tryFetch(url); writeTLECache(text); useRealTLE = true; return text; }
    catch (e) { lastErr = e; }
  }
  throw new Error(lastErr ? lastErr.message : "network error");
}

// Kick off a current-TLE download in the background at startup, so real data is ready (or
// already cached) by the time the user runs a search. Non-blocking, best-effort: any
// failure (offline, rate-limited) just leaves us on the synthetic fallback. A search
// started before this finishes awaits it via tleFetchInFlight (see getTLEText step 3).
function startBackgroundTLEFetch() {
  // Already have a fresh real set (e.g. downloaded earlier today)? Reuse it, skip the download.
  if (haveFreshRealTLE()) { useRealTLE = true; return; }
  // Skip only when the browser is certain it's offline; otherwise try and fail gracefully.
  if (navigator.onLine === false) return;
  const p = fetchCurrentTLE().catch((e) => {
    console.warn("Background TLE download failed; synthetic until it's available:", e && e.message);
  });
  tleFetchInFlight = p;
  p.finally(() => { if (tleFetchInFlight === p) tleFetchInFlight = null; });
}

// Snapshot the current form inputs so a reload can re-run the exact same search.
// (init() calls setNowDefaults(), so without this the reload would reset to "now".)
function savePendingRealSearch() {
  try {
    sessionStorage.setItem(PENDING_REAL_KEY, JSON.stringify({
      date: els.date.value, time: els.time.value,
      origin: els.origin.value, dest: els.dest.value,
      duration: els.duration.value, alt: els.alt.value,
      tzMode, formTz,
    }));
  } catch (_) { /* private mode / quota — reload will still load real data, just not auto-run */ }
}

// On load: if the previous page reloaded itself after fetching real TLE, opt back into
// that data, restore the form, and re-run the search. Returns true if it handled a reload.
function restorePendingRealSearch() {
  let s;
  try {
    const raw = sessionStorage.getItem(PENDING_REAL_KEY);
    sessionStorage.removeItem(PENDING_REAL_KEY);   // one-shot
    if (!raw) return false;
    s = JSON.parse(raw);
  } catch (_) { return false; }
  if (!s) return false;
  useRealTLE = true;   // the cache (localStorage) holds the TLE fetched before the reload
  els.date.value = s.date || els.date.value;
  els.time.value = s.time || els.time.value;
  els.origin.value = s.origin || "";
  els.dest.value = s.dest || "";
  els.duration.value = s.duration || "";
  els.alt.value = s.alt || "";
  tzMode = s.tzMode === "utc" ? "utc" : "local";
  formTz = s.formTz || "";
  updateTzButton();
  // Re-run with the freshly loaded real data (requestSubmit fires the submit handler).
  if (els.form.requestSubmit) els.form.requestSubmit();
  else els.form.dispatchEvent(new Event("submit", { cancelable: true }));
  return true;
}

// Click handler for the synthetic-data note (now a button): download the current TLE
// with a loading indicator, then reload so the search re-runs against real data.
async function onLoadCurrentSats(btn) {
  if (btn.dataset.loading === "1") return;   // ignore re-clicks while in flight
  btn.dataset.loading = "1";
  btn.disabled = true;
  btn.classList.remove("load-err");
  btn.innerHTML = `<span class="spinner spinner-inline"></span> Loading current satellites…`;
  try {
    await fetchCurrentTLE();        // populates the localStorage cache + sets useRealTLE
    savePendingRealSearch();        // so the reload re-runs this search with real data
    location.reload();
  } catch (e) {
    btn.dataset.loading = "0";
    btn.disabled = false;
    btn.classList.add("load-err");
    btn.innerHTML = `Couldn't load satellites (${escapeHtml(e.message || "offline?")}).<br>` +
                    `<span class="synth-cta">TAP TO RETRY</span>`;
  }
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

// --- Time-zone selection for the entered Date/Time -------------------------
// The form interprets the entered wall-clock in `tzMode`:
//   "local" → the origin location's zone when known (airport tz), else the browser's
//   "utc"   → UTC
// The little button after the Time field shows the active zone and toggles it.
let tzMode = "local";          // "local" | "utc"
let formTz = "";               // origin location's IANA tz when known ("" = browser local)

// IANA zone the entered time is read in, given the current mode/location.
function formInterpTz() { return tzMode === "utc" ? "UTC" : (formTz || ""); }

// The entered Date/Time as a UTC instant (for the button's zone abbreviation, which
// can vary with the date across a DST boundary). Falls back to "now" if incomplete.
function enteredMs() {
  const dt = parseDateTime();
  return dt ? wallClockToUTCms(dt.y, dt.mo, dt.d, dt.h, dt.mi, formInterpTz()) : Date.now();
}

function updateTzButton() {
  if (!els.tzbtn) return;
  const label = tzMode === "utc" ? "UTC" : zoneAbbrev(formTz, enteredMs());
  els.tzbtn.textContent = label;
  els.tzbtn.classList.toggle("utc", tzMode === "utc");
  els.tzbtn.setAttribute("aria-label",
    `Time zone: ${label}. Tap to switch to ${tzMode === "utc" ? "local time" : "UTC"}.`);
}

// Write a UTC instant into the Date/Time fields as the wall-clock for zone `tz`
// (tz "" = browser local). Setting .value doesn't fire change/input, so this won't
// re-trigger the relabel listeners.
function setDateTimeFromMs(ms, tz) {
  const o = { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
              hour: "2-digit", minute: "2-digit" };
  if (tz) o.timeZone = tz;
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-US", o).formatToParts(new Date(ms))) p[part.type] = part.value;
  els.date.value = `${p.year}-${p.month}-${p.day}`;
  els.time.value = `${p.hour}:${p.minute}`;
}

// Toggle local ↔ UTC, KEEPING THE SAME ABSOLUTE INSTANT: read the current wall-clock in
// its current zone, flip the mode, then re-display that instant in the new zone (the date
// rolls over if needed). With empty fields there's nothing to convert — just flip.
function toggleTimeZone() {
  const dt = parseDateTime();
  if (dt) {
    const ms = wallClockToUTCms(dt.y, dt.mo, dt.d, dt.h, dt.mi, formInterpTz());
    tzMode = tzMode === "utc" ? "local" : "utc";
    setDateTimeFromMs(ms, formInterpTz());
  } else {
    tzMode = tzMode === "utc" ? "local" : "utc";
  }
  updateTzButton();
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
  if (name !== "results") stopReplay();   // tear down the replay rAF/listeners when leaving results
  if (name === "form" && activeWorker) { activeWorker.terminate(); activeWorker = null; }
  if (name === "form") { stopLiveTimer(); showTopProgress(false); }   // leaving a running scan
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

// --- Merged scanning + results view --------------------------------------------
// There is no separate loading screen: the results layout appears immediately and the
// compass rose + horizon view populate in real time as the worker STREAMS flares. A thin
// orange bar at the top of the window shows scan progress. We re-render at 10 Hz from the
// flares accumulated so far; the final worker "result" then replaces the live view with
// the polished renderResults (animated rose, Open-in-Sitrec, notes).
let liveFlares = [];
let liveDirty = false;
let liveTimer = null;
let liveCtx = null;                              // { req, origin, dest }
let liveStatusEl = null, liveRoseEl = null, liveHorizonEl = null;
let liveDirEl = null, liveMetaEl = null;         // the "Look …" + place/date lines (shown live too)

// While scanning, each newly-found flare fires a ONE-SHOT 60× playback of its moving dot
// along its path (over the replay-mode dim-streak backdrop), so the wide view fills with a
// flurry of dots as the area populates. Distinct from the post-scan replay (1× looping).
// reg = active bursts {f, t0}; seen = flares already fired; proj = current framing. The rAF
// redraws the .replay-flares group of the LIVE horizon SVG each frame from the registry, so
// dots survive the 10 Hz SVG rebuilds (which only redraw the static backdrop).
let liveBurst = null;
const LIVE_BURST_SPEED = 60;
// Wide-view flare style, cycled by the ★ button: 'dots' (disk + arrow) → 'streaks' (timelapse
// lines) → 'replay' (animated, time-driven playback). Default is the replay animation (looping,
// non-live); the ★ cycles on to dots/streaks. Persists across renders this session.
let horizonMode = "replay";
const HMODES = ["dots", "streaks", "replay"];

// Wide-view zoom, cycled by the magnifier button: 1× (default) → 2× → 4× → 1×. Zoom narrows the
// projection window (halfWidth/elMax ÷ factor) so POSITIONS spread out while element sizes (text,
// dots, lines — all absolute px) stay the same; everything re-frames around the same centre.
let horizonZoom = 1;
const ZOOMS = [1, 2, 4];
function zoomWin(win) {
  return horizonZoom > 1
    ? { ...win, halfWidthDeg: win.halfWidthDeg / horizonZoom, elMaxDeg: win.elMaxDeg / horizonZoom }
    : win;
}

// Wide-view container: the horizon SVG (rebuilt on render/toggle) plus two persistent overlay
// buttons at the left edge that survive the SVG rebuilds — ★ cycles the style, and ⏱ (shown
// only when "now" is inside the flaring window) plays the replay anchored to the real clock.
function horizonWrapHTML(svg) {
  return `<div class="horizon-wrap"><div class="horizon-svg">${svg}</div>`
    + `<button type="button" class="hv-zoom${horizonZoom > 1 ? " on" : ""}" `
    + `aria-label="Zoom the wide view: 1×, 2×, 4×" title="Zoom: 1× → 2× → 4×">${horizonZoom}×</button>`
    + `<button type="button" class="hv-toggle${horizonMode !== "dots" ? " on" : ""}" `
    + `aria-label="Cycle wide-view style: dots, streaks, replay" `
    + `title="View: dots → timelapse streaks → replay">★</button>`
    + `</div>`;
}

// Thin orange progress bar fixed at the very top of the window.
function setTopProgress(frac) {
  if (!els.topProgress) return;
  els.topProgress.style.width = (Math.max(0, Math.min(1, frac || 0)) * 100).toFixed(1) + "%";
}
function showTopProgress(on) {
  if (els.topProgressWrap) els.topProgressWrap.classList.toggle("on", !!on);
  if (!on) setTopProgress(0);
}

function setLiveStatus(html) { if (liveStatusEl) liveStatusEl.innerHTML = html; }

// Build the live results scaffold once: a status line + the two SVG panels + legend.
// The panels stay empty until flares stream in; setLiveStatus narrates the pre-scan
// phases (locating, loading TLE) and then the running flare count.
function setupLiveResults() {
  stopReplay();      // a fresh scan tears down any replay animation from the previous result
  stopLiveBurst();   // …and any leftover live-burst animator
  // Same element structure as the final results screen (r-when / r-dir / r-meta / rose /
  // horizon / legend) so the compass and wide view sit in their FINAL position from the
  // first frame — only the text inside the three header lines fills in as the scan runs.
  els.results.innerHTML =
    `<div class="r-when" id="live-status">Resolving location…</div>
     <div class="r-dir" id="live-dir"></div>
     <div class="r-meta" id="live-meta"></div>
     <div class="rose-wrap" id="live-rose"></div>
     ${horizonWrapHTML("")}
     <div class="legend"><span class="lg-flare">●</span> flare &nbsp;·&nbsp; <span class="lg-star">●</span> star &nbsp;·&nbsp; <span class="lg-arrow">↗</span> direction &nbsp;·&nbsp; <span class="lg-hour">↓</span> Sun by hour</div>`;
  // The live scaffold reuses ".r-when" for its status line, so tests/automation must NOT treat
  // that class as "results are final". data-state is the unambiguous marker: "scanning" now,
  // flipped to "final" by renderResults/renderNoFlares/renderError when the real screen renders.
  els.results.dataset.state = "scanning";
  liveStatusEl = document.getElementById("live-status");
  liveDirEl = document.getElementById("live-dir");
  liveMetaEl = document.getElementById("live-meta");
  liveRoseEl = document.getElementById("live-rose");
  liveHorizonEl = els.results.querySelector(".horizon-svg");   // the SVG holder inside the wrap
  const btn = els.results.querySelector(".hv-toggle");
  if (btn) btn.addEventListener("click", () => {
    horizonMode = HMODES[(HMODES.indexOf(horizonMode) + 1) % HMODES.length];
    btn.classList.toggle("on", horizonMode !== "dots");
    liveRender();   // re-draw immediately (replay shows as static streaks until the scan finishes)
  });
  const zbtn = els.results.querySelector(".hv-zoom");
  if (zbtn) zbtn.addEventListener("click", () => {
    horizonZoom = ZOOMS[(ZOOMS.indexOf(horizonZoom) + 1) % ZOOMS.length];
    zbtn.textContent = horizonZoom + "×";
    zbtn.classList.toggle("on", horizonZoom > 1);
    liveRender();
  });
  startLiveBurst();   // begin the rAF loop that animates each newly-found flare's 60× dot burst
}

// --- live "flurry of dots" burst animator ----------------------------------
function stopLiveBurst() {
  if (liveBurst) { if (liveBurst.raf) cancelAnimationFrame(liveBurst.raf); liveBurst = null; }
}

function startLiveBurst() {
  stopLiveBurst();
  liveBurst = { reg: [], seen: new Set(), proj: null, raf: 0 };
  const frame = () => {
    if (!liveBurst) return;
    drawLiveBurst();
    liveBurst.raf = requestAnimationFrame(frame);
  };
  liveBurst.raf = requestAnimationFrame(frame);
}

// Register any newly-arrived visible flares for a one-shot burst (t0 = now), and keep the
// projection in sync — the framing window grows as flares accumulate, so the dots' screen
// positions must use the CURRENT projection (recomputed by liveRender each redraw).
function updateLiveBurst(flares, proj) {
  if (!liveBurst) return;
  liveBurst.proj = proj;
  for (const f of flares) {
    if (liveBurst.seen.has(f)) continue;
    liveBurst.seen.add(f);
    liveBurst.reg.push({ f, t0: performance.now() });
  }
}

// Draw the currently-bursting dots into the live horizon SVG's .replay-flares group. Each
// flare plays from its start to its end at 60× wall-clock, then drops out of the registry
// (leaving only its dim streak in the backdrop). Mirrors startReplay's per-dot drawing.
function drawLiveBurst() {
  const lb = liveBurst;
  if (!lb || !lb.proj || !liveHorizonEl) return;
  const g = liveHorizonEl.querySelector(".replay-flares");
  if (!g) return;   // not in replay mode (no animated layer) — nothing to draw
  const proj = lb.proj, now = performance.now();
  let s = "";
  for (let i = lb.reg.length - 1; i >= 0; i--) {
    const { f, t0 } = lb.reg[i];
    const dur = (f.endMs - f.startMs) || 1;
    const elapsed = (now - t0) * LIVE_BURST_SPEED;   // scaled real-ms since the flare's start
    if (elapsed > dur) { lb.reg.splice(i, 1); continue; }   // one-shot finished
    const t = f.startMs + elapsed;
    const b = flareBrightnessAt(f, t);
    if (b <= 0.01) continue;
    const k = (t - (f.peakMs ?? t)) / MOTION_SAMPLE_MS;
    const az = f.azDeg + (f.dAzDeg || 0) * k;
    if (!proj.inWin(az)) continue;
    const x = proj.xOf(az), y = proj.yOf(f.elDeg + (f.dElDeg || 0) * k);
    const r = (1.0 + 2.0 * b).toFixed(2);
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="url(#rflareDot)" opacity="${Math.min(1, 0.5 + b).toFixed(3)}"/>`;
  }
  g.innerHTML = s;
}

function startLiveTimer() {
  stopLiveTimer();
  liveTimer = setInterval(() => { if (liveDirty) { liveDirty = false; liveRender(); } }, 100);   // 10 Hz
}
function stopLiveTimer() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

// Redraw the rose + horizon + status from the flares accumulated so far. Cheap enough to
// run at 10 Hz; the compass rose is drawn in "live" mode (no animated sprinkle, which
// would otherwise restart every frame).
function liveRender() {
  if (!liveCtx) return;
  // The place/date line is known from the start — fill it immediately so the layout below
  // (compass + wide view) is already in its final position before any flare arrives.
  if (liveMetaEl) liveMetaEl.innerHTML = whereWhenInner(liveCtx.req, liveCtx.origin, liveCtx.dest);
  // Only visible flares drive the live count/plot (the shared f.visible flag, as final).
  const flares = liveFlares.filter((f) => f.visible);
  if (!flares.length) { setLiveStatus("Scanning…"); return; }
  const tz = liveCtx.origin.tz || "";
  let t1 = Infinity, t2 = -Infinity, startAz = flares[0].azDeg, endAz = flares[0].azDeg;
  let startT = Infinity, endT = -Infinity;
  for (const f of flares) {
    if (f.startMs < t1) t1 = f.startMs;
    if (f.endMs > t2) t2 = f.endMs;
    if (f.peakMs < startT) { startT = f.peakMs; startAz = f.azDeg; }
    if (f.peakMs > endT) { endT = f.peakMs; endAz = f.azDeg; }
  }
  const obsLat = flares[0].obsLat ?? liveCtx.origin.lat;
  const obsLon = flares[0].obsLon ?? liveCtx.origin.lon;
  const stars = visibleStars(obsLat, obsLon, new Date(t1));
  const bodies = visibleBodies(obsLat, obsLon, new Date(t1));
  const hvFlares = flares.map((f) =>
    ({ azDeg: f.azDeg, elDeg: f.elDeg, dAzDeg: f.dAzDeg, dElDeg: f.dElDeg, intensity: f.intensity,
       startMs: f.startMs, peakMs: f.peakMs, endMs: f.endMs, coreStartMs: f.coreStartMs, coreEndMs: f.coreEndMs }));
  const win = horizonWindow(hvFlares);
  const sunMarks = sunHourMarkers(t1, t2, tz, obsLat, obsLon);
  const moved = compass16(startAz) !== compass16(endAz) && Math.abs(angDiff(endAz, startAz)) >= 12;
  const arrows = moved ? [{ azDeg: startAz }, { azDeg: endAz }] : [{ azDeg: startAz }];
  const range = `${fmtTime(t1, tz, { second: undefined })}–${fmtTime(t2, tz, { second: undefined })} ${escapeHtml(zoneAbbrev(tz, t1))}`;
  setLiveStatus(`Scanning… <b>${flares.length}</b> flare${flares.length === 1 ? "" : "s"} · ${range}`);
  // "Look …" direction line — same content as the final header, shown live for a stable layout.
  if (liveDirEl) liveDirEl.innerHTML = moved ? `Look <b>${compass16(startAz)}</b> → <b>${compass16(endAz)}</b>` : `Look <b>${compass16(startAz)}</b>`;
  if (liveRoseEl) liveRoseEl.innerHTML = compassRose(arrows, hvFlares, { live: true });
  // Use replay mode live: it draws the dim (12%) streak backdrop AND the empty .replay-flares
  // layer the burst animator fills with the 60× flurry of dots as flares stream in. (dots/
  // streaks modes have no animated layer, so the burst simply doesn't draw there.)
  const liveMode = horizonMode;
  if (liveHorizonEl) liveHorizonEl.innerHTML = horizonView({ stars, bodies, flares: hvFlares, sunMarks, mode: liveMode, ...zoomWin(win) });
  if (liveMode === "replay") updateLiveBurst(flares, horizonProjection(zoomWin(win)));
}

// Compact "<place> · <date>, <time> <ZONE> · <UTC>" context line so every results,
// no-flares, and error screen always states where and when (and in which zone) the
// search was for. Times use the location's zone when known (origin.tz), else browser
// local, and always also show UTC. startMs is the searched start (already adjusted if
// the date was out of range). Returns "" when there's no location/time yet.
function whereWhenInner(req, origin, dest) {
  if (!req || !origin || !req.startMs) return "";
  const tz = origin.tz || "";
  const ms = req.startMs;
  const place = dest ? `${origin.short || origin.name} → ${dest.short || dest.name}`
                     : (origin.short || origin.name);
  const when = `${fmtDateShort(ms, tz)}, ${fmtTime(ms, tz, { second: undefined })} ${zoneAbbrev(tz, ms)}`;
  const utc = `${fmtTime(ms, "UTC", { second: undefined })} UTC`;
  return `${escapeHtml(place)} · ${escapeHtml(when)} · ${utc}`;
}
function whereWhenLine(req, origin, dest) {
  const inner = whereWhenInner(req, origin, dest);
  return inner ? `<div class="r-meta">${inner}</div>` : "";
}

function renderError(msg, req, origin, dest) {
  stopLiveBurst();   // the live DOM (and its .replay-flares target) is about to be replaced
  els.results.innerHTML =
    `<div class="verdict no">Couldn't compute flares</div>${whereWhenLine(req, origin, dest)}
     <div class="no-flares"><p>${escapeHtml(msg)}</p>
       <p>Use <b>Edit</b> (top-left) to change your inputs and try again.</p></div>`;
  els.results.dataset.state = "final";   // real (error) screen is up (see setupLiveResults)
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
// The Sun's azimuth (° CW from N) at a place and UTC instant. Shared by the hourly markers
// and the replay Sun, so the draggable Sun lands on the same azimuths as the ticks above it.
function sunAzimuthAt(utcMs, latDeg, lonDeg) {
  const d = new Date(utcMs);
  const eq = sunEquatorial(d);
  return equatorialToAltAz(eq.raDeg, eq.decDeg, latDeg, lonDeg, d).azDeg;
}

function sunHourMarkers(t1, t2, tz, latDeg, lonDeg) {
  const HOUR = 3600000;
  // ms the zone is ahead of UTC at a given instant (browser-local when tz empty).
  const offAt = (ms) => tz ? tzOffsetMs(new Date(ms), tz)
                           : -new Date(ms).getTimezoneOffset() * 60000;
  const sunAz = (utc) => sunAzimuthAt(utc, latDeg, lonDeg);
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

// ---------------------------------------------------------------------------
// Replay mode — animate the flares over the window at 1× real time
// ---------------------------------------------------------------------------
// The ★ "replay" view plays the prediction the way it will actually look: each satellite
// brightens, holds, and fades over its REAL duration (shared flareBrightnessAt), drifting along
// its real apparent path, with the faint timelapse streaks behind for context. A draggable Sun
// under the horizon marks the current instant (at the Sun's true azimuth) and scrubs time.
// Playback starts at the busiest minute and loops over the window; long gaps with nothing
// visible are skipped (each flare still plays at 1×). The ⏱ button anchors it to the real
// clock instead (only offered when "now" is inside the window). One rAF loop drives it all.
let replayCtl = null;

function stopReplay() {
  if (replayCtl) { replayCtl.stop(); replayCtl = null; }
}

function startReplay(o) {
  stopReplay();
  const root = o.root.querySelector("svg") || o.root;
  const flaresG = root.querySelector(".replay-flares");
  if (!flaresG) return;
  const sunG = root.querySelector(".replay-sun");
  const bodiesG = root.querySelector(".replay-bodies");   // stars + planets (redrawn each second)
  const timeEl = root.querySelector(".replay-time");      // live HH:MM:SS readout
  // LIVE badges (above the time, below the Sun) show only when anchored to the real clock.
  root.querySelectorAll(".replay-live").forEach((e) => e.setAttribute("visibility", o.realtime ? "visible" : "hidden"));
  const { proj, flares, t1, t2, peakMs, obsLat, obsLon, tz } = o;
  const zone = zoneAbbrev(tz, peakMs);
  const clampT = (t) => (t < t1 ? t1 : t > t2 ? t2 : t);
  let lastSec = null;   // throttles the slow-moving sky + the seconds readout to 1 Hz

  // Pre-sample the Sun's screen-x across the window for placing + scrubbing the Sun icon.
  const NS = 120, sunX = new Array(NS + 1), sunT = new Array(NS + 1);
  for (let i = 0; i <= NS; i++) {
    const t = t1 + (t2 - t1) * (i / NS);
    sunT[i] = t;
    sunX[i] = proj.xOf(sunAzimuthAt(t, obsLat, obsLon));
  }
  const clampX = (x) => Math.max(proj.padL, Math.min(proj.W - proj.padR, x));
  const anyActive = (t) => flares.some((f) => t >= f.startMs - 500 && t <= f.endMs + 400);
  const nextStart = (t) => { let m = Infinity; for (const f of flares) if (f.startMs > t && f.startMs < m) m = f.startMs; return m; };

  const ctl = { realtime: !!o.realtime, dragging: false, stopped: false, raf: 0,
                t: o.realtime ? clampT(Date.now()) : peakMs, last: 0 };
  replayCtl = ctl;

  // Render the flares active at time t (positioned + brightened), and move the Sun.
  function draw(t) {
    let s = "";
    for (const f of flares) {
      const b = flareBrightnessAt(f, t);
      if (b <= 0.01) continue;
      const k = (t - (f.peakMs ?? t)) / MOTION_SAMPLE_MS;
      const az = f.azDeg + (f.dAzDeg || 0) * k;
      if (!proj.inWin(az)) continue;
      const x = proj.xOf(az), y = proj.yOf(f.elDeg + (f.dElDeg || 0) * k);
      // A single white dot sized by brightness, edge-softened by the gradient (the solid part
      // is ~88% of r, so the visible disk ≈ 0.9 + 1.8·b px with just a ~12% feather beyond it).
      const r = (1.0 + 2.0 * b).toFixed(2);
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="url(#rflareDot)" opacity="${Math.min(1, 0.5 + b).toFixed(3)}"/>`;
    }
    flaresG.innerHTML = s;
    if (sunG) sunG.setAttribute("transform",
      `translate(${clampX(proj.xOf(sunAzimuthAt(t, obsLat, obsLon))).toFixed(1)},0)`);
    // Once per second: advance the (slowly rotating) stars/planets and the time readout.
    const sec = Math.floor(t / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      const d = new Date(t);
      if (bodiesG) bodiesG.innerHTML = skyBodiesSVG(visibleStars(obsLat, obsLon, d), visibleBodies(obsLat, obsLon, d), proj);
      if (timeEl) timeEl.textContent = fmtTime(t, tz) + (zone ? " " + zone : "");
    }
  }

  function frame(ts) {
    if (ctl.stopped) return;
    if (ctl.realtime) {
      ctl.t = clampT(Date.now());
    } else if (!ctl.dragging) {
      if (ctl.last) {
        ctl.t += (ts - ctl.last);                     // 1× real time
        if (ctl.t > t2) ctl.t = t1;                   // loop the window
        else if (!anyActive(ctl.t)) {                 // skip long dead gaps between flares
          const ns = nextStart(ctl.t);
          if (ns === Infinity) ctl.t = t1;
          else if (ns - ctl.t > 1500) ctl.t = ns - 600;
        }
      }
      ctl.last = ts;
    } else {
      ctl.last = ts;                                  // dragging — hold time, keep last fresh
    }
    draw(ctl.t);
    ctl.raf = requestAnimationFrame(frame);
  }

  // --- Sun drag = scrub time (map pointer-x to the nearest pre-sampled instant) ---
  function xToTime(clientX, clientY) {
    let lx;
    try {
      const p = root.createSVGPoint(); p.x = clientX; p.y = clientY;
      lx = p.matrixTransform(root.getScreenCTM().inverse()).x;
    } catch (_) {
      const r = root.getBoundingClientRect();
      lx = (clientX - r.left) / r.width * proj.W;     // rough fallback
    }
    let bi = 0, bd = Infinity;
    for (let i = 0; i <= NS; i++) { const d = Math.abs(sunX[i] - lx); if (d < bd) { bd = d; bi = i; } }
    return sunT[bi];
  }
  const hit = sunG && sunG.querySelector(".replay-sun-hit");
  function onDown(e) {
    if (ctl.realtime) return;                         // real-time isn't scrubbable
    ctl.dragging = true;
    if (hit) { hit.style.cursor = "grabbing"; if (hit.setPointerCapture && e.pointerId != null) { try { hit.setPointerCapture(e.pointerId); } catch (_) {} } }
    ctl.t = xToTime(e.clientX, e.clientY);
    e.preventDefault();
  }
  function onMove(e) { if (ctl.dragging) { ctl.t = xToTime(e.clientX, e.clientY); e.preventDefault(); } }
  function onUp() { if (ctl.dragging) { ctl.dragging = false; if (hit) hit.style.cursor = "grab"; } }
  if (hit) {
    hit.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  ctl.stop = function () {
    ctl.stopped = true;
    if (ctl.raf) cancelAnimationFrame(ctl.raf);
    if (hit) hit.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  draw(ctl.t);
  ctl.raf = requestAnimationFrame(frame);
}

// Base URL of the Sitrec app that hosts this tool: the tool lives at
// <origin><base>/tools/<name>/, so Sitrec is at <origin><base>/. Using the SAME
// host means local.metabunk.org opens local Sitrec, production opens production.
//
// Strip from "/tools/" onward, case-INSENSITIVELY: the tool may be served at a
// differently-cased path (e.g. /tools/SHF/ on a case-insensitive filesystem), and
// matching only lowercase "shf" left the SHF tool's OWN URL here — which the installed
// SHF PWA then captured, opening the tool again instead of the Sitrec desktop site.
function sitrecBaseURL() {
  const base = window.location.pathname.replace(/\/tools\/.*$/i, "").replace(/\/+$/, "");
  return window.location.origin + base + "/";
}

// "Open in Sitrec" — hand the current prediction to the main Sitrec app, which
// builds a night-sky sitch (satellites + flares), a 60×-speed timeline over the
// window/flight, a synthetic flight camera track (or fixed ground camera +50ft),
// and aims the look camera at the peak flare direction. See src/fromApp.js.
//
// Works with OR without flares: when none were found (the No-Flares screen) we still
// open the same place & time so the user can explore the sky, using the flight window
// (or a short window at a fixed site) and aiming low toward the Sun's azimuth — the
// direction flares would appear.
function openInSitrec(req, flares, origin, dest, peakMs) {
  let t1, t2, peakAz, peakEl, pkMs;
  if (flares && flares.length) {
    // Peak look direction = the flare nearest the peak (busiest) minute.
    let peak = flares[0], best = Infinity;
    for (const f of flares) { const d = Math.abs(f.peakMs - peakMs); if (d < best) { best = d; peak = f; } }
    t1 = Math.min(...flares.map((f) => f.startMs));
    t2 = Math.max(...flares.map((f) => f.endMs));
    peakAz = peak.azDeg; peakEl = peak.elDeg; pkMs = peakMs;
  } else {
    // No flares: open the searched window (flight duration, or a couple of hours at a
    // fixed site) and aim at where flares would be — the Sun's azimuth, low on the horizon.
    t1 = req.startMs;
    t2 = req.startMs + (req.mode === "flight" ? (req.durationSec || 3600) : 2 * 3600) * 1000;
    pkMs = Math.round((t1 + t2) / 2);
    const eq = sunEquatorial(new Date(pkMs));
    const aa = equatorialToAltAz(eq.raDeg, eq.decDeg, origin.lat, origin.lon, new Date(pkMs));
    peakAz = aa.azDeg; peakEl = 8;   // flares hug the horizon; the Sun itself is below it
  }

  const q = new URLSearchParams();
  q.set("fromapp", "1");
  q.set("mode", dest ? "flight" : "fixed");
  q.set("lat", origin.lat.toFixed(5));
  q.set("lon", origin.lon.toFixed(5));
  q.set("peakAz", peakAz.toFixed(1));
  q.set("peakEl", peakEl.toFixed(1));
  // The Sitrec timeline runs (1×) from the first flare to the last, starting at the peak.
  q.set("firstMs", String(Math.round(t1)));
  q.set("lastMs", String(Math.round(t2)));
  q.set("peakMs", String(Math.round(pkMs)));
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

// Whether a flare is bright enough to actually SEE now lives in the shared flarePhysics
// model (flareEngine sets f.visible via isFlareVisible), so SHF and Sitrec agree on the
// definition. The display simply filters on f.visible.

// Full results screen: verdict, one-sentence summary, compass rose, horizon view.
function renderResults(flares, stats, req, origin, dest) {
  if (!flares || flares.length === 0) { renderNoFlares(stats, req, origin, dest); return; }
  stopLiveBurst();   // the live DOM (and its .replay-flares target) is about to be replaced
  const all = flares.slice().sort((a, b) => a.peakMs - b.peakMs);     // full set (local debug list)
  // Drive the prediction (count, compass, horizon, peak, times) from only the flares the
  // SHARED model marks visible (f.visible — the glint outshines the base satellite
  // brightness; flarePhysics.isFlareVisible, the same definition Sitrec renders by). Faint
  // grazing glints no longer inflate the result. Never blank the plot if all were faint.
  const visible = all.filter((f) => f.visible);
  const shown = visible.length ? visible : all;
  const tz = origin.tz || "";
  const t1 = Math.min(...shown.map((f) => f.startMs));
  const t2 = Math.max(...shown.map((f) => f.endMs));
  const startAz = shown[0].azDeg, endAz = shown[shown.length - 1].azDeg;
  const startC = shown[0].compass || compass16(startAz);
  const endC = shown[shown.length - 1].compass || compass16(endAz);
  const moved = startC !== endC && Math.abs(angDiff(endAz, startAz)) >= 12;
  const zone = zoneAbbrev(tz, t1);

  // Compact three-line header (no big banner) — tuned to fit an iPhone SE.
  const localT = `${fmtTime(t1, tz, { second: undefined })}–${fmtTime(t2, tz, { second: undefined })}`;
  const utcT = `${fmtTime(t1, "UTC", { second: undefined })}–${fmtTime(t2, "UTC", { second: undefined })}`;
  const dirLine = moved ? `Look <b>${startC}</b> → <b>${endC}</b>` : `Look <b>${startC}</b>`;
  const place = dest ? `${origin.short || origin.name} → ${dest.short || dest.name}` : (origin.short || origin.name);

  // Peak = the busiest minute (greatest flare density) among the VISIBLE flares.
  const peakMs = (() => {
    const bin = 60000, m = new Map();
    for (const f of shown) { const b = Math.round(f.peakMs / bin); m.set(b, (m.get(b) || 0) + 1); }
    let bestBin = Math.round(shown[0].peakMs / bin), bestN = -1;
    for (const [b, n] of m) if (n > bestN) { bestN = n; bestBin = b; }
    return bestBin * bin;
  })();
  const peakT = fmtTime(peakMs, tz, { second: undefined });

  const arrows = moved ? [{ azDeg: startAz }, { azDeg: endAz }] : [{ azDeg: startAz }];

  const obsLat = shown[0].obsLat ?? origin.lat;
  const obsLon = shown[0].obsLon ?? origin.lon;
  const stars = visibleStars(obsLat, obsLon, new Date(t1));
  const bodies = visibleBodies(obsLat, obsLon, new Date(t1));
  const hvFlares = shown.map((f) => ({
    azDeg: f.azDeg, elDeg: f.elDeg, dAzDeg: f.dAzDeg, dElDeg: f.dElDeg, intensity: f.intensity,
    startMs: f.startMs, peakMs: f.peakMs, endMs: f.endMs, coreStartMs: f.coreStartMs, coreEndMs: f.coreEndMs,
  }));
  const win = horizonWindow(hvFlares);
  const sunMarks = sunHourMarkers(t1, t2, tz, obsLat, obsLon);

  els.results.innerHTML =
    `<div class="r-when">Flares <b>${localT}</b> ${escapeHtml(zone)} · peak <b>${peakT}</b></div>
     <div class="r-dir">${dirLine}</div>
     <div class="r-meta">${escapeHtml(place)} · ${fmtDateShort(t1, tz)} · ${utcT} UTC</div>
     <div class="rose-wrap">${compassRose(arrows, hvFlares)}</div>
     ${horizonWrapHTML(horizonView({ stars, bodies, flares: hvFlares, sunMarks, mode: horizonMode, ...zoomWin(win) }))}
     <div class="legend"><span class="lg-flare">●</span> flare &nbsp;·&nbsp; <span class="lg-star">●</span> star &nbsp;·&nbsp; <span class="lg-arrow">↗</span> direction &nbsp;·&nbsp; <span class="lg-hour">↓</span> Sun by hour</div>
     <button id="opensitrec" type="button" class="go-btn sitrec-btn">Open in Sitrec ↗</button>
     ${notesHTML(req)}`;

  els.results.dataset.state = "final";   // real results screen is up (see setupLiveResults)
  const openBtn = els.results.querySelector("#opensitrec");
  if (openBtn) openBtn.addEventListener("click", () => openInSitrec(req, shown, origin, dest, peakMs));

  // Wide-view controls. ★ cycles dots → streaks → replay; ⏱ (only when "now" is inside the
  // flaring window) jumps to replay anchored to the real clock. Replay animates the flares over
  // the window at 1× via startReplay; dots/streaks are static SVG. renderHorizon rebuilds the
  // SVG for the current mode and (re)starts or stops the animation accordingly.
  const hvBtn = els.results.querySelector(".hv-toggle");
  const hvZoom = els.results.querySelector(".hv-zoom");
  const hvSvg = els.results.querySelector(".horizon-svg");
  const nowInWindow = Date.now() >= t1 && Date.now() <= t2;

  function renderHorizon(realtime) {
    stopReplay();
    const zwin = zoomWin(win);                 // zoom narrows the window; proj must match it
    const proj = horizonProjection(zwin);
    hvSvg.innerHTML = horizonView({ stars, bodies, flares: hvFlares, sunMarks, mode: horizonMode,
                                    liveButton: nowInWindow, ...zwin });
    if (hvBtn) hvBtn.classList.toggle("on", horizonMode !== "dots");
    if (hvZoom) { hvZoom.textContent = horizonZoom + "×"; hvZoom.classList.toggle("on", horizonZoom > 1); }
    if (horizonMode === "replay") {
      // The LIVE badge above the time is the real-time toggle (rebuilt with the SVG, so re-wire it).
      const liveBtn = hvSvg.querySelector(".replay-live-btn");
      if (liveBtn) {
        liveBtn.classList.toggle("on", !!realtime);
        liveBtn.addEventListener("click", () => renderHorizon(!(replayCtl && replayCtl.realtime)));
      }
      startReplay({ root: hvSvg, flares: hvFlares, proj, t1, t2, peakMs, obsLat, obsLon, tz,
                    realtime: !!realtime && nowInWindow });
    }
  }

  if (hvBtn) hvBtn.addEventListener("click", () => {
    horizonMode = HMODES[(HMODES.indexOf(horizonMode) + 1) % HMODES.length];
    renderHorizon(false);
  });
  if (hvZoom) hvZoom.addEventListener("click", () => {
    horizonZoom = ZOOMS[(ZOOMS.indexOf(horizonZoom) + 1) % ZOOMS.length];
    renderHorizon(!!(replayCtl && replayCtl.realtime));   // re-frame, keeping the current real-time state
  });
  // Arrived already in replay mode (persisted from a previous view)? Start the animation now.
  if (horizonMode === "replay") renderHorizon(false);

  // Per-flare detail list — hidden in production for a cleaner page, but shown on local
  // dev hosts as a DEBUG aid: each card lists the satellite, peak time, peak glint, az/el,
  // and relative brightness %, so the SHF flares can be cross-referenced against what
  // Sitrec actually renders (e.g. faint/low-% flares are the ones Sitrec's brightness
  // floor drops). Sorted by time to match scrubbing the Sitrec timeline. Suppressed under
  // automation (navigator.webdriver) — same as the service worker — so the headless e2e test
  // sees the production-clean results page (the local test server is itself a "local host").
  const SHOW_FLARE_LIST = isLocalHost && !navigator.webdriver;
  if (SHOW_FLARE_LIST) {
    const plural = all.length === 1 ? "" : "s";
    const faintN = all.length - visible.length;
    const det = document.createElement("details");
    det.className = "flare-details";
    det.open = true;
    det.innerHTML = `<summary>${all.length} flare${plural} · ${visible.length} visible` +
      `${faintN ? ` · ${faintN} too faint to see` : ""}` +
      ` · scanned ${stats.satsTotal} satellites · debug</summary>`;
    for (const f of all) {
      const card = flareCard(f, tz);
      if (!f.visible) card.classList.add("faint");
      det.appendChild(card);
    }
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

function renderNoFlares(stats, req, origin, dest) {
  stopLiveBurst();   // the live DOM (and its .replay-flares target) is about to be replaced
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
    tail = `<p>Try a flight during the <b>dark hours</b> — flares appear once the sky is dark and can
       continue through the night (how late depends on the season) while the satellites overhead are
       still catching sunlight.</p>`;
  }

  div.innerHTML = `
    ${lead}
    <p>A flare needs <b>you</b> in darkness while the <b>satellite</b> is still lit by the Sun. How much
       of the night that covers depends on the <b>season</b> (and your latitude): in summer the Sun stays
       shallow enough overnight that satellites keep catching it right through the small hours, while in
       winter it dips so deep that even low satellites spend the middle of the night in Earth's shadow.</p>
    ${tail}`;
  els.results.innerHTML =
    `<div class="verdict no">No Flares</div>${whereWhenLine(req, origin, dest)}${notesHTML(req)}`;
  els.results.appendChild(div);
  // Still offer "Open in Sitrec" — opens this place & time so the user can explore the
  // sky there even though no flares were found (no flare data needed).
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.id = "opensitrec";
  openBtn.className = "go-btn sitrec-btn";
  openBtn.textContent = "Open in Sitrec ↗";
  openBtn.addEventListener("click", () => openInSitrec(req, [], origin, dest, null));
  els.results.appendChild(openBtn);
  els.results.dataset.state = "final";   // real results screen is up (see setupLiveResults)
}

// Advisory banners: out-of-range date fallback, and which satellite data was used.
// The data-source note shows on EVERY run so it is always clear whether the
// positions came from synthetic (approximate) or real Starlink elements.
function notesHTML(req) {
  let html = "";
  if (req && req.tleMode === "synthetic") {
    if (req.outOfRange)
      // Out of the current TLE's range → synthetic by design (anchored to the requested
      // date). Loading real data wouldn't help, so this is an explanation, not a button.
      html += `<div class="sim-note synth">⚠ Synthetic satellites — this date is beyond the current data's range, ` +
              `so an approximate constellation for that date is used.</div>`;
    else
      // In range but the real data isn't loaded (offline / download failed). The whole
      // note is a button: clicking it downloads the current TLE (with a loading
      // indicator) and reloads, re-running this search with real data.
      html += `<button type="button" class="sim-note synth synth-load" id="loadsats">` +
              `⚠ Synthetic satellites — couldn't load current data.<br>` +
              `<span class="synth-cta">CLICK HERE TO LOAD CURRENT SATELLITES</span></button>`;
  }
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
  stopLiveTimer();

  // Validate while still on the form.
  const dt = parseDateTime();
  if (!dt) { formError("Please choose a valid date and time."); return; }
  setStatus("");

  // Go straight to the results screen — the scan populates it in real time (no separate
  // loading screen). The thin top bar shows scan progress.
  navigateResults();
  setupLiveResults();
  showTopProgress(true); setTopProgress(0);
  liveFlares = []; liveDirty = false; liveCtx = null;

  try {
    // Origin: typed value, or the browser's location if blank.
    let origin;
    if (els.origin.value.trim()) {
      origin = await resolveField(els.origin);
      if (!origin) throw new Error("Couldn't find that origin — check the spelling.");
    } else {
      setLiveStatus("Getting your location…");
      origin = await resolveBrowserLocation();
    }

    let dest = null;
    if (els.dest.value.trim()) {
      dest = await resolveField(els.dest);
      if (!dest) throw new Error("Couldn't find that destination — check the spelling.");
    }

    // Interpret the entered wall-clock in the chosen zone (UTC if toggled, else the
    // location's zone when known, else browser local); sync the button for a later Edit.
    const interpTz = tzMode === "utc" ? "UTC" : (origin.tz || "");
    if (tzMode !== "utc") { formTz = origin.tz || ""; updateTzButton(); }

    // The real current TLE is only accurate within ~a week of "now". Within that window
    // we use it; beyond it we fall back to a synthetic constellation anchored to the
    // requested date (so the seasonal flare geometry for THAT date stays meaningful — no
    // need to clamp to today the way real-only data forced). inRange drives that choice.
    const startMs = wallClockToUTCms(dt.y, dt.mo, dt.d, dt.h, dt.mi, interpTz);
    const WEEK = 7 * 86400 * 1000;
    const inRange = Math.abs(startMs - Date.now()) <= WEEK;

    const options = {};
    const LOOK_AHEAD_DAYS = 1;   // the flare geometry recurs daily — no need to look further

    let req;
    if (!dest) {
      req = { mode: "fixed", lat: origin.lat, lon: origin.lon, altKm: origin.altKm || 0,
              startMs, maxLookAheadSec: LOOK_AHEAD_DAYS * 86400, options };
      setLiveStatus(`Searching near ${escapeHtml(origin.short || origin.name)}…`);
    } else {
      const distKm = greatCircleDistanceKm(origin.lat, origin.lon, dest.lat, dest.lon);
      const durationSec = (+els.duration.value > 0)
        ? +els.duration.value * 3600
        : distKm / 875 * 3600 + 1800;   // ~875 km/h cruise + 30 min overhead
      const cruiseAltKm = (+els.alt.value > 0 ? +els.alt.value : 37000) * 0.3048 / 1000;
      req = { mode: "flight", origin: { lat: origin.lat, lon: origin.lon }, dest: { lat: dest.lat, lon: dest.lon },
              cruiseAltKm, durationSec, startMs, options };
      setLiveStatus(`Checking the ${escapeHtml(origin.short || origin.name)} → ${escapeHtml(dest.short || dest.name)} flight…`);
    }
    req.outOfRange = !inRange;   // requested date is beyond the current TLE's useful range

    // --- TLE ---
    setLiveStatus("Loading satellite data…");
    let tleText;
    try {
      const tle = await getTLEText(els.tlefile, (m) => setLiveStatus(escapeHtml(m)), new Date(startMs), inRange);
      tleText = tle.text;
      req.tleMode = tle.mode;
    } catch (err) {
      showTopProgress(false);
      renderError(err.message, req, origin, dest);
      return;
    }

    // --- run the STREAMING worker; populate the page live at 10 Hz ---
    setLiveStatus("Scanning…");
    liveCtx = { req, origin, dest };
    liveFlares = []; liveDirty = false;
    startLiveTimer();

    const w = new Worker("flareWorker.js" + VERSION, { type: "module" });
    activeWorker = w;
    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "flares") {
        if (m.flares && m.flares.length) { liveFlares.push(...m.flares); liveDirty = true; }
      } else if (m.type === "progress") {
        setTopProgress(m.fraction);
      } else if (m.type === "result") {
        // Final authoritative (deduped, sorted) set — replace the live view with the
        // polished results (animated rose, Open-in-Sitrec, notes).
        stopLiveTimer(); showTopProgress(false);
        lastResults = { flares: m.flares, stats: m.stats, req, origin, dest };
        renderResults(m.flares, m.stats, req, origin, dest);
        w.terminate(); activeWorker = null;
      } else if (m.type === "error") {
        stopLiveTimer(); showTopProgress(false);
        renderError(m.message || "unknown computation error", req, origin, dest);
        w.terminate(); activeWorker = null;
      }
    };
    w.onerror = (err) => {
      stopLiveTimer(); showTopProgress(false);
      renderError(err.message || "the worker failed to run", req, origin, dest);
      try { w.terminate(); } catch (_) {}
      activeWorker = null;
    };
    w.postMessage({ req, tleText });
  } catch (err) {
    stopLiveTimer(); showTopProgress(false);
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
    get freshRealTLE() { return haveFreshRealTLE(); },
    get tleFetchInFlight() { return !!tleFetchInFlight; },
    get horizonMode() { return horizonMode; },
    get replayCtl() { return replayCtl; },
    // live module helpers, callable from the MCP / console for ad-hoc checks
    horizonView, horizonWindow, compassRose, horizonProjection, flareBrightnessAt,
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
  // "Fetch current TLE" — manual (re)download; real data is also fetched automatically
  // in the background at startup (startBackgroundTLEFetch), so this is mainly a retry.
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
  startBackgroundTLEFetch();   // start downloading the current TLE immediately (best-effort)
  loadAirports();   // fire-and-forget; searchAirports degrades gracefully until ready
  // Origin picks set the time-zone button to that location's zone; destination doesn't
  // affect the observer's zone, so it has no onPick.
  wireAutocomplete(els.origin, els.originSug, (rec) => { formTz = rec.tz || ""; updateTzButton(); });
  wireAutocomplete(els.dest, els.destSug);
  // Time-zone button: tap toggles local ↔ UTC. Typing a new origin clears the known
  // zone (back to browser-local) until it's picked or resolved; changing the date/time
  // refreshes the abbreviation in case it crosses a DST boundary.
  els.tzbtn.addEventListener("click", toggleTimeZone);
  els.origin.addEventListener("input", () => { formTz = ""; updateTzButton(); });
  els.date.addEventListener("change", updateTzButton);
  els.time.addEventListener("change", updateTzButton);
  updateTzButton();
  wireTLEControls();
  // Delegated: the synthetic-data note is re-rendered as a button on each result; one
  // listener on the stable container handles every instance without re-binding.
  els.results.addEventListener("click", (e) => {
    const btn = e.target.closest("#loadsats");
    if (btn) onLoadCurrentSats(btn);
  });
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
  // If we just reloaded after "CLICK HERE TO LOAD CURRENT SATELLITES", re-run that
  // search now against the real TLE that was fetched before the reload.
  restorePendingRealSearch();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
