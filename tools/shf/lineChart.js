// lineChart.js — a small SVG multi-series line chart with a crosshair tooltip.
//
// Used by the flare-statistics viewer (stats/) and the flare rate page (rate/). Styles are
// in lineChart.css. Colors come from CSS custom properties (--series-1 ...), so the page's
// light and dark themes apply without a re-render. Series and label text is set with
// textContent only.
//
//   const chart = createLineChart(element, options);
//   chart.update(newOptions);    // re-render with new data
//
// options:
//   x         [{ pos, label }]  one entry per data point; label is shown in the tooltip
//   xTicks    [{ pos, label }]  axis ticks
//   series    [{ name, colorVar, values }]   values align with x; null = no value
//   yLabel    axis title
//   yMax      optional fixed top of the y axis (small multiples on one scale, or a locked
//             axis); lines above it are clipped at the top of the plot
//   height    px (default 320)
//   compact   smaller margins and fonts, for small multiples
//   markers   optional [{ pos, label }]: a vertical line at each pos, labelled at the top
//   onPick    optional (index) => void: pressing on the plot picks the nearest X, and
//             dragging keeps picking (mouse, pen or finger); Enter or Space picks from the keyboard
//
// A key of the series on show sits above the plot, so each chart names its own lines.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
}

// Round tick values: 0, step, 2·step ... with step = 1, 2 or 5 × 10^n.
export function niceTicks(max, target = 5) {
    if (!(max > 0)) return [0, 1];
    const raw = max / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
}

const fmt = (v) => (v == null ? "–" : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1));

let clipCount = 0;

export function createLineChart(host, initial) {
    let opt = initial;
    let hoverIndex = null;
    host.classList.add("lc");
    const tooltip = document.createElement("div");
    tooltip.className = "lc-tooltip";
    tooltip.setAttribute("role", "status");
    tooltip.hidden = true;
    let svg = null, geom = null;

    function render() {
        const width = host.clientWidth;
        if (width === 0) return;
        const compact = !!opt.compact;
        const height = opt.height || 320;
        const m = compact
            ? { top: 8, right: 10, bottom: 22, left: 34 }
            : { top: 12, right: 16, bottom: 34, left: 56 };
        const w = Math.max(10, width - m.left - m.right);
        const h = Math.max(10, height - m.top - m.bottom);

        const xs = opt.x.map((p) => p.pos);
        const xMin = Math.min(...xs), xMax = Math.max(...xs);
        const dataMax = Math.max(0, ...opt.series.flatMap((s) => s.values.filter((v) => v != null)));
        const yTicks = niceTicks(opt.yMax ?? dataMax, compact ? 3 : 5);
        const yTop = yTicks[yTicks.length - 1];
        const sx = (v) => m.left + (xMax === xMin ? w / 2 : ((v - xMin) / (xMax - xMin)) * w);
        const sy = (v) => m.top + h - (v / yTop) * h;
        geom = { sx, sy, m, w, h, width, height, yTop };

        host.replaceChildren(legend());
        svg = svgEl("svg", {
            width, height, viewBox: `0 0 ${width} ${height}`, class: "lc-svg",
            tabindex: "0", role: "img",
            "aria-label": `${opt.yLabel || "Chart"}. Use the left and right arrow keys to read values.`,
        });

        // Gridlines and y ticks
        const grid = svgEl("g", { class: "lc-grid" }, svg);
        for (const t of yTicks) {
            svgEl("line", { x1: m.left, x2: m.left + w, y1: sy(t), y2: sy(t) }, grid);
            const label = svgEl("text", { x: m.left - 6, y: sy(t), class: "lc-tick", "text-anchor": "end", "dominant-baseline": "middle" }, grid);
            label.textContent = t.toLocaleString();
        }
        svgEl("line", { x1: m.left, x2: m.left + w, y1: sy(0), y2: sy(0), class: "lc-baseline" }, svg);

        // X ticks
        const xAxis = svgEl("g", {}, svg);
        for (const t of opt.xTicks) {
            const label = svgEl("text", { x: sx(t.pos), y: m.top + h + (compact ? 14 : 18), class: "lc-tick", "text-anchor": "middle" }, xAxis);
            label.textContent = t.label;
        }
        if (opt.yLabel && !compact) {
            const title = svgEl("text", { x: 14, y: m.top + h / 2, class: "lc-axis-title", "text-anchor": "middle",
                transform: `rotate(-90 14 ${m.top + h / 2})` }, svg);
            title.textContent = opt.yLabel;
        }

        // Lines; a null value breaks the line. With a fixed yMax a value can be above the
        // top of the axis, so the lines are clipped to the plot (plus room for the stroke).
        // The id is unique per chart, because a saved image can hold several charts.
        const clipId = `lc-clip-${++clipCount}`;
        const clip = svgEl("clipPath", { id: clipId }, svgEl("defs", {}, svg));
        svgEl("rect", { x: m.left - 2, y: m.top - 2, width: w + 4, height: h + 4 }, clip);
        const lines = svgEl("g", { "clip-path": `url(#${clipId})` }, svg);
        for (const s of opt.series) {
            let d = "", pen = false;
            s.values.forEach((v, i) => {
                if (v == null) { pen = false; return; }
                d += `${pen ? "L" : "M"}${sx(opt.x[i].pos).toFixed(1)},${sy(v).toFixed(1)}`;
                pen = true;
            });
            svgEl("path", { d, class: "lc-line", style: `stroke: var(${s.colorVar})` }, lines);
        }

        // Markers: a vertical line with a label at the top, kept inside the plot.
        for (const mk of opt.markers || []) {
            if (mk.pos < xMin || mk.pos > xMax) continue;
            const x = sx(mk.pos);
            svgEl("line", { x1: x, x2: x, y1: m.top, y2: m.top + h, class: "lc-marker" }, svg);
            if (mk.label) {
                const right = x > m.left + w * 0.75;
                const label = svgEl("text", { x: x + (right ? -4 : 4), y: m.top + 10, class: "lc-marker-label",
                    "text-anchor": right ? "end" : "start" }, svg);
                label.textContent = mk.label;
            }
        }

        // Crosshair and hover dots (hidden until hover)
        // Hidden with display, not visibility: a child's visibility="visible" would
        // override a hidden parent and leave the dots on screen.
        const cross = svgEl("g", { class: "lc-cross", display: "none" }, svg);
        svgEl("line", { y1: m.top, y2: m.top + h, class: "lc-hair" }, cross);
        for (const s of opt.series) svgEl("circle", { r: 4, class: "lc-dot", style: `fill: var(${s.colorVar})` }, cross);

        // Hit area covers the whole plot, so the pointer only has to find the X.
        const hit = svgEl("rect", { x: m.left, y: m.top, width: w, height: h, class: "lc-hit" }, svg);
        hit.addEventListener("pointermove", (e) => {
            const rect = svg.getBoundingClientRect();
            showIndex(nearestIndex(e.clientX - rect.left));
        });
        hit.addEventListener("pointerleave", hide);
        host.classList.toggle("lc-pick", !!opt.onPick);
        svg.addEventListener("focus", () => showIndex(hoverIndex ?? 0));
        svg.addEventListener("blur", hide);
        svg.addEventListener("keydown", (e) => {
            if (opt.onPick && (e.key === "Enter" || e.key === " ") && hoverIndex != null) {
                e.preventDefault();
                opt.onPick(hoverIndex);
                return;
            }
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const step = e.key === "ArrowLeft" ? -1 : 1;
            showIndex(Math.max(0, Math.min(opt.x.length - 1, (hoverIndex ?? 0) + step)));
        });

        host.append(svg, tooltip);
        if (hoverIndex != null && hoverIndex < opt.x.length) showIndex(hoverIndex);
    }

    // Key: a short line in each series color, then its name (text in ink, not series color).
    function legend() {
        const key = document.createElement("div");
        key.className = "lc-key";
        for (const s of opt.series) {
            const item = document.createElement("span");
            item.className = "lc-key-item";
            const swatch = document.createElement("span");
            swatch.className = "lc-key-swatch";
            swatch.style.background = `var(${s.colorVar})`;
            item.append(swatch, document.createTextNode(s.name));
            key.appendChild(item);
        }
        return key;
    }

    function nearestIndex(px) {
        let best = 0, bestD = Infinity;
        opt.x.forEach((p, i) => {
            const d = Math.abs(geom.sx(p.pos) - px);
            if (d < bestD) { bestD = d; best = i; }
        });
        return best;
    }

    function showIndex(i) {
        hoverIndex = i;
        const cross = svg.querySelector(".lc-cross");
        const x = geom.sx(opt.x[i].pos);
        cross.removeAttribute("display");
        const hair = cross.querySelector(".lc-hair");
        hair.setAttribute("x1", x); hair.setAttribute("x2", x);
        cross.querySelectorAll(".lc-dot").forEach((dot, k) => {
            const v = opt.series[k].values[i];
            dot.setAttribute("visibility", v == null ? "hidden" : "visible");
            dot.setAttribute("cx", x);
            if (v != null) dot.setAttribute("cy", geom.sy(Math.min(v, geom.yTop)));   // clipped values: dot at the top
        });

        // Tooltip: the X label, then every series at this X, values first.
        tooltip.replaceChildren();
        const head = document.createElement("div");
        head.className = "lc-tt-head";
        head.textContent = opt.x[i].label;
        tooltip.appendChild(head);
        for (const s of opt.series) {
            const row = document.createElement("div");
            row.className = "lc-tt-row";
            const key = document.createElement("span");
            key.className = "lc-tt-key";
            key.style.background = `var(${s.colorVar})`;
            const value = document.createElement("strong");
            value.textContent = fmt(s.values[i]);
            const name = document.createElement("span");
            name.className = "lc-tt-name";
            name.textContent = s.name;
            row.append(key, value, name);
            tooltip.appendChild(row);
        }
        tooltip.hidden = false;
        // Place beside the crosshair, flipping to the left near the right edge.
        const tw = tooltip.offsetWidth;
        const left = x + 12 + tw > geom.width ? x - 12 - tw : x + 12;
        tooltip.style.left = `${Math.max(0, left)}px`;
        tooltip.style.top = `${svg.offsetTop + geom.m.top}px`;   // below the key
    }

    function hide() {
        if (dragId != null) return;          // a drag keeps its tooltip, even outside the plot
        if (svg && document.activeElement === svg) return;
        hoverIndex = null;
        tooltip.hidden = true;
        svg?.querySelector(".lc-cross")?.setAttribute("display", "none");
    }

    // Pick by press and drag (onPick). A pick usually makes the page draw the chart again,
    // which replaces the SVG, so the listeners and the pointer capture are on the host,
    // which stays.
    let dragId = null;
    function pickAt(clientX) {
        const i = nearestIndex(clientX - svg.getBoundingClientRect().left);
        showIndex(i);
        opt.onPick(i);
    }
    host.addEventListener("pointerdown", (e) => {
        if (!opt.onPick || e.button !== 0 || !e.target.classList?.contains("lc-hit")) return;
        e.preventDefault();                  // no text selection while dragging
        dragId = e.pointerId;
        try { host.setPointerCapture(e.pointerId); } catch { /* the drag still works inside the chart */ }
        pickAt(e.clientX);
    });
    host.addEventListener("pointermove", (e) => { if (e.pointerId === dragId) pickAt(e.clientX); });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
        host.addEventListener(type, (e) => { if (e.pointerId === dragId) dragId = null; });
    }

    const resize = new ResizeObserver(() => render());
    resize.observe(host);
    render();

    return {
        update(next) { opt = next; render(); },
    };
}
