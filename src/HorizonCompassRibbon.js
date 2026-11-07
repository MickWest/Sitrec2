import {MathUtils, Vector3} from "three";

// True bearings in the observer's local frame. For an observer above the
// ellipsoid, solve the ray/ellipsoid tangency condition at each bearing so
// the ribbon follows the sea-level horizon, including its dip with altitude.
export function horizonCompassFrame(position, equatorRadius, polarRadius) {
    const p = position.clone().divideScalar(equatorRadius);
    const zScale = (equatorRadius / polarRadius) ** 2;
    const dot = (a, b) => a.x * b.x + a.y * b.y + zScale * a.z * b.z;
    const up = new Vector3(p.x, p.y, p.z * zScale).normalize();
    const east = new Vector3(-p.y, p.x, 0);
    if (east.lengthSq() < 1e-20) east.set(0, 1, 0);
    east.normalize();
    const north = new Vector3().crossVectors(up, east).normalize();
    const c = Math.max(0, dot(p, p) - 1);
    const pu = dot(p, up);
    const a = pu * pu - c * dot(up, up);

    return {
        up, north, east,
        direction(bearing, out = new Vector3()) {
            const az = MathUtils.degToRad(bearing);
            out.copy(north).multiplyScalar(Math.cos(az)).addScaledVector(east, Math.sin(az));
            if (c > 1e-14) {
                const ph = dot(p, out);
                const b = 2 * (ph * pu - c * dot(out, up));
                const d = ph * ph - c * dot(out, out);
                const slope = (-b - Math.sqrt(Math.max(0, b * b - 4 * a * d))) / (2 * a);
                out.addScaledVector(up, slope).normalize();
            }
            return out;
        },
    };
}

const compassNames = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// project maps a world direction to canvas pixels, or null behind the camera.
// It uses the view's displayed projection, including panorama and fisheye.
export function drawHorizonCompassRibbon(ctx, frame, project, rect, {
    wrap = false, opacity = 1, textSize = 14, pixelsPerDegree = rect.w / 180,
    showCardinals = true, showDegrees = true,
} = {}) {
    if (opacity <= 0) return;
    // Choose a bearing-aligned scale from zoom and text size only. Greedy
    // screen-space overlap removal makes neighboring labels trade places as
    // the camera pans, even though neither bearing has left the view.
    const scale = Math.max(0.01, pixelsPerDegree);
    const numberSize = Math.max(6, Math.round(textSize * 11 / 14));
    const labelStep = [10, 20, 30, 60, 90].find(step => step * scale >= numberSize * 1.6 + 3) ?? 90;
    const cardinalStep = 45 * scale >= textSize * 2.5 ? 45 : 90;
    const tickStep = [1, 5, 10, 15, 30, 45, 90].find(step => step * scale >= 8) ?? 90;
    const direction = new Vector3();
    const points = [];
    for (let az = 0; az <= 360; az++) {
        points.push(project(frame.direction(az, direction)));
    }

    ctx.save();
    ctx.globalAlpha *= opacity;
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.strokeStyle = "rgba(184, 201, 218, 0.4)";
    ctx.lineWidth = 1;
    ctx.shadowColor = "#000000";
    ctx.shadowBlur = 3;
    ctx.beginPath();
    for (let az = 1; az <= 360; az++) {
        const p = points[az - 1], q = points[az];
        // Do not join the two edges of a wrapped panorama across the view.
        if (!p || !q || (wrap && Math.abs(p.x - q.x) > rect.w / 2)) continue;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let az = 0; az < 360; az++) {
        const cardinal = az % cardinalStep === 0;
        const major = az % labelStep === 0;
        if (!cardinal && !major && az % tickStep !== 0) continue;
        const p = points[az];
        if (!p || p.x < rect.x - 20 || p.x > rect.x + rect.w + 20
            || p.y < rect.y - 30 || p.y > rect.y + rect.h + 30) continue;
        const length = cardinal ? 12 : major ? 8 : az % 5 === 0 ? 6 : 3;
        ctx.save();
        ctx.translate(p.x, p.y);
        // Keep labels upright and ticks vertical on screen, even with roll
        // or a curved horizon in wide-angle, fisheye and panoramic views.
        ctx.strokeStyle = cardinal ? "#b8c9da" : "rgba(184, 201, 218, 0.85)";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -length);
        ctx.stroke();
        // Compass names sit above the ruler and numbers below it, so a nearby
        // compass name does not need to remove a degree label.
        if (cardinal && showCardinals) {
            ctx.font = `bold ${textSize}px Arial`;
            ctx.fillStyle = "#b8c9da";
            ctx.fillText(compassNames[az / 45], 0, -length - textSize * 0.8);
        }
        if (major && showDegrees) {
            ctx.font = `${numberSize}px Arial`;
            ctx.fillStyle = "#e6ecf4";
            ctx.fillText(`${az}°`, 0, numberSize + 1);
        }
        ctx.restore();
    }
    ctx.restore();
}
