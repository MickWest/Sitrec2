// location.js — location resolution for the Starlink-flare app.
//
// Resolves a free-text query to {lat, lon, altKm, name, tz, tzSource, source}:
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
        // Compact label for the small results line, e.g. "LAX, Los Angeles".
        short: (rec.iata || rec.icao || "") + (rec.city ? ", " + rec.city : ""),
        tz: rec.tz || "",
        source: "airport",
    };
}

// ---- lat/lon -> IANA time zone -------------------------------------------
// Nominatim returns no time zone, and 593 of the airport records carry none either.
// Until this existed both cases fell back to the BROWSER's zone, so searching an English
// airfield from California reported it as PDT and shifted the whole scan window eight
// hours. airports.json already carries an IANA zone for 6591 of its records, so the
// nearest one of those is a far better answer than "wherever the user happens to be".
//
// Measured leave-one-out over those 6591 (private/probes/ShfNearestAirportTz.mjs): the
// nearest airport's zone has the same UTC offset — checked in BOTH July and January, so
// DST rules have to agree too — for 95.3% of them. Preferring an airport in the same
// country lifts that to 98.0%. The residual misses sit on zone boundaries inside one
// country (the US Eastern/Central line, Australia SA/NSW, Brazil, Russia) and are an hour
// or two, never eight. k=3 and k=5 nearest-neighbour voting were also measured and did
// not help (89.4% vs 89.6% on exact zone name) — near a boundary the neighbours split.

// Nominatim's English country names already agree with airports.json for most of the
// awkward ones — measured 2026-09-09 against the live endpoint with accept-language=en,
// which returned "Cape Verde", "East Timor", "Myanmar", "Turkey" and "Ivory Coast". These
// are the ones that disagreed, plus the official-name variants the endpoint would return
// if it ever switched. A name that maps to nothing simply forfeits the same-country
// preference and falls back to the global nearest — no worse than not having the table.
const COUNTRY_ALIASES = {
    "czechia": "czech republic",                                  // measured
    "democratic republic of the congo": "congo (kinshasa)",       // measured
    "congo-brazzaville": "congo (brazzaville)",                   // measured
    "republic of the congo": "congo (brazzaville)",
    "north macedonia": "macedonia",                               // measured
    "ivory coast": "cote d'ivoire",                               // measured
    "eswatini": "swaziland",
    "cabo verde": "cape verde",
    "timor-leste": "east timor",
    "türkiye": "turkey",
};
const normCountry = (s) => {
    const k = (s || "").trim().toLowerCase();
    return COUNTRY_ALIASES[k] || k;
};

// How much farther a same-country airport may be before we stop preferring it. Without
// this, a remote territory whose geocoded country is the mainland's (St Thomas comes back
// as "United States") gets dragged thousands of km to a mainland zone. Measured sweep:
// no guard 97.63%, 1000 km 97.95%, 500 km 97.95%, 300 km 97.85%, 150 km 97.38%.
const SAME_COUNTRY_SLACK_KM = 500;

// Nearest airport that HAS an IANA zone. `country` is the location's country name when the
// geocoder supplied one. Returns {tz, km, airport, sameCountry} or null.
export async function nearestAirportTz(lat, lon, country) {
    const airports = await loadAirports();
    const D = Math.PI / 180, R = 6371;
    const la = lat * D, lo = lon * D, cl = Math.cos(la);
    const qx = cl * Math.cos(lo), qy = cl * Math.sin(lo), qz = Math.sin(la);
    const want = normCountry(country);

    // One pass, tracking the best overall and the best in-country. Ranking by squared
    // CHORD length through the sphere is monotonic in great-circle distance, so it orders
    // identically to a haversine while costing no trig per candidate beyond the position
    // itself — and unlike a lat/lon box it behaves at the poles and across the date line.
    let bg = null, bgD2 = Infinity, bc = null, bcD2 = Infinity;
    for (const a of airports) {
        if (!a.tz) continue;
        const ala = a.lat * D, alo = a.lon * D, ac = Math.cos(ala);
        const dx = ac * Math.cos(alo) - qx, dy = ac * Math.sin(alo) - qy, dz = Math.sin(ala) - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bgD2) { bgD2 = d2; bg = a; }
        if (want && d2 < bcD2 && normCountry(a.country) === want) { bcD2 = d2; bc = a; }
    }
    if (!bg) return null;

    const kmOf = (d2) => 2 * R * Math.asin(Math.min(1, Math.sqrt(d2) / 2));
    const label = (a) => a.iata || a.icao || a.city || a.name || "airport";
    const globalKm = kmOf(bgD2);
    if (bc) {
        const ckm = kmOf(bcD2);
        if (ckm - globalKm <= SAME_COUNTRY_SLACK_KM)
            return { tz: bc.tz, km: ckm, airport: label(bc), sameCountry: true };
    }
    return { tz: bg.tz, km: globalKm, airport: label(bg), sameCountry: false };
}

// Fill in a resolved location's zone when it has none, so no caller silently inherits the
// browser's. Mutates and returns `loc`. A location that already knows its own zone (an
// airport record) keeps it — that is ground truth, not a guess.
export async function ensureTz(loc, country) {
    if (!loc || loc.tz) return loc;
    const near = await nearestAirportTz(loc.lat, loc.lon, country);
    if (near) {
        loc.tz = near.tz;
        loc.tzSource = `nearest airport (${near.airport}, ${Math.round(near.km)} km)`;
    }
    return loc;
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
        if (hit) return await ensureTz(fromAirport(hit), hit.country);
    }

    // 2) exact ICAO — 4 letters.
    if (/^[A-Z]{4}$/.test(qUpper)) {
        const hit = airports.find((a) => (a.icao || "").toUpperCase() === qUpper);
        if (hit) return await ensureTz(fromAirport(hit), hit.country);
    }

    // 3) name / city substring. Prefer entries that HAVE an IATA code.
    const subMatches = airports.filter(
        (a) => lc(a.name).includes(qLower) || lc(a.city).includes(qLower)
    );
    if (subMatches.length) {
        const best = subMatches.find((a) => a.iata) || subMatches[0];
        return await ensureTz(fromAirport(best), best.country);
    }

    // 4) Nominatim — same endpoint Sitrec uses. addressdetails gives us the country, and
    // accept-language pins it (and display_name) to English: the country is matched against
    // airports.json's English names to pick the zone, and would otherwise arrive in whatever
    // language the browser asks for.
    const r = await fetch(
        "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1" +
            "&accept-language=en&limit=1&q=" + encodeURIComponent(q),
        { headers: { "User-Agent": "Sitrec-StarlinkFlares/1.0" } }
    );
    const d = await r.json();
    if (!d.length) throw new Error("Location not found: " + q);
    const dn = d[0].display_name || q;
    const country = (d[0].address && d[0].address.country) || dn.split(",").pop().trim();
    return await ensureTz({
        lat: +d[0].lat,
        lon: +d[0].lon,
        altKm: 0,
        name: dn,
        short: dn.split(",")[0].trim(),   // first segment, e.g. "Paris"
        tz: "",
        source: "nominatim",
    }, country);
}

// Reverse-geocode a lat/lon to a short readable place name (city-ish + country),
// e.g. for a browser-geolocated origin. Returns a string or null if nothing usable.
export async function reverseGeocode(lat, lon) {
    try {
        const r = await fetch(
            "https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=en&lat=" +
                encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon),
            { headers: { "User-Agent": "Sitrec-StarlinkFlares/1.0" } }
        );
        if (!r.ok) return null;
        const d = await r.json();
        if (!d || d.error) return null;
        const a = d.address || {};
        const place = a.city || a.town || a.village || a.hamlet || a.suburb ||
            a.county || a.state || a.region;
        if (place && a.country) return place + ", " + a.country;
        return place || d.display_name || null;
    } catch {
        return null;
    }
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
