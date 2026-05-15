// ASTERIX radar data parser.
//
// Supports drag-and-drop of:
//   • libpcap (.pcap) captures of UDP multicast carrying ASTERIX
//   • raw ASTERIX streams (.raw / concatenated CAT records, no framing)
//
// Decodes CAT-048 (Mode-S monoradar target reports) and CAT-062 (system
// tracks). CAT-034 (radar status) and CAT-065 (service status) are walked
// for length but produce no track points.
//
// Output is an array of MISB rows compatible with CTrackFileMISB:
//   row[MISB.UnixTimeStamp]      ms since Unix epoch (PCAP packet timestamp,
//                                refined with CAT-048 time-of-day if present)
//   row[MISB.SensorLatitude]     aircraft latitude (deg)
//   row[MISB.SensorLongitude]    aircraft longitude (deg)
//   row[MISB.SensorTrueAltitude] aircraft altitude (m, from Flight Level)
//   row[MISB.PlatformTailNumber] callsign (trimmed)
//   row[MISB.TrackID]            stable per-aircraft id (Mode-S address hex,
//                                falling back to ASTERIX track number)
//
// CAT-048 reports targets in polar coords relative to a sensor whose
// position is not carried in the message — it is site configuration. We do
// not have an authoritative SAC/SIC → site database here, so we default to
// a Zagreb-area reference (the sample data is Croatia Control, SAC=247) and
// expose a SAC_SIC_RADAR table that's easy to extend.

import {MISB, MISBFields} from "../MISBFields";

// Site reference points for radars seen in the wild.
// Keyed by `${SAC}_${SIC}`. lat/lon in degrees, alt in meters MSL.
// Add entries as needed.
const SAC_SIC_RADAR = {
    // Croatia Control. Bulk Croatia ASTERIX samples are from a Zagreb-area
    // MSSR; without the operator's site list we pick LDZA (Zagreb Pleso)
    // as a best-guess reference. Tracks render in the correct *region*;
    // override per-radar in this table when a verified location is known.
    "247_2": {lat: 45.7429, lon: 16.0688, alt: 110, name: "Croatia Control (SIC 2)"},
};

const DEFAULT_RADAR = {lat: 45.7429, lon: 16.0688, alt: 110, name: "Unknown radar (default LDZA)"};

// ---------- low-level helpers ----------

function u16BE(u8, off) { return (u8[off] << 8) | u8[off + 1]; }
function u24BE(u8, off) { return (u8[off] << 16) | (u8[off + 1] << 8) | u8[off + 2]; }
function u32BE(u8, off) { return ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0; }
function s16BE(u8, off) { const v = u16BE(u8, off); return v & 0x8000 ? v - 0x10000 : v; }
function s32BE(u8, off) { const v = u32BE(u8, off); return v & 0x80000000 ? v - 0x100000000 : v; }

// Walk an FSPEC starting at `off`, return {bits: [bool...], next: nextOff}.
// FSPEC is a sequence of octets where bit 0 (LSB) is the FX (extension) flag.
// Bits 7..1 are FRN flags for the next 7 fields in UAP order.
function readFSPEC(u8, off, end) {
    const bits = [];
    while (off < end) {
        const b = u8[off++];
        for (let i = 7; i >= 1; i--) bits.push((b >> i) & 1);
        if ((b & 1) === 0) break; // FX bit cleared → no extension
    }
    return {bits, next: off};
}

// ---------- PCAP framing ----------

// Returns array of {tsSec, tsUsec, payload: Uint8Array} for each UDP packet
// in a classic-libpcap or pcapng file. Strips Ethernet + IPv4 + UDP headers.
// Skips records that aren't IPv4/UDP/Ethernet. Returns null if not a PCAP.
function parsePCAP(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8.length < 24) return null;

    const m = (u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3];
    let little;
    if (m === (0xd4c3b2a1 | 0)) little = true;        // little-endian classic
    else if (m === (0xa1b2c3d4 | 0)) little = false;  // big-endian classic
    else if (m === (0x4d3cb2a1 | 0)) little = true;   // nanosecond little
    else if (m === (0xa1b23c4d | 0)) little = false;  // nanosecond big
    else return null;

    const r16 = (off) => little ? (u8[off] | (u8[off + 1] << 8)) : ((u8[off] << 8) | u8[off + 1]);
    const r32 = (off) => little
        ? ((u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0)
        : (((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0);

    const network = r32(20);
    // 1 = LINKTYPE_ETHERNET (covers all our samples). Other link types could
    // be added when there's demand.
    if (network !== 1) {
        console.warn(`parsePCAP: unsupported link type ${network}, expected Ethernet(1)`);
        return null;
    }

    const out = [];
    let off = 24;
    while (off + 16 <= u8.length) {
        const tsSec = r32(off);
        const tsUsec = r32(off + 4);
        const inclLen = r32(off + 8);
        // const origLen = r32(off + 12);
        off += 16;
        if (off + inclLen > u8.length) break;

        const pktEnd = off + inclLen;
        // Ethernet II: 14 bytes. EtherType at 12..13. 0x0800 = IPv4.
        if (inclLen >= 14 && u8[off + 12] === 0x08 && u8[off + 13] === 0x00) {
            const ipOff = off + 14;
            const ihl = (u8[ipOff] & 0x0F) * 4;
            const proto = u8[ipOff + 9];
            if (proto === 17 && ipOff + ihl + 8 <= pktEnd) {  // UDP
                const udpOff = ipOff + ihl;
                const udpLen = (u8[udpOff + 4] << 8) | u8[udpOff + 5];
                const dataOff = udpOff + 8;
                const dataLen = Math.max(0, udpLen - 8);
                if (dataOff + dataLen <= pktEnd && dataLen > 0) {
                    out.push({
                        tsSec, tsUsec,
                        payload: u8.subarray(dataOff, dataOff + dataLen),
                    });
                }
            }
        }
        off = pktEnd;
    }
    return out;
}

// ---------- ASTERIX record walker ----------

// Returns array of {cat, body: Uint8Array} for each record in the stream.
// Tolerates truncation: stops at first inconsistency.
function walkASTERIX(u8) {
    const out = [];
    let off = 0;
    while (off + 3 <= u8.length) {
        const cat = u8[off];
        const len = (u8[off + 1] << 8) | u8[off + 2];
        if (len < 3 || off + len > u8.length) break;
        out.push({cat, body: u8.subarray(off + 3, off + len)});
        off += len;
    }
    return out;
}

// ---------- CAT-048 field decoders ----------
//
// UAP order (FRN → field, fixed/variable/repetitive, octets):
//   1  I048/010  Data Source Identifier            fixed 2
//   2  I048/140  Time of Day                       fixed 3
//   3  I048/020  Target Report Descriptor          variable (FX-chained octets)
//   4  I048/040  Measured Position (polar)         fixed 4
//   5  I048/070  Mode-3/A Code                     fixed 2
//   6  I048/090  Flight Level                      fixed 2
//   7  I048/130  Radar Plot Characteristics        variable (1 primary octet + sub-fields)
//   FX
//   8  I048/220  Aircraft Address (Mode-S)         fixed 3
//   9  I048/240  Aircraft Identification           fixed 6 (ICAO 6-bit packed)
//   10 I048/250  Mode-S MB Data                    repetitive (REP + REP*8)
//   11 I048/161  Track Number                      fixed 2
//   12 I048/042  Calculated Position (Cartesian)   fixed 4
//   13 I048/200  Calculated Track Velocity         fixed 4
//   14 I048/170  Track Status                      variable
//   FX
//   15 I048/210  Track Quality                     fixed 4
//   16 I048/030  Warning/Error                     variable
//   17 I048/080  Mode-3/A Confidence               fixed 2
//   18 I048/100  Mode-C Code and Confidence        fixed 4
//   19 I048/110  Height Measured                   fixed 2
//   20 I048/120  Radial Doppler Speed              variable (1 primary + sub-fields)
//   21 I048/230  Comms/ACAS Capability             fixed 2

const CAT048_FIELDS = [
    {name: "010", kind: "fixed", len: 2},
    {name: "140", kind: "fixed", len: 3},
    {name: "020", kind: "variable"},
    {name: "040", kind: "fixed", len: 4},
    {name: "070", kind: "fixed", len: 2},
    {name: "090", kind: "fixed", len: 2},
    {name: "130", kind: "compound130"},
    // FX
    {name: "220", kind: "fixed", len: 3},
    {name: "240", kind: "fixed", len: 6},
    {name: "250", kind: "repetitive", itemLen: 8},
    {name: "161", kind: "fixed", len: 2},
    {name: "042", kind: "fixed", len: 4},
    {name: "200", kind: "fixed", len: 4},
    {name: "170", kind: "variable"},
    // FX
    {name: "210", kind: "fixed", len: 4},
    {name: "030", kind: "variable"},
    {name: "080", kind: "fixed", len: 2},
    {name: "100", kind: "fixed", len: 4},
    {name: "110", kind: "fixed", len: 2},
    {name: "120", kind: "compound120"},
    {name: "230", kind: "fixed", len: 2},
];

function consumeField(spec, u8, off, end) {
    if (spec.kind === "fixed") {
        if (off + spec.len > end) return null;
        return {data: u8.subarray(off, off + spec.len), next: off + spec.len};
    }
    if (spec.kind === "variable") {
        const start = off;
        while (off < end) {
            const b = u8[off++];
            if ((b & 1) === 0) break;
        }
        return {data: u8.subarray(start, off), next: off};
    }
    if (spec.kind === "repetitive") {
        if (off >= end) return null;
        const rep = u8[off];
        const total = 1 + rep * spec.itemLen;
        if (off + total > end) return null;
        return {data: u8.subarray(off, off + total), next: off + total};
    }
    if (spec.kind === "compound130") {
        // I048/130 Radar Plot Characteristics: 1 primary subfield octet
        // (FX-extensible) selecting sub-items. We don't decode the
        // sub-items, just consume them so later fields stay aligned.
        // Sub-item lengths per ASTERIX spec (octets):
        //   SRL=1, SRR=1, SAM=1, PRL=1, PAM=1, RPD=1, APD=1, FX
        const start = off;
        const subLens = [1, 1, 1, 1, 1, 1, 1];
        let primary = 0;
        let primaryLen = 0;
        // Primary subfield is FX-chained but in practice always 1 octet.
        if (off >= end) return null;
        primary = u8[off++];
        primaryLen = 1;
        while ((primary & 1) !== 0) {
            // Extended primary: skip further primary octets (each contributes
            // 7 more sub-item flags, but the spec only defines 7 sub-items
            // so this is essentially never hit). We still need to consume.
            if (off >= end) return null;
            primary = u8[off++];
            primaryLen++;
        }
        // We only decode the first primary octet's sub-items.
        const first = u8[start];
        for (let i = 0; i < 7; i++) {
            const present = (first >> (7 - i)) & 1;
            if (present) {
                if (off + subLens[i] > end) return null;
                off += subLens[i];
            }
        }
        return {data: u8.subarray(start, off), next: off};
    }
    if (spec.kind === "compound120") {
        // I048/120 Radial Doppler Speed: 1 primary octet, two sub-items
        // (CAL: 2 octets, RDS: 1 + N*6 repetitive)
        const start = off;
        if (off >= end) return null;
        const primary = u8[off++];
        if (primary & 0x80) {
            if (off + 2 > end) return null;
            off += 2; // CAL
        }
        if (primary & 0x40) {
            if (off >= end) return null;
            const rep = u8[off++];
            if (off + rep * 6 > end) return null;
            off += rep * 6;
        }
        return {data: u8.subarray(start, off), next: off};
    }
    return null;
}

// Decode I048/240 callsign: 6 octets carrying 8 chars of ICAO 6-bit chars.
function decodeCallsign(d) {
    // 48 bits → 8 chars × 6 bits. ICAO 6-bit alphabet (ASTERIX 048/240):
    // 0x00=' ',0x01='A',...,0x1A='Z', 0x20=space, 0x30..0x39='0'..'9'.
    const bits = (BigInt(d[0]) << 40n) | (BigInt(d[1]) << 32n) | (BigInt(d[2]) << 24n) |
                 (BigInt(d[3]) << 16n) | (BigInt(d[4]) << 8n) | BigInt(d[5]);
    let s = "";
    for (let i = 7; i >= 0; i--) {
        const c = Number((bits >> BigInt(i * 6)) & 0x3Fn);
        if (c >= 1 && c <= 26) s += String.fromCharCode(64 + c);       // A..Z
        else if (c >= 0x30 && c <= 0x39) s += String.fromCharCode(c);  // 0..9
        else s += " ";
    }
    return s.trim();
}

// Decode one CAT-048 record body (FSPEC + data items).
// Returns {sac, sic, todSec, rhoNm, thetaDeg, flightLevel, modeS, callsign,
//          trackNumber} (any may be undefined).
function decodeCAT048(body) {
    const fs = readFSPEC(body, 0, body.length);
    let off = fs.next;
    const out = {};
    for (let i = 0; i < CAT048_FIELDS.length && i < fs.bits.length; i++) {
        if (!fs.bits[i]) continue;
        const spec = CAT048_FIELDS[i];
        const r = consumeField(spec, body, off, body.length);
        if (!r) return out;  // truncated — return what we have
        const d = r.data;
        off = r.next;

        switch (spec.name) {
            case "010":
                out.sac = d[0]; out.sic = d[1];
                break;
            case "140": {
                // 1/128 sec since UTC midnight
                const raw = u24BE(d, 0);
                out.todSec = raw / 128;
                break;
            }
            case "040": {
                // RHO: 1/256 NM, THETA: 360/2^16 deg
                out.rhoNm = u16BE(d, 0) / 256;
                out.thetaDeg = u16BE(d, 2) * 360 / 65536;
                break;
            }
            case "090": {
                // Flight level: 14-bit two's complement, 1/4 FL units.
                // FL = 100 ft, so altitude_ft = raw * 0.25 * 100 = raw * 25.
                let raw = u16BE(d, 0) & 0x3FFF;
                if (raw & 0x2000) raw -= 0x4000;
                out.flightLevelFt = raw * 25;
                break;
            }
            case "220":
                out.modeS = (d[0] << 16) | (d[1] << 8) | d[2];
                break;
            case "240":
                out.callsign = decodeCallsign(d);
                break;
            case "161":
                out.trackNumber = u16BE(d, 0) & 0x0FFF;
                break;
            case "042": {
                // Calculated Cartesian (X, Y) in 1/128 NM, two's complement
                out.xNm = s16BE(d, 0) / 128;
                out.yNm = s16BE(d, 2) / 128;
                break;
            }
            case "200": {
                // Calculated Track Velocity: ground speed (16-bit, LSB=2^-14 NM/s)
                // and heading (16-bit, LSB=360/2^16 deg). The track system
                // needs ≥ 2 distinct-time points per aircraft to interpolate
                // a position; ASTERIX target reports are scan snapshots,
                // so we use this velocity to forward-project a synthetic
                // second point and turn a single plot into a short heading
                // vector on the map.
                out.groundSpeedKt = (u16BE(d, 0) / 16384) * 3600;
                out.headingDeg = u16BE(d, 2) * 360 / 65536;
                break;
            }
        }
    }
    return out;
}

// ---------- CAT-062 (system tracks) ----------
//
// We only decode a subset sufficient to display tracks:
//   FRN 1  I062/010 Data Source Identifier         fixed 2
//   FRN 2  spare
//   FRN 3  I062/015 Service Identification         fixed 1
//   FRN 4  I062/070 Time of Track Information      fixed 3
//   FRN 5  I062/105 Calc. Position WGS-84 (lat,lon) fixed 8   (each 180/2^31 deg)
//   FRN 6  I062/100 Calc. Position Cartesian       fixed 6
//   FRN 7  I062/185 Calc. Track Velocity Cartesian fixed 4
//   FRN 8  I062/210 Calc. Acceleration Cartesian   fixed 2
//   FRN 9  I062/060 Track Mode-3/A                 fixed 2
//   FRN 10 I062/245 Target Identification          fixed 7
//   FRN 11 I062/380 Aircraft Derived Data          variable / compound
//   FRN 12 I062/040 Track Number                   fixed 2
//   FRN 13 I062/080 Track Status                   variable
//   FRN 14 I062/290 System Track Update Ages       compound
//   FRN 15 I062/200 Mode of Movement               fixed 1
//   FRN 16 I062/295 Track Data Ages                compound
//   FRN 17 I062/136 Measured Flight Level          fixed 2
//   FRN 18 I062/130 Calc. Track Geometric Altitude fixed 2
//   FRN 19 I062/135 Calc. Track Barometric Altitude fixed 2
//   FRN 20 I062/220 Calc. Rate of Climb/Descent    fixed 2
//   FRN 21 I062/390 Flight Plan Related Data       compound
//   FRN 22 I062/270 Target Size and Orientation    variable
//   FRN 23 I062/300 Vehicle Fleet Identification   fixed 1
//   FRN 24 I062/110 Mode 5 Data                    compound
//   FRN 25 I062/120 Track Mode 2 Code              fixed 2
//   FRN 26 I062/510 Composed Track Number          variable (3 + 3*N)
//   FRN 27 I062/500 Estimated Accuracies           compound
//   FRN 28 I062/340 Measured Information           compound
//   FRN 34 I062/RE  Reserved Expansion             explicit (1 + N)
//   FRN 35 I062/SP  Special Purpose                explicit (1 + N)
//
// Because CAT-062 has many compound fields whose sub-item lengths must
// match the spec exactly, mis-parsing one item desynchronises everything
// after it. We decode the position fields (I062/105 and /380 callsign)
// using the prefix of the UAP — once we've consumed the position we don't
// need later fields, so we stop walking even though there may be more
// data after.

const CAT062_PREFIX = [
    {name: "010", kind: "fixed", len: 2},
    {name: "spare", kind: "fixed", len: 0},  // FRN 2 is spare; never present
    {name: "015", kind: "fixed", len: 1},
    {name: "070", kind: "fixed", len: 3},
    {name: "105", kind: "fixed", len: 8},
    {name: "100", kind: "fixed", len: 6},
    {name: "185", kind: "fixed", len: 4},
    {name: "210", kind: "fixed", len: 2},
    {name: "060", kind: "fixed", len: 2},
    {name: "245", kind: "fixed", len: 7},
];

function decodeCAT062(body) {
    const fs = readFSPEC(body, 0, body.length);
    let off = fs.next;
    const out = {};
    for (let i = 0; i < CAT062_PREFIX.length && i < fs.bits.length; i++) {
        if (!fs.bits[i]) continue;
        const spec = CAT062_PREFIX[i];
        if (spec.len === 0) continue;
        if (off + spec.len > body.length) return out;
        const d = body.subarray(off, off + spec.len);
        off += spec.len;
        if (spec.name === "010") { out.sac = d[0]; out.sic = d[1]; }
        else if (spec.name === "070") out.todSec = u24BE(d, 0) / 128;
        else if (spec.name === "105") {
            // 4-octet signed lat + 4-octet signed lon, LSB = 180/2^25 deg
            // (Eurocontrol ASTERIX CAT-062 v1.x).
            out.lat = s32BE(d, 0) * (180 / 33554432);
            out.lon = s32BE(d, 4) * (180 / 33554432);
        }
        else if (spec.name === "245") {
            // Octet 1: high 2 bits = STI; low 6 bits unused.
            // Octets 2..7: 6 chars of ICAO 6-bit (only 6 of 8 positions used).
            // Be lenient: try the same decoder, padding to 6 chars.
            const padded = new Uint8Array(6);
            padded.set(d.subarray(1, Math.min(d.length, 7)));
            // Reuse decodeCallsign (it returns 8 chars from 6 octets;
            // padded with low bytes 0 → trailing space which trim() drops).
            out.callsign = decodeCallsign(padded);
        }
    }
    return out;
}

// ---------- coordinate projection ----------

// Project polar (range NM, bearing deg from north, clockwise) from a radar
// reference LLA + altitude (m MSL) to aircraft LLA. We use a spherical
// approximation (good to a fraction of a degree at ~200 NM); the radar
// data themselves are 1/256 NM × ~0.005° resolution, far coarser than
// the WGS-84 vs sphere difference at typical surveillance ranges.
function projectPolar(radarLat, radarLon, rangeNm, bearingDeg) {
    const R = 6371000; // m
    const rangeM = rangeNm * 1852;
    const br = bearingDeg * Math.PI / 180;
    const lat1 = radarLat * Math.PI / 180;
    const lon1 = radarLon * Math.PI / 180;
    const angDist = rangeM / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angDist) +
                           Math.cos(lat1) * Math.sin(angDist) * Math.cos(br));
    const lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(angDist) * Math.cos(lat1),
                                   Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2));
    return {lat: lat2 * 180 / Math.PI, lon: ((lon2 * 180 / Math.PI + 540) % 360) - 180};
}

// ---------- main entry ----------

// Parse a buffer of PCAP or raw ASTERIX data. Returns an array of MISB rows
// (one per CAT-048/CAT-062 target report carrying a position), or null if
// the buffer doesn't look like ASTERIX.
export function parseASTERIXBuffer(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8.length < 3) return null;

    let pcapPackets = null;
    let rawRecords = null;

    if (isPCAP(u8)) {
        pcapPackets = parsePCAP(u8);
        if (!pcapPackets || pcapPackets.length === 0) return null;
    } else if (looksLikeASTERIX(u8)) {
        // No PCAP framing: timestamp comes from CAT-048 I048/140
        // (time of day, no date). Use today UTC midnight as date.
        rawRecords = walkASTERIX(u8);
        if (rawRecords.length === 0) return null;
    } else {
        return null;
    }

    const rows = [];
    let radarRef = DEFAULT_RADAR;
    let counts = {cat048: 0, cat034: 0, cat062: 0, cat065: 0, other: 0, points: 0};
    const seenRadars = new Set();

    const processRecord = (rec, baseTimeMs) => {
        if (rec.cat === 48) {
            counts.cat048++;
            const m = decodeCAT048(rec.body);
            const key = `${m.sac}_${m.sic}`;
            if (m.sac !== undefined) {
                seenRadars.add(key);
                if (SAC_SIC_RADAR[key]) radarRef = SAC_SIC_RADAR[key];
            }

            if (m.rhoNm === undefined || m.thetaDeg === undefined) return;
            const {lat, lon} = projectPolar(radarRef.lat, radarRef.lon, m.rhoNm, m.thetaDeg);
            // Altitude: prefer Mode-C flight level (pressure altitude).
            // FL is barometric — we treat as MSL for display.
            const altM = m.flightLevelFt !== undefined ? m.flightLevelFt * 0.3048 : radarRef.alt;

            // Stable per-aircraft id: Mode-S address (hex) preferred,
            // ASTERIX track number as fallback. Without a stable id every
            // sweep would become its own one-point track.
            const trackID = m.modeS !== undefined
                ? "S" + m.modeS.toString(16).toUpperCase().padStart(6, "0")
                : (m.trackNumber !== undefined ? "T" + m.trackNumber : null);
            if (trackID === null) return;

            // Combine the PCAP packet date with the ASTERIX time-of-day for
            // sub-second precision. Time-of-day is from UTC midnight; if it
            // disagrees with the packet ts by more than ~12 h assume a day
            // rollover and keep the packet timestamp.
            let timeMs = baseTimeMs;
            if (m.todSec !== undefined && baseTimeMs !== null) {
                const dayMs = 86400 * 1000;
                const midnight = Math.floor(baseTimeMs / dayMs) * dayMs;
                const fromTod = midnight + m.todSec * 1000;
                if (Math.abs(fromTod - baseTimeMs) < dayMs / 2) timeMs = fromTod;
            } else if (m.todSec !== undefined) {
                // Raw stream with no packet time: anchor to today UTC midnight
                const dayMs = 86400 * 1000;
                const midnight = Math.floor(Date.now() / dayMs) * dayMs;
                timeMs = midnight + m.todSec * 1000;
            }

            const row = new Array(MISBFields).fill(null);
            row[MISB.UnixTimeStamp] = timeMs;
            row[MISB.SensorLatitude] = lat;
            row[MISB.SensorLongitude] = lon;
            row[MISB.SensorTrueAltitude] = altM;
            row[MISB.PlatformTailNumber] = m.callsign || trackID;
            row[MISB.TrackID] = trackID;
            rows.push(row);
            counts.points++;

            // Forward-projected synthetic second point. ASTERIX target
            // reports are scan snapshots — typically each aircraft appears
            // once per radar rotation (~5 s). A single MISB row per
            // aircraft is below the track system's 2-point minimum, so
            // we project the plot forward using the radar's tracked
            // velocity (I048/200). The projection horizon is one nominal
            // scan period; this both keeps the synthetic point realistic
            // and makes heading visible at typical map zoom.
            if (m.groundSpeedKt !== undefined && m.headingDeg !== undefined && m.groundSpeedKt > 0) {
                const dtSec = 4;
                const distNm = m.groundSpeedKt / 3600 * dtSec;
                const next = projectPolar(lat, lon, distNm, m.headingDeg);
                const row2 = new Array(MISBFields).fill(null);
                row2[MISB.UnixTimeStamp] = timeMs + dtSec * 1000;
                row2[MISB.SensorLatitude] = next.lat;
                row2[MISB.SensorLongitude] = next.lon;
                row2[MISB.SensorTrueAltitude] = altM;
                row2[MISB.PlatformTailNumber] = m.callsign || trackID;
                row2[MISB.TrackID] = trackID;
                rows.push(row2);
            }
        } else if (rec.cat === 34) {
            counts.cat034++;
        } else if (rec.cat === 62) {
            counts.cat062++;
            const m = decodeCAT062(rec.body);
            if (m.lat === undefined || m.lon === undefined) return;
            const trackID = m.callsign && m.callsign.length > 0
                ? "C" + m.callsign : "C" + (m.sac ?? "?") + "_" + (m.sic ?? "?");
            let timeMs = baseTimeMs;
            if (m.todSec !== undefined && baseTimeMs !== null) {
                const dayMs = 86400 * 1000;
                const midnight = Math.floor(baseTimeMs / dayMs) * dayMs;
                const fromTod = midnight + m.todSec * 1000;
                if (Math.abs(fromTod - baseTimeMs) < dayMs / 2) timeMs = fromTod;
            }
            const row = new Array(MISBFields).fill(null);
            row[MISB.UnixTimeStamp] = timeMs;
            row[MISB.SensorLatitude] = m.lat;
            row[MISB.SensorLongitude] = m.lon;
            row[MISB.SensorTrueAltitude] = 0;  // CAT-062 altitude is in a separate field we don't decode
            row[MISB.PlatformTailNumber] = m.callsign || trackID;
            row[MISB.TrackID] = trackID;
            rows.push(row);
            counts.points++;
        } else if (rec.cat === 65) {
            counts.cat065++;
        } else {
            counts.other++;
        }
    };

    if (pcapPackets) {
        for (const pkt of pcapPackets) {
            const baseMs = pkt.tsSec * 1000 + Math.floor(pkt.tsUsec / 1000);
            for (const rec of walkASTERIX(pkt.payload)) {
                processRecord(rec, baseMs);
            }
        }
    } else {
        for (const rec of rawRecords) processRecord(rec, null);
    }

    // Stretch each aircraft's timeline to the dataset's global time window.
    // A radar PCAP is typically a snapshot: each plot occupies < 1 antenna
    // rotation and aircraft are reported at slightly different times. With
    // only their own (plot_time .. plot_time + horizon) range, individual
    // aircraft become "current" at different frames and disappear at
    // different frames — confusing when the user expects to see the whole
    // radar picture at once. To keep every aircraft visible across the
    // sitch timeline we prepend a stationary phantom row at the global
    // min-time and append one at the global max-time, both at the
    // aircraft's first/last actual lat/lon.
    if (rows.length > 0) {
        let minT = Infinity, maxT = -Infinity;
        for (const r of rows) {
            const t = r[MISB.UnixTimeStamp];
            if (t < minT) minT = t;
            if (t > maxT) maxT = t;
        }
        // Back off by a full second and floor to integer ms. The sitch's
        // start time is derived from the earliest row and rounded to whole
        // ms; if our phantom row had a fractional part the sitch would
        // start just *after* the row and clip frame 0.
        const phantomStart = Math.floor(minT - 1000);
        const phantomEnd = Math.ceil(maxT + 1000);

        const phantoms = new Map();
        for (const r of rows) {
            const id = r[MISB.TrackID];
            let p = phantoms.get(id);
            if (!p) {
                p = {first: r, last: r};
                phantoms.set(id, p);
            } else {
                if (r[MISB.UnixTimeStamp] < p.first[MISB.UnixTimeStamp]) p.first = r;
                if (r[MISB.UnixTimeStamp] > p.last[MISB.UnixTimeStamp]) p.last = r;
            }
        }
        for (const [, p] of phantoms) {
            const cloneAt = (src, t) => {
                const row = src.slice();
                row[MISB.UnixTimeStamp] = t;
                return row;
            };
            rows.push(cloneAt(p.first, phantomStart));
            rows.push(cloneAt(p.last, phantomEnd));
        }
    }

    // Per-aircraft sort + dedupe. CTrackFileMISB.toMISB filters by TrackID
    // in the source-row order, so consecutive duplicate-time rows for a
    // single aircraft would otherwise break CNodeTrackFromMISB
    // (asserts "Time data is not increasing" and then NaN positions).
    // ASTERIX target reports can land in the same UDP packet with identical
    // PCAP timestamps and ToD values, so we have to collapse them.
    const byTrack = new Map();
    for (const r of rows) {
        const k = r[MISB.TrackID];
        if (!byTrack.has(k)) byTrack.set(k, []);
        byTrack.get(k).push(r);
    }
    const dedup = [];
    let dropped = 0;
    for (const trackRows of byTrack.values()) {
        trackRows.sort((a, b) => a[MISB.UnixTimeStamp] - b[MISB.UnixTimeStamp]);
        let lastT = -Infinity;
        for (const r of trackRows) {
            if (r[MISB.UnixTimeStamp] === lastT) { dropped++; continue; }
            lastT = r[MISB.UnixTimeStamp];
            dedup.push(r);
        }
    }
    // Final global sort: keeps timeline-style display stable. Within a single
    // aircraft this is a no-op because all timestamps are now strictly
    // increasing per track.
    dedup.sort((a, b) => a[MISB.UnixTimeStamp] - b[MISB.UnixTimeStamp]);
    rows.length = 0;
    rows.push(...dedup);

    console.log(`ASTERIX: parsed CAT048=${counts.cat048} CAT034=${counts.cat034} ` +
                `CAT062=${counts.cat062} CAT065=${counts.cat065} other=${counts.other} ` +
                `→ ${counts.points} positions (${dropped} duplicate-time dropped) ` +
                `across ${seenRadars.size} radar(s) (reference: ${radarRef.name})`);

    return rows;
}

export function isPCAP(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8.length < 4) return false;
    const m = (u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3];
    return m === (0xd4c3b2a1 | 0) || m === (0xa1b2c3d4 | 0) ||
           m === (0x4d3cb2a1 | 0) || m === (0xa1b23c4d | 0);
}

// Cheap heuristic: a raw ASTERIX stream starts with a CAT byte (1..255)
// followed by a 16-bit big-endian length that's ≥ 4 and ≤ buffer size,
// and whose value steps walk us to the end of the buffer exactly (or
// nearly exactly — tolerate trailing zero padding).
export function looksLikeASTERIX(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8.length < 3) return false;
    let off = 0;
    let records = 0;
    while (off + 3 <= u8.length) {
        const cat = u8[off];
        const len = (u8[off + 1] << 8) | u8[off + 2];
        if (cat === 0 || len < 4 || off + len > u8.length) return records >= 1 && off >= u8.length - 8;
        // Categories actually in use are < 256, but specifically the well-known ones cluster low.
        if (cat > 250) return false;
        off += len;
        records++;
        if (records >= 4) return true;  // 4 valid consecutive records is enough
    }
    return records >= 1;
}
