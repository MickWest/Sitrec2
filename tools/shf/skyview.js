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

// Apparent-motion sampling interval (ms): dAzDeg/dElDeg are the satellite's change in
// az/el over this span, so its position at time t = peak + d(Az|El)·(t − peakMs)/MOTION_SAMPLE_MS.
// Shared by the streak path, the dot's motion arrow, and the replay animation.
export const MOTION_SAMPLE_MS = 2000;

// The horizon panorama's az/el → x/y projection plus its key coordinates, given the framing
// window {azCenter, halfWidthDeg, elMaxDeg}. Extracted so the live results page can animate
// the replay flares + Sun onto the SAME SVG with the IDENTICAL mapping horizonView draws by —
// the moving layer can't drift from the static scene because both call this one function.
export function horizonProjection(win) {
    const HW = win.halfWidthDeg;
    const elMax = win.elMaxDeg || 45;
    const azCenter = win.azCenter;
    const W = 760, H = 300, padL = 8, padR = 8, horizonY = 250, topY = 26;
    const plotW = W - padL - padR;
    const xOf = (az) => padL + (angDiff(az, azCenter) / HW + 1) / 2 * plotW;   // rel∈[-HW,HW] -> [padL, W-padR]
    // Unclamped: a point above elMax or below the horizon gets a real off-view y, and the sky
    // clip-path crops it at the edge — clamping instead would squash overflowing lines onto the rim.
    const yOf = (el) => horizonY - el / elMax * (horizonY - topY);
    const inWin = (az) => Math.abs(angDiff(az, azCenter)) <= HW + 0.5;
    return {
        W, H, padL, padR, horizonY, topY, plotW, HW, elMax, azCenter, xOf, yOf, inWin,
        elPxPerDeg: (horizonY - topY) / elMax, azPxPerDeg: plotW / (2 * HW),
    };
}

// Brightness (0..intensity) of a flare at absolute time t (ms): a ramp-HOLD-ramp that rises
// from 0 at startMs to its peak intensity by the core start, holds across the core
// (coreStartMs..coreEndMs — where the glint sat inside the cone's full-brightness core), then
// falls back to 0 by endMs. With no recorded core it's a triangle peaking at peakMs. Uses the
// SAME control points as the timelapse-streak gradient, so the replay animation and the streak
// agree on each flare's brightness curve (and both ultimately derive from flarePhysics).
export function flareBrightnessAt(f, t) {
    const a = f.startMs, b = f.endMs;
    if (!(t > a && t < b)) return 0;
    const inten = Math.max(0, Math.min(1, f.intensity ?? 1));
    const hasCore = f.coreStartMs && f.coreEndMs && f.coreEndMs > f.coreStartMs + 1;
    const cs = hasCore ? f.coreStartMs : (f.peakMs ?? (a + b) / 2);
    const ce = hasCore ? f.coreEndMs : cs;
    if (t < cs) return inten * (t - a) / Math.max(1, cs - a);   // ramp up
    if (t <= ce) return inten;                                  // hold (single peak if no core)
    return inten * (b - t) / Math.max(1, b - ce);               // ramp down
}

// SVG for the bright stars (white, brighter = bigger; labelled when mag < 1.6) and the planets/
// Moon (coloured, always labelled) that are above the horizon and inside the framing window.
// Extracted from horizonView so the replay animation can REDRAW them at the current time (their
// alt/az drift with the sky) using the IDENTICAL look. P is a horizonProjection result.
export function skyBodiesSVG(stars, bodies, P) {
    const { xOf, yOf, inWin, elMax } = P;
    let s = "";
    for (const st of (stars || [])) {
        if (st.altDeg < 0 || st.altDeg > elMax || !inWin(st.azDeg)) continue;
        const x = xOf(st.azDeg), y = yOf(st.altDeg);
        const r = Math.max(1.1, 3.2 - st.mag * 0.7);
        s += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#eaf1ff"/>`;
        if (st.mag < 1.6) s += `<text x="${n(x + r + 3)}" y="${n(y + 3.5)}" font-size="12" fill="#aab8da">${esc(st.name)}</text>`;
    }
    for (const b of (bodies || [])) {
        if (b.altDeg < 0 || b.altDeg > elMax || !inWin(b.azDeg)) continue;
        const x = xOf(b.azDeg), y = yOf(b.altDeg), r = b.r || 3.4;
        s += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${b.color}"/>`;
        s += `<text x="${n(x + r + 3)}" y="${n(y + 4)}" font-size="12" fill="${b.color}">${esc(b.name)}</text>`;
    }
    return s;
}

// A small "LIVE" badge — red text + a red dot in a red-outlined box. Used UNDER the Sun as a
// pure indicator: rendered hidden, the app shows it only while real-time mode is active. (x,y)
// is the box's top-left; the badge is 46×16.
function liveBadge(x, y) {
    return `<g class="replay-live" visibility="hidden" pointer-events="none">`
        + `<rect x="${n(x)}" y="${n(y)}" width="46" height="16" rx="3" fill="rgba(220,30,30,0.18)" stroke="#ff4040" stroke-width="1"/>`
        + `<circle cx="${n(x + 10)}" cy="${n(y + 8)}" r="2.6" fill="#ff3b3b"/>`
        + `<text x="${n(x + 17)}" y="${n(y + 12)}" font-size="10" font-weight="700" fill="#ff6b6b" `
        + `font-family="ui-monospace, SFMono-Regular, Menlo, monospace" letter-spacing="0.6">LIVE</text>`
        + `</g>`;
}

// The LIVE toggle BUTTON above the time readout (replaces the old clock button). It is always
// drawn (when real time is possible); colours come from CSS — grey with the dot at opacity 0
// when off (so nothing shifts), red box + red dot + red text when .on. The app wires the click
// and toggles .on. Same 46×16 geometry as liveBadge so the two read identically.
function liveButton(x, y) {
    return `<g class="replay-live-btn" style="cursor:pointer">`
        + `<rect class="rl-box" x="${n(x)}" y="${n(y)}" width="46" height="16" rx="3"/>`
        + `<circle class="rl-dot" cx="${n(x + 10)}" cy="${n(y + 8)}" r="2.6"/>`
        + `<text class="rl-text" x="${n(x + 17)}" y="${n(y + 12)}" font-size="10" font-weight="700" `
        + `letter-spacing="0.6" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">LIVE</text>`
        + `</g>`;
}

// One animated "flare" dot at (px,py): a small white point that brightens, holds,
// and fades while drifting a short distance, at SPEED units/s, in a random
// direction, lit at a random moment within a single PERIOD-second SMIL loop.
// Three-stage envelope: rise (upMin..upMin+upRange s), hold at MAX (2–12 s), fall
// (== rise). The compass uses a brisk 1–2 s rise; the naked-eye preview 3–6 s.
// opts:
//   upOnly     — restrict the drift so it never heads downward (dy <= 0 in SVG).
//   shrinkFade — fade ENTIRELY by growing/shrinking the radius (0 -> rMax -> 0) at
//                constant full opacity, instead of dimming a fixed-size disk. Opacity
//                is then binary, toggled only while the radius is 0 (so no visible
//                pop and no dim translucent disks); the inevitable sub-pixel tail
//                where r < ~1px is the only place transparency does any work.
function twinkleFlare(px, py, PERIOD, SPEED, upMin = 1, upRange = 1, opts = {}) {
    const up = upMin + Math.random() * upRange;        // fade-in / fade-out time
    const hold = 2 + Math.random() * 10;               // hold at max 2–12 s
    const D = up + hold + up;                           // total lit window (down == up)
    const t0 = Math.random() * (PERIOD - D);           // random moment in the loop
    // Drift direction; with upOnly, pick a lower-half angle so sin(dir) <= 0 -> dy <= 0
    // in SVG coordinates (y grows downward), i.e. the dot only ever moves up or sideways.
    const dir = opts.upOnly ? Math.PI + Math.random() * Math.PI : Math.random() * 2 * Math.PI;
    const dist = SPEED * D;                            // same speed -> distance ∝ D
    const dx = Math.cos(dir) * dist, dy = Math.sin(dir) * dist;
    const rDot = 1.1 + Math.random() * 0.9;
    const rMax = rDot * 1.7;
    // key times (normalised to the loop): idle, rise, hold, fall, idle
    const t1 = (t0 / PERIOD).toFixed(4);
    const t2 = ((t0 + up) / PERIOD).toFixed(4);
    const t3 = ((t0 + up + hold) / PERIOD).toFixed(4);
    const t4 = ((t0 + D) / PERIOD).toFixed(4);
    const kt = `0;${t1};${t2};${t3};${t4};1`;
    // Fade by SIZE (shrinkFade) or by OPACITY (default compass look).
    const opVals = opts.shrinkFade ? `0;1;1;1;1;0` : `0;0;0.95;0.95;0;0`;
    const rVals = opts.shrinkFade
        ? `0;0;${n(rMax)};${n(rMax)};0;0`
        : `${n(rDot * 0.4)};${n(rDot * 0.4)};${n(rMax)};${n(rMax)};${n(rDot * 0.4)};${n(rDot * 0.4)}`;
    return `<circle cx="${n(px)}" cy="${n(py)}" r="0" fill="#ffffff" opacity="0">`
        + `<animate attributeName="opacity" dur="${PERIOD}s" repeatCount="indefinite" keyTimes="${kt}" values="${opVals}"/>`
        + `<animate attributeName="r" dur="${PERIOD}s" repeatCount="indefinite" keyTimes="${kt}" values="${rVals}"/>`
        + `<animateTransform attributeName="transform" type="translate" dur="${PERIOD}s" repeatCount="indefinite" keyTimes="0;${t1};${t4};1" values="0 0;0 0;${n(dx)} ${n(dy)};${n(dx)} ${n(dy)}"/>`
        + `</circle>`;
}

// Animated "sprinkle" of small white flares in the angular sector BETWEEN the
// arrows (just outside the rim). Every dot at the SAME speed but a random
// direction/moment within a single 60 s loop (SMIL, repeats indefinitely).
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
        out += twinkleFlare(px, py, PERIOD, SPEED);
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
// opts.live: skip the animated (SMIL) flare sprinkle — used for the 10 Hz live
//   re-render during scanning, where restarting the animation every frame would flicker.
export function compassRose(arrows, flares, opts = {}) {
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
    // in the wedge between the arrows) has room to appear and drift. The bottom is
    // trimmed close to the circle (nothing draws below it) to cut dead vertical space.
    return `<svg viewBox="0 -30 ${W} ${W + 12}" class="compass-rose" role="img" aria-label="Compass showing the flare direction">
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="#0c1224" stroke="#2a3550" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="${R - 30}" fill="none" stroke="#1c2740" stroke-width="1"/>
      ${pts.join("")}
      ${labels}
      ${flareArc(flares, cx, cy, R)}
      ${opts.live ? "" : flareDots(arrows, cx, cy, R)}
      ${arr}
      <circle cx="${cx}" cy="${cy}" r="3.5" fill="#cfe0ff"/>
    </svg>`;
}

// --- horizon view ----------------------------------------------------------
// opts: {
//   stars:    [{name, azDeg, altDeg, mag}]   (all above the horizon; filtered here)
//   bodies:   [{name, azDeg, altDeg, color, r}]
//   flares:   [{azDeg, elDeg, dAzDeg, dElDeg, intensity}]
//   sunMarks: [{azDeg, label}]   hourly Sun-azimuth markers (label e.g. "11pm")
//   azCenter, halfWidthDeg, elMaxDeg
// }
export function horizonView(opts) {
    const stars = opts.stars || [];
    const bodies = opts.bodies || [];   // planets + Moon: {name, azDeg, altDeg, color, r}
    const flares = opts.flares || [];
    const sunMarks = opts.sunMarks || [];
    // Wide-view style: 'dots' (white disk + motion arrow), 'streaks' (timelapse lines), or
    // 'replay' (faint streaks behind a JS-animated, time-driven flare playback the app drives).
    // Accept the older boolean opts.streaks too. Replay reuses the streak drawing, dimmed.
    const mode = opts.mode || (opts.streaks ? "streaks" : "dots");
    const replay = mode === "replay";
    const liveBtn = !!opts.liveButton;     // draw the LIVE toggle (real time is possible: now ∈ window)
    const streaks = mode === "streaks" || replay;
    const streakMul = replay ? 0.12 : 1;   // ~10% faint timelapse streaks as context under the replay layer

    const P = horizonProjection(opts);
    const { W, H, padL, padR, horizonY, topY, plotW, HW, elMax, azCenter, xOf, yOf, inWin } = P;

    // Hourly Sun-azimuth markers: a labelled amber down-arrow per whole hour, drawn
    // in a headroom band ABOVE the sky so they never collide with stars/flares. The
    // arrow points down into the sky at the Sun's azimuth (the flares track it). Skip
    // a marker whose label would crowd the previous one (keeps it readable on mobile).
    const HEAD = 30;                                // headroom band height (when used)
    const labelY = -HEAD + 13, lineTop = -10, lineBot = 12;   // arrow spans headroom -> top of sky
    let hourMarksSvg = "";
    let lastX = -1e9;
    for (const mk of sunMarks) {
        if (!inWin(mk.azDeg)) continue;
        const x = xOf(mk.azDeg);
        if (Math.abs(x - lastX) < 30) continue;     // avoid overlapping labels
        lastX = x;
        hourMarksSvg += `<g stroke="#ffcf3f" fill="#ffcf3f" opacity="0.85">`
            + `<line x1="${n(x)}" y1="${lineTop}" x2="${n(x)}" y2="${lineBot}" stroke-width="1.5"/>`
            + `<polygon points="${n(x)},${n(lineBot + 5)} ${n(x - 3.5)},${n(lineBot - 1)} ${n(x + 3.5)},${n(lineBot - 1)}" stroke="none"/>`
            + `</g>`
            + `<text x="${n(x)}" y="${labelY}" text-anchor="middle" font-size="13" font-weight="700" fill="#ffcf3f">${esc(mk.label)}</text>`;
    }
    const head = hourMarksSvg ? HEAD : 0;           // only reserve the band if a marker drew

    // sky gradient + ground
    let svg = `<svg viewBox="0 ${-head} ${W} ${H + head}" class="horizon-view" role="img" aria-label="Horizon view of the flares, bright stars, and the Sun's hourly direction">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0a1330"/>
          <stop offset="0.7" stop-color="#13213f"/>
          <stop offset="1" stop-color="#243a5e"/>
        </linearGradient>
        <clipPath id="skyClip"><rect x="0" y="0" width="${W}" height="${horizonY}"/></clipPath>
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

    // stars (white), planets (coloured) and the Moon — above the horizon, inside the window.
    // In replay they go in a group the app redraws each second as the sky rotates with time.
    const bodiesSVG = skyBodiesSVG(stars, bodies, P);
    svg += replay ? `<g class="replay-bodies">${bodiesSVG}</g>` : bodiesSVG;

    // flares (drawn last, on top). Two looks, toggled by opts.streaks:
    //  • default — a small WHITE disk with a thin, ~75%-opacity amber motion arrow.
    //  • streaks — a "timelapse exposure": a 2px white line tracing the satellite's path
    //    over the flare (peak ± apparent-motion × time-offset), brightest (opacity =
    //    intensity) at the peak and fading to nothing at the ends, ≈ its brightness curve.
    const WHITE_R = 1.75;                      // small white dot (half the old size)
    const { elPxPerDeg, azPxPerDeg } = P;
    const MOTION_DT_MS = MOTION_SAMPLE_MS;     // dAzDeg/dElDeg sampled over ~2 s
    // Everything flare-related goes in a group clipped to the sky rect, so streaks/arrows that
    // run off the top, sides, or below the horizon are cropped at the edge (not squashed onto it).
    svg += `<g clip-path="url(#skyClip)">`;
    if (streaks) {
        let defs = "", lines = "", gi = 0;
        for (const f of flares) {
            if (!inWin(f.azDeg)) continue;
            const inten = Math.max(0, Math.min(1, f.intensity ?? 1));
            const dAz = f.dAzDeg || 0, dEl = f.dElDeg || 0;
            const back = ((f.peakMs - f.startMs) || 0) / MOTION_DT_MS;   // peak -> start, in motion-samples
            const fwd = ((f.endMs - f.peakMs) || 0) / MOTION_DT_MS;      // peak -> end
            const xp = xOf(f.azDeg), yp = yOf(f.elDeg);
            const x1 = xOf(f.azDeg - dAz * back), y1 = yOf(f.elDeg - dEl * back);
            const x2 = xOf(f.azDeg + dAz * fwd), y2 = yOf(f.elDeg + dEl * fwd);
            if (Math.hypot(x2 - x1, y2 - y1) < 2) {                       // negligible path -> a point
                lines += `<circle cx="${n(xp)}" cy="${n(yp)}" r="1.6" fill="#ffffff" opacity="${n(inten * streakMul)}"/>`;
                continue;
            }
            // Brightness profile along the streak. If the flare held at full brightness
            // (the core: coreStartMs..coreEndMs from the shared physics), draw a flat-top
            // ramp-HOLD-ramp by repeating the bright stop at both core edges. Otherwise it
            // never reached full brightness, so a single peak stop (a triangle) is right.
            const total = (f.endMs - f.startMs) || 1;
            const off = (v) => Math.round(Math.max(0.02, Math.min(0.98, v)) * 1000) / 1000;
            let midStops;
            if (f.coreStartMs && f.coreEndMs && f.coreEndMs > f.coreStartMs + 1) {
                const cs = off((f.coreStartMs - f.startMs) / total);
                let ce = off((f.coreEndMs - f.startMs) / total);
                if (ce <= cs) ce = Math.min(0.98, cs + 0.01);
                midStops = `<stop offset="${cs}" stop-color="#ffffff" stop-opacity="${n(inten * streakMul)}"/>`
                    + `<stop offset="${ce}" stop-color="#ffffff" stop-opacity="${n(inten * streakMul)}"/>`;
            } else {
                midStops = `<stop offset="${off((f.peakMs - f.startMs) / total)}" stop-color="#ffffff" stop-opacity="${n(inten * streakMul)}"/>`;
            }
            const id = "st" + (gi++);
            defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}">`
                + `<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>${midStops}`
                + `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>`;
            lines += `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="url(#${id})" stroke-width="2" stroke-linecap="round"/>`;
        }
        svg += `<defs>${defs}</defs>${lines}`;
    } else {
        for (const f of flares) {
            if (!inWin(f.azDeg)) continue;
            const x = xOf(f.azDeg), y = yOf(f.elDeg);
            // motion arrow first (thin, semi-transparent) so the disk sits cleanly on top.
            // Length now reflects the flare's DURATION: how far the satellite travels over
            // the run (apparent motion × duration), capped so a long one can't dominate.
            const durDt = ((f.endMs - f.startMs) || 0) / MOTION_DT_MS;
            let vx = (f.dAzDeg || 0) * azPxPerDeg * durDt;
            let vy = -(f.dElDeg || 0) * elPxPerDeg * durDt;
            let m = Math.hypot(vx, vy);
            if (m > 3) {
                const MAXL = 80; if (m > MAXL) { vx = vx / m * MAXL; vy = vy / m * MAXL; }
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
    }
    svg += `</g>`;   // end sky-clipped flare group

    // Replay layer: an empty group the live page fills each animation frame with the flares
    // active at the current replay time (positioned + brightened via the shared flareBrightnessAt),
    // and a draggable Sun under the horizon that marks that instant at the Sun's true azimuth.
    if (replay) {
        const sunY = horizonY + 14, cx0 = n((padL + W - padR) / 2);
        // White flare dot with a softened edge (objectBoundingBox, so it re-centres on every
        // circle the app draws): solid white out to ~88% of the radius, then a quick fade to
        // transparent over the outer ~12% — just enough to kill the hard edge, no real bloom.
        svg += `<defs><radialGradient id="rflareDot">`
            + `<stop offset="0" stop-color="#ffffff" stop-opacity="1"/>`
            + `<stop offset="0.88" stop-color="#ffffff" stop-opacity="1"/>`
            + `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>`
            + `</radialGradient></defs>`;
        svg += `<g class="replay-flares" clip-path="url(#skyClip)"></g>`
            + `<g class="replay-sun" transform="translate(${cx0},0)">`
            + `<line x1="0" y1="${horizonY}" x2="0" y2="${sunY - 11}" stroke="#ffcf3f" stroke-width="1.8" stroke-opacity="0.6"/>`
            + `<circle cx="0" cy="${sunY}" r="10" fill="#ffd24a"/>`
            + `<g stroke="#ffd24a" stroke-width="1.8" stroke-linecap="round">`
            + `<line x1="-16.5" y1="${sunY}" x2="-12.75" y2="${sunY}"/><line x1="12.75" y1="${sunY}" x2="16.5" y2="${sunY}"/>`
            + `<line x1="0" y1="${sunY + 12.75}" x2="0" y2="${sunY + 16.5}"/>`
            + `<line x1="-11.25" y1="${sunY + 11.25}" x2="-9" y2="${sunY + 9}"/><line x1="11.25" y1="${sunY + 11.25}" x2="9" y2="${sunY + 9}"/>`
            + `</g>`
            // Finger-friendly grab zone: wider (±34) and extended a little above the
            // horizon so it's an easy touch target on a phone. It rides inside the
            // translated replay-sun group, so the zone follows the Sun as time scrubs.
            + `<rect class="replay-sun-hit" x="-34" y="${horizonY - 12}" width="68" height="${H - horizonY + 12}" fill="transparent" style="cursor:grab"/>`
            + liveBadge(-23, 281)                    // a LIVE badge below the Sun (moves with it; shown only in real time)
            + `</g>`;
        // Live time readout (with seconds), top-left above the horizon — the app sets its text
        // each second to the current replay instant. Monospace so the width doesn't jitter. The
        // LIVE toggle button sits just above it (only when real time is possible).
        svg += (liveBtn ? liveButton(padL + 4, 1) : "")
            + `<text class="replay-time" x="${padL + 4}" y="34" font-size="15" font-weight="700" `
            + `font-family="ui-monospace, SFMono-Regular, Menlo, monospace" fill="#dfe8ff"></text>`;
    }

    // hourly Sun-azimuth markers on top (in the headroom band above the sky)
    svg += hourMarksSvg;

    svg += `</svg>`;
    return svg;
}

// --- "it looks like" naked-eye animation -----------------------------------
// The same twinkling-flare sprinkle as the compass-rose live preview, but set in
// a small patch of night sky: a horizon line, a couple of static stars, and the
// flares appearing/drifting low over the horizon (reuses twinkleFlare, so the
// motion matches the compass exactly). Self-contained animated SVG (SMIL).
export function flareSimSky() {
    const W = 200, H = 150, horizonY = 128;

    // A couple of static background stars.
    const starPos = [[40, 30], [150, 26], [96, 50], [176, 66], [22, 60]];
    let stars = "";
    for (const [x, y] of starPos) {
        stars += `<circle cx="${x}" cy="${y}" r="0.9" fill="#cdd8f5" opacity="0.7"/>`;
    }

    // Twinkling flares — same envelope/drift mechanism as the compass sprinkle, but
    // with slow 3–6 s fades and clustered toward the centre of the patch (the part of
    // sky above the set Sun), drifting gently so they stay framed.
    const PERIOD = 60, SPEED = 4.2, N = 14;
    let flares = "";
    for (let i = 0; i < N; i++) {
        const px = W / 2 + (Math.random() - 0.5) * 84;     // centred ~100 ± 42
        const py = 60 + Math.random() * 48;                // mid-low in the sky, above the horizon
        flares += twinkleFlare(px, py, PERIOD, SPEED, 3, 3, { upOnly: true, shrinkFade: true });   // fade-in/out 3–6 s
    }

    return `<svg viewBox="0 0 ${W} ${H}" class="looklike-sky" role="img" aria-label="Animation of Starlink satellites flaring low over the horizon">
      <defs><linearGradient id="llsky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0a1330"/><stop offset="1" stop-color="#1a2a4d"/>
      </linearGradient></defs>
      <rect x="0" y="0" width="${W}" height="${horizonY}" fill="url(#llsky)"/>
      <rect x="0" y="${horizonY}" width="${W}" height="${H - horizonY}" fill="#070b16"/>
      <line x1="0" y1="${horizonY}" x2="${W}" y2="${horizonY}" stroke="#5a6e9a" stroke-width="1" stroke-opacity="0.7"/>
      ${stars}
      ${flares}
    </svg>`;
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
