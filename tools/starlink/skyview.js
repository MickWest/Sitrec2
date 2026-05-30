// skyview.js — SVG builders for the results page:
//   compassRose(arrows)   — a top-down compass with 1–2 yellow direction arrows.
//   horizonView({...})    — a horizon panorama with a compass ribbon, labelled
//                           bright stars, and the predicted flares (with motion arrows).
//
// Both return SVG strings to drop into the DOM. Pure module, no dependencies.
// Azimuth convention: degrees clockwise from North (N=0, E=90, S=180, W=270).

const DEG = Math.PI / 180;
const n = (x) => (Math.round(x * 10) / 10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Smallest signed difference a-b on a circle, in (-180,180].
function angDiff(a, b) {
    let d = ((a - b + 540) % 360) - 180;
    return d;
}

// Animated "sprinkle" of small white flares in the angular sector BETWEEN the
// arrows (just outside the rim). Each dot twinkles (opacity + size) and drifts a
// short distance over 5–10 s — every dot at the SAME speed but a random direction
// and a random moment within a single 60 s loop (SMIL, repeats indefinitely).
function flareDots(arrows, cx, cy, R) {
    if (!arrows || !arrows.length) return "";
    const a0 = arrows[0].azDeg;
    const a1 = arrows.length >= 2 ? arrows[arrows.length - 1].azDeg : a0;
    // Sweep the short way from a0 to a1; for a single arrow use a narrow band.
    let lo = a0, span = arrows.length >= 2 ? angDiff(a1, a0) : 0;
    if (arrows.length < 2) { lo = a0 - 16; span = 32; }

    const PERIOD = 60;   // whole sprinkle repeats every 60 s
    const SPEED = 2.2;   // SVG units / second — identical for every dot
    const N = 16;
    let out = "";
    for (let i = 0; i < N; i++) {
        const az = (lo + Math.random() * span) * DEG;
        const rad = R + 4 + Math.random() * 22;            // just beyond the outer ring
        const px = cx + Math.sin(az) * rad;
        const py = cy - Math.cos(az) * rad;
        // Three-stage flare envelope: fade UP (1–2 s), hold at MAX (2–12 s),
        // fade DOWN (== up). The dot drifts the whole time it is lit.
        const up = 1 + Math.random();                      // fade-in / fade-out 1–2 s
        const hold = 2 + Math.random() * 10;               // hold at max 2–12 s
        const D = up + hold + up;                           // total lit window (down == up)
        const t0 = Math.random() * (PERIOD - D);           // random moment in the loop
        const dir = Math.random() * 2 * Math.PI;           // random direction
        const dist = SPEED * D;                            // same speed -> distance ∝ D
        const dx = Math.cos(dir) * dist, dy = Math.sin(dir) * dist;
        const rDot = 1.1 + Math.random() * 0.9;
        // key times (normalised to the 60 s loop): idle, rise, hold, fall, idle
        const t1 = (t0 / PERIOD).toFixed(4);
        const t2 = ((t0 + up) / PERIOD).toFixed(4);
        const t3 = ((t0 + up + hold) / PERIOD).toFixed(4);
        const t4 = ((t0 + D) / PERIOD).toFixed(4);
        const kt = `0;${t1};${t2};${t3};${t4};1`;
        out += `<circle cx="${n(px)}" cy="${n(py)}" r="${n(rDot)}" fill="#ffffff" opacity="0">`
            + `<animate attributeName="opacity" dur="${PERIOD}s" repeatCount="indefinite" keyTimes="${kt}" values="0;0;0.95;0.95;0;0"/>`
            + `<animate attributeName="r" dur="${PERIOD}s" repeatCount="indefinite" keyTimes="${kt}" values="${n(rDot * 0.4)};${n(rDot * 0.4)};${n(rDot * 1.7)};${n(rDot * 1.7)};${n(rDot * 0.4)};${n(rDot * 0.4)}"/>`
            + `<animateTransform attributeName="transform" type="translate" dur="${PERIOD}s" repeatCount="indefinite" keyTimes="0;${t1};${t4};1" values="0 0;0 0;${n(dx)} ${n(dy)};${n(dx)} ${n(dy)}"/>`
            + `</circle>`;
    }
    return out;
}

// An amber arc along the rim spanning the azimuths where flares occur, whose
// thickness AND opacity track the flare density at each azimuth — so it is fat
// and bright where flares are most frequent and tapers to thin/faint at the
// edges of the distribution (≈ flares-per-minute, since azimuth tracks time).
function flareArc(flares, cx, cy, R) {
    if (!flares || flares.length < 2) return "";
    // Circular mean of the flare azimuths, and the widest deviation from it.
    let sx = 0, sy = 0;
    for (const f of flares) { sx += Math.cos(f.azDeg * DEG); sy += Math.sin(f.azDeg * DEG); }
    const center = ((Math.atan2(sy, sx) / DEG) % 360 + 360) % 360;
    let span = 0;
    for (const f of flares) span = Math.max(span, Math.abs(angDiff(f.azDeg, center)));
    if (span < 1.5) return "";   // essentially one direction — an arc adds nothing

    // Density histogram across [-span, +span] (degrees from centre), smoothed.
    const BINS = 48, k = 3;
    const hist = new Array(BINS).fill(0);
    for (const f of flares) {
        let b = Math.floor((angDiff(f.azDeg, center) + span) / (2 * span) * BINS);
        if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
        hist[b]++;
    }
    const sm = new Array(BINS).fill(0);
    for (let i = 0; i < BINS; i++) {
        let s = 0, c = 0;
        for (let j = -k; j <= k; j++) { const idx = i + j; if (idx >= 0 && idx < BINS) { s += hist[idx]; c++; } }
        sm[i] = s / c;
    }
    const maxD = Math.max(...sm) || 1;

    const baseW = 9;             // max band thickness (SVG units)
    let out = `<g class="flare-arc">`;
    for (let i = 0; i < BINS; i++) {
        const d = sm[i] / maxD;          // 0..1 local density
        if (d <= 0.02) continue;
        const aA = (center - span + (i / BINS) * 2 * span) * DEG;
        const aB = (center - span + ((i + 1) / BINS) * 2 * span) * DEG;
        const x1 = cx + Math.sin(aA) * R, y1 = cy - Math.cos(aA) * R;
        const x2 = cx + Math.sin(aB) * R, y2 = cy - Math.cos(aB) * R;
        const w = (0.15 + 0.85 * d) * baseW;     // thickness ∝ density
        const op = 0.12 + 0.6 * d;               // opacity ∝ density
        out += `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#ffcf3f" `
            + `stroke-width="${n(w)}" stroke-opacity="${n(op)}" stroke-linecap="round"/>`;
    }
    return out + `</g>`;
}

// --- compass rose ----------------------------------------------------------
// arrows: [{ azDeg, color?, label? }] (1 or 2). Yellow by default.
// flares: optional [{azDeg, ...}] — used to draw the density arc along the rim.
export function compassRose(arrows, flares) {
    const W = 220, cx = 110, cy = 112, R = 84;
    const pts = [];
    // tick marks every 22.5°
    for (let a = 0; a < 360; a += 22.5) {
        const major = a % 90 === 0;
        const r0 = major ? R - 12 : R - 7;
        const x1 = cx + Math.sin(a * DEG) * r0, y1 = cy - Math.cos(a * DEG) * r0;
        const x2 = cx + Math.sin(a * DEG) * R, y2 = cy - Math.cos(a * DEG) * R;
        pts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#3a4566" stroke-width="${major ? 2 : 1}" stroke-opacity="0.6"/>`);
    }
    // 8-point labels
    const dirs = [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]];
    const labels = dirs.map(([t, a]) => {
        const rr = R - 22;
        const x = cx + Math.sin(a * DEG) * rr, y = cy - Math.cos(a * DEG) * rr;
        const major = a % 90 === 0;
        return `<text x="${n(x)}" y="${n(y + 4)}" text-anchor="middle" font-size="${major ? 13 : 10}" `
            + `fill="${major ? "#cfe0ff" : "#7f8db3"}" font-weight="${major ? 700 : 500}">${t}</text>`;
    }).join("");

    const arr = (arrows || []).map((a) => {
        const col = a.color || "#ffcf3f";
        const len = R - 16;
        const tipx = cx + Math.sin(a.azDeg * DEG) * len;
        const tipy = cy - Math.cos(a.azDeg * DEG) * len;
        // arrowhead
        const back = len - 16;
        const bx = cx + Math.sin(a.azDeg * DEG) * back, by = cy - Math.cos(a.azDeg * DEG) * back;
        const perp = (a.azDeg + 90) * DEG;
        const hx = Math.sin(perp) * 7, hy = -Math.cos(perp) * 7;
        return `<line x1="${cx}" y1="${cy}" x2="${n(tipx)}" y2="${n(tipy)}" stroke="${col}" stroke-width="4" stroke-linecap="round"/>`
            + `<polygon points="${n(tipx)},${n(tipy)} ${n(bx + hx)},${n(by + hy)} ${n(bx - hx)},${n(by - hy)}" fill="${col}"/>`;
    }).join("");

    // Expand the viewBox upward so the sprinkle of flares (just beyond the rim,
    // in the wedge between the arrows) has room to appear and drift.
    return `<svg viewBox="0 -30 ${W} ${W + 30}" class="compass-rose" role="img" aria-label="Compass showing the flare direction">
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="#0c1224" stroke="#2a3550" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="${R - 30}" fill="none" stroke="#1c2740" stroke-width="1"/>
      ${pts.join("")}
      ${labels}
      ${flareArc(flares, cx, cy, R)}
      ${flareDots(arrows, cx, cy, R)}
      ${arr}
      <circle cx="${cx}" cy="${cy}" r="3.5" fill="#cfe0ff"/>
    </svg>`;
}

// --- horizon view ----------------------------------------------------------
// opts: {
//   stars:  [{name, azDeg, altDeg, mag}]   (all above the horizon; filtered here)
//   flares: [{azDeg, elDeg, dAzDeg, dElDeg, intensity}]
//   azCenter, halfWidthDeg, elMaxDeg
// }
export function horizonView(opts) {
    const stars = opts.stars || [];
    const bodies = opts.bodies || [];   // planets + Moon: {name, azDeg, altDeg, color, r}
    const flares = opts.flares || [];
    const azCenter = opts.azCenter;
    const HW = opts.halfWidthDeg;          // degrees either side of centre
    const elMax = opts.elMaxDeg || 45;

    const W = 760, H = 300;
    const padL = 8, padR = 8;
    const horizonY = 250, topY = 26;
    const plotW = W - padL - padR;

    const xOf = (az) => padL + (angDiff(az, azCenter) / HW + 1) / 2 * plotW;   // rel∈[-HW,HW] -> [padL, W-padR]
    const yOf = (el) => horizonY - Math.max(0, Math.min(elMax, el)) / elMax * (horizonY - topY);
    const inWin = (az) => Math.abs(angDiff(az, azCenter)) <= HW + 0.5;

    // sky gradient + ground
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="horizon-view" role="img" aria-label="Horizon view of the flares and bright stars">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0a1330"/>
          <stop offset="0.7" stop-color="#13213f"/>
          <stop offset="1" stop-color="#243a5e"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${W}" height="${horizonY}" fill="url(#sky)"/>
      <rect x="0" y="${horizonY}" width="${W}" height="${H - horizonY}" fill="#0a0f1d"/>`;

    // elevation gridlines
    for (const el of [10, 20, 30, 40]) {
        if (el > elMax) continue;
        const y = yOf(el);
        svg += `<line x1="${padL}" y1="${n(y)}" x2="${W - padR}" y2="${n(y)}" stroke="#ffffff" stroke-opacity="0.06"/>`
            + `<text x="${W - padR - 2}" y="${n(y - 2)}" text-anchor="end" font-size="11" fill="#6b79a0">${el}°</text>`;
    }

    // horizon line
    svg += `<line x1="${padL}" y1="${horizonY}" x2="${W - padR}" y2="${horizonY}" stroke="#7da0d8" stroke-width="2"/>`;

    // compass ribbon: ticks every 15°, labels at 22.5° compass points
    const C16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const startAz = Math.ceil((azCenter - HW) / 15) * 15;
    for (let a = startAz; a <= azCenter + HW; a += 15) {
        const az = ((a % 360) + 360) % 360;
        const x = xOf(az);
        const isPt = Math.abs(az / 22.5 - Math.round(az / 22.5)) < 1e-6;
        svg += `<line x1="${n(x)}" y1="${horizonY}" x2="${n(x)}" y2="${horizonY + (isPt ? 10 : 5)}" stroke="#7da0d8" stroke-opacity="${isPt ? 0.9 : 0.4}"/>`;
        if (isPt) {
            const lab = C16[Math.round(az / 22.5) % 16];
            const card = az % 90 === 0;
            svg += `<text x="${n(x)}" y="${horizonY + 25}" text-anchor="middle" font-size="${card ? 15 : 12}" `
                + `font-weight="${card ? 700 : 500}" fill="${card ? "#cfe0ff" : "#9aaad0"}">${lab}</text>`;
        }
    }

    // stars
    for (const s of stars) {
        if (s.altDeg < 0 || s.altDeg > elMax || !inWin(s.azDeg)) continue;
        const x = xOf(s.azDeg), y = yOf(s.altDeg);
        const r = Math.max(1.1, 3.2 - s.mag * 0.7);
        svg += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#eaf1ff"/>`;
        if (s.mag < 1.6) {
            svg += `<text x="${n(x + r + 3)}" y="${n(y + 3.5)}" font-size="12" fill="#aab8da">${esc(s.name)}</text>`;
        }
    }

    // planets (coloured) and the Moon (grey, larger) — always labelled
    for (const b of bodies) {
        if (b.altDeg < 0 || b.altDeg > elMax || !inWin(b.azDeg)) continue;
        const x = xOf(b.azDeg), y = yOf(b.altDeg), r = b.r || 3.4;
        svg += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${b.color}"/>`;
        svg += `<text x="${n(x + r + 3)}" y="${n(y + 4)}" font-size="12" fill="${b.color}">${esc(b.name)}</text>`;
    }

    // flares (drawn last, on top): small WHITE disks (same max size as the
    // compass-rose sprinkle), each with a thin, ~75%-opacity amber motion arrow.
    const WHITE_R = 3.5;                       // ≈ compass sprinkle's peak dot size
    const elPxPerDeg = (horizonY - topY) / elMax;
    const azPxPerDeg = plotW / (2 * HW);
    for (const f of flares) {
        if (!inWin(f.azDeg)) continue;
        const x = xOf(f.azDeg), y = yOf(f.elDeg);
        // motion arrow first (thin, semi-transparent) so the disk sits cleanly on top
        let vx = (f.dAzDeg || 0) * azPxPerDeg;
        let vy = -(f.dElDeg || 0) * elPxPerDeg;
        const m = Math.hypot(vx, vy);
        if (m > 0.5) {
            const L = 15; vx = vx / m * L; vy = vy / m * L;
            const ex = x + vx, ey = y + vy;
            const ang = Math.atan2(vy, vx);
            const a1 = ang + Math.PI - 0.4, a2 = ang + Math.PI + 0.4;
            svg += `<g stroke="#ffcf3f" fill="#ffcf3f" opacity="0.75">`
                + `<line x1="${n(x)}" y1="${n(y)}" x2="${n(ex)}" y2="${n(ey)}" stroke-width="1"/>`
                + `<polygon points="${n(ex)},${n(ey)} ${n(ex + Math.cos(a1) * 4)},${n(ey + Math.sin(a1) * 4)} ${n(ex + Math.cos(a2) * 4)},${n(ey + Math.sin(a2) * 4)}" stroke="none"/>`
                + `</g>`;
        }
        svg += `<circle cx="${n(x)}" cy="${n(y)}" r="${WHITE_R}" fill="#ffffff"/>`;
    }

    svg += `</svg>`;
    return svg;
}

// Decide a horizon-view window (centre + half-width) that frames all the flares.
export function horizonWindow(flares) {
    if (!flares.length) return { azCenter: 0, halfWidthDeg: 90, elMaxDeg: 45 };
    // circular mean of flare azimuths
    let sx = 0, sy = 0, maxEl = 0;
    for (const f of flares) { sx += Math.cos(f.azDeg * DEG); sy += Math.sin(f.azDeg * DEG); maxEl = Math.max(maxEl, f.elDeg); }
    const azCenter = ((Math.atan2(sy, sx) / DEG) % 360 + 360) % 360;
    // widest deviation from centre
    let maxDev = 0;
    for (const f of flares) maxDev = Math.max(maxDev, Math.abs(angDiff(f.azDeg, azCenter)));
    const halfWidthDeg = Math.min(120, Math.max(50, maxDev + 35));
    const elMaxDeg = Math.min(60, Math.max(30, maxEl * 1.4 + 5));
    return { azCenter, halfWidthDeg, elMaxDeg };
}
