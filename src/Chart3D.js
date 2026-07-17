// Lightweight interactive 3D data cube for the traverse gallery.
//
// Renders a rotatable 3D volume (a box with three labelled axes and grids on the
// three back bounding planes) with polyline / ray / marker series, using a plain
// 2D canvas and an orthographic projection — NOT WebGL — so many small charts can
// live on the page at once without exhausting GL contexts. Drag to rotate.
//
// A Chart3DGroup ties charts together: "Sync Orientation" (default on) rotates
// every chart together; "Sync Scale" (default off) locks every chart to one
// chart's data bounds so their sizes are directly comparable.
//
// Scene format (all coordinates in DISPLAY units; per-axis tick formatters give
// the labels):
//   {
//     bounds: {minX,maxX, minY,maxY, minZ,maxZ},   // X=East, Y=North, Z=Alt
//     series: [
//       {type:'line',  pts:[[x,y,z],...], color, width, startDot, endRing},
//       {type:'rays',  segs:[[x0,y0,z0, x1,y1,z1],...], color, alpha, width},
//       {type:'points',pts:[[x,y,z],...], color, size},
//     ],
//     labels: {x, y, z},
//     fmt: {x:(v)=>str, y, z},   // optional tick formatters
//   }

const DEG = Math.PI / 180;

function matrixFromAzEl(az, el) {
    const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    return [
        ca, sa, 0,
        -sa * se, ca * se, ce,
        sa * ce, -ca * ce, se,
    ];
}

function matMul(a, b) {
    return [
        a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
        a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
        a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
        a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
        a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
        a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
        a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
        a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
        a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
    ];
}

function matVec(m, v) {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
}

function quatFromTo(a, b) {
    const cross = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const w = 1 + dot;
    const len = Math.hypot(cross[0], cross[1], cross[2], w);
    if (len < 1e-9) return [0, 0, 0, 1];
    return [cross[0] / len, cross[1] / len, cross[2] / len, w / len];
}

function quatToMatrix(q) {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
        1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
        2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
        2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
    ];
}

// Shared orientation / scale controller for a set of charts.
export class Chart3DGroup {
    constructor(opts = {}) {
        this.charts = [];
        // Default view: pure top-down, matching the old 2D plan view.
        this.az = (opts.az ?? 0) * DEG;
        this.el = (opts.el ?? 90) * DEG;
        this.matrix = matrixFromAzEl(this.az, this.el);
        this.syncOrientation = opts.syncOrientation ?? true;
        this.syncScale = opts.syncScale ?? false;
        this.sharedBounds = null;         // active when syncScale is on
        this._raf = 0;
        this._redrawAll = false;
        this._redrawSet = new Set();
    }

    add(chart) { this.charts.push(chart); }
    remove(chart) { const i = this.charts.indexOf(chart); if (i >= 0) this.charts.splice(i, 1); }

    // Coalesce redraws of every (or one) chart into a single animation frame.
    _redraw(all, one) {
        if (all) {
            this._redrawAll = true;
        } else if (one) {
            this._redrawSet.add(one);
        }
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            const targets = this._redrawAll ? this.charts : Array.from(this._redrawSet);
            this._redrawAll = false;
            this._redrawSet.clear();
            for (const c of targets) c.draw();
        });
    }

    // A chart reports a drag. When orientation is synced, everyone rotates.
    orientationFromDrag(matrix, source) {
        if (this.syncOrientation) {
            this.matrix = matrix.slice();
            this._redraw(true);
        } else {
            source.localMatrix = matrix.slice();
            this._redraw(false, source);
        }
    }

    setSyncOrientation(on, currentChart) {
        if (on) {
            // Adopt the focused chart's CURRENT (independent) orientation before
            // flipping the flag — orientationFor() is gated on syncOrientation, so
            // this must read it while sync is still off, otherwise it would return
            // the stale shared matrix and snap every chart back, discarding the
            // rotation the user was just making.
            if (currentChart) this.matrix = this.orientationFor(currentChart).slice();
            this.syncOrientation = true;
            this._redraw(true);
        } else {
            this.syncOrientation = false;
            // Start independent rotation from the current shared view, not the
            // constructor default, so turning sync off does not snap charts.
            for (const chart of this.charts) {
                chart.localMatrix = this.matrix.slice();
            }
        }
    }

    // Lock every chart to `currentChart`'s data bounds (or release the lock).
    setSyncScale(on, currentChart) {
        this.syncScale = on;
        this.sharedBounds = on && currentChart ? currentChart.bounds : null;
        this._redraw(true);
    }

    orientationFor(chart) {
        return this.syncOrientation ? this.matrix : chart.localMatrix;
    }
}

function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const s = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
    return s * mag;
}
function niceTicks(lo, hi, target = 5) {
    if (!(hi > lo)) return [lo];
    const step = niceStep(hi - lo, target);
    const start = Math.ceil(lo / step) * step;
    const out = [];
    for (let v = start; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    return out;
}

export class Chart3D {
    constructor(canvas, scene, group, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.scene = scene;
        this.bounds = scene.bounds;
        this.group = group;
        this.localMatrix = group.matrix.slice();
        this.pad = opts.pad ?? 0.14;          // fraction of the canvas kept as margin
        this.scaleBoost = opts.scaleBoost ?? 1.625;
        group.add(this);
        this._bindPointer();
        this.resize();
    }

    dispose() {
        this.group.remove(this);
        this.canvas.replaceWith(this.canvas.cloneNode(false));  // drop listeners
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const r = this.canvas.getBoundingClientRect();
        const w = Math.max(80, r.width || this.canvas.clientWidth || 300);
        const h = Math.max(80, r.height || this.canvas.clientHeight || 220);
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.dpr = dpr; this.w = w; this.h = h;
        this.draw();
    }

    _bindPointer() {
        const c = this.canvas;
        let dragging = false, startVec = null, startMatrix = null;
        const trackballVec = (e) => {
            const r = c.getBoundingClientRect();
            const radius = Math.max(1, Math.min(r.width, r.height) * 0.5);
            let x = (e.clientX - (r.left + r.width / 2)) / radius;
            let y = -((e.clientY - (r.top + r.height / 2)) / radius);
            const d2 = x * x + y * y;
            if (d2 > 1) {
                const d = Math.sqrt(d2);
                x /= d; y /= d;
                return [x, y, 0];
            }
            return [x, y, Math.sqrt(1 - d2)];
        };
        const down = (e) => {
            dragging = true;
            startVec = trackballVec(e);
            startMatrix = this.group.orientationFor(this).slice();
            c.setPointerCapture && c.setPointerCapture(e.pointerId);
            c.style.cursor = "grabbing";
            e.preventDefault(); e.stopPropagation();
        };
        const move = (e) => {
            if (!dragging) return;
            const currentVec = trackballVec(e);
            const dragMatrix = quatToMatrix(quatFromTo(startVec, currentVec));
            this.group.orientationFromDrag(matMul(dragMatrix, startMatrix), this);
            e.preventDefault(); e.stopPropagation();
        };
        const up = (e) => {
            dragging = false;
            startVec = null;
            startMatrix = null;
            c.style.cursor = "grab";
            e && e.stopPropagation();
        };
        c.addEventListener("pointerdown", down);
        c.addEventListener("pointermove", move);
        c.addEventListener("pointerup", up);
        c.addEventListener("pointercancel", up);
        c.style.touchAction = "none";
        c.style.cursor = "grab";
    }

    // Normalize a display point into the unit box. X/Y/Z all share one scale,
    // so altitude has the same visual scale as East/North when the view is
    // rotated away from the default top-down orientation.
    _norm(p, b) {
        const spanX = b.maxX - b.minX || 1, spanY = b.maxY - b.minY || 1, spanZ = b.maxZ - b.minZ || 1;
        const base = Math.max(spanX, spanY, spanZ) || 1;
        return [
            (p[0] - (b.minX + b.maxX) / 2) / base,
            (p[1] - (b.minY + b.maxY) / 2) / base,
            (p[2] - (b.minZ + b.maxZ) / 2) / base,
        ];
    }

    // Rotate a normalized point by the orientation matrix and return {sx, sy, depth}. sx/sy are
    // screen axes (before fit); depth increases toward the camera.
    _rot(n, matrix) {
        const r = matVec(matrix, n);
        return {sx: r[0], sy: r[1], depth: r[2]};
    }

    activeBounds() {
        return (this.group.syncScale && this.group.sharedBounds) ? this.group.sharedBounds : this.bounds;
    }

    draw() {
        const ctx = this.ctx, dpr = this.dpr, W = this.w, H = this.h;
        if (!W || !H) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        const b = this.activeBounds();
        const orientation = this.group.orientationFor(this);

        // Box corners in normalized space (using the ACTIVE bounds so a synced
        // scale really rescales the drawing), mapped from the actual data bounds.
        const spanX = b.maxX - b.minX || 1, spanY = b.maxY - b.minY || 1, spanZ = b.maxZ - b.minZ || 1;
        const base = Math.max(spanX, spanY, spanZ) || 1;
        const hx = spanX / base / 2, hy = spanY / base / 2, hz = spanZ / base / 2;

        // Fit once to the enclosing sphere of the normalized box, not to the
        // current projected corner bounds. That keeps the chart's scale stable
        // while rotating instead of "breathing" larger/smaller by orientation.
        const sphereR = Math.hypot(hx, hy, hz) || 1;
        const scale = Math.min(W * (1 - this.pad * 2), H * (1 - this.pad * 2)) / (sphereR * 2) * this.scaleBoost;
        const cx = W / 2;
        const cy = H / 2;
        this.lastScale = scale;

        // project a DISPLAY-unit point -> canvas px
        const proj = (p) => {
            const r = this._rot(this._norm(p, b), orientation);
            return {x: cx + r.sx * scale, y: cy - r.sy * scale, depth: r.depth};
        };
        // project a NORMALIZED-box point (for the frame) -> canvas px
        const projN = (nx, ny, nz) => {
            const r = this._rot([nx, ny, nz], orientation);
            return {x: cx + r.sx * scale, y: cy - r.sy * scale, depth: r.depth};
        };

        this._drawFrame(ctx, b, projN, orientation, hx, hy, hz);
        this._drawSeries(ctx, proj);
    }

    // The box: three back-plane grids, the 12 wireframe edges, axis ticks+labels.
    _drawFrame(ctx, b, projN, orientation, hx, hy, hz) {
        // We render on a dark gallery, so fixed dark-friendly ink.
        const gridCol = "rgba(255,255,255,0.10)";
        const edgeCol = "rgba(255,255,255,0.28)";
        const tickInk = "#aeb6c0";
        const axisInk = "#cdd4dd";

        // For each axis choose the "back" face (the one farther from the camera)
        // to host its grid, matching matplotlib.
        const faceDepth = (nx, ny, nz) => this._rot([nx, ny, nz], orientation).depth;
        const backX = faceDepth(-hx, 0, 0) < faceDepth(hx, 0, 0) ? -hx : hx;   // plane x = backX
        const backY = faceDepth(0, -hy, 0) < faceDepth(0, hy, 0) ? -hy : hy;
        const backZ = faceDepth(0, 0, -hz) < faceDepth(0, 0, hz) ? -hz : hz;

        const line = (a, c, col, wdt) => {
            ctx.strokeStyle = col; ctx.lineWidth = wdt;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
        };

        // Normalized <-> data helpers per axis
        const spanX = b.maxX - b.minX, spanY = b.maxY - b.minY, spanZ = b.maxZ - b.minZ;
        const baseN = Math.max(spanX, spanY, spanZ) || 1;
        const nxOf = (vx) => (vx - (b.minX + b.maxX) / 2) / baseN;
        const nyOf = (vy) => (vy - (b.minY + b.maxY) / 2) / baseN;
        const nzOf = (vz) => (vz - (b.minZ + b.maxZ) / 2) / baseN;
        const ticksX = niceTicks(b.minX, b.maxX, 5).filter((v) => v >= b.minX && v <= b.maxX);
        const ticksY = niceTicks(b.minY, b.maxY, 5).filter((v) => v >= b.minY && v <= b.maxY);
        const ticksZ = niceTicks(b.minZ, b.maxZ, 5).filter((v) => v >= b.minZ && v <= b.maxZ);

        // Solid ground plane at min-Z (altitude 0 in the traversal graphs).
        const ground = [
            projN(-hx, -hy, -hz),
            projN(hx, -hy, -hz),
            projN(hx, hy, -hz),
            projN(-hx, hy, -hz),
        ];
        ctx.fillStyle = "#062015";
        ctx.beginPath();
        ctx.moveTo(ground[0].x, ground[0].y);
        for (let i = 1; i < ground.length; i++) ctx.lineTo(ground[i].x, ground[i].y);
        ctx.closePath();
        ctx.fill();

        // --- back-plane grids ---
        // X = backX plane (spans Y,Z)
        for (const vy of ticksY) line(projN(backX, nyOf(vy), -hz), projN(backX, nyOf(vy), hz), gridCol, 1);
        for (const vz of ticksZ) line(projN(backX, -hy, nzOf(vz)), projN(backX, hy, nzOf(vz)), gridCol, 1);
        // Y = backY plane (spans X,Z)
        for (const vx of ticksX) line(projN(nxOf(vx), backY, -hz), projN(nxOf(vx), backY, hz), gridCol, 1);
        for (const vz of ticksZ) line(projN(-hx, backY, nzOf(vz)), projN(hx, backY, nzOf(vz)), gridCol, 1);
        // Z = backZ plane (spans X,Y) — the floor/ceiling grid
        for (const vx of ticksX) line(projN(nxOf(vx), -hy, backZ), projN(nxOf(vx), hy, backZ), gridCol, 1);
        for (const vy of ticksY) line(projN(-hx, nyOf(vy), backZ), projN(hx, nyOf(vy), backZ), gridCol, 1);

        // --- box wireframe (12 edges) ---
        const C = {};
        for (const ix of [-1, 1]) for (const iy of [-1, 1]) for (const iz of [-1, 1])
            C[`${ix}${iy}${iz}`] = projN(ix * hx, iy * hy, iz * hz);
        const edge = (a, c) => line(C[a], C[c], edgeCol, 1.1);
        // along X
        edge("-1-1-1", "1-1-1"); edge("-11-1", "11-1"); edge("-1-11", "1-11"); edge("-111", "111");
        // along Y
        edge("-1-1-1", "-11-1"); edge("1-1-1", "11-1"); edge("-1-11", "-111"); edge("1-11", "111");
        // along Z
        edge("-1-1-1", "-1-11"); edge("1-1-1", "1-11"); edge("-11-1", "-111"); edge("11-1", "111");

        // --- tick labels + axis titles ---
        ctx.font = "10px system-ui, -apple-system, sans-serif";
        ctx.fillStyle = tickInk;
        const fmt = this.scene.fmt || {};
        const fx = fmt.x || ((v) => `${v}`), fy = fmt.y || ((v) => `${v}`), fz = fmt.z || ((v) => `${v}`);

        // X ticks along the front-bottom edge at y = -backY (opposite the back Y plane), z=backZ
        const yEdge = -backY, zEdge = backZ;
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        for (const vx of ticksX) {
            const pnt = projN(nxOf(vx), yEdge, zEdge);
            ctx.fillText(fx(vx), pnt.x, pnt.y + 3);
        }
        // Y ticks along the edge at x = -backX, z=backZ
        const xEdge = -backX;
        ctx.textAlign = "start"; ctx.textBaseline = "middle";
        for (const vy of ticksY) {
            const pnt = projN(xEdge, nyOf(vy), zEdge);
            ctx.fillText(fy(vy), pnt.x + 4, pnt.y);
        }
        // Z ticks along the vertical back edge at x=backX, y=backY
        ctx.textAlign = "end"; ctx.textBaseline = "middle";
        for (const vz of ticksZ) {
            const pnt = projN(backX, backY, nzOf(vz));
            ctx.fillText(fz(vz), pnt.x - 4, pnt.y);
        }

        // axis titles
        const L = this.scene.labels || {};
        ctx.fillStyle = axisInk;
        ctx.font = "600 11px system-ui, -apple-system, sans-serif";
        if (L.x) { const m = projN(0, yEdge, zEdge); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(L.x, m.x, m.y + 15); }
        if (L.y) { const m = projN(xEdge, 0, zEdge); ctx.textAlign = "start"; ctx.textBaseline = "middle"; ctx.fillText(L.y, m.x + 22, m.y); }
        if (L.z) { const m = projN(backX, backY, 0); ctx.textAlign = "end"; ctx.textBaseline = "middle"; ctx.fillText(L.z, m.x - 22, m.y); }
    }

    _drawSeries(ctx, proj) {
        for (const s of this.scene.series) {
            if (s.type === "rays") {
                ctx.strokeStyle = s.color; ctx.globalAlpha = s.alpha ?? 0.5; ctx.lineWidth = s.width ?? 1;
                ctx.beginPath();
                for (const g of s.segs) {
                    const a = proj([g[0], g[1], g[2]]), c = proj([g[3], g[4], g[5]]);
                    ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
                }
                ctx.stroke(); ctx.globalAlpha = 1;
            } else if (s.type === "line") {
                ctx.strokeStyle = s.color; ctx.lineWidth = s.width ?? 2;
                ctx.lineJoin = "round";
                if (s.dash) ctx.setLineDash(s.dash);
                ctx.beginPath();
                let first = true;
                for (const p of s.pts) {
                    const q = proj(p);
                    if (first) { ctx.moveTo(q.x, q.y); first = false; } else ctx.lineTo(q.x, q.y);
                }
                ctx.stroke();
                if (s.dash) ctx.setLineDash([]);
                if (s.pts.length) {
                    if (s.startDot) {
                        const q = proj(s.pts[0]);
                        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2); ctx.fill();
                    }
                    if (s.endRing) {
                        const q = proj(s.pts[s.pts.length - 1]);
                        ctx.strokeStyle = s.color; ctx.lineWidth = 1.6;
                        ctx.beginPath(); ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2); ctx.stroke();
                    }
                }
            } else if (s.type === "points") {
                ctx.fillStyle = s.color;
                for (const p of s.pts) {
                    const q = proj(p);
                    ctx.beginPath(); ctx.arc(q.x, q.y, s.size ?? 2, 0, Math.PI * 2); ctx.fill();
                }
            }
        }
    }
}
