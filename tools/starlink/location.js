// location.js — location resolution for the Starlink-flare app.
//
// Resolves a free-text query to {lat, lon, altKm, name, tz, source}:
//   1) exact IATA code  (3 letters)
//   2) exact ICAO code  (4 letters)
//   3) airport name/city substring (prefer entries that have an IATA code)
//   4) Nominatim geocoder (same endpoint Sitrec uses)
//
// Also provides searchAirports() for autocomplete.
//
// Conventions: distances in KILOMETRES, angles in DEGREES. Pure ES module;
// the only optional dependency is ./geo.js (not currently needed here).

// ---- airport data loading -------------------------------------------------
// We are imported as `location.js?v=<build stamp>`; reuse that query on the
// airports.json fetch so it is cache-busted by the same build timestamp.
const VERSION = new URL(import.meta.url).search;

// Cache the PROMISE so the fetch happens exactly once, even if several callers
// await loadAirports() before the first request resolves.
let _airportsPromise = null;

export async function loadAirports() {
    if (_airportsPromise === null) {
        _airportsPromise = fetch("./airports.json" + VERSION).then((r) => {
            if (!r.ok) throw new Error("Failed to load airports.json: " + r.status);
            return r.json();
        });
    }
    return _airportsPromise;
}

// ---- small helpers --------------------------------------------------------
const lc = (s) => (s || "").toLowerCase();

// Readable label for an airport match, e.g. "LAX – Los Angeles Intl, Los Angeles".
function airportLabel(rec) {
    return (rec.iata ? rec.iata + " – " : "") +
        (rec.name || "") +
        (rec.city ? ", " + rec.city : "");
}

// Build the resolved-location object from an airport record.
function fromAirport(rec) {
    return {
        lat: rec.lat,
        lon: rec.lon,
        altKm: (rec.alt || 0) / 1000,
        name: airportLabel(rec),
        tz: rec.tz || "",
        source: "airport",
    };
}

// ---- main resolver --------------------------------------------------------
export async function resolveLocation(query) {
    const q = (query || "").trim();
    if (!q) throw new Error("Empty location query");

    const airports = await loadAirports();
    const qUpper = q.toUpperCase();
    const qLower = q.toLowerCase();

    // 1) exact IATA — 3 letters A-Z.
    if (/^[A-Z]{3}$/.test(qUpper)) {
        const hit = airports.find((a) => (a.iata || "").toUpperCase() === qUpper);
        if (hit) return fromAirport(hit);
    }

    // 2) exact ICAO — 4 letters.
    if (/^[A-Z]{4}$/.test(qUpper)) {
        const hit = airports.find((a) => (a.icao || "").toUpperCase() === qUpper);
        if (hit) return fromAirport(hit);
    }

    // 3) name / city substring. Prefer entries that HAVE an IATA code.
    const subMatches = airports.filter(
        (a) => lc(a.name).includes(qLower) || lc(a.city).includes(qLower)
    );
    if (subMatches.length) {
        const best = subMatches.find((a) => a.iata) || subMatches[0];
        return fromAirport(best);
    }

    // 4) Nominatim — same endpoint Sitrec uses.
    const r = await fetch(
        "https://nominatim.openstreetmap.org/search?format=json&q=" +
            encodeURIComponent(q) + "&limit=1",
        { headers: { "User-Agent": "Sitrec-StarlinkFlares/1.0" } }
    );
    const d = await r.json();
    if (!d.length) throw new Error("Location not found: " + q);
    return {
        lat: +d[0].lat,
        lon: +d[0].lon,
        altKm: 0,
        name: d[0].display_name,
        tz: "",
        source: "nominatim",
    };
}

// ---- autocomplete ---------------------------------------------------------
// Match where iata/icao/name/city contains the query (case-insensitive).
// Rank: exact code first, then prefix matches, then plain substring.
export async function searchAirports(query, limit = 8) {
    const q = (query || "").trim();
    if (!q) return [];

    const airports = await loadAirports();
    const qLower = q.toLowerCase();

    const scored = [];
    for (const a of airports) {
        const iata = lc(a.iata);
        const icao = lc(a.icao);
        const name = lc(a.name);
        const city = lc(a.city);

        // Skip records that don't match at all.
        const inIata = iata.includes(qLower);
        const inIcao = icao.includes(qLower);
        const inName = name.includes(qLower);
        const inCity = city.includes(qLower);
        if (!inIata && !inIcao && !inName && !inCity) continue;

        // Lower score = better. Exact code beats prefix beats substring.
        let score = 5;
        if (iata === qLower || icao === qLower) {
            score = 0;                              // exact code
        } else if (iata.startsWith(qLower) || icao.startsWith(qLower)) {
            score = 1;                              // code prefix
        } else if (name.startsWith(qLower) || city.startsWith(qLower)) {
            score = 2;                              // name/city prefix
        } else if (inName || inCity) {
            score = 3;                              // name/city substring
        } else {
            score = 4;                              // code substring (mid-string)
        }
        // Mild preference for "real" airports that have an IATA code.
        if (!a.iata) score += 0.5;

        scored.push({ rec: a, score });
    }

    scored.sort((p, q2) => p.score - q2.score);
    return scored.slice(0, limit).map((s) => s.rec);
}
